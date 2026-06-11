/* ===========================================================================
   pathgraph.js — the connected, city-wide street network + A* router that
   pedestrians (population.js) and vehicles (traffic.js) move on.

   The walkable network is the union of every block's PERIMETER RING (the 28
   road tiles returned by C.ringTiles). Rings of physically-adjacent blocks sit
   one tile apart (blocks are placed flush at multiples of BLOCK_TILES), so two
   ring tiles that are Manhattan-adjacent are simply linked — this both closes
   each block's loop AND stitches neighbouring blocks together across the street
   seam, with no special-casing of the spiral's non-consecutive slot numbers.

   One shared graph; people and cars are separated visually by a perpendicular
   LANE OFFSET (people hug the curb/sidewalk side, cars ride the road) rather
   than by separate node sets — the inner 6x6 of every block is parcels, so
   there is no building-free tile lane to route a second graph through.

   Rebuilt only when the city grows (C.getGroundVersion() changes). Paths are
   A* with a Manhattan heuristic, LRU-cached, and rationed by a per-frame search
   budget so a burst of arrivals can never spike a frame.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const OFF = 20000, MUL = 40000;            // pack (tx,ty) -> int (huge headroom)
  function pack(tx, ty) { return (tx + OFF) * MUL + (ty + OFF); }

  const nodes = new Map();                    // id -> { id, tx, ty, nbrs:[id] }
  let builtVersion = -1;
  let version = 0;

  const cache = new Map();                    // 'startId_goalId' -> [{tx,ty}]
  const CACHE_CAP = 2000;
  const MAX_EXP = 6000;                       // A* expansion cap (best-effort beyond)

  let frameBudget = 0;                        // A* searches allowed this frame

  // ---- Build ----------------------------------------------------------------
  function build() {
    nodes.clear();
    cache.clear();
    const blocks = new Set(C.usedBlocks());
    blocks.add(0); // origin block always exists
    for (const slot of blocks) {
      for (const t of C.ringTiles(slot)) {
        const id = pack(t.tx, t.ty);
        if (!nodes.has(id)) nodes.set(id, { id, tx: t.tx, ty: t.ty, nbrs: [] });
      }
    }
    for (const n of nodes.values()) {
      for (const [dx, dy] of DIRS) {
        const nid = pack(n.tx + dx, n.ty + dy);
        if (nodes.has(nid)) n.nbrs.push(nid);
      }
    }
    builtVersion = C.getGroundVersion();
    version++;
  }

  function ensureBuilt() {
    if (nodes.size === 0 || builtVersion !== C.getGroundVersion()) build();
  }

  // ---- Lookups --------------------------------------------------------------
  function nearestNode(tx, ty) {
    const cx = Math.round(tx), cy = Math.round(ty);
    let n = nodes.get(pack(cx, cy));
    if (n) return n;
    for (let r = 1; r <= 10; r++) {            // expanding Chebyshev shell
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          n = nodes.get(pack(cx + dx, cy + dy));
          if (n) return n;
        }
      }
    }
    return null;
  }

  // ---- Min-heap (binary, keyed by f-score) ----------------------------------
  function MinHeap() {
    const a = [];
    this.size = function () { return a.length; };
    this.push = function (id, f) {
      a.push({ id, f });
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p].f <= a[i].f) break;
        const tmp = a[p]; a[p] = a[i]; a[i] = tmp; i = p;
      }
    };
    this.pop = function () {
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = 2 * i + 2; let m = i;
          if (l < a.length && a[l].f < a[m].f) m = l;
          if (r < a.length && a[r].f < a[m].f) m = r;
          if (m === i) break;
          const tmp = a[m]; a[m] = a[i]; a[i] = tmp; i = m;
        }
      }
      return top.id;
    };
  }

  function heur(a, b) { return Math.abs(a.tx - b.tx) + Math.abs(a.ty - b.ty); }

  function reconstruct(came, endId) {
    const out = [];
    let cur = endId;
    while (cur != null) {
      const n = nodes.get(cur);
      out.push({ tx: n.tx, ty: n.ty });
      cur = came.has(cur) ? came.get(cur) : null;
    }
    out.reverse();
    return out;
  }

  /**
   * Path between two world tiles as a list of {tx,ty} ring-tile waypoints.
   * Returns null when the graph isn't ready, the endpoints can't snap, or the
   * per-frame search budget is spent on a cache miss (caller retries later).
   */
  function findPath(ax, ay, bx, by, force) {
    ensureBuilt();
    const start = nearestNode(ax, ay);
    const goal = nearestNode(bx, by);
    if (!start || !goal) return null;
    if (start.id === goal.id) return [{ tx: start.tx, ty: start.ty }];

    const ck = start.id + '_' + goal.id;
    const hit = cache.get(ck);
    if (hit) { cache.delete(ck); cache.set(ck, hit); return hit.slice(); }
    if (!force && frameBudget <= 0) return null; // defer the expensive search
    if (!force) frameBudget--;

    const open = new MinHeap();
    const g = new Map();
    const came = new Map();
    const closed = new Set();
    g.set(start.id, 0);
    open.push(start.id, heur(start, goal));
    let best = start, bestH = heur(start, goal), found = false, exp = 0;

    while (open.size() && exp < MAX_EXP) {
      const cur = open.pop();
      if (cur === goal.id) { found = true; break; }
      if (closed.has(cur)) continue;
      closed.add(cur);
      exp++;
      const node = nodes.get(cur);
      const h = heur(node, goal);
      if (h < bestH) { bestH = h; best = node; }
      const gc = g.get(cur);
      for (const nid of node.nbrs) {
        const ng = gc + 1;
        const prev = g.has(nid) ? g.get(nid) : Infinity;
        if (ng < prev) {
          g.set(nid, ng);
          came.set(nid, cur);
          open.push(nid, ng + heur(nodes.get(nid), goal));
        }
      }
    }

    const path = reconstruct(came, found ? goal.id : best.id);
    if (found) {
      cache.set(ck, path);
      if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
    }
    return path.slice();
  }

  // ---- Per-frame budget -----------------------------------------------------
  function resetBudget(n) { frameBudget = n; }

  C.graph = {
    ensureBuilt,
    findPath,
    nearestNode,
    resetBudget,
    graphVersion: function () { return version; },
    nodeCount: function () { return nodes.size; },
  };
})();
