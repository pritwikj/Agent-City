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
    parcelOrigin,
    lotPlacement,
    ringTiles,
    ringIndexNearest,
    worldBounds,
    getGroundVersion: () => groundVersion,
  });
})();
