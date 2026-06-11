/* ===========================================================================
   citymodel.js — client mirror of the server's persistent city + the layout
   solver that turns districts/lots into tile positions.

   Layout contract (mirrors server/city.js):
     - Blocks are 8x8 tiles, placed on the global spiral (lot.block holds the
       slot index — persisted server-side, never re-derived here).
     - Block = 1-tile perimeter road + 6x6 interior = 3x3 parcels of 2x2
       tiles, serpentine order (lot.parcel is also persisted).
     - Building footprints ([1,1]|[1,2]|[2,2]) sit inside their parcel; the
       leftover parcel tiles become yard.
   Citizens walk ONLY on the perimeter ring of a block (28 ordered road
   tiles) — the invariant that keeps depth sorting trivially correct.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const B = C.BLOCK_TILES;

  // ---- Mirror state ----------------------------------------------------------
  const districts = new Map(); // key -> district (server shape, with lots[])
  const lotsById = new Map();  // lot.id -> lot (so a worker can find its building)
  let groundVersion = 0;       // bumped when blocks appear (static layer rebuild)
  let maxFloorsSeen = 4;       // for bounds padding

  function reset() {
    districts.clear();
    lotsById.clear();
    groundVersion++;
  }

  /** Replace the whole mirror from a { version, districts } city snapshot. */
  function applyCity(city) {
    districts.clear();
    lotsById.clear();
    for (const d of (city && city.districts) || []) {
      if (!d || typeof d.key !== 'string') continue;
      districts.set(d.key, d);
      for (const lot of d.lots || []) { noteFloors(lot); if (lot && lot.id) lotsById.set(lot.id, lot); }
    }
    groundVersion++;
  }

  /**
   * Apply a cityDelta. Returns { event, lot, district } so the renderer can
   * trigger effects (topping-out flash, smoke, ...). Idempotent: the delta
   * carries the full lot record.
   */
  function applyCityDelta(msg) {
    if (!msg || !msg.districtKey || !msg.lot) return null;
    let d = districts.get(msg.districtKey);
    if (!d) {
      if (!msg.district) return null; // progress for an unknown district; snapshot will heal
      d = Object.assign({ lots: [] }, msg.district);
      districts.set(msg.districtKey, d);
      groundVersion++;
    } else if (msg.district) {
      const hadBlocks = (d.blocks || []).length;
      Object.assign(d, msg.district, { lots: d.lots });
      if ((d.blocks || []).length !== hadBlocks) groundVersion++;
    }
    const lot = msg.lot;
    const prev = d.lots[lot.index];
    d.lots[lot.index] = lot;
    if (lot.id) lotsById.set(lot.id, lot);
    noteFloors(lot);
    if (!prev && msg.event !== 'groundbreak') groundVersion++; // healed gap
    return { event: msg.event, lot, district: d };
  }

  function noteFloors(lot) {
    const f = lot && lot.building && lot.building.floors;
    if (typeof f === 'number' && f > maxFloorsSeen) maxFloorsSeen = f;
  }

  // ---- Lookups ----------------------------------------------------------------
  function districtByKey(key) { return districts.get(key) || null; }
  function lotById(id) { return (id && lotsById.get(id)) || null; }

  function activeLot(d) {
    if (!d || !d.lots || !d.lots.length) return null;
    const last = d.lots[d.lots.length - 1];
    return last && last.state === 'construction' ? last : null;
  }

  function usedBlocks() {
    const out = new Set();
    for (const d of districts.values()) for (const b of d.blocks || []) out.add(b);
    return [...out];
  }

  // ---- Organic growth ----------------------------------------------------------
  // A city grows on two fronts at once. Below the density target it's a coin
  // flip between opening a new frontier block and infilling an existing one, so
  // the footprint expands in step with neighborhoods filling out. Infill still
  // prefers the denser core so suburbs stay comparatively sparse.
  // MIRROR of server/city.js (chooseSite / pickExpansionSlot / weightedPick) —
  // change both together.
  const SPREAD_TARGET = 3;          // avg buildings/block before infill beats expansion
  const EXPAND_PROB = 0.5;          // balanced: ~50/50 new frontier block vs. infill existing community
  const INFILL_EXPAND_PROB = 0.12;  // once a block is dense, opening a new one is rare
  const HOOD_INFILL_W = { downtown: 6, inner: 4, upper: 3, middle: 3, working: 2.5, rural: 0.7 };
  const PARCEL_W = [1, 2, 1, 2, 4, 2, 1, 2, 1]; // center-out infill preference
  // Multi-nucleus growth: the metro is NOT one contiguous blob spreading
  // center-out. It is a downtown CORE plus detached SATELLITE TOWNS — inner
  // suburbs and far-flung farm communities — founded across a real GAP and tied
  // back to the core by freeways (see infra.js connectors). Each town grows from
  // its OWN edge toward its OWN centre so the gaps between towns persist (the
  // Southern-California look). MIRROR of server/city.js — change both together.
  const SATELLITE_PROB = 0.10;      // chance an expansion founds a NEW detached town (lower: grow the towns we have, don't keep spawning lone parcels)
  const SATELLITE_GAP = 2;          // empty blocks between a new town and the core's edge
  const SATELLITE_MIN_BLOCKS = 4;   // the core needs a footing before it spins off towns
  const TOWN_PULL = 1.3;            // pull toward a town's OWN centre -> compact communities
  const SUBURB_TARGET = 6;          // blocks a satellite should reach to read as a REAL town (not a lone parcel)
  const SUBURB_BOOST = 3;           // how hard expansion favors an under-built satellite, fading to parity at SUBURB_TARGET

  /** block slot -> Set(parcel index) currently occupied, from a district's lots. */
  function parcelUsage(d) {
    const used = new Map();
    for (const lot of (d && d.lots) || []) {
      if (!lot) continue;
      let s = used.get(lot.block);
      if (!s) { s = new Set(); used.set(lot.block, s); }
      s.add(lot.parcel);
    }
    return used;
  }

  /** Seeded weighted pick over `items`; weightOf(item) -> non-negative weight. */
  function weightedPick(items, weightOf, seed) {
    let total = 0;
    for (const it of items) total += weightOf(it);
    if (total <= 0) return items[0];
    let roll = ((seed >>> 0) % 100000) / 100000 * total;
    for (const it of items) {
      roll -= weightOf(it);
      if (roll < 0) return it;
    }
    return items[items.length - 1];
  }

  /**
   * Partition built blocks into TOWNS (8-connected clusters); the CORE is the
   * cluster at the origin, every other is a detached satellite town. MIRROR of
   * server/city.js clusterTowns().
   */
  function clusterTowns(usedSlots) {
    const C = window.CITY;
    const pts = [];
    const idx = new Map();
    for (const s of usedSlots) {
      const { bx, by } = C.spiralSlot(s);
      idx.set(bx + ',' + by, pts.length);
      pts.push({ bx, by });
    }
    const parent = pts.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const j = idx.get((p.bx + dx) + ',' + (p.by + dy));
        if (j !== undefined) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
      }
    }
    const towns = new Map();
    for (let i = 0; i < pts.length; i++) {
      const r = find(i);
      let t = towns.get(r);
      if (!t) { t = { cells: [], sx: 0, sy: 0 }; towns.set(r, t); }
      t.cells.push(pts[i]); t.sx += pts[i].bx; t.sy += pts[i].by;
    }
    const out = [];
    for (const t of towns.values()) {
      out.push({ cells: t.cells, cx: t.sx / t.cells.length, cy: t.sy / t.cells.length, size: t.cells.length });
    }
    return out;
  }

  /** Empty, free 8-neighbour block cells around a town's built cells. */
  function frontierOf(town, usedPos, isFree) {
    const C = window.CITY;
    const list = [];
    const seen = new Set();
    for (const c of town.cells) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = c.bx + dx, ny = c.by + dy, k = nx + ',' + ny;
        if (usedPos.has(k) || seen.has(k)) continue;
        seen.add(k);
        const slot = C.slotForPos(nx, ny);
        if (isFree(slot)) list.push({ slot, bx: nx, by: ny });
      }
    }
    return list;
  }

  /**
   * Found a NEW detached town along a seeded compass corridor, a real GAP past
   * the core's edge with a clear 3x3 around it. -1 if no corridor has room.
   * MIRROR of server/city.js foundSatellite().
   */
  function foundSatellite(usedPos, coreRing, seed, isFree) {
    const C = window.CITY;
    const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const dist = coreRing + SATELLITE_GAP + (seed % 3);
    for (let a = 0; a < DIRS.length; a++) {
      const di = (((seed >>> 5) % DIRS.length) + a) % DIRS.length;
      const bx = DIRS[di][0] * dist, by = DIRS[di][1] * dist;
      let blocked = false;
      for (let ex = -1; ex <= 1 && !blocked; ex++) for (let ey = -1; ey <= 1; ey++) {
        if (usedPos.has((bx + ex) + ',' + (by + ey))) blocked = true;
      }
      if (blocked) continue;
      const slot = C.slotForPos(bx, by);
      if (isFree(slot)) return slot;
    }
    return -1;
  }

  /**
   * Pick a NEW (empty) block for the city to grow onto. The metro grows as MANY
   * towns, not one blob: with probability SATELLITE_PROB found a fresh detached
   * town out past the core; otherwise extend an existing town from its own edge,
   * pulled toward that town's centre so each stays compact and the inter-town
   * gaps persist (near towns read as suburbs, far ones as farmland). `isFree`
   * guards a claimed slot. MIRROR of server/city.js pickExpansionSlot().
   */
  function pickExpansionSlot(usedSlots, seed, isFree) {
    const C = window.CITY;
    const usedPos = new Set();
    for (const s of usedSlots) { const { bx, by } = C.spiralSlot(s); usedPos.add(bx + ',' + by); }
    const towns = clusterTowns(usedSlots);
    let core = null;
    for (const t of towns) if (t.cells.some((c) => c.bx === 0 && c.by === 0)) { core = t; break; }
    if (!core) for (const t of towns) if (!core || t.size > core.size) core = t;
    let coreRing = 0;
    if (core) for (const c of core.cells) coreRing = Math.max(coreRing, Math.abs(c.bx), Math.abs(c.by));

    if (usedSlots.length >= SATELLITE_MIN_BLOCKS && (seed % 1000) / 1000 < SATELLITE_PROB) {
      const slot = foundSatellite(usedPos, coreRing, seed, isFree);
      if (slot >= 0) return slot;
    }

    // The core leads (sqrt of size) but an under-built satellite gets a catch-up
    // boost so it accretes into a real multi-block town instead of freezing at a
    // lone parcel; the boost fades to nothing as it nears SUBURB_TARGET blocks.
    const town = weightedPick(towns, (t) => {
      const base = 0.5 + Math.sqrt(t.size);
      if (t === core) return base;
      const deficit = Math.max(0, SUBURB_TARGET - t.size) / SUBURB_TARGET;
      return base * (1 + SUBURB_BOOST * deficit);
    }, seed >>> 9);
    let list = frontierOf(town, usedPos, isFree);
    if (!list.length) {
      for (const t of towns) for (const c of frontierOf(t, usedPos, isFree)) list.push(c);
    }
    if (!list.length) { let s = 0; while (!isFree(s)) s++; return s; }
    return weightedPick(list, (c) => {
      const d = Math.hypot(c.bx - town.cx, c.by - town.cy);
      const pull = 1 + TOWN_PULL / (1 + d);
      const jit = 0.35 + ((C.hash32('exp:' + c.bx + ',' + c.by + ':' + seed) % 1000) / 1000) * 0.65;
      return pull * jit;
    }, seed >>> 3).slot;
  }

  /**
   * Decide where the next building breaks ground. Returns { blockSlot, parcel }
   * and MUTATES d.blocks when it grows onto a new block. `isFree(slot)` reports
   * whether a slot is unclaimed (across all districts). Reads only d.lots, so it
   * works mid-stream before the new lot is pushed.
   */
  function chooseSite(d, seed, isFree) {
    const C = window.CITY;
    const n = (d.lots || []).length;
    const used = parcelUsage(d);
    const infill = (d.blocks || []).filter((b) => {
      const s = used.get(b);
      return (s ? s.size : 0) < C.LOTS_PER_BLOCK;
    });
    const avgOcc = n / Math.max(1, (d.blocks || []).length);
    const r = (seed % 1000) / 1000;
    const expandProb = avgOcc < SPREAD_TARGET ? EXPAND_PROB : INFILL_EXPAND_PROB;
    let blockSlot;
    if (infill.length === 0 || r < expandProb) {
      blockSlot = pickExpansionSlot(d.blocks || [], seed, isFree);
      d.blocks.push(blockSlot);
    } else {
      blockSlot = weightedPick(infill, (b) => HOOD_INFILL_W[C.neighborhoodFor(b).klass] || 1, seed >>> 7);
    }
    const taken = used.get(blockSlot);
    const free = [];
    for (let p = 0; p < C.LOTS_PER_BLOCK; p++) if (!taken || !taken.has(p)) free.push(p);
    const parcel = weightedPick(free, (p) => PARCEL_W[p] || 1, seed >>> 13);
    return { blockSlot, parcel };
  }

  // ---- Layout solver ------------------------------------------------------------

  /** NW tile of a parcel (0..8, serpentine over the 3x3 interior grid). */
  function parcelOrigin(blockSlot, parcel) {
    const o = C.blockOrigin(blockSlot);
    const r = Math.floor(parcel / C.PARCEL_GRID);
    let c = parcel % C.PARCEL_GRID;
    if (r % 2 === 1) c = C.PARCEL_GRID - 1 - c;
    return { tx: o.tx + 1 + c * 2, ty: o.ty + 1 + r * 2 };
  }

  /** Building tile origin + footprint for a lot (seed places it in its parcel). */
  function lotPlacement(lot) {
    const p = parcelOrigin(lot.block, lot.parcel);
    const fp = (lot.building && lot.building.footprint) || [1, 1];
    const w = fp[0], dpt = fp[1];
    const seed = (lot.building && lot.building.seed) || 0;
    const ox = w < 2 ? (seed & 1) : 0;
    const oy = dpt < 2 ? ((seed >> 1) & 1) : 0;
    return { tx: p.tx + ox, ty: p.ty + oy, w, d: dpt, parcelTx: p.tx, parcelTy: p.ty };
  }

  /**
   * Ordered perimeter road tiles of a block (28 tiles, clockwise from the NW
   * corner). Citizens live exclusively on these.
   */
  const ringCache = new Map();
  function ringTiles(blockSlot) {
    let ring = ringCache.get(blockSlot);
    if (ring) return ring;
    const o = C.blockOrigin(blockSlot);
    ring = [];
    for (let i = 0; i < B; i++) ring.push({ tx: o.tx + i, ty: o.ty });            // top
    for (let i = 1; i < B; i++) ring.push({ tx: o.tx + B - 1, ty: o.ty + i });    // right
    for (let i = B - 2; i >= 0; i--) ring.push({ tx: o.tx + i, ty: o.ty + B - 1 }); // bottom
    for (let i = B - 2; i >= 1; i--) ring.push({ tx: o.tx, ty: o.ty + i });       // left
    ringCache.set(blockSlot, ring);
    return ring;
  }

  /** Ring index whose tile is closest to a given tile position. */
  function ringIndexNearest(blockSlot, tx, ty) {
    const ring = ringTiles(blockSlot);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const d = Math.abs(ring[i].tx - tx) + Math.abs(ring[i].ty - ty);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** World-space (screen px, pre-camera) bounding rect of the whole city. */
  function worldBounds() {
    const blocks = usedBlocks();
    if (blocks.length === 0) blocks.push(0);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const slot of blocks) {
      const o = C.blockOrigin(slot);
      for (const [cx, cy] of [[0, 0], [B, 0], [0, B], [B, B]]) {
        const p = C.worldToScreen(o.tx + cx, o.ty + cy, 0);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    // include the ambient infrastructure (beltway, rail loop, airport) so the
    // camera autofit frames the whole metro, not just the built blocks.
    if (C.infra && C.infra.screenExtent) {
      const e = C.infra.screenExtent();
      if (e.minX < minX) minX = e.minX;
      if (e.minY < minY) minY = e.minY;
      if (e.maxX > maxX) maxX = e.maxX;
      if (e.maxY > maxY) maxY = e.maxY;
    }
    minY -= maxFloorsSeen * C.FLOOR_H + C.TILE_H; // room for the tallest tower
    return { minX, minY, maxX, maxY };
  }

  Object.assign(window.CITY, {
    districts,
    cityReset: reset,
    applyCity,
    applyCityDelta,
    districtByKey,
    lotById,
    activeLot,
    usedBlocks,
    parcelUsage,
    chooseSite,
    parcelOrigin,
    lotPlacement,
    ringTiles,
    ringIndexNearest,
    worldBounds,
    getGroundVersion: () => groundVersion,
  });
})();
