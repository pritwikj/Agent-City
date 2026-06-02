/* ===========================================================================
   world.js — configuration, deterministic placement, the local world mirror,
   and the demo/mock event generator.

   No build step, no modules: everything hangs off a global `DSV` namespace.
   =========================================================================== */
(function () {
  'use strict';

  // ---- Logical grid -------------------------------------------------------
  // HIGH-RES pass: 640x640 logical blocks (2x the previous 320 grid) with PX=1,
  // so the offscreen scene buffer stays the same 640px size (no perf/memory hit)
  // but every block is now half as large on screen -> 4x the block count and
  // far finer detail (crisper hull bands, denser greebles, accurate sprites).
  // Station geometry in station.js multiplies its design-time offsets by DETAIL
  // (=2) so the layout is identical, just rendered at double density.
  // The scene is SQUARE so the Death Star renders as a TRUE CIRCLE — render.js
  // scales the whole scene UNIFORMLY (single factor) and pillar/letterboxes the
  // leftover with the space color, so the circle stays circular at any window.
  const GRID_W = 640;
  const GRID_H = 640;
  const PX = 1; // logical pixel size of one block on the offscreen canvas
  const DETAIL = 2; // station-geometry scale factor vs the original 320 design

  // Fixed Imperial palette. Extra intermediate shades added for the richer
  // 4–5-band hull and deck shading — still cohesive, dark, no light/dark adapt.
  const PAL = {
    space:    '#0b0b14',
    // hull shading bands, light upper-left -> dark lower-right (5 bands)
    hullHi:   '#82828e',
    hull2:    '#6f6f7a',
    hullMid:  '#555560',
    hull4:    '#494952',
    hullLo:   '#3c3c45',
    hullEdge: '#2a2a32', // crisp dark rim line
    greeble:  '#7a7a86', // subtle panel/greeble highlight on hull
    interior: '#16161e',
    interior2:'#1c1c26', // slightly lighter interior wash for depth
    deckHi:   '#6a6a76',
    deckMid:  '#5e5e68',
    deckLo:   '#4a4a54',
    deckEdge: '#33333c',
    divider:  '#3a3a44',
    dividerHi:'#4a4a56',
    dish:     '#34343d',
    dish2:    '#2a2a32',
    dishLip:  '#222229', // dark crater lip around the superlaser dish
    dishRim:  '#6a6a78', // lit upper edge of the dish crater
    emitter:  '#8a90a0', // focusing-tower pixels around the dish rim
    lens:     '#cfd6e0',
    beam:     '#7ec850',
    // equatorial trench + hull surface paneling
    trench:   '#1e1e26',
    trenchHi: '#62626e',
    panel:    '#666670', // panel-seam line on the hull shell
    panelLo:  '#3e3e48',
    // interior power conduits
    conduit:  '#2c2c36',
    conduitHi:'#43434e',
    // deck stations + floor furniture (consoles, weapons, sensors, lamps)
    station:  '#34343e',
    stationHi:'#50505c',
    barrel:   '#55596a', // turbolaser barrels / antenna masts
    railing:  '#41414c', // deck-edge safety rails
    grate:    '#3f3f49', // walkway grating tread
    lamp:     '#ffd86a', // lit bulb / beacon / status blip
    lampDim:  '#5a5230', // glow spill around a lamp
    blue:     '#3a6ec8', // energy cores / power-cell caps / tractor beam
    glass:    '#243a44', // dark monitor glass face
    screen:   '#46c4a0',
    screenDim:'#1e4a40',
    bezel:    '#2c2c34',
    alert:    '#c83a3a',
    star:     '#2a2a3a',
    starBright:'#5a5a72',
    spark:    '#ffd24a',
    // high-res detail extras
    panelHi:  '#7c7c88', // bright panel-seam highlight on the lit hull arc
    rivet:    '#8a8a96', // single bright rivet/stud dot
    window:   '#ffe69a', // tiny lit viewport in interior bulkheads
    windowDim:'#5a4f2e', // unlit / dim viewport
    pipe:     '#3a3a46', // structural pipe run
    pipeHi:   '#52525e', // pipe highlight
  };

  // Per-session accent colors. Distinct hues, all readable on dark interior.
  // (One color per window/session — the floor it owns is tinted to match.)
  const ACCENTS = [
    '#c83a3a', // red
    '#3a6ec8', // blue
    '#e8c84a', // gold
    '#46c4a0', // teal
    '#c86ad6', // purple
    '#e88a3a', // orange
    '#7ec850', // green
    '#5ad6e8', // cyan
  ];

  // ---- Deck geometry ------------------------------------------------------
  // Decks are horizontal floor strips. We compute their vertical band and the
  // interior x-range (clipped to the hull circle) once; sprites stand on them.
  // Filled in by station.js after it lays out the station so both share one
  // source of truth.
  const decks = []; // [{ index, floorY, leftX, rightX }]
  const DECK_COUNT = 5;

  // ---- Deterministic hashing (FNV-1a, 32-bit) -----------------------------
  // Stable across runs/reconnects so a project always lands on the same deck +
  // color and a session always gets a stable sprite type.
  function hash32(str) {
    let h = 0x811c9dc5;
    str = String(str == null ? '' : str);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // ---- Project identity ---------------------------------------------------
  // Accept project as a string OR { name, key/path } (defensive per spec).
  function projectKey(project) {
    if (project == null) return 'unknown';
    if (typeof project === 'string') return project;
    return String(project.key || project.path || project.name || 'unknown');
  }
  function projectName(project) {
    if (project == null) return 'unknown';
    if (typeof project === 'string') {
      // Take the last path segment as a friendly name.
      const seg = project.replace(/[\\/]+$/, '').split(/[\\/]/);
      return seg[seg.length - 1] || project;
    }
    return String(project.name || project.key || project.path || 'unknown');
  }

  // Session registry: key -> { key, name, deck, accent }. ONE FLOOR PER
  // WINDOW/SESSION: each Claude Code session claims a distinct deck (subagents
  // share their parent session's floor). The preferred deck comes from the
  // session-id hash (stable across reconnects); if that floor is already taken
  // by another session we linear-probe to the next FREE floor so no two
  // sessions ever share a deck. Only when every floor is occupied (more live
  // sessions than decks) do we fall back to sharing the hashed deck. Decks are
  // released on despawn (freeSession) so floors recycle as windows open/close.
  const sessions = new Map();
  // Per-deck occupancy COUNT (not a boolean): when live sessions outnumber decks
  // two sessions may share a deck, so a deck is only truly free at count 0. This
  // keeps recycling correct — freeing one shared session doesn't vacate the deck.
  const deckSessionCount = new Array(DECK_COUNT).fill(0);

  // Friendly fallback name when no session title is known yet.
  function shortSessionName(key) {
    return key.length > 12 ? key.slice(0, 8) : key;
  }

  // Look up (or create) the floor placement for a session key. `hints.name`
  // (session title, falling back to project name) refreshes the legend label.
  function getSession(sessionField, hints) {
    hints = hints || {};
    const key = String(sessionField == null ? 'unknown' : sessionField);
    let s = sessions.get(key);
    if (s) {
      // Adopt a real name once one arrives (don't overwrite a good one with a fallback).
      if (hints.name && (!s.name || s.name === s.key || s.name === shortSessionName(s.key))) {
        s.name = hints.name;
      }
      return s;
    }
    const h = hash32(key);
    let deck = h % DECK_COUNT;
    if (deckSessionCount[deck] > 0) {
      // hashed floor occupied -> walk to the next free floor deterministically
      let found = -1;
      for (let i = 1; i < DECK_COUNT; i++) {
        const d = (deck + i) % DECK_COUNT;
        if (deckSessionCount[d] === 0) { found = d; break; }
      }
      if (found >= 0) deck = found; // else all floors full -> share hashed deck
    }
    deckSessionCount[deck]++;
    const accent = ACCENTS[(h >>> 8) % ACCENTS.length];
    s = { key, name: hints.name || shortSessionName(key), deck, accent };
    sessions.set(key, s);
    return s;
  }

  // Release a session's floor so a future window can reuse the deck.
  function freeSession(sessionField) {
    const key = String(sessionField == null ? 'unknown' : sessionField);
    const s = sessions.get(key);
    if (!s) return; // already freed -> idempotent, no double-decrement
    deckSessionCount[s.deck] = Math.max(0, deckSessionCount[s.deck] - 1);
    sessions.delete(key);
  }

  // Wipe the whole registry (used when a full snapshot replaces the world).
  function resetSessions() {
    sessions.clear();
    deckSessionCount.fill(0);
  }

  // ---- Slot assignment ----------------------------------------------------
  // Each deck has a row of slots; a session occupies exactly one. Stable per
  // entity for its lifetime; freed on despawn so it can be reused. No two live
  // sprites share a slot.
  const SLOTS_PER_DECK = 9; // beyond this we shrink + show "+N"
  const deckSlots = []; // deckSlots[deckIndex] = array of entityId|null
  function ensureDeckSlots(d) {
    if (!deckSlots[d]) deckSlots[d] = new Array(SLOTS_PER_DECK).fill(null);
    return deckSlots[d];
  }
  function claimSlot(deckIndex, entityId, hashSeed) {
    const slots = ensureDeckSlots(deckIndex);
    // Already claimed?
    for (let i = 0; i < slots.length; i++) if (slots[i] === entityId) return i;
    // Preferred slot from hash, then linear probe — deterministic + collision-free.
    const start = hashSeed % SLOTS_PER_DECK;
    for (let i = 0; i < SLOTS_PER_DECK; i++) {
      const s = (start + i) % SLOTS_PER_DECK;
      if (slots[s] === null) { slots[s] = entityId; return s; }
    }
    return -1; // deck full -> overflow (+N), sprite shares last slot shrunk
  }
  function freeSlot(deckIndex, entityId) {
    const slots = deckSlots[deckIndex];
    if (!slots) return;
    for (let i = 0; i < slots.length; i++) if (slots[i] === entityId) slots[i] = null;
  }
  function deckOverflow(deckIndex) {
    const slots = deckSlots[deckIndex];
    if (!slots) return 0;
    let used = 0;
    for (const s of slots) if (s !== null) used++;
    return Math.max(0, used - SLOTS_PER_DECK);
  }

  // ---- Sprite type selection — THREE EXPLICIT TIERS -----------------------
  //   Tier 1: orchestrator session (has ever spawned a subagent) -> VADER, but
  //           only ONE Vader exists at a time. If Vader is already standing on a
  //           floor, a second orchestrator (on another floor) becomes a red
  //           Imperial Royal Guard instead. Caller passes opts.vaderTaken.
  //   Tier 2: regular session -> officer OR stormtrooper (by session_id hash).
  //           (gunner retired from session selection.)
  //   Tier 3: subagent -> astromech (default) OR kx security droid
  //           (by agent_id hash, falling back to agentType).
  // The orchestrator status is only known once a subagent appears, so render.js
  // tracks a sticky per-session `hasOrchestrated` flag and promotes IN PLACE.
  function chooseSpriteType(entity, opts) {
    opts = opts || {};
    if (entity.kind === 'subagent') {
      // Tier 3: droids. Astromech is the common case; KX is the rest.
      const seed = hash32(entity.id || entity.agentType || 'sub');
      // 50/50 split between astromech and KX security droid; deterministic.
      return (seed % 2 === 0) ? 'kx' : 'astromech';
    }
    // Tier 1: sticky orchestrator promotion -> Vader, or Guard if Vader is taken.
    if (opts.hasOrchestrated) return opts.vaderTaken ? 'guard' : 'vader';
    // Tier 2: regular session -> officer or stormtrooper, by session_id hash.
    const h = hash32(entity.id);
    return (h % 2 === 0) ? 'officer' : 'trooper';
  }

  // ---- Tool family -> console screen color (client-side map) --------------
  function familyScreenColor(family, accent) {
    switch (family) {
      case 'exec':     return '#e8c84a';
      case 'read':     return '#46c4a0';
      case 'edit':     return '#e8703a';
      case 'scan':     return '#5ad6e8';
      case 'delegate': return '#c86ad6';
      default:         return accent || '#46c4a0';
    }
  }

  // =========================================================================
  //  Demo / mock event generator (?demo=1 or WS unreachable)
  //  Produces snapshot/spawn/delta/despawn/aggregates messages on a timer so
  //  every sprite type, tool family, error and despawn path is exercised.
  // =========================================================================
  function makeMockServer(onMessage) {
    let seq = 1;
    const live = new Map(); // id -> {entity}
    let timers = [];
    let stopped = false;

    const PROJECTS = [
      { name: 'death-star-viz', key: '/Users/dev/death-star-viz' },
      { name: 'dawgz-app',      key: '/Users/dev/Dawgz/DawgzApp' },
      { name: 'api-gateway',    key: '/srv/api-gateway' },
      { name: 'pixel-engine',   key: '/Users/dev/pixel-engine' },
    ];
    const AGENT_TYPES = ['general-purpose', 'searcher', 'orchestrator', 'reviewer', null];
    const FAMILIES = ['exec', 'read', 'edit', 'scan', 'delegate', 'generic'];
    // Sample "<Verb> <target>" phrases per family so the floating labels read
    // like real tool activity in demo mode (mirrors server toolActionLabel()).
    const ACTIONS = {
      exec:     ['Running npm test', 'Running git status', 'Running make build', 'Running pytest'],
      read:     ['Reading world.js', 'Reading render.js', 'Reading config.json', 'Reading README.md'],
      edit:     ['Editing sprites.js', 'Editing render.js', 'Editing main.py', 'Editing index.html'],
      scan:     ['Searching "hooks docs"', 'Fetching example.com', 'Searching "canvas api"'],
      delegate: ['Delegating → searcher', 'Delegating → reviewer', 'Delegating → general-purpose'],
      generic:  ['Working · TodoWrite', 'Working · status check'],
    };
    const actionFor = (fam) => pick(ACTIONS[fam] || ['Working']);
    let idc = 0;
    const rnd = (n) => Math.floor(Math.random() * n);
    const pick = (a) => a[rnd(a.length)];

    function emit(msg) {
      if (stopped) return;
      msg.seq = seq++;
      onMessage(msg);
    }

    function newSession(opts) {
      opts = opts || {};
      const id = 'sess-' + (++idc);
      const e = {
        id, kind: 'session',
        agentType: null,
        parentSessionId: null,
        isOrchestrator: false, // flips true the first time it spawns a subagent
        project: opts.project || pick(PROJECTS),
        status: 'spawning',
        currentToolFamily: null,
        currentAction: null,
        errorCount: 0,
      };
      return e;
    }
    function newSubagent(parent) {
      const id = 'agent-' + (++idc);
      return {
        id, kind: 'subagent',
        agentType: pick(AGENT_TYPES),
        parentSessionId: parent.id,
        project: parent.project,
        status: 'working',
        currentToolFamily: pick(FAMILIES),
        errorCount: 0,
      };
    }

    // Initial snapshot: showcase the full three-tier hierarchy already present
    // (no walk-on): two orchestrators on DIFFERENT floors — the first renders as
    // Vader, the second (Vader already taken) as a red Imperial Royal Guard —
    // each with subagents, plus a couple of plain sessions (officer/trooper).
    function initialSnapshot() {
      const ents = [];
      // Tier-1 #1: an orchestrator already running with 2 subagents -> VADER.
      const boss = newSession({ project: PROJECTS[0] });
      boss.status = 'working';
      boss.isOrchestrator = true; // has subagents -> renders as Vader
      boss.currentToolFamily = 'delegate';
      boss.currentAction = 'Delegating → astromech';
      live.set(boss.id, boss);
      ents.push(boss);
      // Force two subagents (ids chosen so the hash yields one astromech + one
      // KX, so the snapshot shows both droid types under the Vader).
      const subA = newSubagent(boss); subA.id = 'agent-snap-0'; // hash%3 !== 0 -> astromech
      const subK = newSubagent(boss); subK.id = 'agent-snap-2'; // hash%3 === 0 -> kx
      live.set(subA.id, subA); ents.push(subA);
      live.set(subK.id, subK); ents.push(subK);
      // Tier-1 #2: a SECOND orchestrator on another floor -> ROYAL GUARD (Vader
      // is already taken). One subagent under it triggers the promotion.
      const boss2 = newSession({ project: PROJECTS[1] });
      boss2.status = 'working';
      boss2.isOrchestrator = true; // Vader already taken -> renders as Royal Guard
      boss2.currentToolFamily = 'delegate';
      boss2.currentAction = 'Delegating → reviewer';
      live.set(boss2.id, boss2);
      ents.push(boss2);
      const subG = newSubagent(boss2); subG.id = 'agent-snap-1'; // astromech
      live.set(subG.id, subG); ents.push(subG);
      // A few plain sessions (Tier 2).
      for (let i = 0; i < 3; i++) {
        const e = newSession();
        e.status = pick(['working', 'idle', 'working']);
        e.currentToolFamily = e.status === 'working' ? pick(FAMILIES) : null;
        e.currentAction = e.currentToolFamily ? actionFor(e.currentToolFamily) : null;
        live.set(e.id, e);
        ents.push(e);
      }
      emit({ type: 'snapshot', entities: ents.map(clone), aggregates: aggregates() });
    }

    function aggregates() {
      let active = 0, errs = 0, n = 0;
      for (const e of live.values()) {
        if (e.status === 'working') active++;
        errs += e.errorCount || 0; n++;
      }
      return {
        activeCount: active,
        throughput: active + rnd(3),
        errorRate: n ? Math.min(1, errs / (n * 6)) : 0,
      };
    }
    const clone = (o) => JSON.parse(JSON.stringify(o));

    // Scripted lifecycle beats so demo exercises everything.
    function tick() {
      if (stopped) return;
      const ids = [...live.keys()];
      const r = Math.random();

      if (live.size < 9 && r < 0.28) {
        // spawn a new session (walk-on)
        const e = newSession();
        live.set(e.id, e);
        emit({ type: 'spawn', entity: clone(e) });
        // shortly after, it starts working
        schedule(700 + rnd(600), () => {
          if (!live.has(e.id)) return;
          e.status = 'working'; e.currentToolFamily = pick(FAMILIES);
          e.currentAction = actionFor(e.currentToolFamily);
          emit({ type: 'delta', entityId: e.id, changes: { status: 'working', currentToolFamily: e.currentToolFamily, currentAction: e.currentAction } });
        });
      } else if (r < 0.45 && ids.length) {
        // Spawn a subagent beside a session parent. Prefer a session that has
        // NOT yet orchestrated, so the client shows an in-place Vader promotion.
        const sessions = [...live.values()].filter((x) => x.kind === 'session');
        const subParents = new Set([...live.values()]
          .filter((x) => x.kind === 'subagent').map((x) => x.parentSessionId));
        const fresh = sessions.filter((s) => !subParents.has(s.id));
        const p = fresh.length ? pick(fresh) : (sessions.length ? pick(sessions) : null);
        if (p) {
          // Promote the parent to orchestrator the first time (sticky) -> Vader/Guard.
          if (!p.isOrchestrator) {
            p.isOrchestrator = true;
            emit({ type: 'delta', entityId: p.id, changes: { isOrchestrator: true, signal: 'orchestrate' } });
          }
          const sub = newSubagent(p);
          live.set(sub.id, sub);
          emit({ type: 'spawn', entity: clone(sub) });
          // Subagent despawns later — the parent should STAY Vader (sticky).
          schedule(2500 + rnd(3000), () => {
            if (!live.has(sub.id)) return;
            live.delete(sub.id);
            emit({ type: 'despawn', entityId: sub.id });
          });
        }
      } else if (r < 0.62 && ids.length) {
        // a working/idle session changes tool family (burst-debounce test:
        // fire several rapid deltas)
        const sessions = [...live.values()].filter((x) => x.kind === 'session');
        if (sessions.length) {
          const e = pick(sessions);
          const burst = 1 + rnd(4);
          for (let b = 0; b < burst; b++) {
            schedule(b * 80, () => {
              if (!live.has(e.id)) return;
              e.status = 'working'; e.currentToolFamily = pick(FAMILIES);
              e.currentAction = actionFor(e.currentToolFamily);
              emit({ type: 'delta', entityId: e.id, changes: { status: 'working', currentToolFamily: e.currentToolFamily, currentAction: e.currentAction } });
            });
          }
          // then go idle
          schedule(burst * 80 + 900 + rnd(900), () => {
            if (!live.has(e.id)) return;
            e.status = 'idle'; e.currentToolFamily = null; e.currentAction = null;
            emit({ type: 'delta', entityId: e.id, changes: { status: 'idle', currentToolFamily: null, currentAction: null } });
          });
        }
      } else if (r < 0.72 && ids.length) {
        // error event
        const sessions = [...live.values()].filter((x) => x.kind === 'session');
        if (sessions.length) {
          const e = pick(sessions);
          e.errorCount = (e.errorCount || 0) + 1; e.status = 'working';
          e.currentToolFamily = pick(FAMILIES); e.currentAction = actionFor(e.currentToolFamily);
          emit({ type: 'delta', entityId: e.id, changes: { errorCount: e.errorCount, status: 'working', currentToolFamily: e.currentToolFamily, currentAction: e.currentAction } });
        }
      } else if (r < 0.82) {
        // despawn a session (walk-off)
        const sessions = [...live.values()].filter((x) => x.kind === 'session');
        if (sessions.length > 2) {
          const e = pick(sessions);
          // despawn its subagents too
          for (const s of [...live.values()]) {
            if (s.parentSessionId === e.id) { live.delete(s.id); emit({ type: 'despawn', entityId: s.id }); }
          }
          live.delete(e.id);
          emit({ type: 'despawn', entityId: e.id });
        }
      }
      // aggregates pulse
      emit({ type: 'aggregates', aggregates: aggregates() });
    }

    function schedule(ms, fn) { timers.push(setTimeout(fn, ms)); }

    initialSnapshot();
    const iv = setInterval(tick, 1400);
    timers.push(iv);

    return {
      stop() {
        stopped = true;
        for (const t of timers) { clearTimeout(t); clearInterval(t); }
        timers = [];
      },
    };
  }

  // ---- Export -------------------------------------------------------------
  window.DSV = window.DSV || {};
  Object.assign(window.DSV, {
    GRID_W, GRID_H, PX, DETAIL, PAL, ACCENTS, DECK_COUNT, SLOTS_PER_DECK,
    decks,
    hash32, projectKey, projectName,
    getSession, freeSession, resetSessions, sessions,
    claimSlot, freeSlot, deckOverflow, ensureDeckSlots,
    chooseSpriteType, familyScreenColor,
    makeMockServer,
  });
})();
