/**
 * index.js — Death Star Viz event server (entry point)
 *
 * Pipeline:  Claude Code hooks --POST /ingest--> [async reduce] --> WorldModel
 *                                                                      |
 *                                          WS /stream <--snapshot+deltas--+
 *
 * Run:  npm start   (node server/index.js)
 * Port: 8080 (override with PORT env var). DEBUG=1 enables verbose logging.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WEBSOCKET MESSAGE CONTRACT  (the client author relies on these EXACT shapes)
 * ─────────────────────────────────────────────────────────────────────────────
 * Client -> server, optionally, as the FIRST message after connect:
 *     { "lastSeq": <number> }
 *   Omit it (or send anything non-numeric) for a fresh connect.
 *
 * Server -> client:
 *   Snapshot (sent on fresh/stale connect, before live stream):
 *     { "type":"snapshot", "seq":<n>, "entities":[ <full record>, ... ], "aggregates":{...} }
 *
 *   Spawn (a new entity appeared) — carries the FULL record:
 *     { "type":"spawn", "seq":<n>, "entity":{ <full record> } }
 *
 *   Delta (partial update to an existing entity):
 *     { "type":"delta", "seq":<n>, "entityId":"<id>", "changes":{ ...partial record... } }
 *     `changes` may also carry a transient `signal`:
 *        "spawn" | "prompt" | "tool_start" | "tool_end" | "error" | "waiting" | "dim"
 *     Signals are one-shot client cues; persistent fields (status, currentTool,
 *     currentToolFamily, errorCount, dimmed, ...) are the source of truth.
 *
 *   Despawn (entity removed — SessionEnd, SubagentStop, or reaper):
 *     { "type":"despawn", "seq":<n>, "entityId":"<id>" }
 *
 *   Aggregates (fleet-wide stats; pushed on the tick):
 *     { "type":"aggregates", "seq":<n>, "aggregates":{
 *          activeCount, totalCount, throughput, toolStartsWindow, errorsWindow,
 *          errorRate, spend, projects:[{key,name,path,count,working}], windowMs } }
 *
 * Full entity record fields:
 *   id, kind ("session"|"subagent"), agentType, parentSessionId,
 *   project { key, name, path }, status ("spawning"|"working"|"idle"|"finished"),
 *   currentTool, currentToolFamily, lastSeen, toolCount, errorCount, dimmed,
 *   recentEvents[ {t,e} ]   (plus optional model/source/title/agentTranscriptPath)
 *
 * Every spawn/delta/despawn/aggregates message has a unique monotonic `seq`.
 * Reconnect with `lastSeq` still in the ring buffer -> server replays only the
 * missed spawn/delta/despawn messages. Stale/missing -> full snapshot.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { WorldModel } from './worldModel.js';
import { CityModel, TUNING } from './city.js';
import { loadCity, createPersister } from './persist.js';
import { createIngest } from './ingest.js';
import {
  startReaper,
  DIM_THRESHOLD_MS,
  DESPAWN_THRESHOLD_MS,
  REAP_INTERVAL_MS,
} from './reaper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const TICK_MS = 150; // broadcast cadence: coalesce bursts + push aggregates
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// ── Core state ───────────────────────────────────────────────────────────────
const world = new WorldModel();
const ingest = createIngest(world, { debug: DEBUG });
startReaper(world, { debug: DEBUG });

// Persistent city layer: tool work builds districts/lots that survive restarts.
const SAVE_PATH = path.resolve(__dirname, '..', 'data', 'city.json');
const city = new CityModel(world); // shares the world's seq space
const savedCity = loadCity(SAVE_PATH, { debug: DEBUG });
if (savedCity) city.loadFrom(savedCity);
const persister = createPersister(city, SAVE_PATH, { debug: DEBUG });

world.on('work', (w) => {
  // City growth must never take down the ingest pipeline.
  try {
    if (w.isFailure) city.recordIncident(w);
    else city.recordWork(w);
  } catch (err) {
    console.error('[city] record failed:', err?.message ?? err);
  }
});

// Thinking builds too: a session mid-turn with no tool running (status
// 'thinking') is reasoning, and that's still work. Credit it on a timer at
// TUNING.WORK_PER_THINK_SEC units/sec, routed through the same recordWork path
// so it binds/raises a building exactly like a tool call — pure volume of work.
const THINK_TICK_MS = 2_000;
const thinkTimer = setInterval(() => {
  const amount = TUNING.WORK_PER_THINK_SEC * (THINK_TICK_MS / 1000);
  if (amount <= 0) return;
  for (const rec of world.entities.values()) {
    if (rec.kind !== 'session' || !rec.turnActive || rec.status !== 'thinking') continue;
    try {
      city.recordWork({ project: rec.project, sessionId: rec.id, amount });
    } catch (err) {
      console.error('[city] think-work failed:', err?.message ?? err);
    }
  }
}, THINK_TICK_MS);
if (typeof thinkTimer.unref === 'function') thinkTimer.unref();

// When the city binds a session to a building, tag the session entity so the
// client can place its worker at that construction site.
city.on('assign', ({ sessionId, districtKey, lotId }) => {
  try {
    world.setSessionBuilding(sessionId, districtKey, lotId);
  } catch (err) {
    console.error('[city] assign failed:', err?.message ?? err);
  }
});

// ── HTTP / Express ───────────────────────────────────────────────────────────
const app = express();

// Tolerant JSON body parsing: accept any content-type, never throw on odd/empty
// bodies. We capture the raw body and parse defensively ourselves.
app.use(
  express.raw({ type: '*/*', limit: '2mb' })
);

/**
 * POST /ingest — accept a hook payload, return 202 IMMEDIATELY, reduce async.
 * Returning fast is the top reliability requirement: Claude Code hooks block
 * until this responds.
 */
app.post('/ingest', (req, res) => {
  // Respond first, before any parsing/processing work.
  res.status(202).end();

  // Parse + enqueue out of band; tolerate empty / malformed bodies.
  setImmediate(() => {
    let payload = null;
    try {
      const raw = req.body;
      if (Buffer.isBuffer(raw) && raw.length > 0) {
        payload = JSON.parse(raw.toString('utf8'));
      } else if (typeof raw === 'string' && raw.length > 0) {
        payload = JSON.parse(raw);
      } else if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) {
        payload = raw; // already-parsed object (shouldn't happen with raw())
      }
    } catch (err) {
      if (DEBUG) console.log('[ingest] unparseable body:', err?.message ?? err);
      return; // swallow; never crash
    }
    if (payload) ingest.enqueue(payload);
  });
});

// Health check.
app.get('/health', (_req, res) => {
  res.json({ ok: true, entities: world.entities.size, seq: world.seq, ...city.stats() });
});

// Serve the client (added by another agent) at /. Mounted last so /ingest etc.
// take precedence.
app.use(express.static(PUBLIC_DIR));

// ── HTTP + WS server ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

/** Safe send: ignore if socket is closing/closed. */
function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    if (DEBUG) console.log('[ws] send failed:', err?.message ?? err);
  }
}

/** Broadcast to all open clients. */
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(data);
      } catch {
        /* ignore individual client failures */
      }
    }
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.handshakeDone = false;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // The client MAY send { lastSeq } as its first message. We give it a brief
  // window; if it hasn't spoken by the time we want to stream, we snapshot.
  let handshakeTimer = setTimeout(() => doHandshake(ws, undefined), 250);

  ws.on('message', (raw) => {
    if (ws.handshakeDone) return; // only the first message participates
    clearTimeout(handshakeTimer);
    let lastSeq;
    try {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg && typeof msg.lastSeq === 'number') lastSeq = msg.lastSeq;
    } catch {
      /* ignore; treat as fresh connect */
    }
    doHandshake(ws, lastSeq);
  });

  ws.on('close', () => {
    clearTimeout(handshakeTimer);
  });
  ws.on('error', () => {
    clearTimeout(handshakeTimer);
  });
});

/** Decide snapshot vs delta-replay for a newly connected client. */
function doHandshake(ws, lastSeq) {
  if (ws.handshakeDone) return;
  ws.handshakeDone = true;

  const missed = lastSeq !== undefined ? world.deltasSince(lastSeq) : null;
  if (missed) {
    // Resync: replay only what was missed (may be empty if already current).
    if (DEBUG) console.log(`[ws] resync from seq=${lastSeq} (${missed.length} msgs)`);
    for (const m of missed) send(ws, m);
    // Follow with fresh aggregates so the lens is correct immediately.
    send(ws, { type: 'aggregates', seq: world.seq, aggregates: aggregatesWithCity() });
  } else {
    // Fresh / stale -> full snapshot.
    const snap = world.snapshot();
    snap.aggregates.city = city.stats();
    if (DEBUG) console.log(`[ws] snapshot @ seq=${snap.seq} (${snap.entities.length} entities)`);
    send(ws, snap);
  }
  // City messages are never in the resync ring; ALWAYS send a fresh full city
  // snapshot on handshake (it is small — a few KB for hundreds of buildings).
  send(ws, city.snapshotCity());
  ws.subscribed = true;
}

function aggregatesWithCity() {
  const aggregates = world.computeAggregates();
  aggregates.city = city.stats();
  return aggregates;
}

// ── Outbound coalescing ──────────────────────────────────────────────────────
//
// Lifecycle beats (spawn / despawn / error delta) go out IMMEDIATELY. Other
// high-frequency deltas are coalesced into the ~150ms tick. Aggregates piggy-
// back on the tick. Messages already carry their seq from the world model, so
// ordering by seq is preserved as long as we flush the pending buffer in order.

let pending = []; // deltas waiting for the next tick
let aggregatesDirty = false;
/** @type {Map<string, object>} lotId -> latest progress cityDelta (coalesced) */
let pendingCity = new Map();

world.on('message', (msg) => {
  switch (msg.type) {
    case 'despawn':
      // A departed session no longer needs its city binding tracked.
      city.releaseSession(msg.entityId);
      // fallthrough to the lifecycle-beat broadcast below.
    case 'spawn':
      // Lifecycle beat: push immediately to subscribed clients.
      flushPending(); // keep seq ordering: drain coalesced ones first
      broadcastSubscribed(msg);
      aggregatesDirty = true;
      break;
    case 'delta':
      if (msg.changes && msg.changes.signal === 'error') {
        // Errors are a lifecycle beat too.
        flushPending();
        broadcastSubscribed(msg);
        aggregatesDirty = true;
      } else {
        pending.push(msg);
        aggregatesDirty = true;
      }
      break;
    case 'aggregates':
      // Emitted by world.emitAggregates(); we instead drive aggregates from the
      // tick, so just broadcast directly if one arrives.
      broadcastSubscribed(msg);
      break;
    default:
      broadcastSubscribed(msg);
  }
});

function broadcastSubscribed(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && ws.subscribed) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }
}

function flushPending() {
  if (pending.length === 0) return;
  // pending is already in seq order (push order == emit order).
  for (const m of pending) broadcastSubscribed(m);
  pending = [];
}

// City messages: `progress` deltas are high-frequency (one per tool use) and
// idempotent (full lot in every delta), so coalesce them per lot on the tick.
// Lifecycle beats (groundbreak/complete/incident) flush immediately.
city.on('message', (msg) => {
  if (msg.type === 'cityDelta' && msg.event === 'progress') {
    pendingCity.set(msg.lot.id, msg);
    aggregatesDirty = true;
  } else {
    flushPendingCity();
    broadcastSubscribed(msg);
    aggregatesDirty = true;
  }
});

function flushPendingCity() {
  if (pendingCity.size === 0) return;
  for (const m of pendingCity.values()) broadcastSubscribed(m);
  pendingCity = new Map();
}

// Fixed tick: flush coalesced deltas, then push aggregates if anything changed.
const tickHandle = setInterval(() => {
  flushPending();
  flushPendingCity();
  if (aggregatesDirty) {
    aggregatesDirty = false;
    const seq = world.nextSeq();
    broadcastSubscribed({ type: 'aggregates', seq, aggregates: aggregatesWithCity() });
  }
}, TICK_MS);
if (typeof tickHandle.unref === 'function') tickHandle.unref();

// ── WS keepalive (drop dead sockets) ─────────────────────────────────────────
const pingHandle = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30_000);
if (typeof pingHandle.unref === 'function') pingHandle.unref();

// ── Process safety: never crash the pipe on an unexpected error ──────────────
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err?.stack ?? err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log('');
  const cs = city.stats();
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║   AGENT CITY — event server online                    ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log(`   listening      : ${PORT}`);
  console.log(`   ingest (POST)  : ${base}/ingest`);
  console.log(`   stream (WS)    : ws://localhost:${PORT}/stream`);
  console.log(`   viz            : ${base}/`);
  console.log(`   city           : ${cs.buildings} built / ${cs.underConstruction} in progress across ${cs.districts} district(s)`);
  console.log(`   save file      : ${SAVE_PATH}`);
  console.log(`   tick           : ${TICK_MS}ms   reaper: dim ${DIM_THRESHOLD_MS / 1000}s / despawn ${DESPAWN_THRESHOLD_MS / 1000}s every ${REAP_INTERVAL_MS / 1000}s`);
  console.log(`   debug          : ${DEBUG ? 'on' : 'off (set DEBUG=1 for verbose)'}`);
  console.log('');
});

// Graceful shutdown.
function shutdown() {
  persister.flushSync(); // never lose city progress on a clean exit
  clearInterval(tickHandle);
  clearInterval(pingHandle);
  try {
    wss.close();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  // Force-exit if close hangs.
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, server, world }; // exported for potential testing
