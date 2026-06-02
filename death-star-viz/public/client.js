/* ===========================================================================
   client.js — WebSocket consumer, reconnect/backoff, demo-mode fallback,
   and HUD/legend/per-session dialogue wiring. Starts the render loop.

   Server contract (ws://localhost:8080/stream):
     -> on open: send { lastSeq }
     <- snapshot | spawn | delta | despawn | aggregates  (each carries seq)
   =========================================================================== */
(function () {
  'use strict';
  const DSV = window.DSV;
  const R = DSV.render;

  // ---- DOM refs -----------------------------------------------------------
  const elStatus = document.getElementById('status');
  const elSessions = document.getElementById('hud-sessions');
  const elDroids = document.getElementById('hud-droids');
  const elThru = document.getElementById('hud-thru');
  const elErr = document.getElementById('hud-err');
  const elLegend = document.getElementById('legend-list');
  const elSessionDialogs = document.getElementById('session-dialogs');

  // ---- State --------------------------------------------------------------
  let lastSeq = null;
  let ws = null;
  let backoff = 500;
  const BACKOFF_MAX = 8000;
  let demoMode = false;
  let mock = null;
  let connectAttempts = 0;
  let everConnected = false;
  const entityKinds = new Map(); // entityId -> session | subagent
  const sessionDialogs = new Map(); // sessionId -> dialog state

  const params = new URLSearchParams(location.search);
  const FORCE_DEMO = params.get('demo') === '1';
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/stream';
  const DIALOG_LINES_CAP = 12;

  // ---- Status banner ------------------------------------------------------
  function setStatus(text, cls) {
    elStatus.textContent = text;
    elStatus.className = 'hud status ' + (cls || '');
  }

  // ---- Message dispatch (shared by live + demo) ---------------------------
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.seq === 'number') {
      if (lastSeq == null || msg.seq > lastSeq) lastSeq = msg.seq;
    }
    switch (msg.type) {
      case 'snapshot':
        {
          const entities = Array.isArray(msg.entities) ? msg.entities : [];
          R.applySnapshot(entities);
          syncSessionDialogsFromSnapshot(entities);
        }
        if (msg.aggregates) R.setAggregates(msg.aggregates);
        break;
      case 'spawn':
        if (msg.entity) {
          if (msg.entity.id && msg.entity.kind) entityKinds.set(msg.entity.id, msg.entity.kind);
          R.spawnSprite(msg.entity, true); // animate walk-on
          if (msg.entity.kind === 'session') {
            ensureSessionDialog(msg.entity.id, msg.entity);
            renderSessionDialogs();
          }
        }
        break;
      case 'delta':
        if (msg.entityId && msg.changes) {
          // merge changes into a minimal entity record then update sprite
          const ent = Object.assign({ id: msg.entityId }, msg.changes);
          // ensure we keep kind/project if the sprite already exists
          const existing = R.sprites.get(msg.entityId);
          if (existing) {
            ent.kind = ent.kind || existing.kind;
          }
          R.updateSprite(ent);
          applyDialogDelta(msg.entityId, msg.changes, msg.seq);
        }
        break;
      case 'despawn':
        if (msg.entityId) {
          R.removeSprite(msg.entityId);
          removeEntity(msg.entityId);
        }
        break;
      case 'aggregates':
        if (msg.aggregates) R.setAggregates(msg.aggregates);
        break;
      default:
        // tolerate unknown/typed events defensively
        if (msg.entity) {
          if (msg.entity.id && msg.entity.kind) entityKinds.set(msg.entity.id, msg.entity.kind);
          R.spawnSprite(msg.entity, true);
          if (msg.entity.kind === 'session') {
            ensureSessionDialog(msg.entity.id, msg.entity);
            renderSessionDialogs();
          }
        } else if (msg.entityId && msg.changes) {
          R.updateSprite(Object.assign({ id: msg.entityId }, msg.changes));
          applyDialogDelta(msg.entityId, msg.changes, msg.seq);
        }
        break;
    }
  }

  // ---- WebSocket lifecycle ------------------------------------------------
  function connect() {
    if (FORCE_DEMO) { startDemo('?demo=1'); return; }
    connectAttempts++;
    setStatus('CONNECTING…', 'connecting');
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      everConnected = true;
      backoff = 500;
      connectAttempts = 0;
      setStatus('LIVE', 'live');
      // if we had fallen back to demo, stop it now that a real server appeared
      if (demoMode) { stopDemo(); }
      const hello = {};
      if (lastSeq != null) hello.lastSeq = lastSeq;
      try { ws.send(JSON.stringify(hello)); } catch (_) {}
    };

    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (_) { return; }
      // server may batch an array of messages
      if (Array.isArray(data)) data.forEach(handleMessage);
      else handleMessage(data);
    };

    ws.onclose = () => {
      if (demoMode) return; // demo already running
      scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch (_) {}
    };
  }

  function scheduleReconnect() {
    setStatus('CONNECTING… (retry)', 'connecting');
    // After a few failed attempts and never having connected, fall back to
    // demo mode so the user sees something rather than an empty station.
    if (!everConnected && connectAttempts >= 3 && !demoMode) {
      startDemo('server unreachable');
      // keep trying the real server quietly in the background
    }
    setTimeout(() => {
      if (demoMode && everConnected) return;
      connect();
    }, backoff);
    backoff = Math.min(BACKOFF_MAX, Math.round(backoff * 1.7));
  }

  // ---- Demo mode ----------------------------------------------------------
  function startDemo(why) {
    if (demoMode) return;
    demoMode = true;
    setStatus('DEMO MODE — ' + why, 'demo');
    mock = DSV.makeMockServer(handleMessage);
  }
  function stopDemo() {
    if (!demoMode) return;
    demoMode = false;
    if (mock) { mock.stop(); mock = null; }
    // clear demo world; a real snapshot will repopulate
    R.applySnapshot([]);
    lastSeq = null;
  }
  // ---- HUD / legend / per-session dialogues ------------------------------
  function renderLegend() {
    // One legend row per live window/session, in floor order.
    const items = [...DSV.sessions.values()].sort((a, b) => a.deck - b.deck);
    if (items.length === 0) { elLegend.innerHTML = '<div class="legend-deck">— none —</div>'; return; }
    elLegend.innerHTML = items.map((s) =>
      '<div class="legend-item">' +
        '<span class="legend-swatch" style="background:' + s.accent + '"></span>' +
        '<span class="legend-name">' + esc(s.name) + '</span>' +
        '<span class="legend-deck">L' + (s.deck + 1) + '</span>' +
      '</div>'
    ).join('');
  }

  function ensureSessionDialog(sessionId, seed) {
    if (!sessionId) return null;
    let dlg = sessionDialogs.get(sessionId);
    if (!dlg) {
      dlg = {
        id: sessionId,
        title: sessionId,
        status: 'idle',
        currentAction: null,
        lines: [],
        updatedAt: Date.now(),
        lastLineKey: '',
      };
      sessionDialogs.set(sessionId, dlg);
    }
    if (seed) {
      if (typeof seed.title === 'string' && seed.title.trim()) dlg.title = seed.title.trim();
      if (typeof seed.status === 'string' && seed.status.trim()) dlg.status = seed.status;
      if (typeof seed.currentAction === 'string' && seed.currentAction.trim()) dlg.currentAction = seed.currentAction;
      if (Array.isArray(seed.recentToolActions) && dlg.lines.length === 0) {
        const seedLines = seed.recentToolActions.slice(-DIALOG_LINES_CAP).reverse();
        for (const ln of seedLines) {
          if (!ln || typeof ln !== 'object') continue;
          dlg.lines.push({
            seq: typeof ln.seq === 'number' ? ln.seq : '',
            kind: typeof ln.kind === 'string' ? ln.kind : 'action',
            text: typeof ln.text === 'string' ? ln.text : '',
          });
        }
      }
    }
    return dlg;
  }

  function dialogClassName(dlg) {
    const head = dlg.lines[0];
    if (head && head.kind === 'error') return 'session-dialog is-error';
    if (dlg.status === 'working') return 'session-dialog is-working';
    return 'session-dialog is-idle';
  }

  function appendDialogLine(sessionId, kind, text, seq) {
    const dlg = ensureSessionDialog(sessionId);
    if (!dlg || !text) return;
    const safeText = String(text);
    const key = String(seq || '') + '|' + kind + '|' + safeText;
    if (dlg.lastLineKey === key) return;
    dlg.lastLineKey = key;
    dlg.lines.unshift({
      seq: typeof seq === 'number' ? seq : '',
      kind: kind || 'action',
      text: safeText,
    });
    if (dlg.lines.length > DIALOG_LINES_CAP) dlg.lines.length = DIALOG_LINES_CAP;
    dlg.updatedAt = Date.now();
  }

  function syncSessionDialogsFromSnapshot(entities) {
    entityKinds.clear();
    const seenSessions = new Set();
    for (const ent of entities) {
      if (!ent || !ent.id) continue;
      if (ent.kind) entityKinds.set(ent.id, ent.kind);
      if (ent.kind !== 'session') continue;
      ensureSessionDialog(ent.id, ent);
      seenSessions.add(ent.id);
    }
    for (const sessionId of [...sessionDialogs.keys()]) {
      if (!seenSessions.has(sessionId)) sessionDialogs.delete(sessionId);
    }
    renderSessionDialogs();
  }

  function applyDialogDelta(entityId, changes, seq) {
    if (!entityId || !changes || typeof changes !== 'object') return;
    if (typeof changes.kind === 'string') entityKinds.set(entityId, changes.kind);
    const knownKind = entityKinds.get(entityId) || (sessionDialogs.has(entityId) ? 'session' : null);
    if (knownKind !== 'session') return;

    const dlg = ensureSessionDialog(entityId, changes);
    if (!dlg) return;
    if (typeof changes.status === 'string') dlg.status = changes.status;
    const priorAction = dlg.currentAction;
    if ('currentAction' in changes) dlg.currentAction = changes.currentAction || null;

    const signal = typeof changes.signal === 'string' ? changes.signal : '';
    if (signal === 'tool_start') {
      appendDialogLine(entityId, 'action', dlg.currentAction || familyActionFallback(changes.currentToolFamily), seq);
    } else if (signal === 'tool_end') {
      const completedAction = priorAction || dlg.currentAction;
      appendDialogLine(entityId, 'done', completedAction ? ('Done: ' + completedAction) : 'Tool finished', seq);
    } else if (signal === 'error') {
      const failedAction = priorAction || dlg.currentAction;
      const msg = failedAction ? ('Tool failed: ' + failedAction) : 'Tool failed';
      appendDialogLine(entityId, 'error', msg, seq);
    }

    if (signal === 'tool_start' || signal === 'tool_end' || signal === 'error') {
      dlg.updatedAt = Date.now();
      renderSessionDialogs();
    } else if (typeof changes.status === 'string' || ('title' in changes)) {
      dlg.updatedAt = Date.now();
      renderSessionDialogs();
    }
  }

  function familyActionFallback(family) {
    switch (family) {
      case 'exec': return 'Running command';
      case 'read': return 'Reading files';
      case 'edit': return 'Editing files';
      case 'scan': return 'Searching code';
      case 'delegate': return 'Delegating task';
      default: return 'Working';
    }
  }

  function removeEntity(entityId) {
    const kind = entityKinds.get(entityId);
    entityKinds.delete(entityId);
    if (kind === 'session' || sessionDialogs.has(entityId)) {
      sessionDialogs.delete(entityId);
      renderSessionDialogs();
    }
  }

  function renderSessionDialogs() {
    const dialogs = [...sessionDialogs.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    if (dialogs.length === 0) {
      elSessionDialogs.innerHTML = '';
      return;
    }
    elSessionDialogs.innerHTML = dialogs.map((dlg) => {
      const title = dlg.title || dlg.id;
      const linesArr = dlg.lines.length ? [...dlg.lines].reverse() : [{ kind: 'idle', text: 'Standing by', seq: '' }];
      const lines = linesArr.map((line) => {
        const kindClass = line.kind === 'error' ? 'd-error' : '';
        const seqText = line.seq ? ('#' + line.seq) : '•';
        return '<div class="dialog-line">' +
          '<span class="d-seq">' + seqText + '</span>' +
          '<span class="' + kindClass + '">' + esc(line.text) + '</span>' +
        '</div>';
      }).join('');
      return '<div class="' + dialogClassName(dlg) + '">' +
        '<div class="session-dialog-header">' +
          '<span class="session-dialog-title">' + esc(title) + '</span>' +
        '</div>' +
        '<div class="session-dialog-lines">' + lines + '</div>' +
      '</div>';
    }).join('');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function refreshHud() {
    const c = R.counts();
    elSessions.textContent = c.sessions;
    elDroids.textContent = c.droids;
    elThru.textContent = c.throughput || 0;
    const pct = Math.round((c.errorRate || 0) * 100);
    elErr.textContent = pct + '%';
    elThru.className = 'hud-v' + (c.throughput > 0 ? ' hot' : '');
    elErr.className = 'hud-v' + (pct > 20 ? ' alert' : '');
    renderLegend();
  }

  // No interactivity: no keyboard handlers, no on-screen controls. Demo mode is
  // available only via the ?demo=1 URL param. The HUD/legend/dialog windows are
  // passive readouts and are always visible.

  // ---- Boot ---------------------------------------------------------------
  // Start the render loop first (so the station shows immediately, even while
  // CONNECTING…), then connect / demo.
  R.start();
  setStatus('CONNECTING…', 'connecting');
  connect();
  setInterval(refreshHud, 400);
  refreshHud();
})();
