/* ===========================================================================
   render.js — sprite/agent manager + animation loop (the dynamic layer).

   The server sets INTENT (logicalState). This loop OWNS position: it
   interpolates x toward targetX, advances the walk cycle, plays the task
   animation, and debounces rapid state flips so a PreToolUse burst keeps a
   sprite working at its console instead of ping-ponging.
   =========================================================================== */
(function () {
  'use strict';
  const DSV = window.DSV;
  const { PX, PAL, GRID_W, GRID_H, SLOTS_PER_DECK } = DSV;
  const U = DSV.DETAIL; // high-res scale factor (2); on-screen units are halved
  const SP = DSV.sprites;

  // ---- Sprite manager -----------------------------------------------------
  // id -> sprite { spriteType, deck, slot, accent, x, targetX, floorY, facing,
  //                logicalState, animFrame, animClock, removeAt, ... }
  const sprites = new Map();
  const ambient = []; // mouse droids (ambient life)
  // Floating DOM action labels over each sprite's head (set up in setupCanvas).
  let labelLayer = null;
  const labelEls = new Map(); // entityId -> <div.agent-label>
  let dpr = 1; // device-pixel ratio, kept in sync by resize()
  // ---- Sprite type assignment --------------------------------------------
  // With ONE FLOOR PER SESSION, the boss is decided by ORCHESTRATION, not by
  // seniority: a session that spawns a subagent becomes the commander of its
  // floor -> the BOSS: Vader if the single global Vader mantle is free,
  // otherwise a red Imperial Royal Guard (so a second orchestrator elsewhere
  // shows a Guard). EVERYTHING ELSE (plain sessions that never delegate + all
  // subagents) -> a fresh RANDOM pick of officer / stormtrooper / astromech /
  // KX, rolled at spawn time. orchestrators is the ordered list of LIVE
  // orchestrator session ids (oldest first); when the Vader holder leaves the
  // next orchestrator is promoted in place.
  const orchestrators = []; // sessionId[] oldest-first, each has spawned a subagent
  let vaderHolder = null;   // the single global Vader sessionId (or null)
  const NONBOSS_TYPES = ['officer', 'trooper', 'astromech', 'kx'];

  function markOrchestrator(id) {
    if (id && !orchestrators.includes(id)) orchestrators.push(id);
  }
  // Random non-boss sprite, re-rolled every spawn (not stable across respawns).
  function randomNonBoss() {
    return NONBOSS_TYPES[Math.floor(Math.random() * NONBOSS_TYPES.length)];
  }
  // Boss sprite for an orchestrator session: claim the unique global Vader
  // mantle if it's free (or already ours), otherwise a Royal Guard.
  function bossType(id) {
    if (vaderHolder === null || vaderHolder === id) { vaderHolder = id; return 'vader'; }
    return 'guard';
  }

  // Swap a sprite's type IN PLACE (no respawn): keep id/deck/slot/post/accent,
  // refresh the anim frame, re-anchor feet for the new height, and re-center on
  // its post so a promotion doesn't shove it off its station.
  function retypeSprite(sp, type) {
    if (!sp || sp.spriteType === type) return;
    sp.spriteType = type;
    sp.animFrame = 0;
    sp.walkPhase = 0;
    const dk = deckById(sp.deckIndex) || DSV.decks[0];
    sp.floorY = dk.floorY - SP.spriteHeight(type) - 1;
    if (sp.homePostX != null) {
      sp.idleX = postIdleX(sp.homePostX, type);
      if (sp.logicalState === 'idle') sp.x = sp.targetX = sp.idleX;
    }
  }

  // After a spawn/despawn, make sure every live orchestrator is shown as a boss.
  // The Vader mantle is released if its holder is gone, then reclaimed by the
  // earliest live orchestrator (insertion order) — so exactly ONE Vader exists
  // and every other orchestrator is a Royal Guard. Non-orchestrator sprites
  // keep whatever random type they were given at spawn (untouched here).
  function reconcileSessionTypes() {
    if (vaderHolder !== null && !sprites.has(vaderHolder)) vaderHolder = null;
    // Drop orchestrators whose sprite is gone so the list stays live-only.
    for (let i = orchestrators.length - 1; i >= 0; i--) {
      if (!sprites.has(orchestrators[i])) orchestrators.splice(i, 1);
    }
    for (const id of orchestrators) {
      const sp = sprites.get(id);
      if (sp && sp.kind === 'session') retypeSprite(sp, bossType(sp.id));
    }
  }

  // Aggregates (drive dish lens + alert)
  let agg = { activeCount: 0, throughput: 0, errorRate: 0 };
  let alertLevel = 0; // 0..1 eased toward errorRate spike

  // Tunables — WALK_SPEED scales with resolution so on-screen pace is unchanged
  // even though blocks are now half as large.
  const WALK_SPEED = 0.55 * U;    // blocks per frame-ish (scaled by dt)
  const STATE_DEBOUNCE_MS = 350;  // ignore flips faster than this for movement
  const WORK_MIN_MS = 700;        // minimum time pinned at console
  // Autonomous "busywork": when the server isn't driving a sprite, it rotates
  // between stations on its deck so the decks always look staffed and active.
  const AUTO_REST_MIN = 600, AUTO_REST_VAR = 2200;   // pause before next task
  const AUTO_WORK_MIN = 1200, AUTO_WORK_VAR = 2600;  // time spent at a station
  const AUTO_MAX_HOPS = 3;                            // stations before heading home
  const AUTO_FAMILIES = ['exec', 'read', 'edit', 'scan', 'generic'];

  function deckById(d) { return DSV.decks[d]; }

  // Slot -> idle x position on a deck (sprites line up, never overlap).
  function slotX(deck, slot, type) {
    const usable = (deck.rightX - deck.leftX) - 6 * U;
    const n = SLOTS_PER_DECK;
    const x = deck.leftX + 3 * U + (usable * (slot + 0.5)) / n;
    return Math.round(x - SP.spriteWidth(type) / 2);
  }

  // Nearest console on a deck to a given x.
  function nearestConsole(deckIndex, x) {
    let best = null, bestD = Infinity;
    for (const c of DSV.consoles) {
      if (c.deck !== deckIndex) continue;
      const d = Math.abs(c.x - x);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  // ---- Station posts ------------------------------------------------------
  // Each console exposes 1-3 standing POSTS (DSV.consoles[].spots). A session
  // claims a post for its lifetime so crew always park AT a workstation — idle,
  // working, and between tasks — instead of stopping on empty floor. Built once
  // from the static console layout; claims are stable + collision-free per deck.
  const deckPosts = new Map(); // deckIndex -> [{ x, console, occupant }]
  function buildPosts() {
    deckPosts.clear();
    for (const c of DSV.consoles) {
      let arr = deckPosts.get(c.deck);
      if (!arr) { arr = []; deckPosts.set(c.deck, arr); }
      const dk = deckById(c.deck);
      const spots = (c.spots && c.spots.length) ? c.spots : [c.x];
      for (const sx of spots) {
        // clamp the post inside the deck's walkable interior
        const x = dk ? Math.max(dk.leftX + 3 * U, Math.min(dk.rightX - 3 * U, sx)) : sx;
        arr.push({ x, console: c, occupant: null });
      }
    }
  }
  function claimPost(deckIndex, id, seed) {
    if (!deckPosts.size) buildPosts();
    const arr = deckPosts.get(deckIndex);
    if (!arr || !arr.length) return null;
    for (const p of arr) if (p.occupant === id) return p; // already mine
    const start = seed % arr.length;
    for (let i = 0; i < arr.length; i++) {
      const p = arr[(start + i) % arr.length];
      if (!p.occupant) { p.occupant = id; return p; }
    }
    return null; // every post on this deck is taken -> overflow
  }
  function freePost(deckIndex, id) {
    const arr = deckPosts.get(deckIndex);
    if (!arr) return;
    for (const p of arr) if (p.occupant === id) p.occupant = null;
  }
  function freeAllPosts() {
    for (const arr of deckPosts.values()) for (const p of arr) p.occupant = null;
  }
  // Post x -> sprite-anchored idle x (centers the sprite on the post).
  function postIdleX(postX, type) {
    return Math.round(postX - SP.spriteWidth(type) / 2) + 1;
  }

  function isUuidLike(text) {
    if (typeof text !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text.trim());
  }

  function cleanTitle(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  // Star Wars themed placeholder shown until Claude Code's AI tab title arrives.
  // Indicates the session is loading / preparing / initializing.
  const LOADING_LABELS = [
    'Spinning up the hyperdrive…',
    'Powering the reactor core…',
    'Calibrating targeting computer…',
    'Charging the superlaser…',
    'Plotting hyperspace route…',
    'Initializing droid systems…',
    'Warming up the thrusters…',
    'Awaiting orders…',
  ];
  // Deterministic per session key so the phrase stays stable (no flicker).
  function loadingLabel(key) {
    const h = DSV.hash32(String(key == null ? 'unknown' : key));
    return LOADING_LABELS[h % LOADING_LABELS.length];
  }

  function titleForSprite(sp) {
    const t = cleanTitle(sp.title);
    if (t && !isUuidLike(t)) return t;
    return loadingLabel(sp.sessionKey || sp.id);
  }

  function trimToWidth(text, maxChars) {
    const s = cleanTitle(text);
    if (!s) return '';
    if (s.length <= maxChars) return s;
    if (maxChars < 2) return s.slice(0, Math.max(1, maxChars));
    return s.slice(0, maxChars - 1).trimEnd() + '…';
  }

  // Map server status + family -> a client logical state.
  function deriveState(entity) {
    const st = entity.status;
    if (st === 'finished') return 'leaving';
    if (st === 'spawning') return 'arriving';
    if (st === 'working' && entity.currentToolFamily) return 'working';
    if (st === 'working') return 'working';
    // idle / waiting
    return 'idle';
  }

  // ---- Create / update / remove from world deltas -------------------------
  function spawnSprite(entity, animateWalkOn) {
    if (sprites.has(entity.id)) { updateSprite(entity); return; }
    const projName = DSV.projectName(entity.project);

    let deck, slot, type, accent, parent = null, sessionKey = null;
    let homeConsole = null, homePostX = null, overflow = false;
    if (entity.kind === 'subagent' && entity.parentSessionId && sprites.has(entity.parentSessionId)) {
      // A subagent beside its parent session -> shares that floor, random non-boss.
      parent = sprites.get(entity.parentSessionId);
      deck = parent.deckIndex;
      type = randomNonBoss();
      accent = parent.accent;
      slot = parent.slot; // sits beside parent
      sessionKey = parent.sessionKey;
    } else {
      // ONE FLOOR PER SESSION: a session owns its floor; an orphan subagent
      // (parent not spawned yet) borrows its parent session's floor, created on
      // demand so it stays consistent once the parent's sprite arrives.
      sessionKey = entity.kind === 'subagent'
        ? (entity.parentSessionId || entity.id)
        : entity.id;
      const titleHint = cleanTitle(entity.title || '');
      // Until the real AI title arrives, label the floor with a Star Wars themed
      // loading phrase rather than the project name.
      const nameHint = (titleHint && !isUuidLike(titleHint)) ? titleHint : loadingLabel(sessionKey);
      const sess = DSV.getSession(sessionKey, { name: nameHint });
      deck = sess.deck;
      accent = sess.accent;
      // A real session title always wins as the floor's legend label, even if an
      // orphan subagent created this floor earlier with a project-name fallback.
      if (entity.kind === 'session' && titleHint && !isUuidLike(titleHint)) sess.name = titleHint;
      if (entity.kind === 'subagent') {
        // Orphan subagent (parent not seen yet) -> random non-boss sprite.
        type = randomNonBoss();
      } else if (entity.isOrchestrator) {
        // A session that has delegated -> commander of its floor (Vader/Guard).
        markOrchestrator(entity.id);
        type = bossType(entity.id);
      } else {
        // A plain session that has never delegated -> random non-boss sprite.
        type = randomNonBoss();
      }
      const seed = DSV.hash32(entity.id);
      // Claim a station POST so the sprite is stationed AT a workstation. If
      // every post on the deck is taken, fall back to a lined-up floor slot.
      const post = claimPost(deck, entity.id, seed);
      if (post) { homeConsole = post.console; homePostX = post.x; }
      else { slot = DSV.claimSlot(deck, entity.id, seed); overflow = true; }
    }

    const dk = deckById(deck) || DSV.decks[0];
    const floorTop = dk.floorY - SP.spriteHeight(type) - 1; // top row so feet sit on floor
    const idleX = entity.kind === 'subagent' && parent
      ? parent.idleX + SP.spriteWidth(parent.spriteType) + U
      : homeConsole
        ? postIdleX(homePostX, type)
        : slotX(dk, Math.max(0, slot), type);

    const sp = {
      id: entity.id,
      kind: entity.kind,
      spriteType: type,
      deckIndex: deck,
      slot,
      accent,
      sessionKey, // the session whose FLOOR this sprite stands on
      parentId: entity.parentSessionId || null,
      agentType: entity.agentType || null, // for subagent labels
      title: cleanTitle(entity.title || ''),
      projectName: projName,
      titleUpdatedAt: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      action: entity.currentAction || null, // server "<Verb> <target>" phrase
      floorY: floorTop,
      idleX,
      x: idleX,
      targetX: idleX,
      facing: 1,
      logicalState: 'idle',
      pendingState: null,
      animFrame: 0,
      animClock: 0,
      walkPhase: 0,
      console: null,
      eyeRed: false,
      errorCount: entity.errorCount || 0,
      stumbleUntil: 0,
      brightUntil: 0,
      workMinUntil: 0,
      lastStateChange: 0,
      removeAt: 0,
      bob: 0,
      restUntil: 0,      // autonomy: when to leave for the next station
      autoWorkUntil: 0,  // autonomy: when to finish at the current station
      autoHops: 0,       // autonomy: stations visited this excursion
      homeConsole,       // the workstation this sprite is stationed at
      homePostX,         // exact post x at that station (sprite-centered idleX)
      overflow,          // true if no post was free -> stands at a floor slot
    };

    if (animateWalkOn) {
      // Enter from the nearest hull edge, walk to slot.
      const fromLeft = idleX < DSV.station.CX;
      sp.x = fromLeft ? dk.leftX - 4 : dk.rightX + 4;
      sp.facing = fromLeft ? 1 : -1;
      sp.targetX = idleX;
      sp.logicalState = 'arriving';
    }

    sprites.set(entity.id, sp);
    updateSprite(entity, true);
    return sp;
  }

  function updateSprite(entity, skipMotionDebounce) {
    const sp = sprites.get(entity.id);
    if (!sp) return;
    const now = performance.now();
    if (entity.accent) sp.accent = entity.accent;

    // error detection: errorCount increased, OR a one-shot error signal.
    if (typeof entity.errorCount === 'number' && entity.errorCount > sp.errorCount) {
      sp.errorCount = entity.errorCount;
      sp.stumbleUntil = now + 700;
    }
    if (entity.signal === 'error') sp.stumbleUntil = now + 700;

    // Orchestration promotion: the first time a session delegates, the server
    // sends { isOrchestrator: true }. It becomes the commander of its floor ->
    // Vader (or Guard if Vader is already taken). reconcile re-ranks the mantle.
    if (entity.isOrchestrator === true && sp.kind === 'session' && !orchestrators.includes(sp.id)) {
      markOrchestrator(sp.id);
      reconcileSessionTypes();
    }

    // dim/sit signal from the reaper: sprite sits, no transit until refreshed.
    if (entity.dimmed === true || entity.signal === 'dim') sp.dimmed = true;
    else if (entity.dimmed === false) sp.dimmed = false;

    // A delta may only carry a transient signal (e.g. tool_start/waiting) with
    // no persistent status/family. Only mutate fields actually present so a
    // signal-only delta never snaps a working sprite to idle.
    if ('currentToolFamily' in entity) sp.toolFamily = entity.currentToolFamily || null;
    if ('title' in entity) {
      const nextTitle = cleanTitle(entity.title || '');
      if (nextTitle && nextTitle !== sp.title) {
        sp.title = nextTitle;
        sp.titleUpdatedAt = now;
        // Surface the real title on this session's floor legend entry (a real
        // title always wins over a project-name / short-id fallback).
        if (sp.kind === 'session' && !isUuidLike(nextTitle) && sp.sessionKey) {
          const s = DSV.sessions.get(sp.sessionKey);
          if (s) s.name = nextTitle;
        }
      }
    }
    // Action label phrase ("Reading world.js"). PreToolUse sets it; PostToolUse
    // /Stop send it as null to clear. Update before the pure-signal early-out.
    if ('currentAction' in entity) sp.action = entity.currentAction || null;
    if (entity.status === undefined && entity.kind === undefined &&
        !('errorCount' in entity)) {
      // pure-signal delta: nothing more to do for motion
      return;
    }
    if (entity.status !== undefined) sp.serverStatus = entity.status;

    // Build an effective record for state derivation from current truth.
    const eff = {
      status: entity.status !== undefined ? entity.status : sp.serverStatus,
      currentToolFamily: sp.toolFamily,
      kind: sp.kind,
    };
    const want = deriveState(eff);

    // Debounce rapid logical flips that would move the sprite. Tool-family
    // churn while "working" never re-walks — only working<->idle<->leaving move.
    const movesState = (a, b) => {
      if (a === b) return false;
      // working->working with different family does not re-path
      return true;
    };

    if (want === 'leaving') {
      sp.logicalState = 'leaving';
      const dk = deckById(sp.deckIndex) || DSV.decks[0];
      const left = sp.x < DSV.station.CX;
      sp.targetX = left ? dk.leftX - 6 : dk.rightX + 6;
      sp.facing = left ? -1 : 1;
      sp.removeAt = now + 4000; // safety despawn even if it can't reach edge
      return;
    }

    if (want === 'working') {
      // pin to a console; debounce re-targeting under bursts
      if (sp.logicalState !== 'working' || !sp.console) {
        if (skipMotionDebounce || now - sp.lastStateChange > STATE_DEBOUNCE_MS) {
          // Prefer this sprite's OWN station post (so crew man their own desk
          // and don't pile onto one console); fall back to the nearest console.
          const c = sp.homeConsole || nearestConsole(sp.deckIndex, sp.x) || { x: sp.idleX };
          sp.console = c;
          sp.targetX = sp.homeConsole
            ? sp.idleX
            : Math.round(c.x - SP.spriteWidth(sp.spriteType) / 2) + 1;
          sp.facing = c.x >= sp.x ? 1 : -1;
          sp.logicalState = 'working';
          sp.workMinUntil = now + WORK_MIN_MS;
          sp.lastStateChange = now;
        }
      } else {
        // already working: just refresh the min-pin window, no re-path
        sp.workMinUntil = Math.max(sp.workMinUntil, now + WORK_MIN_MS);
      }
      return;
    }

    // idle / arriving
    if (want === 'idle') {
      // honor a minimum work pin so a quick PreToolUse->PostToolUse doesn't
      // snap the sprite away mid-animation
      if (sp.logicalState === 'working' && now < sp.workMinUntil) {
        sp.pendingState = 'idle';
        return;
      }
      if (movesState(sp.logicalState, 'idle')) {
        sp.logicalState = 'idleReturn';
        sp.targetX = sp.idleX;
        sp.facing = sp.idleX >= sp.x ? 1 : -1;
        sp.console = null;
        sp.brightUntil = now + 220; // brief bright frame on finishing work
        sp.lastStateChange = now;
      }
    }
  }

  function removeSprite(id) {
    const sp = sprites.get(id);
    if (!sp) return;
    sp.logicalState = 'leaving';
    const dk = deckById(sp.deckIndex) || DSV.decks[0];
    const left = sp.x < DSV.station.CX;
    sp.targetX = left ? dk.leftX - 6 : dk.rightX + 6;
    sp.facing = left ? -1 : 1;
    sp.removeAt = performance.now() + 4000;
  }

  function finalizeRemove(id) {
    const sp = sprites.get(id);
    if (!sp) return;
    // Release any station post / floor slot this sprite claimed (a no-op for
    // subagents that sit beside a parent and never claimed their own).
    DSV.freeSlot(sp.deckIndex, id); freePost(sp.deckIndex, id);
    if (sp.kind === 'session') {
      const oi = orchestrators.indexOf(id); // drop from the orchestrator list
      if (oi !== -1) orchestrators.splice(oi, 1);
    }
    sprites.delete(id);
    removeLabel(id);
    // Release this session's FLOOR once nothing stands on it anymore, so the
    // deck recycles for a future window. Subagents keep their parent's floor
    // reserved until they too despawn (whichever leaves last frees the deck).
    if (sp.sessionKey) {
      let stillUsed = false;
      for (const o of sprites.values()) {
        if (o.sessionKey === sp.sessionKey) { stillUsed = true; break; }
      }
      if (!stillUsed) DSV.freeSession(sp.sessionKey);
    }
    // Promote survivors so the boss / soldier roles stay filled after a despawn.
    reconcileSessionTypes();
  }

  // Replace whole world from a snapshot: place sprites in CURRENT state, NO
  // walk-on animation.
  function applySnapshot(entities) {
    // reset placement bookkeeping
    sprites.clear();
    clearAllLabels();
    orchestrators.length = 0; vaderHolder = null; // re-rank bosses from the snapshot
    DSV.resetSessions(); // wipe floor assignments so the snapshot re-claims decks
    freeAllPosts(); // release every station post so reassignment is collision-free
    // clear every deck's slot row so snapshot reassignment is collision-free
    for (let d = 0; d < DSV.DECK_COUNT; d++) {
      const arr = DSV.ensureDeckSlots(d);
      for (let i = 0; i < arr.length; i++) arr[i] = null;
    }
    // sessions first (so subagents can find parents)
    const sessions = entities.filter((e) => e && e.kind !== 'subagent');
    const subs = entities.filter((e) => e && e.kind === 'subagent');
    for (const e of sessions) {
      const sp = spawnSprite(e, false); // no walk-on
      // place directly in current pose/position
      placeInCurrentState(sp, e);
    }
    for (const e of subs) {
      const sp = spawnSprite(e, false);
      if (sp) placeInCurrentState(sp, e);
    }
  }

  // For snapshots: snap directly to where the state implies (no transit).
  function placeInCurrentState(sp, entity) {
    if (!sp) return;
    const want = deriveState(entity);
    if (want === 'working') {
      const c = sp.homeConsole || nearestConsole(sp.deckIndex, sp.idleX) || { x: sp.idleX };
      sp.console = c;
      sp.x = sp.targetX = sp.homeConsole
        ? sp.idleX
        : Math.round(c.x - SP.spriteWidth(sp.spriteType) / 2) + 1;
      sp.logicalState = 'working';
      sp.workMinUntil = 0;
    } else {
      sp.x = sp.targetX = sp.idleX;
      sp.logicalState = 'idle';
    }
  }

  // ---- Ambient mouse droids (removed) ------------------------------------
  // Mouse droids were ambient life scurrying along the floors; removed per
  // request. seedAmbient now keeps the list empty so stepAmbient / the draw
  // loop iterate nothing.
  function seedAmbient() {
    ambient.length = 0;
  }

  function stepAmbient(dt, now) {
    for (const m of ambient) {
      m.clock += dt;
      if (m.frame !== undefined && m.clock > 120) { m.frame ^= 1; m.clock = 0; }
      if (now < m.pauseUntil) continue;
      m.x += m.dir * (WALK_SPEED * 2.2) * (dt / 16);
      if (m.x <= m.leftX) { m.x = m.leftX; m.dir = 1; if (Math.random() < 0.5) m.pauseUntil = now + 400 + Math.random() * 600; }
      if (m.x >= m.rightX) { m.x = m.rightX; m.dir = -1; if (Math.random() < 0.5) m.pauseUntil = now + 400 + Math.random() * 600; }
      if (Math.random() < 0.004) m.dir *= -1; // random reverse
    }
  }

  // ---- Aggregates ---------------------------------------------------------
  let lastErrRate = 0;
  function setAggregates(a) {
    if (!a) return;
    agg = {
      activeCount: a.activeCount != null ? a.activeCount : (a.active != null ? a.active : agg.activeCount),
      throughput: a.throughput != null ? a.throughput : agg.throughput,
      errorRate: a.errorRate != null ? a.errorRate : (a.errorRate === 0 ? 0 : agg.errorRate),
    };
    // spike detection -> bump alert
    if (agg.errorRate > lastErrRate + 0.05) alertLevel = Math.min(1, alertLevel + 0.5);
    lastErrRate = agg.errorRate;
  }

  // ---- Autonomous task rotation ------------------------------------------
  // Pick a station on the sprite's deck to walk to next — preferably one it
  // isn't already standing at, so it actually moves back and forth.
  function pickAutoStation(sp) {
    const here = Math.round(sp.x);
    const opts = [];
    for (const c of DSV.consoles) if (c.deck === sp.deckIndex) opts.push(c);
    if (!opts.length) return null;
    const others = opts.filter((c) => Math.abs(c.x - here) > 4);
    const pool = others.length ? others : opts;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Drive idle sprites between stations. Only runs when the SERVER isn't
  // actively working this sprite (real tool activity always wins) and it isn't
  // dimmed or mid-transit. Reuses the 'work' pose + lit-console visuals.
  function stepAutonomy(sp, now) {
    if (sp.dimmed || sp.serverStatus === 'working') return;
    const ls = sp.logicalState;
    if (ls === 'idle') {
      if (!sp.restUntil) sp.restUntil = now + AUTO_REST_MIN + Math.random() * AUTO_REST_VAR;
      if (now >= sp.restUntil) {
        sp.restUntil = 0;
        // Mostly settle in and work at the sprite's OWN station; occasionally
        // patrol to a different one. The destination is ALWAYS a station, so a
        // sprite never stops on empty floor.
        const patrol = Math.random() < 0.3;
        const target = (!patrol && sp.homeConsole) ? sp.homeConsole
                     : (pickAutoStation(sp) || sp.homeConsole);
        if (!target) { sp.restUntil = now + 1500; return; }
        sp.console = target;
        sp.targetX = (target === sp.homeConsole)
          ? sp.idleX
          : Math.round(target.x - SP.spriteWidth(sp.spriteType) / 2) + 1;
        sp.facing = target.x >= sp.x ? 1 : -1;
        sp.logicalState = 'autoGo';
      }
    } else if (ls === 'autoWork') {
      if (now >= sp.autoWorkUntil) {
        sp.autoHops = (sp.autoHops || 0) + 1;
        if (sp.autoHops < AUTO_MAX_HOPS && Math.random() < 0.5) {
          const target = pickAutoStation(sp);
          if (target) {
            sp.console = target;
            sp.targetX = Math.round(target.x - SP.spriteWidth(sp.spriteType) / 2) + 1;
            sp.facing = target.x >= sp.x ? 1 : -1;
            sp.logicalState = 'autoGo';
            return;
          }
        }
        // head back to the HOME POST (a station, not bare floor) and rest a while
        sp.autoHops = 0;
        sp.console = sp.homeConsole || null;
        sp.targetX = sp.idleX;
        sp.facing = sp.idleX >= sp.x ? 1 : -1;
        sp.logicalState = 'idleReturn';
      }
    }
  }

  // ---- Per-frame motion update -------------------------------------------
  function stepSprite(sp, dt, now) {
    stepAutonomy(sp, now);
    // resolve pending idle that was held by work-min pin
    if (sp.pendingState === 'idle' && now >= sp.workMinUntil && sp.logicalState === 'working') {
      sp.pendingState = null;
      sp.logicalState = 'idleReturn';
      sp.targetX = sp.idleX;
      sp.facing = sp.idleX >= sp.x ? 1 : -1;
      sp.console = null;
      sp.brightUntil = now + 220;
    }

    const speed = (SP.isDroid(sp.spriteType) ? WALK_SPEED * 1.4
                  : (sp.spriteType === 'vader' || sp.spriteType === 'commander' || sp.spriteType === 'guard') ? WALK_SPEED * 0.85 // glide
                  : sp.spriteType === 'kx' ? WALK_SPEED * 0.95   // long stiff strides
                  : sp.spriteType === 'officer' ? WALK_SPEED * 0.8 : WALK_SPEED);
    const dx = sp.targetX - sp.x;
    const moving = Math.abs(dx) > 0.6;

    if (moving) {
      const step = Math.sign(dx) * speed * (dt / 16);
      if (Math.abs(step) > Math.abs(dx)) sp.x = sp.targetX; else sp.x += step;
      sp.facing = dx >= 0 ? 1 : -1;
      sp.walkPhase += dt;
      // KX takes long stiff strides (slower frame swap); others normal.
      const swap = sp.spriteType === 'kx' ? 210 : 130;
      if (sp.walkPhase > swap) { sp.walkPhase = 0; sp.animFrame ^= 1; }
    } else {
      sp.x = sp.targetX;
      // arrived
      if (sp.logicalState === 'arriving') { sp.logicalState = 'idle'; sp.restUntil = 0; }
      if (sp.logicalState === 'idleReturn') { sp.logicalState = 'idle'; sp.restUntil = 0; }
      if (sp.logicalState === 'autoGo') {
        // reached an autonomous station: settle in and "work" for a while
        sp.logicalState = 'autoWork';
        sp.autoWorkUntil = now + AUTO_WORK_MIN + Math.random() * AUTO_WORK_VAR;
        sp.toolFamily = AUTO_FAMILIES[Math.floor(Math.random() * AUTO_FAMILIES.length)];
      }
    }

    // droid bob + dome/eye animation
    if (SP.isDroid(sp.spriteType)) {
      sp.animClock += dt;
      sp.bob = (Math.floor(now / 220) % 2 === 0 && moving) ? -1 : 0;
      if (sp.animClock > 600) { sp.eyeRed = !sp.eyeRed; sp.animClock = 0; }
    } else {
      sp.bob = 0;
    }

    // leaving -> remove when off-screen or timed out
    if (sp.logicalState === 'leaving') {
      const dk = deckById(sp.deckIndex) || DSV.decks[0];
      if (!moving || now > sp.removeAt ||
          sp.x < dk.leftX - 5 || sp.x > dk.rightX + 5) {
        finalizeRemove(sp.id);
      }
    }
  }

  // ---- Choose pose for current sprite state -------------------------------
  function poseFor(sp, now) {
    if (now < sp.stumbleUntil) return 'stumble';
    const moving = Math.abs(sp.targetX - sp.x) > 0.6;
    if (moving) return sp.animFrame ? 'walk2' : 'walk1';
    if (sp.logicalState === 'working' || sp.logicalState === 'autoWork') return 'work';
    return 'idle';
  }

  // Draw one embedded status screen per deck showing the most relevant
  // session title for that floor. This is rendered INTO the station scene so it
  // reads like built-in Death Star hardware, not HUD chrome.
  function drawDeckTitleScreens(ctx) {
    const chosenByDeck = new Map(); // deck -> { sp, score, title }
    for (const sp of sprites.values()) {
      if (sp.kind !== 'session' || sp.logicalState === 'leaving') continue;
      const title = titleForSprite(sp);
      if (!title) continue;
      const score =
        (sp.serverStatus === 'working' ? 3000 : 0) +
        ((sp.logicalState === 'working' || sp.logicalState === 'autoWork') ? 1200 : 0) +
        (sp.titleUpdatedAt || 0);
      const prev = chosenByDeck.get(sp.deckIndex);
      if (!prev || score > prev.score) chosenByDeck.set(sp.deckIndex, { sp, score, title });
    }
    if (chosenByDeck.size === 0) return;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const dk of DSV.decks) {
      const pick = chosenByDeck.get(dk.index);
      if (!pick) continue;

      const active = pick.sp.serverStatus === 'working' ||
        pick.sp.logicalState === 'working' ||
        pick.sp.logicalState === 'autoWork';

      const ceilY = dk.index > 0
        ? (DSV.decks[dk.index - 1].floorY + 4 * U)
        : (DSV.station.CY - DSV.station.R + DSV.station.HULL_T + 2 * U);
      const roomTop = dk.index === 0 ? Math.max(ceilY, dk.floorY - 42 * U) : ceilY;
      
      // Calculate usable width at the text's Y position to avoid overlapping the hull
      const textY = roomTop + 8 * U;
      const dy = textY - DSV.station.CY;
      const innerR = DSV.station.R - DSV.station.HULL_T;
      const inside = innerR * innerR - dy * dy;
      const hw = inside > 0 ? Math.sqrt(inside) - 1 : 0;
      const roomLeft = Math.max(dk.leftX, DSV.station.CX - hw);
      const roomRight = Math.min(dk.rightX, DSV.station.CX + hw);
      
      const usableW = (roomRight - roomLeft - 16 * U) * PX;
      const textCx = (roomLeft + roomRight) / 2;

      // Place it higher up on the back wall, just under the ceiling beam
      const ty = Math.round(textY * PX);
      const tx = Math.round(textCx * PX);

      const txt = `SECTOR ${dk.index + 1}: ${pick.title}`.toUpperCase();
      
      let fontSize = 6 * U;
      ctx.font = `bold ${fontSize}px "Courier New", ui-monospace, Menlo, monospace`;
      let textWidth = ctx.measureText(txt).width;
      
      if (textWidth > usableW && usableW > 0) {
        fontSize = Math.max(4 * U, Math.floor(fontSize * (usableW / textWidth)));
        ctx.font = `bold ${fontSize}px "Courier New", ui-monospace, Menlo, monospace`;
        textWidth = ctx.measureText(txt).width;
      }
      
      let finalTxt = txt;
      if (textWidth > usableW && usableW > 0) {
         const avgCharW = textWidth / txt.length;
         const maxChars = Math.floor(usableW / avgCharW);
         finalTxt = txt.slice(0, Math.max(3, maxChars - 1)) + '…';
      }

      // Dark shadow/recess for depth (hard pixel drop shadow)
      ctx.fillStyle = '#0a0a10';
      ctx.fillText(finalTxt, tx + 2 * PX, ty + 2 * PX);
      
      // Main text color - faint if idle, glowing if active
      if (active) {
        // "Glowing" in 8-bit: draw a slightly darker, thicker outline or just bright color
        ctx.fillStyle = pick.sp.accent || '#64f1c7';
      } else {
        ctx.fillStyle = '#3a3a44'; // Faint painted look when idle
      }
      
      ctx.fillText(finalTxt, tx, ty);
    }

    ctx.restore();
  }

  // ---- Dynamic-layer draw -------------------------------------------------
  function drawDynamic(ctx, now) {
    // lit consoles for working sprites
    const litConsoles = new Map(); // "deck,x" -> color
    for (const sp of sprites.values()) {
      if ((sp.logicalState === 'working' || sp.logicalState === 'autoWork') && sp.console) {
        const col = DSV.familyScreenColor(sp.toolFamily, sp.accent);
        litConsoles.set(sp.console.deck + ',' + sp.console.x, { col, sp });
      }
    }
    for (const [, v] of litConsoles) {
      const sp = v.sp;
      const c = sp.console;
      const s = DSV.screenRect(c.x, c.y); // SAME recess station.js drew, so it aligns
      // blink for exec; steady otherwise
      let lit = v.col;
      if (sp.toolFamily === 'exec' && (Math.floor(now / 180) % 2 === 0)) lit = PAL.screenDim;
      if (now < sp.stumbleUntil) lit = PAL.alert; // red console spark on error
      // light the recessed work-screen
      ctx.fillStyle = lit;
      ctx.fillRect(s.x * PX, s.y * PX, s.w * PX, s.h * PX);
      // blinking data pixels along the screen top
      if (Math.floor(now / 140) % 2 === 0) {
        ctx.fillStyle = PAL.lens;
        ctx.fillRect((s.x + s.w - 1) * PX, s.y * PX, PX, PX);
        ctx.fillRect(s.x * PX, (s.y + s.h - 1) * PX, PX, PX);
      }
      // scan sweep across the screen
      if (sp.toolFamily === 'scan') {
        const sweep = Math.floor((now / 110) % s.w);
        ctx.fillStyle = v.col;
        ctx.fillRect((s.x + sweep) * PX, s.y * PX, PX, s.h * PX);
      }
      if (sp.toolFamily === 'edit' || now < sp.stumbleUntil) {
        SP.drawSparks(ctx, c.x, s.y - 1, now < sp.stumbleUntil, Math.floor(now / 60));
      }
    }

    drawDeckTitleScreens(ctx);

    // sprites (sessions + droids). Dimmed (reaper-idle) sprites stand in the
    // idle pose but are NEVER drawn transparent — always fully opaque.
    for (const sp of sprites.values()) {
      const pose = sp.dimmed ? 'idle' : poseFor(sp, now);
      const blockX = Math.round(sp.x);
      SP.drawSprite(ctx, sp.spriteType, pose, blockX, sp.floorY, sp.facing, sp.accent,
        { eyeRed: sp.eyeRed, errorSpark: now < sp.stumbleUntil, bob: sp.bob });
    }

    // ambient mouse droids
    for (const m of ambient) {
      SP.drawSprite(ctx, 'mouse', m.frame ? 'walk1' : 'walk2',
        Math.round(m.x), m.floorY, m.dir, '#6a6e7a', {});
    }

    // per-deck "+N" overflow markers (crew that found no free station post)
    const overByDeck = {};
    for (const sp of sprites.values())
      if (sp.overflow) overByDeck[sp.deckIndex] = (overByDeck[sp.deckIndex] || 0) + 1;
    for (let d = 0; d < DSV.DECK_COUNT; d++) {
      if (!overByDeck[d]) continue;
      const dk = deckById(d);
      if (!dk) continue;
      ctx.fillStyle = PAL.lens;
      // tiny block marker; HUD legend explains. (text overlay is in DOM.)
      ctx.fillRect((dk.rightX - 2 * U) * PX, (dk.floorY - 4 * U) * PX, PX * 2 * U, PX * U);
    }

    // superlaser lens brightness from aggregate activity
    drawDishAndBeam(ctx, now);

    // alert tint on hull rim / decks when error rate spikes
    if (alertLevel > 0.02) drawAlert(ctx, now);
  }

  function drawDishAndBeam(ctx, now) {
    const d = DSV.dish;
    if (!d) return;
    const activity = Math.min(1, (agg.throughput || agg.activeCount || 0) / 8);
    // lens block: brighter with activity (lerp dish->lens color)
    const lensCol = activity > 0.66 ? PAL.lens : activity > 0.33 ? '#9aa0ae' : '#5a5e6a';
    ctx.fillStyle = lensCol;
    ctx.fillRect((d.cx - U) * PX, (d.cy - U) * PX, 2 * U * PX, 2 * U * PX);
    // hot core when busy
    if (activity > 0.5) { ctx.fillStyle = '#eef4ff'; ctx.fillRect(d.cx * PX, (d.cy - 1) * PX, U * PX, U * PX); }

    // beams: only fire when there's activity; the eight rim emitters shoot
    // convergent green rays that meet at the off-corner focal node.
    if (activity <= 0.05 || !DSV.beam) return;
    const flick = (Math.floor(now / 90) % 2 === 0);
    const thick = activity > 0.75 ? U : Math.max(1, Math.round(U / 2));
    for (const ray of DSV.beam.rays) {
      for (let i = 0; i < ray.length; i++) {
        // convergent beam; thin it out at low activity by skipping blocks
        if (activity < 0.5 && i % 2 === 0) continue;
        const [x, y] = ray[i];
        ctx.fillStyle = (flick && i % 3 === 0) ? '#aef07a' : PAL.beam;
        ctx.fillRect(x * PX, y * PX, thick * PX, thick * PX);
      }
    }
    // focal node: a bright pulsing core where the rays converge
    const b = DSV.beam;
    const pulse = 0.6 + 0.4 * Math.sin(now / 70);
    const fr = Math.max(U, Math.round(U * (1 + activity) * pulse));
    ctx.fillStyle = flick ? '#eef9d8' : '#aef07a';
    ctx.fillRect((b.fx - fr) * PX, (b.fy - fr) * PX, 2 * fr * PX, 2 * fr * PX);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((b.fx - Math.round(fr / 2)) * PX, (b.fy - Math.round(fr / 2)) * PX, fr * PX, fr * PX);
  }

  function drawAlert(ctx, now) {
    const st = DSV.station;
    const a = alertLevel * (0.5 + 0.5 * Math.sin(now / 160));
    ctx.globalAlpha = 0.18 * a;
    ctx.fillStyle = PAL.alert;
    // rim flash: redraw a thin red band on hull rim
    const R = st.R, CX = st.CX, CY = st.CY, T = st.HULL_T;
    for (let row = CY - R; row <= CY + R; row += 1) {
      const dy = row - CY;
      const inside = R * R - dy * dy;
      if (inside <= 0) continue;
      const hw = Math.sqrt(inside);
      const x0 = Math.round(CX - hw), x1 = Math.round(CX + hw);
      ctx.fillRect(x0 * PX, row * PX, PX * T, PX);
      ctx.fillRect((x1 - T + 1) * PX, row * PX, PX * T, PX);
    }
    ctx.globalAlpha = 1;
  }

  // ---- Main loop ----------------------------------------------------------
  // The scene is composed at its NATIVE square resolution onto an offscreen
  // "scene" buffer (station backdrop + dynamic sprite layer). Each frame that
  // buffer is blitted to the visible canvas with a SINGLE uniform scale factor,
  // centered, leaving pillar/letterbox bars of the space color. This guarantees
  // the Death Star stays a TRUE CIRCLE at any window aspect ratio.
  let canvas, ctx;            // visible canvas (device pixels = window size)
  let scene, sctx;            // offscreen native-res scene buffer
  let station, last = 0, running = false;
  const SCENE_W = GRID_W * PX;
  const SCENE_H = GRID_H * PX;

  function resize() {
    if (!canvas) return;
    // Use device pixels so the blit is crisp; CSS keeps it filling the window.
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssW = window.innerWidth || SCENE_W;
    const cssH = window.innerHeight || SCENE_H;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.imageSmoothingEnabled = false;
  }

  function setupCanvas() {
    canvas = document.getElementById('stage');
    ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    labelLayer = document.getElementById('labels'); // DOM overlay for action text
    // Offscreen scene buffer at native logical resolution (square -> circle).
    scene = document.createElement('canvas');
    scene.width = SCENE_W;
    scene.height = SCENE_H;
    sctx = scene.getContext('2d');
    sctx.imageSmoothingEnabled = false;
    resize();
    window.addEventListener('resize', resize);
  }

  // ---- Floating action labels (DOM overlay) -------------------------------
  // A crisp HTML tag floats over each sprite's head with the hybrid
  // "<Verb> <target>" phrase the server derived (e.g. "Reading world.js").
  // Positioned with the SAME uniform scale/offset the scene blit uses, so the
  // text tracks the pixel sprite exactly at any zoom / window size.
  // Verb for a tool family, so the tag matches the work animation the sprite is
  // actually playing (e.g. an editing/welding sprite reads "Editing…").
  function familyLabel(fam) {
    switch (fam) {
      case 'exec':     return 'Running…';
      case 'read':     return 'Reading…';
      case 'edit':     return 'Editing…';
      case 'scan':     return 'Scanning…';
      case 'delegate': return 'Delegating…';
      default:         return 'Working…';
    }
  }

  function labelText(sp, now) {
    if (now < sp.stumbleUntil) return '⚠ tool failed';
    if (sp.kind === 'subagent') {
      if (sp.agentType) return '⟳ ' + sp.agentType;     // ⟳ <type>
      return sp.spriteType === 'kx' ? 'KX unit' : 'Astromech';
    }
    if (sp.action) return sp.action;                          // real tool action
    // Any active work animation — real OR the autonomous busywork loop — should
    // read as work, never "Standing by". So an editing sprite says "Editing…".
    if (sp.serverStatus === 'working' ||
        sp.logicalState === 'working' || sp.logicalState === 'autoWork') {
      return familyLabel(sp.toolFamily);
    }
    return '';                                                // genuinely idle -> no caption
  }

  function removeLabel(id) {
    const el = labelEls.get(id);
    if (el) { el.remove(); labelEls.delete(id); }
  }
  function clearAllLabels() {
    for (const el of labelEls.values()) el.remove();
    labelEls.clear();
  }

  // Reconcile DOM labels against live sprites, then position each in CSS pixels.
  // dx/dy/scale are DEVICE-pixel blit params; divide by dpr to land in CSS space.
  function updateLabels(dx, dy, scale, now) {
    if (!labelLayer) return;
    for (const sp of sprites.values()) {
      if (sp.logicalState === 'leaving') { removeLabel(sp.id); continue; } // walking off
      const txt = labelText(sp, now);
      if (!txt) { removeLabel(sp.id); continue; } // genuinely idle -> no caption at all
      let el = labelEls.get(sp.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'agent-label';
        el._txt = ''; el._accent = '';
        labelLayer.appendChild(el);
        labelEls.set(sp.id, el);
      }
      if (txt !== el._txt) { el.textContent = txt; el._txt = txt; }

      const err = now < sp.stumbleUntil;
      // Only sprites doing something have a label now, so every label is shown at
      // full strength (real tool actions get a brighter accent than busywork).
      const realWork = !err && (sp.kind === 'subagent' || !!sp.action || sp.serverStatus === 'working');
      el.classList.toggle('is-error', err);
      el.classList.toggle('is-active', realWork);
      if (el._accent !== sp.accent) { el.style.setProperty('--accent', sp.accent); el._accent = sp.accent; }

      // anchor: a couple of blocks above the sprite's head, centered on it
      const w = SP.spriteWidth(sp.spriteType);
      const logX = (sp.x + w / 2) * PX;
      const logY = (sp.floorY - 2) * PX;
      const cssX = (dx + logX * scale) / dpr;
      const cssY = (dy + logY * scale) / dpr;
      el.style.transform = 'translate(' + cssX + 'px,' + cssY + 'px) translate(-50%,-100%)';
    }
    // drop labels whose sprite is gone
    for (const id of [...labelEls.keys()]) if (!sprites.has(id)) removeLabel(id);
  }

  function frame(t) {
    if (!running) return;
    const dt = Math.min(50, t - last || 16);
    last = t;
    const now = t;

    // update motion
    stepAmbient(dt, now);
    for (const sp of [...sprites.values()]) stepSprite(sp, dt, now);

    // decay alert
    alertLevel = Math.max(0, alertLevel - dt / 4000);

    // 1) compose the scene at native resolution: backdrop then dynamic layer
    sctx.imageSmoothingEnabled = false;
    if (station) sctx.drawImage(station, 0, 0);
    else { sctx.fillStyle = PAL.space; sctx.fillRect(0, 0, SCENE_W, SCENE_H); }
    drawDynamic(sctx, now);

    // 2) blit to the visible canvas with a SINGLE uniform scale, centered,
    //    pillar/letterboxed with the space color.
    const cw = canvas.width, ch = canvas.height;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PAL.space;
    ctx.fillRect(0, 0, cw, ch);
    const fit = Math.min(cw / SCENE_W, ch / SCENE_H);
    // Prefer an integer scale for crispest pixels, but only if it doesn't waste
    // too much of the window (>~20%); otherwise use the uniform float fit (still
    // nearest-neighbor since imageSmoothingEnabled=false). Always a SINGLE
    // factor for both axes, so the circle never distorts.
    let scale = fit;
    const intScale = Math.floor(fit);
    if (intScale >= 1 && intScale / fit >= 0.8) scale = intScale;
    const dw = Math.round(SCENE_W * scale);
    const dh = Math.round(SCENE_H * scale);
    const dx = Math.floor((cw - dw) / 2);
    const dy = Math.floor((ch - dh) / 2);
    ctx.drawImage(scene, 0, 0, SCENE_W, SCENE_H, dx, dy, dw, dh);

    // 3) position the floating DOM action labels to match the blit
    updateLabels(dx, dy, scale, now);

    requestAnimationFrame(frame);
  }

  function start() {
    setupCanvas();
    station = DSV.buildStation();
    buildPosts(); // derive crew standing posts from the freshly-laid-out consoles
    seedAmbient();
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  // counts for HUD
  function counts() {
    let s = 0, dr = 0;
    for (const sp of sprites.values()) {
      if (sp.kind === 'subagent') dr++; else s++;
    }
    return { sessions: s, droids: dr, throughput: agg.throughput, errorRate: agg.errorRate };
  }

  DSV.render = {
    start, spawnSprite, updateSprite, removeSprite, applySnapshot,
    setAggregates, counts, sprites,
    getAgg: () => agg,
  };
})();
