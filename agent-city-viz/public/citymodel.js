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
  // A city does NOT pack one block to capacity before breaking ground on the
  // next — it sprawls. New buildings open frontier blocks while those are still
  // mostly empty, and infill prefers the denser core so suburbs stay sparse.
  // MIRROR of server/city.js (chooseSite / pickExpansionSlot / weightedPick) —
  // change both together.
  const SPREAD_TARGET = 3;          // avg buildings/block before infill beats expansion
  const EXPAND_PROB = 0.78;         // strong frontier bias -> sprawl (~1.3 bldgs/block steady state)
  const INFILL_EXPAND_PROB = 0.12;  // once a block is dense, opening a new one is rare
  const HOOD_INFILL_W = { downtown: 6, inner: 4, upper: 3, middle: 3, working: 2.5, rural: 0.7 };
  const PARCEL_W = [1, 2, 1, 2, 4, 2, 1, 2, 1]; // center-out infill preference
  // Frontier-growth knobs: expansion grows from the EDGES of existing blocks in
  // seeded-random directions (NOT strictly inward-out along the spiral), so the
  // build ORDER is organic — a suburb pocket can develop before downtown, and
  // vice-versa. The density gradient still emerges later, from infill weighting.
  const LEAP_PROB = 0.11;           // chance a new block founds a detached satellite town
  const INWARD_PULL = 0.9;          // light centering — loose enough to let the metro sprawl outward

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
   * Pick a NEW (empty) block for the city to grow onto. Grows from the edges of
   * existing development in a seeded-random direction — not strictly inward-out
   * — so neighborhoods come up in an organic order. `isFree(slot)` guards against
   * reusing a claimed slot. MIRROR of server/city.js pickExpansionSlot().
   */
  function pickExpansionSlot(usedSlots, seed, isFree) {
    const C = window.CITY;
    const usedPos = new Set();
    let maxRing = 0;
    for (const s of usedSlots) {
      const { bx, by } = C.spiralSlot(s);
      usedPos.add(bx + ',' + by);
      maxRing = Math.max(maxRing, Math.abs(bx), Math.abs(by));
    }
    // satellite leap: occasionally found a detached settlement out past the edge
    if ((seed % 100) / 100 < LEAP_PROB) {
      const r = maxRing + 1 + (seed % 3);
      const ang = ((seed >>> 5) % 360) * Math.PI / 180;
      const bx = Math.round(r * Math.cos(ang)), by = Math.round(r * Math.sin(ang));
      if (!usedPos.has(bx + ',' + by)) {
        const slot = C.slotForPos(bx, by);
        if (isFree(slot)) return slot;
      }
    }
    // frontier candidates: empty 8-neighbours of any built cell
    const list = [];
    const seen = new Set();
    for (const s of usedSlots) {
      const { bx, by } = C.spiralSlot(s);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = bx + dx, ny = by + dy, k = nx + ',' + ny;
        if (usedPos.has(k) || seen.has(k)) continue;
        seen.add(k);
        const slot = C.slotForPos(nx, ny);
        if (isFree(slot)) list.push({ slot, bx: nx, by: ny });
      }
    }
    if (!list.length) { let s = 0; while (!isFree(s)) s++; return s; }
    // gentle inward pull (keeps the metro centred) x per-cell seeded jitter (so
    // the growth direction varies) — deliberately NO downtown class bias here,
    // so the build ORDER is organic; density bias lives in infill instead.
    return weightedPick(list, (c) => {
      const ring = Math.max(Math.abs(c.bx), Math.abs(c.by));
      const pull = 1 + INWARD_PULL / (1 + ring);
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
