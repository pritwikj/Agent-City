/**
 * worldModel.js
 *
 * The authoritative world model: a reduction over the Claude Code hook event
 * stream. Holds a map of entityId -> record (sessions keyed by session_id,
 * subagents keyed by agent_id), a monotonic sequence counter, fleet
 * aggregates, and a bounded ring buffer of outbound deltas for reconnect
 * resync.
 *
 * This module is intentionally pure-data + small emitter: it does NOT know
 * about HTTP or WebSockets. `ingest.js` feeds it events; `index.js` listens
 * for outbound messages and broadcasts them. The reaper calls into it on a
 * timer.
 *
 * ── OUTBOUND MESSAGE CONTRACT (the client depends on these EXACT shapes) ──
 *
 * The model emits 'message' events. Each message is one of:
 *
 *   { type: "spawn",      seq, entity }       // a full entity record appeared
 *   { type: "delta",      seq, entityId, changes }  // partial record update
 *   { type: "despawn",    seq, entityId }     // entity removed
 *   { type: "aggregates", seq, aggregates }   // fleet aggregates update
 *
 * A connect-time snapshot (assembled by index.js, not emitted here) is:
 *
 *   { type: "snapshot",   seq, entities: [ ...full records... ], aggregates }
 *
 * `changes` in a delta is always a partial of the entity record. Lifecycle
 * deltas additionally carry a `signal` field inside `changes` for one-shot
 * client cues that are NOT part of persistent state:
 *   changes.signal === "tool_start" | "tool_end" | "error" | "waiting" | "prompt"
 * Persistent fields (status, currentTool, currentToolFamily, errorCount, ...)
 * are the source of truth; `signal` is a transient hint the client may flash.
 *
 * Every spawn/delta/despawn/aggregates message carries a unique, monotonic
 * `seq`. The ring buffer stores spawn/delta/despawn (entity) messages so a
 * reconnecting client can replay only what it missed.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { toolFamily, toolActionLabel } from './toolFamilies.js';
import { TUNING } from './city.js';

// ── Tunables ────────────────────────────────────────────────────────────────
const RING_BUFFER_SIZE = 500; // recent entity deltas retained for resync
const RECENT_EVENTS_CAP = 10; // per-entity generic event ring buffer
const RECENT_TOOL_ACTIONS_CAP = 8; // per-session Claude-style action lines
const THROUGHPUT_WINDOW_MS = 10_000; // rolling window for tool-start throughput
const ERROR_WINDOW_MS = 30_000; // rolling window for error-rate
const SESSION_TITLE_MAX = 56;
// Claude Code writes its AI-generated tab title into the session transcript as
// `{"type":"ai-title","aiTitle":"…"}` lines (the latest wins). We read it back
// to use as the session's display title. Re-checking is throttled per session
// and gated on the file's mtime so it stays cheap on hot event streams.
const TITLE_REFRESH_MS = 5_000; // min interval between transcript reads once a title is known
const TITLE_TAIL_BYTES = 262_144; // only scan the tail of the transcript for the latest ai-title

function compactText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

function clipTitle(text, max = SESSION_TITLE_MAX) {
  if (typeof text !== 'string') return null;
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

/**
 * Read Claude Code's latest AI tab title from a session transcript file.
 * Scans only the tail of the file (titles are appended and the most recent
 * wins) and returns the trimmed `aiTitle`, or null if none is found / readable.
 * @param {string} transcriptPath
 * @param {number} [knownSize] file size from a prior stat, to skip an fstat
 * @returns {string|null}
 */
function readLastAiTitle(transcriptPath, knownSize) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = typeof knownSize === 'number' ? knownSize : fs.fstatSync(fd).size;
    if (size <= 0) return null;
    const start = Math.max(0, size - TITLE_TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    // If we started mid-file the first line is a partial — drop it.
    if (start > 0 && lines.length) lines.shift();
    let found = null;
    for (const line of lines) {
      if (!line || line.indexOf('ai-title') === -1) continue; // cheap pre-filter
      try {
        const o = JSON.parse(line);
        if (o && o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
          found = o.aiTitle.trim(); // keep scanning; last one wins
        }
      } catch {
        // ignore partial / malformed lines
      }
    }
    return found;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }
}

/**
 * Sum assistant `output_tokens` appended to a transcript since a byte offset.
 * Reads only [fromOffset, size) — never the whole file. Parses complete JSONL
 * lines; a trailing line with no newline is PARTIAL — excluded, and nextOffset
 * stops before it so it is re-read whole next time. Cheap on hot streams: the
 * caller mtime-gates before calling, and we pre-filter lines before JSON.parse.
 * @param {string} transcriptPath
 * @param {number} fromOffset byte offset of the last consumed boundary
 * @param {number} [knownSize] file size from a prior stat, to skip an fstat
 * @returns {{ tokens: number, nextOffset: number } | null} null on read error
 */
function readOutputTokensSince(transcriptPath, fromOffset, knownSize) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = typeof knownSize === 'number' ? knownSize : fs.fstatSync(fd).size;
    if (size <= fromOffset) return { tokens: 0, nextOffset: fromOffset };
    const len = size - fromOffset;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, fromOffset);
    const text = buf.toString('utf8');
    // Only whole lines (up to the last newline) are safe to parse; a partial
    // trailing line is deferred so we don't advance the cursor past it.
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { tokens: 0, nextOffset: fromOffset };
    const complete = text.slice(0, lastNl);
    // Byte length (not string length) — offsets are bytes and JSONL is UTF-8.
    const nextOffset = fromOffset + Buffer.byteLength(complete, 'utf8') + 1;
    let tokens = 0;
    for (const line of complete.split('\n')) {
      if (!line || line.indexOf('output_tokens') === -1) continue; // cheap pre-filter
      try {
        const o = JSON.parse(line);
        const ot = o && o.type === 'assistant' && o.message && o.message.usage
          ? o.message.usage.output_tokens : undefined;
        if (typeof ot === 'number' && Number.isFinite(ot)) tokens += ot;
      } catch {
        // ignore partial / malformed lines
      }
    }
    return { tokens, nextOffset };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }
}

/**
 * Derive a stable project descriptor from a cwd path.
 * @param {*} cwd
 * @returns {{ key: string, name: string, path: string }}
 */
function deriveProject(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { key: 'unknown', name: 'unknown', path: '' };
  }
  // basename is the human-readable name; full path is the stable key.
  const cleaned = cwd.replace(/[/\\]+$/, ''); // strip trailing slashes
  const name = path.basename(cleaned) || cleaned || 'unknown';
  return { key: cleaned, name, path: cleaned };
}

export class WorldModel extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} entityId -> record */
    this.entities = new Map();
    /** monotonic sequence counter; first emitted seq is 1 */
    this.seq = 0;
    /** ring buffer of { seq, msg } for entity spawn/delta/despawn replay */
    this.ring = [];
    /** rolling event timestamps for aggregate windows */
    this.toolStartTimes = []; // ms timestamps of PreToolUse
    this.errorTimes = []; // ms timestamps of failures
    /** per-session LIFO stacks of in-flight tools (with action text) */
    this.inFlight = new Map(); // sessionId -> [{ toolName, family, action }]
    /** per-session transcript title cache: sessionId -> { lastCheckMs, mtimeMs, title } */
    this.titleCache = new Map();
    /** transcript token cursor: key(sessionId|agentId) -> { offset, mtimeMs, seeded } */
    this.tokenCursor = new Map();
  }

  // ── seq + emit helpers ─────────────────────────────────────────────────────

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  /** Push an entity message (spawn/delta/despawn) into the ring + emit it. */
  emitEntityMessage(msg) {
    this.ring.push({ seq: msg.seq, msg });
    if (this.ring.length > RING_BUFFER_SIZE) {
      this.ring.splice(0, this.ring.length - RING_BUFFER_SIZE);
    }
    this.emit('message', msg);
  }

  emitSpawn(entity) {
    const seq = this.nextSeq();
    this.emitEntityMessage({ type: 'spawn', seq, entity: clone(entity) });
  }

  emitDelta(entityId, changes) {
    const seq = this.nextSeq();
    this.emitEntityMessage({ type: 'delta', seq, entityId, changes: clone(changes) });
    return seq;
  }

  emitDespawn(entityId) {
    const seq = this.nextSeq();
    this.emitEntityMessage({ type: 'despawn', seq, entityId });
  }

  /** Aggregates are NOT stored in the ring buffer (always recomputable). */
  emitAggregates() {
    const seq = this.nextSeq();
    const aggregates = this.computeAggregates();
    this.emit('message', { type: 'aggregates', seq, aggregates });
  }

  // ── snapshot / resync support ───────────────────────────────────────────────

  /** Full snapshot of current world for a fresh / stale connect. */
  snapshot() {
    const seq = this.seq; // current-as-of; do NOT advance
    return {
      type: 'snapshot',
      seq,
      entities: Array.from(this.entities.values()).map(clone),
      aggregates: this.computeAggregates(),
    };
  }

  /**
   * Return buffered entity messages with seq > lastSeq, or null if the
   * requested point has fallen out of the ring (caller should snapshot).
   * @param {number} lastSeq
   * @returns {Array<object>|null}
   */
  deltasSince(lastSeq) {
    if (typeof lastSeq !== 'number' || !Number.isFinite(lastSeq)) return null;
    if (lastSeq >= this.seq) return []; // already current
    if (this.ring.length === 0) return null;
    const oldest = this.ring[0].seq;
    // If the gap predates our buffer we cannot replay reliably.
    if (lastSeq < oldest - 1) return null;
    return this.ring.filter((e) => e.seq > lastSeq).map((e) => e.msg);
  }

  // ── aggregates ──────────────────────────────────────────────────────────────

  computeAggregates() {
    const now = Date.now();
    this.pruneWindows(now);

    let active = 0;
    const byProject = {};
    for (const rec of this.entities.values()) {
      if (rec.status !== 'finished') active += 1;
      const pk = rec.project?.key ?? 'unknown';
      if (!byProject[pk]) {
        byProject[pk] = {
          key: pk,
          name: rec.project?.name ?? 'unknown',
          path: rec.project?.path ?? '',
          count: 0,
          working: 0,
        };
      }
      byProject[pk].count += 1;
      if (rec.status === 'working') byProject[pk].working += 1;
    }

    const toolStarts = this.toolStartTimes.length; // within window
    const errors = this.errorTimes.length; // within window
    const throughput = toolStarts / (THROUGHPUT_WINDOW_MS / 1000); // starts/sec
    const errorRate = toolStarts + errors > 0 ? errors / (toolStarts + errors) : 0;

    return {
      activeCount: active,
      totalCount: this.entities.size,
      throughput, // tool starts per second over the rolling window
      toolStartsWindow: toolStarts,
      errorsWindow: errors,
      errorRate, // 0..1
      spend: null, // OTel not wired; reserved
      projects: Object.values(byProject),
      windowMs: { throughput: THROUGHPUT_WINDOW_MS, error: ERROR_WINDOW_MS },
    };
  }

  pruneWindows(now = Date.now()) {
    const tCut = now - THROUGHPUT_WINDOW_MS;
    while (this.toolStartTimes.length && this.toolStartTimes[0] < tCut) {
      this.toolStartTimes.shift();
    }
    const eCut = now - ERROR_WINDOW_MS;
    while (this.errorTimes.length && this.errorTimes[0] < eCut) {
      this.errorTimes.shift();
    }
  }

  // ── record helpers ──────────────────────────────────────────────────────────

  touch(rec, now = Date.now()) {
    rec.lastSeen = now;
  }

  pushRecentEvent(rec, label) {
    if (!Array.isArray(rec.recentEvents)) rec.recentEvents = [];
    rec.recentEvents.push({ t: Date.now(), e: label });
    if (rec.recentEvents.length > RECENT_EVENTS_CAP) {
      rec.recentEvents.splice(0, rec.recentEvents.length - RECENT_EVENTS_CAP);
    }
  }

  pushRecentToolAction(rec, kind, text, seq = null, now = Date.now()) {
    if (!rec || rec.kind !== 'session') return;
    if (!Array.isArray(rec.recentToolActions)) rec.recentToolActions = [];
    rec.recentToolActions.push({
      t: now,
      kind: kind || 'action',
      text: String(text || ''),
      seq: typeof seq === 'number' ? seq : null,
    });
    if (rec.recentToolActions.length > RECENT_TOOL_ACTIONS_CAP) {
      rec.recentToolActions.splice(0, rec.recentToolActions.length - RECENT_TOOL_ACTIONS_CAP);
    }
  }

  /** Look up the project descriptor for a session (for subagent inheritance). */
  projectForSession(sessionId) {
    const rec = this.entities.get(sessionId);
    return rec?.project ?? { key: 'unknown', name: 'unknown', path: '' };
  }

  // ── the reducer ───────────────────────────────────────────────────────────
  //
  // `apply` dispatches on hook_event_name. Each branch mutates the world and
  // emits the appropriate outbound message(s). Defensive throughout: any field
  // may be missing.

  /**
   * @param {object} event a parsed hook payload
   */
  apply(event) {
    if (!event || typeof event !== 'object') return;
    const name = event.hook_event_name;
    const now = Date.now();

    // Robust orchestrator detection: ANY subagent-context event carries the
    // parent's session_id PLUS an agent_id. If we ever see that, the parent is
    // an orchestrator -> Vader. This does not rely on SubagentStart firing.
    this.maybePromoteOrchestrator(event, now);

    this.dispatch(name, event, now);

    // After the handler has created/updated the session record, sync its title
    // with Claude Code's AI-generated tab title (read from the transcript).
    this.maybeUpdateTitleFromTranscript(event, now);
  }

  /** Dispatch a hook event to its per-event-name handler. */
  dispatch(name, event, now) {
    switch (name) {
      case 'SessionStart':
        return this.onSessionStart(event, now);
      case 'SessionEnd':
        return this.onSessionEnd(event, now);
      case 'UserPromptSubmit':
        return this.onUserPromptSubmit(event, now);
      case 'PreToolUse':
        return this.onPreToolUse(event, now);
      case 'PostToolUse':
        return this.onPostToolUse(event, now, false);
      case 'PostToolUseFailure':
        return this.onPostToolUse(event, now, true);
      case 'SubagentStart':
        return this.onSubagentStart(event, now);
      case 'SubagentStop':
        return this.onSubagentStop(event, now);
      case 'Notification':
        return this.onNotification(event, now);
      case 'Stop':
        return this.onStop(event, now);
      default:
        // Unknown event: best-effort liveness touch if we can identify an entity.
        return this.onUnknown(event, now);
    }
  }

  /**
   * If an event came from a subagent context (has both session_id and a
   * distinct agent_id), mark the parent session as a sticky orchestrator so it
   * renders as Vader. Idempotent; only emits a delta on the first promotion.
   */
  maybePromoteOrchestrator(event, now) {
    const parentId = event.session_id;
    const agentId = event.agent_id;
    if (!parentId || !agentId || parentId === agentId) return;
    const parent = this.entities.get(parentId);
    if (!parent || parent.kind !== 'session' || parent.isOrchestrator) return;
    parent.isOrchestrator = true;
    this.touch(parent, now);
    this.emitDelta(parentId, { isOrchestrator: true, signal: 'orchestrate' });
  }

  // Ensure a session record exists; create a minimal one if first-seen mid-stream.
  ensureSession(event, now) {
    const id = event.session_id;
    if (!id) return null;
    let rec = this.entities.get(id);
    if (!rec) {
      rec = this.makeSessionRecord(event, now);
      this.entities.set(id, rec);
      this.touch(rec, now);
      this.emitSpawn(rec);
    } else {
      // Keep Claude's session title in sync whenever hooks include it.
      if (typeof event.session_title === 'string' && event.session_title.trim()) {
        const nextTitle = event.session_title.trim();
        if (rec.title !== nextTitle) {
          rec.title = nextTitle;
          this.touch(rec, now);
          this.emitDelta(id, { title: nextTitle });
        }
      }
    }
    return rec;
  }

  /**
   * Sync a session's title with Claude Code's AI-generated tab title, read from
   * the session transcript (`transcript_path` is present on every hook event).
   * This is the only display-title source: until it arrives a session shows its
   * project-name / short-id fallback, never the raw user prompt.
   *
   * Cheap on hot streams: re-reads are gated on the transcript's mtime and, once
   * a title is known, throttled to at most once per TITLE_REFRESH_MS per session.
   */
  maybeUpdateTitleFromTranscript(event, now) {
    const id = event && event.session_id;
    const tpath = event && event.transcript_path;
    if (!id || typeof tpath !== 'string' || !tpath) return;
    const rec = this.entities.get(id);
    if (!rec || rec.kind !== 'session') return;

    let cache = this.titleCache.get(id);
    if (!cache) {
      cache = { lastCheckMs: 0, mtimeMs: -1, title: null };
      this.titleCache.set(id, cache);
    }
    // Once we have a title, don't re-read more than once per refresh window.
    if (cache.title && now - cache.lastCheckMs < TITLE_REFRESH_MS) return;
    cache.lastCheckMs = now;

    let stat;
    try {
      stat = fs.statSync(tpath);
    } catch {
      return; // transcript not readable (yet)
    }
    if (stat.mtimeMs === cache.mtimeMs) return; // unchanged since last read
    cache.mtimeMs = stat.mtimeMs;

    const aiTitle = readLastAiTitle(tpath, stat.size);
    if (!aiTitle) return;
    cache.title = aiTitle;

    const next = clipTitle(compactText(aiTitle));
    if (next && next !== rec.title) {
      rec.title = next;
      rec.titleSource = 'ai';
      this.touch(rec, now);
      this.emitDelta(id, { title: next });
    }
  }

  /**
   * Output-token work amount for a just-completed tool call. Reads the relevant
   * transcript incrementally from this session/agent's cursor and converts the
   * newly-flushed `output_tokens` into construction work units. Always >= 0.
   *
   * Tool calls remain the BINDING trigger (they always place the worker); this
   * only governs how MUCH the building rises. A call before the assistant turn
   * has flushed legitimately returns 0 (bind only) — those tokens land on the
   * next tool call. Subagent work reads `agent_transcript_path` (keyed by
   * agent_id) but is still attributed to the parent session's lot.
   *
   * First sighting SEEDS the cursor to EOF and returns 0, so an already-long
   * transcript isn't dumped as one giant delta.
   * @returns {number} work units (output_tokens / OUTPUT_TOKENS_PER_WORK)
   */
  tokenDeltaFor(rec, event) {
    const isSub = event.agent_id && event.agent_id !== event.session_id;
    const tpath = isSub ? event.agent_transcript_path : event.transcript_path;
    const key = isSub ? event.agent_id : event.session_id;
    if (typeof tpath !== 'string' || !tpath) return 0;

    let stat;
    try { stat = fs.statSync(tpath); } catch { return 0; } // not readable yet → retry next tool

    let cur = this.tokenCursor.get(key);
    if (!cur) {
      // Seed to EOF: only tokens produced AFTER the server first sees this
      // session/agent count — never the historical transcript.
      this.tokenCursor.set(key, { offset: stat.size, mtimeMs: stat.mtimeMs, seeded: true });
      return 0;
    }
    if (stat.mtimeMs === cur.mtimeMs) return 0;        // unchanged → cheap exit, no read
    if (stat.size < cur.offset) cur.offset = 0;        // truncation/rotation → re-scan from start

    const r = readOutputTokensSince(tpath, cur.offset, stat.size);
    if (!r) return 0;                                  // read error → leave cursor, retry next tool
    cur.offset = r.nextOffset;
    cur.mtimeMs = stat.mtimeMs;
    return r.tokens / TUNING.OUTPUT_TOKENS_PER_WORK;
  }

  makeSessionRecord(event, now) {
    return {
      id: event.session_id,
      kind: 'session',
      agentType: typeof event.agent_type === 'string' ? event.agent_type : null,
      parentSessionId: null,
      // Sticky: set true the first time this session spawns a subagent. Drives
      // the Darth Vader sprite. Persisted on the record so it survives snapshots
      // / reconnects even after the subagent has despawned.
      isOrchestrator: false,
      project: deriveProject(event.cwd),
      status: 'idle',
      title: typeof event.session_title === 'string' && event.session_title.trim()
        ? event.session_title.trim()
        : null,
      currentTool: null,
      currentToolFamily: null,
      // Human-readable "<Verb> <target>" phrase for the floating sprite label;
      // set on PreToolUse, cleared/restored on PostToolUse + Stop.
      currentAction: null,
      // The city building this session is bound to (set by CityModel via
      // setSessionBuilding once the session does its first work). The client
      // uses this to place the session's worker at its construction site.
      buildingLotId: null,
      buildingDistrictKey: null,
      lastSeen: now,
      toolCount: 0,
      errorCount: 0,
      dimmed: false,
      // True between UserPromptSubmit and Stop: the session is mid-turn, so it's
      // actively thinking/working even when no hook is firing (no event is sent
      // during model reasoning). The reaper keeps mid-turn crews on-site.
      turnActive: false,
      recentEvents: [],
      recentToolActions: [],
    };
  }

  /**
   * Tag a session with the city lot it is building (called from index.js when
   * the CityModel emits an 'assign'). Emits a delta so the client can move the
   * worker to its site. No-op for unknown / non-session ids.
   */
  setSessionBuilding(sessionId, districtKey, lotId) {
    const rec = this.entities.get(sessionId);
    if (!rec || rec.kind !== 'session') return;
    if (rec.buildingLotId === lotId && rec.buildingDistrictKey === districtKey) return;
    rec.buildingLotId = lotId;
    rec.buildingDistrictKey = districtKey;
    this.emitDelta(sessionId, { buildingLotId: lotId, buildingDistrictKey: districtKey });
  }

  onSessionStart(event, now) {
    const id = event.session_id;
    if (!id) return;
    let rec = this.entities.get(id);
    if (!rec) {
      rec = this.makeSessionRecord(event, now);
      // Carry SessionStart-specific metadata where present.
      if (typeof event.model === 'string') rec.model = event.model;
      if (typeof event.source === 'string') rec.source = event.source;
      if (typeof event.session_title === 'string' && event.session_title.trim()) {
        rec.title = event.session_title.trim();
      }
      this.entities.set(id, rec);
      this.touch(rec, now);
      this.pushRecentEvent(rec, 'SessionStart');
      this.emitSpawn(rec);
    } else {
      // Refresh existing record (e.g. resume). Settle to idle.
      rec.status = 'idle';
      rec.dimmed = false;
      if (typeof event.cwd === 'string') rec.project = deriveProject(event.cwd);
      if (typeof event.model === 'string') rec.model = event.model;
      if (typeof event.session_title === 'string' && event.session_title.trim()) {
        rec.title = event.session_title.trim();
      }
      this.touch(rec, now);
      this.pushRecentEvent(rec, 'SessionStart');
      this.emitDelta(id, {
        status: 'idle',
        dimmed: false,
        project: rec.project,
        title: rec.title ?? null,
        signal: 'spawn',
      });
    }
  }

  onUserPromptSubmit(event, now) {
    const rec = this.ensureSession(event, now);
    if (!rec) return;
    this.touch(rec, now);
    rec.dimmed = false;
    // The turn begins: Claude starts thinking. No hook fires during reasoning,
    // so we mark the session working ('thinking') and turnActive so the reaper
    // keeps the crew on-site through the whole turn, not just during tool calls.
    rec.turnActive = true;
    rec.status = 'thinking';
    this.pushRecentEvent(rec, 'UserPromptSubmit');
    // Intentionally do NOT derive a title from the raw prompt text. We wait for
    // Claude Code's AI-generated tab title (read from the transcript) and only
    // surface that. Until it arrives the session shows its project-name / short
    // -id fallback rather than the user's prompt.
    this.emitDelta(rec.id, {
      status: 'thinking',
      dimmed: false,
      signal: 'prompt',
    });
  }

  onPreToolUse(event, now) {
    const rec = this.ensureSession(event, now);
    if (!rec) return;
    const toolName = typeof event.tool_name === 'string' ? event.tool_name : 'unknown';
    const family = toolFamily(toolName);
    const action = toolActionLabel(toolName, event.tool_input);

    // Push onto the per-session LIFO stack of in-flight tools. Carry the action
    // label so it can be restored when a nested tool completes (LIFO resume).
    const stack = this.inFlight.get(rec.id) ?? [];
    stack.push({ toolName, family, action });
    this.inFlight.set(rec.id, stack);

    rec.status = 'working';
    rec.currentTool = toolName;
    rec.currentToolFamily = family;
    rec.currentAction = action;
    rec.toolCount += 1;
    rec.dimmed = false;
    this.touch(rec, now);
    this.toolStartTimes.push(now);
    this.pushRecentEvent(rec, `PreToolUse:${toolName}`);

    const seq = this.emitDelta(rec.id, {
      status: 'working',
      currentTool: toolName,
      currentToolFamily: family,
      currentAction: action,
      toolCount: rec.toolCount,
      dimmed: false,
      signal: 'tool_start',
    });
    this.pushRecentToolAction(rec, 'action', action, seq, now);
  }

  onPostToolUse(event, now, isFailure) {
    const rec = this.ensureSession(event, now);
    if (!rec) return;

    // Pop the matching in-flight tool (LIFO; no tool_use_id available).
    const stack = this.inFlight.get(rec.id) ?? [];
    const finished = stack.pop() || null;
    if (stack.length === 0) this.inFlight.delete(rec.id);
    else this.inFlight.set(rec.id, stack);

    const changes = {};
    if (isFailure) {
      rec.errorCount += 1;
      this.errorTimes.push(now);
      changes.errorCount = rec.errorCount;
      changes.signal = 'error';
      this.pushRecentEvent(rec, `PostToolUseFailure:${event.tool_name ?? '?'}`);
    } else {
      changes.signal = 'tool_end';
      this.pushRecentEvent(rec, `PostToolUse:${event.tool_name ?? '?'}`);
    }

    if (stack.length === 0) {
      // No more in-flight tools. If the turn is still live the agent is back to
      // thinking (model reasoning fires no hook), so keep the crew visibly busy
      // rather than idle; only a Stop returns it to true idle.
      const next = rec.turnActive ? 'thinking' : 'idle';
      rec.status = next;
      rec.currentTool = null;
      rec.currentToolFamily = null;
      rec.currentAction = null;
      changes.status = next;
      changes.currentTool = null;
      changes.currentToolFamily = null;
      changes.currentAction = null;
    } else {
      // Resume showing the tool now at the top of the stack.
      const top = stack[stack.length - 1];
      rec.status = 'working';
      rec.currentTool = top.toolName;
      rec.currentToolFamily = top.family;
      rec.currentAction = top.action;
      changes.status = 'working';
      changes.currentTool = top.toolName;
      changes.currentToolFamily = top.family;
      changes.currentAction = top.action;
    }

    rec.dimmed = false;
    changes.dimmed = false;
    this.touch(rec, now);
    const seq = this.emitDelta(rec.id, changes);
    if (isFailure) {
      const failedText = finished?.action ? `Tool failed: ${finished.action}` : 'Tool failed';
      this.pushRecentToolAction(rec, 'error', failedText, seq, now);
    } else {
      const doneText = finished?.action ? `Done: ${finished.action}` : 'Tool finished';
      this.pushRecentToolAction(rec, 'done', doneText, seq, now);
    }

    // Feed the persistent city layer. The tool call BINDS the session to its
    // lot and places the worker; how MUCH it builds is the model's output_tokens
    // produced since the last deposit (0 ⇒ bind only). Failures become incidents
    // and carry no amount. Consumed in index.js.
    const amount = isFailure ? 0 : this.tokenDeltaFor(rec, event);
    this.emit('work', {
      project: rec.project,
      family: finished?.family ?? null,
      sessionId: rec.id,
      isFailure,
      amount,
    });
  }

  onSubagentStart(event, now) {
    const id = event.agent_id;
    if (!id) return;
    const parentId = event.session_id ?? null;
    // Ensure parent session exists so project inheritance works.
    if (parentId) this.ensureSession(event, now);

    // Promote the parent session to orchestrator (sticky) -> renders as Vader.
    if (parentId) {
      const parent = this.entities.get(parentId);
      if (parent && parent.kind === 'session' && !parent.isOrchestrator) {
        parent.isOrchestrator = true;
        this.touch(parent, now);
        this.emitDelta(parentId, { isOrchestrator: true, signal: 'orchestrate' });
      }
    }

    let rec = this.entities.get(id);
    const project = parentId ? this.projectForSession(parentId) : deriveProject(event.cwd);
    if (!rec) {
      rec = {
        id,
        kind: 'subagent',
        agentType: typeof event.agent_type === 'string' ? event.agent_type : 'generic',
        parentSessionId: parentId,
        project,
        status: 'spawning',
        currentTool: null,
        currentToolFamily: null,
        lastSeen: now,
        toolCount: 0,
        errorCount: 0,
        dimmed: false,
        recentEvents: [],
      };
      if (typeof event.agent_transcript_path === 'string') {
        rec.agentTranscriptPath = event.agent_transcript_path;
      }
      this.entities.set(id, rec);
      this.touch(rec, now);
      this.pushRecentEvent(rec, 'SubagentStart');
      this.emitSpawn(rec);
      // Settle spawning -> idle so the client plays roll-in then idle.
      rec.status = 'idle';
      this.emitDelta(id, { status: 'idle' });
    } else {
      rec.status = 'idle';
      rec.dimmed = false;
      this.touch(rec, now);
      this.emitDelta(id, { status: 'idle', dimmed: false });
    }
  }

  onSubagentStop(event, now) {
    const id = event.agent_id;
    if (!id) return;
    const rec = this.entities.get(id);
    if (!rec) return;
    // Subagents are removed on stop (droid rolls off).
    this.entities.delete(id);
    this.inFlight.delete(id);
    this.emitDespawn(id);
  }

  onNotification(event, now) {
    const rec = this.ensureSession(event, now);
    if (!rec) return;
    rec.dimmed = false;
    this.touch(rec, now);
    this.pushRecentEvent(rec, 'Notification');
    // Transient "waiting" indication; persistent status unchanged.
    this.emitDelta(rec.id, { dimmed: false, signal: 'waiting' });
  }

  onStop(event, now) {
    const rec = this.ensureSession(event, now);
    if (!rec) return;
    // Stop returns the session to idle but does NOT despawn it. The turn is
    // over (Claude is waiting for the user again), so the crew may now age out.
    this.inFlight.delete(rec.id);
    rec.turnActive = false;
    rec.status = 'idle';
    rec.currentTool = null;
    rec.currentToolFamily = null;
    rec.currentAction = null;
    rec.dimmed = false;
    this.touch(rec, now);
    this.pushRecentEvent(rec, 'Stop');
    const seq = this.emitDelta(rec.id, {
      status: 'idle',
      currentTool: null,
      currentToolFamily: null,
      currentAction: null,
      dimmed: false,
      signal: 'tool_end',
    });
    this.pushRecentToolAction(rec, 'done', 'Stopped', seq, now);
  }

  onSessionEnd(event, now) {
    const id = event.session_id;
    if (!id) return;
    const rec = this.entities.get(id);
    if (!rec) return;
    // Despawn the session and all of its subagents.
    this.entities.delete(id);
    this.inFlight.delete(id);
    this.tokenCursor.delete(id);
    this.emitDespawn(id);
    for (const [otherId, other] of this.entities) {
      if (other.kind === 'subagent' && other.parentSessionId === id) {
        this.entities.delete(otherId);
        this.inFlight.delete(otherId);
        this.tokenCursor.delete(otherId);
        this.emitDespawn(otherId);
      }
    }
  }

  onUnknown(event, now) {
    // Best-effort: keep a known entity alive without changing its state.
    const id = event.agent_id ?? event.session_id;
    if (!id) return;
    const rec = this.entities.get(id);
    if (!rec) return;
    this.touch(rec, now);
    this.pushRecentEvent(rec, `?${event.hook_event_name ?? 'unknown'}`);
  }
}

/** Shallow-deep clone safe for our plain-data records (no functions/cycles). */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
