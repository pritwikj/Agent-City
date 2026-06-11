/* ===========================================================================
   infra.js — geometry AND construction state for the city's ambient
   INFRASTRUCTURE: the highway beltway, the commuter rail loop, and the airport.

   NOTHING here "just appears". Every network is BUILT UP, paid for by the
   city's accumulated work (Σ district.totalWork — the same persisted unit that
   raises buildings). A young city paves its beltway edge-by-edge, then lays its
   rail loop, then constructs its airport; an established city already has them
   (its workers built them over many work units before the page loaded). The
   draw modules (highway/rail/airport.js) read this state to render finished
   spans, active roadworks, and the equipment at each work front.

   Build order is a single sequential pipeline gated by city size:
     beltway (always) → rail loop (≥4 blocks) → airport (≥6 blocks)

   The beltway, once an edge is paved, becomes REAL ROAD: its tiles (plus a ramp
   to the nearest block) are published via drivableTiles() and folded into the
   pathgraph, so ordinary traffic drives on it. roadVersion() bumps whenever a
   new edge opens so the graph rebuilds.

   Geometry (corners/loops/airport rect) is cached on the ground version; the
   cheap construction state is recomputed whenever the work total changes.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const B = C.BLOCK_TILES;

  // ---- Tunables -------------------------------------------------------------
  const BELT_MARGIN = 2;            // highway ring, tiles outside the blocks
  const RAIL_MARGIN = 5;            // rail loop, further out
  const RAIL_MIN_BLOCKS = 4;
  const AIRPORT_MIN_BLOCKS = 6;
  const AF_GAP = 3;                 // tiles past the rail loop's east edge
  const AF_LEN = 14;               // runway length (along +tx)
  const AF_HALF = 4;               // airfield half-depth (along ty)

  // Work (Σ totalWork units) to construct each piece.
  const HW_EDGE_WORK = 30;          // per beltway edge (×4 = a full ring)
  const RAIL_EDGE_WORK = 30;        // per rail edge
  const AIRPORT_WORK = 180;         // whole airfield, staged
  const HW_TOTAL = HW_EDGE_WORK * 4;
  const RAIL_TOTAL = RAIL_EDGE_WORK * 4;

  let builtVersion = -1;
  let ver = 0;
  let geo = null;

  let lastWork = -1;
  let con = null;
  let roadVer = 0;
  let lastBuiltEdges = 0;

  // ---- Geometry (cached on ground version) ----------------------------------
  function computeCityBounds() {
    let blocks = C.usedBlocks();
    if (!blocks.length) blocks = [0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const slot of blocks) {
      const o = C.blockOrigin(slot);
      if (o.tx < x0) x0 = o.tx;
      if (o.ty < y0) y0 = o.ty;
      if (o.tx + B - 1 > x1) x1 = o.tx + B - 1;   // inclusive max tile
      if (o.ty + B - 1 > y1) y1 = o.ty + B - 1;
    }
    return { x0, y0, x1, y1, blocks: blocks.length };
  }

  function rect(m, b) {
    return [
      { tx: b.x0 - m, ty: b.y0 - m },   // 0 NW
      { tx: b.x1 + m, ty: b.y0 - m },   // 1 NE
      { tx: b.x1 + m, ty: b.y1 + m },   // 2 SE
      { tx: b.x0 - m, ty: b.y1 + m },   // 3 SW
    ];
  }

  function loopMetrics(corners) {
    const seg = [];
    let total = 0;
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], c = corners[(i + 1) % corners.length];
      const L = Math.hypot(c.tx - a.tx, c.ty - a.ty);
      seg.push(L); total += L;
    }
    return { seg, total };
  }

  function rebuildGeo() {
    const b = computeCityBounds();
    const beltCorners = rect(BELT_MARGIN, b);
    const belt = Object.assign({ corners: beltCorners }, loopMetrics(beltCorners));
    let rail = null;
    if (b.blocks >= RAIL_MIN_BLOCKS) {
      const rc = rect(RAIL_MARGIN, b);
      rail = Object.assign({ corners: rc }, loopMetrics(rc));
    }
    let airport = null;
    if (b.blocks >= AIRPORT_MIN_BLOCKS) {
      const yc = Math.round((b.y0 + b.y1) / 2);
      const ax0 = b.x1 + RAIL_MARGIN + AF_GAP;
      airport = {
        x0: ax0, x1: ax0 + AF_LEN, y0: yc - AF_HALF, y1: yc + AF_HALF,
        cx: ax0 + AF_LEN / 2, cy: yc,
        runY: yc, runX0: ax0 + 1.5, runX1: ax0 + AF_LEN - 1.5,
      };
    }
    geo = { b, belt, rail, airport };
    builtVersion = C.getGroundVersion();
    ver++;
    lastWork = -1; // force construction recompute against the new geometry
  }

  function ensure() {
    if (!geo || builtVersion !== C.getGroundVersion()) rebuildGeo();
    return geo;
  }

  // ---- Construction state (recomputed when work changes) --------------------
  function cityWork() {
    let w = 0;
    for (const d of C.districts.values()) w += d.totalWork || 0;
    return w;
  }

  // Integer tiles along an axis-aligned edge between two corner tiles.
  function edgeTiles(a, b) {
    const out = [];
    const x0 = Math.round(a.tx), y0 = Math.round(a.ty);
    const x1 = Math.round(b.tx), y1 = Math.round(b.ty);
    if (y0 === y1) { const s = Math.sign(x1 - x0) || 1; for (let x = x0; x !== x1 + s; x += s) out.push({ tx: x, ty: y0 }); }
    else { const s = Math.sign(y1 - y0) || 1; for (let y = y0; y !== y1 + s; y += s) out.push({ tx: x0, ty: y }); }
    return out;
  }

  // A short ramp from the midpoint of beltway edge i inward to the block ring,
  // so cars can get on/off the highway.
  function rampTiles(b, i) {
    const mx = Math.round((b.x0 + b.x1) / 2), my = Math.round((b.y0 + b.y1) / 2);
    const out = [];
    if (i === 0) for (let y = b.y0 - BELT_MARGIN + 1; y <= b.y0 - 1; y++) out.push({ tx: mx, ty: y }); // N
    else if (i === 1) for (let x = b.x1 + 1; x <= b.x1 + BELT_MARGIN - 1; x++) out.push({ tx: x, ty: my }); // E
    else if (i === 2) for (let y = b.y1 + 1; y <= b.y1 + BELT_MARGIN - 1; y++) out.push({ tx: mx, ty: y }); // S
    else for (let x = b.x0 - BELT_MARGIN + 1; x <= b.x0 - 1; x++) out.push({ tx: x, ty: my });           // W
    return out;
  }

  function computeConstruction() {
    const g = ensure();
    const w = cityWork();
    if (con && w === lastWork) return con;
    lastWork = w;

    // 1) Highway
    const hwWork = Math.max(0, Math.min(HW_TOTAL, w));
    const hwBuiltEdges = Math.min(4, Math.floor(hwWork / HW_EDGE_WORK));
    const hwActiveEdge = hwBuiltEdges < 4 ? hwBuiltEdges : -1;
    const hwActiveFrac = hwActiveEdge >= 0 ? (hwWork - hwBuiltEdges * HW_EDGE_WORK) / HW_EDGE_WORK : 1;
    const highway = {
      corners: g.belt.corners, seg: g.belt.seg, total: g.belt.total,
      builtEdges: hwBuiltEdges, activeEdge: hwActiveEdge, activeFrac: hwActiveFrac,
      complete: hwBuiltEdges >= 4,
    };

    // 2) Rail (only once the highway is done and the city is big enough)
    let rail = null;
    if (g.rail) {
      const railWork = highway.complete ? Math.max(0, Math.min(RAIL_TOTAL, w - HW_TOTAL)) : 0;
      const rb = Math.min(4, Math.floor(railWork / RAIL_EDGE_WORK));
      const ra = rb < 4 ? rb : -1;
      rail = {
        corners: g.rail.corners, seg: g.rail.seg, total: g.rail.total,
        builtEdges: rb, activeEdge: ra,
        activeFrac: ra >= 0 ? (railWork - rb * RAIL_EDGE_WORK) / RAIL_EDGE_WORK : 1,
        complete: rb >= 4,
      };
    }

    // 3) Airport (only once rail is done)
    let airport = null;
    if (g.airport) {
      const railDone = !g.rail || (rail && rail.complete);
      const aw = railDone ? Math.max(0, Math.min(AIRPORT_WORK, w - HW_TOTAL - RAIL_TOTAL)) : 0;
      airport = Object.assign({}, g.airport, { progress: aw / AIRPORT_WORK, complete: aw >= AIRPORT_WORK });
    }

    // Publish drivable highway tiles (completed edges + their ramps) and bump
    // the road version when the count of open edges changes.
    const tiles = [];
    for (let i = 0; i < highway.builtEdges; i++) {
      const a = g.belt.corners[i], b = g.belt.corners[(i + 1) % 4];
      for (const t of edgeTiles(a, b)) tiles.push(t);
      for (const t of rampTiles(g.b, i)) tiles.push(t);
    }
    if (highway.builtEdges !== lastBuiltEdges) { lastBuiltEdges = highway.builtEdges; roadVer++; }

    con = { highway, rail, airport, drivable: tiles };
    return con;
  }

  // ---- Public API -----------------------------------------------------------
  function screenExtent() {
    const g = ensure();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const acc = (tx, ty) => {
      const p = C.worldToScreen(tx, ty, 0);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    };
    for (const pt of g.belt.corners) acc(pt.tx, pt.ty);
    if (g.rail) for (const pt of g.rail.corners) acc(pt.tx, pt.ty);
    if (g.airport) { const a = g.airport; acc(a.x0, a.y0); acc(a.x1, a.y0); acc(a.x1, a.y1); acc(a.x0, a.y1); }
    return { minX, minY, maxX, maxY };
  }

  // Position + heading at arc-length s along a closed corner loop.
  function posOnLoop(loop, s) {
    const total = loop.total || 1;
    s = ((s % total) + total) % total;
    for (let i = 0; i < loop.corners.length; i++) {
      const L = loop.seg[i];
      if (s <= L || i === loop.corners.length - 1) {
        const a = loop.corners[i], b = loop.corners[(i + 1) % loop.corners.length];
        const t = L > 1e-6 ? s / L : 0;
        const dx = b.tx - a.tx, dy = b.ty - a.ty;
        const m = Math.hypot(dx, dy) || 1;
        return { tx: a.tx + dx * t, ty: a.ty + dy * t, dirx: dx / m, diry: dy / m };
      }
      s -= L;
    }
    const a = loop.corners[0];
    return { tx: a.tx, ty: a.ty, dirx: 1, diry: 0 };
  }

  // Arc-length at the end of beltway/rail edge i (for marking built spans).
  function lenToEdge(loop, edges) {
    let s = 0;
    for (let i = 0; i < edges; i++) s += loop.seg[i];
    return s;
  }

  C.infra = {
    ensure,
    version: () => ver,
    cityBounds: () => ensure().b,
    cityWork,
    highway: () => computeConstruction().highway,
    rail: () => computeConstruction().rail,
    airport: () => computeConstruction().airport,
    drivableTiles: () => computeConstruction().drivable,
    roadVersion: () => { computeConstruction(); return roadVer; },
    screenExtent,
    posOnLoop,
    lenToEdge,
    constants: { BELT_MARGIN, HW_EDGE_WORK },
  };
})();
