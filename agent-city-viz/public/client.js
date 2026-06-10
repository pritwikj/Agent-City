/* ===========================================================================
   client.js — WebSocket consumer, reconnect/backoff, demo-mode fallback,
   HUD/districts wiring. Starts the render loop.

   Server contract (ws://localhost:8080/stream):
     -> on open: send { lastSeq }
     <- snapshot | spawn | delta | despawn | aggregates   (entity stream)
     <- city | cityDelta                                  (persistent city)
   City messages are NOT replayed from the resync ring — the server sends a
   full city snapshot on every handshake.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const R = C.render;

  // ---- DOM refs -----------------------------------------------------------
  const elStatus = document.getElementById('status');
  const elPop = document.getElementById('hud-pop');
  const elCrews = document.getElementById('hud-crews');
  const elRate = document.getElementById('hud-rate');
  const elInc = document.getElementById('hud-inc');
  const elBld = document.getElementById('hud-bld');
  const elDistricts = document.getElementById('district-list');

  // ---- State --------------------------------------------------------------
  let lastSeq = null;
  let ws = null;
  let backoff = 500;
  const BACKOFF_MAX = 8000;
  let demoMode = false;
  let mock = null;
  let connectAttempts = 0;
  let everConnected = false;

  const params = new URLSearchParams(location.search);
  const FORCE_DEMO = params.get('demo') === '1';
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/stream';

  function setStatus(text, cls) {
    elStatus.textContent = text;
    elStatus.className = 'status ' + (cls || '');
  }

  // ---- Message dispatch (shared by live + demo) ---------------------------
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.seq === 'number') {
      if (lastSeq == null || msg.seq > lastSeq) lastSeq = msg.seq;
    }
    switch (msg.type) {
      case 'snapshot': {
        const entities = Array.isArray(msg.entities) ? msg.entities : [];
        R.applySnapshot(entities);
        if (msg.aggregates) R.setAggregates(msg.aggregates);
        break;
      }
      case 'spawn':
        if (msg.entity) {
          R.spawnSprite(msg.entity, true);
        }
        break;
      case 'delta':
        if (msg.entityId && msg.changes) {
          R.updateSprite(Object.assign({ id: msg.entityId }, msg.changes));
        }
        break;
      case 'despawn':
        if (msg.entityId) {
          R.removeSprite(msg.entityId);
        }
        break;
      case 'aggregates':
        if (msg.aggregates) R.setAggregates(msg.aggregates);
        break;
      case 'city':
        if (msg.city) R.applyCitySnapshot(msg.city);
        break;
      case 'cityDelta':
        R.applyCityDelta(msg);
        break;
      default:
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
      if (demoMode) stopDemo();
      const hello = {};
      if (lastSeq != null) hello.lastSeq = lastSeq;
      try { ws.send(JSON.stringify(hello)); } catch (_) {}
    };

    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (_) { return; }
      if (Array.isArray(data)) data.forEach(handleMessage);
      else handleMessage(data);
    };

    ws.onclose = () => {
      if (demoMode) return;
      scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch (_) {}
    };
  }

  function scheduleReconnect() {
    setStatus('CONNECTING… (retry)', 'connecting');
    if (!everConnected && connectAttempts >= 3 && !demoMode) {
      startDemo('server unreachable');
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
    mock = C.makeMockServer(handleMessage);
  }
  function stopDemo() {
    if (!demoMode) return;
    demoMode = false;
    if (mock) { mock.stop(); mock = null; }
    // clear demo world; the real snapshot + city snapshot will repopulate
    R.applySnapshot([]);
    C.cityReset();
    C.fx.clearEffects();
    lastSeq = null;
  }

  // ---- HUD ------------------------------------------------------------------
  function renderDistricts() {
    const items = [...C.districts.values()].sort((a, b) => a.index - b.index);
    if (items.length === 0) {
      elDistricts.innerHTML = '<div class="district-empty">— awaiting first construction —</div>';
      return;
    }
    elDistricts.innerHTML = items.map((d) => {
      const built = d.completedCount || 0;
      const total = (d.lots || []).length;
      return '<div class="district-item">' +
        '<span class="district-swatch" style="background:' + C.districtColor(d.hue, 60, 52) + '"></span>' +
        '<span class="district-name">' + C.esc(d.name) + '</span>' +
        '<span class="district-count">' + built + '/' + total + '</span>' +
      '</div>';
    }).join('');
  }

  function refreshHud() {
    const c = R.counts();
    elPop.textContent = c.sessions;
    elCrews.textContent = c.crews;
    elRate.textContent = (c.throughput || 0).toFixed ? Number(c.throughput || 0).toFixed(1) : c.throughput;
    const pct = Math.round((c.errorRate || 0) * 100);
    elInc.textContent = pct + '%';
    elBld.textContent = c.city ? c.city.buildings : 0;
    elRate.className = 'stat-v' + (c.throughput > 0 ? ' hot' : '');
    elInc.className = 'stat-v' + (pct > 20 ? ' alert' : '');
    renderDistricts();
  }

  // ---- Boot ---------------------------------------------------------------
  R.start();
  setStatus('CONNECTING…', 'connecting');
  connect();
  setInterval(refreshHud, 400);
  refreshHud();
})();
