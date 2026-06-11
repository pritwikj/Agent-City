/* ===========================================================================
   traffic.js — cars and public transit on the shared street graph.

   Cars: spawned on the road network, their count and quality biased by each
   block's neighborhood (more, nicer, taxi-heavy downtown/uptown; fewer, older
   in the working/inner city). They A*-route block to block, ride the road with
   a right-of-travel lane offset (so opposing flows separate into two-way), and
   recycle to a fresh trip on arrival.

   Buses: a couple of looping routes stitched (via A*) between the city's
   transit-type buildings, dwelling briefly at each station; if the city has no
   stations yet they simply circle the downtown core.

   Drawn as small oriented iso boxes, depth-sorted into the same frame list as
   buildings and pedestrians. Client-side and ambient — no server involvement.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const canvas = document.getElementById('city-canvas');

  // ---- Tunables -------------------------------------------------------------
  const CAR_OFFSET = 0.16;         // tiles, right of travel (two-way separation)
  const RECALC_MS = 1100;
  const CULL_MARGIN = 64;
  const CAR_LEN = 0.62, CAR_WID = 0.3;
  const BUS_LEN = 1.15, BUS_WID = 0.42;

  // Car-following (IDM-lite): cars hold a velocity, accelerate toward a desired
  // speed when clear, and brake for the nearest obstacle ahead on their path —
  // yielding queues, platoons, stop-and-go, and intersection give-way for free.
  const ACCEL = 3.2;               // tiles/s^2 comfortable acceleration
  const BRAKE = 4.6;               // tiles/s^2 comfortable deceleration
  const MIN_GAP = 0.62;            // tiles bumper-to-bumper standstill spacing
  const HEADWAY = 0.85;            // s desired time gap to the leader
  const LOOK_TILES = 4.2;          // distance ahead along path scanned for a leader
  const LOOK_STEPS = 6;            // path waypoints walked while scanning
  const ONCOMING_DOT = -0.3;       // heading·other below this = opposing lane (ignore)
  const TURN_DOT = 0.7;            // heading·next-seg below this = a turn is coming
  const TURN_NORMAL = 1.8;         // tiles/s cap easing round a ~90° corner
  const TURN_HARD = 1.05;          // tiles/s cap for a near-U-turn
  const STEER_RATE = 9;            // heading-lerp rate (1/s); arcs turns vs snapping
  const UNSTICK_MS = 2600;         // creep through a junction after this gridlocked
  const PK_OFF = 20000, PK_MUL = 40000;
  function packTile(tx, ty) { return (tx + PK_OFF) * PK_MUL + (ty + PK_OFF); }

  const NICE_CARS = ['#d8443a', '#2f6fb0', '#e8b53a', '#2a2d33', '#eceef0', '#3a8f5a', '#b0433f'];
  const DULL_CARS = ['#7a7d82', '#5a6a78', '#8a7a5a', '#43474d', '#9a9488', '#6a6f66'];

  // ---- State ----------------------------------------------------------------
  const cars = new Map();
  const buses = [];
  let nextId = 1;
  let lastRecalc = -1e9;
  let routesVersion = -1;
  let allBlocks = [0];
  let targetCars = 0;

  // ---- Recompute (throttled): car budget + bus routes -----------------------
  function recompute(camera) {
    allBlocks = C.usedBlocks(); if (!allBlocks.length) allBlocks = [0];
    let dens = 0;
    for (const s of allBlocks) {
      const prof = C.NEIGHBORHOODS[C.neighborhoodFor(s).klass] || C.NEIGHBORHOODS.middle;
      dens += prof.carDensity;
    }
    // Uncapped: traffic scales with the city's size; the zoom factor is a render
    // level-of-detail, not a cap on how many cars the city can have.
    let t = Math.max(allBlocks.length ? 4 : 0, Math.round(dens * 0.9));
    const z = camera ? camera.zoom : 1;
    if (z < 0.5) t = Math.round(t * 0.4);
    else if (z < 0.8) t = Math.round(t * 0.7);
    targetCars = t;

    if (routesVersion !== C.graph.graphVersion()) {
      buildBusRoutes();
      routesVersion = C.graph.graphVersion();
    }
  }

  // ---- Bus routes -----------------------------------------------------------
  function transitStations() {
    const pts = [];
    for (const d of C.districts.values()) {
      for (const lot of d.lots || []) {
        if (!lot || lot.state !== 'complete' || !lot.building) continue;
        if (lot.building.type !== 'transit') continue;
        const pl = C.lotPlacement(lot);
        const n = C.graph.nearestNode(pl.tx + pl.w / 2, pl.ty + pl.d / 2);
        if (n) pts.push({ tx: n.tx, ty: n.ty });
        if (pts.length >= 6) return pts;
      }
    }
    return pts;
  }

  function stitch(stops) {
    // nearest-neighbour tour, then A* between consecutive stops into one loop.
    const order = [stops[0]];
    const rest = stops.slice(1);
    while (rest.length) {
      const cur = order[order.length - 1];
      let bi = 0, bd = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const dd = Math.abs(rest[i].tx - cur.tx) + Math.abs(rest[i].ty - cur.ty);
        if (dd < bd) { bd = dd; bi = i; }
      }
      order.push(rest.splice(bi, 1)[0]);
    }
    const tiles = [];
    const stationIdx = new Set();
    for (let i = 0; i < order.length; i++) {
      const a = order[i], b = order[(i + 1) % order.length];
      stationIdx.add(tiles.length);
      const seg = C.graph.findPath(a.tx, a.ty, b.tx, b.ty, true);
      if (!seg || seg.length < 2) continue;
      for (let k = 0; k < seg.length - 1; k++) tiles.push(seg[k]);
    }
    return tiles.length >= 3 ? { tiles, stations: stationIdx } : null;
  }

  function buildBusRoutes() {
    buses.length = 0;
    let route = null;
    const stops = transitStations();
    if (stops.length >= 2) route = stitch(stops);
    if (!route) {                                  // fallback: circle the core
      const ring = C.ringTiles(allBlocks[0]);
      route = { tiles: ring.map((t) => ({ tx: t.tx, ty: t.ty })), stations: new Set([0, Math.floor(ring.length / 2)]) };
    }
    const n = Math.max(1, Math.round(route.tiles.length / 26)); // buses scale with route length
    for (let i = 0; i < n; i++) {
      const at = Math.floor((route.tiles.length * i) / n);
      buses.push({
        route, pi: at, tx: route.tiles[at].tx, ty: route.tiles[at].ty,
        dirx: 1, diry: 0, dwellUntil: 0, speed: 2.7,
      });
    }
  }

  // ---- Cars: spawn / advance ------------------------------------------------
  function carColor(slot) {
    const prof = C.NEIGHBORHOODS[C.neighborhoodFor(slot).klass] || C.NEIGHBORHOODS.middle;
    if (Math.random() < prof.taxiProb) return { color: '#f2c014', taxi: true };
    const nice = Math.random() < prof.carQuality;
    const pal = nice ? NICE_CARS : DULL_CARS;
    return { color: pal[(Math.random() * pal.length) | 0], taxi: false };
  }

  function spawnCar() {
    const slot = allBlocks[(Math.random() * allBlocks.length) | 0];
    const ring = C.ringTiles(slot);
    const t = ring[(Math.random() * ring.length) | 0];
    const c = carColor(slot);
    const car = {
      id: 'c' + (nextId++), tx: t.tx, ty: t.ty, dirx: 1, diry: 0,
      path: null, pi: 0,
      vmax: 3.0 + Math.random() * 1.4,   // desired free-flow speed (per-driver)
      v: 0,                              // current speed, tiles/s (starts at rest)
      stuckMs: 0,                        // how long we've been gridlocked at ~0
      color: c.color, taxi: c.taxi, len: CAR_LEN, wid: CAR_WID, alpha: 0,
    };
    cars.set(car.id, car);
  }

  function newCarGoal(car) {
    const slot = allBlocks[(Math.random() * allBlocks.length) | 0];
    const ring = C.ringTiles(slot);
    const g = ring[(Math.random() * ring.length) | 0];
    const path = C.graph.findPath(car.tx, car.ty, g.tx, g.ty);
    if (!path || path.length < 2) return false;
    car.path = path; car.pi = 1;
    return true;
  }

  // --- Spatial hash of cars by rounded tile (rebuilt each frame) -------------
  const grid = new Map();
  function rebuildGrid() {
    grid.clear();
    for (const car of cars.values()) {
      const k = packTile(Math.round(car.tx), Math.round(car.ty));
      let b = grid.get(k);
      if (!b) { b = []; grid.set(k, b); }
      b.push(car);
    }
  }

  // Nearest car ahead along THIS car's own path (so detection follows the road
  // around corners and across the intersection seam). Returns {gap, lv} where
  // gap is bumper-to-bumper distance in tiles and lv the leader's speed; null
  // when the road ahead is clear. Strongly-opposing traffic (the other lane) is
  // ignored; same-direction followers and perpendicular crossers are obstacles.
  function leaderAhead(car) {
    const path = car.path;
    if (!path) return null;
    let acc = 0, px = car.tx, py = car.ty, pi = car.pi;
    let best = null, bestGap = Infinity;
    for (let s = 0; s < LOOK_STEPS && pi < path.length && acc < LOOK_TILES; s++, pi++) {
      const wp = path[pi];
      const bucket = grid.get(packTile(Math.round(wp.tx), Math.round(wp.ty)));
      if (bucket) {
        for (const o of bucket) {
          if (o === car) continue;
          if (o.dirx * car.dirx + o.diry * car.diry < ONCOMING_DOT) continue; // oncoming lane
          const along = acc + Math.hypot(o.tx - px, o.ty - py);
          const gap = along - CAR_LEN;
          if (along > 0.06 && gap < bestGap) { bestGap = gap; best = o; }
        }
      }
      acc += Math.hypot(wp.tx - px, wp.ty - py);
      px = wp.tx; py = wp.ty;
    }
    return best ? { gap: Math.max(0.02, bestGap), lv: best.v } : null;
  }

  // Desired speed for the moment: free-flow vmax, eased down when a turn is
  // coming up so the car rounds corners instead of pivoting in place.
  function desiredSpeed(car) {
    const path = car.path;
    if (!path || car.pi + 1 >= path.length) return car.vmax;
    const a = path[car.pi], b = path[car.pi + 1];
    let ox = b.tx - a.tx, oy = b.ty - a.ty;
    const om = Math.hypot(ox, oy) || 1; ox /= om; oy /= om;
    const dot = car.dirx * ox + car.diry * oy;
    if (dot >= TURN_DOT) return car.vmax;
    const cap = dot < 0 ? TURN_HARD : TURN_NORMAL;       // U-turn vs corner
    const dc = Math.hypot(a.tx - car.tx, a.ty - car.ty); // distance to the bend
    return Math.min(car.vmax, cap + dc * 1.3);           // ease in, accelerate out
  }

  // IDM-lite longitudinal control, then move car.v*dt along the polyline.
  function driveCar(car, dt) {
    const vmax = desiredSpeed(car);
    const lead = leaderAhead(car);
    let a;
    if (lead) {
      const dv = car.v - lead.lv;                         // closing rate
      const sStar = MIN_GAP + Math.max(0, car.v * HEADWAY + (car.v * dv) / (2 * Math.sqrt(ACCEL * BRAKE)));
      a = ACCEL * (1 - Math.pow(car.v / vmax, 4) - Math.pow(sStar / lead.gap, 2));
    } else {
      a = ACCEL * (1 - Math.pow(car.v / vmax, 4));
    }
    car.v = Math.max(0, car.v + C.clamp(a, -BRAKE * 1.6, ACCEL) * dt);

    // Gridlock relief: if a junction give-way leaves us stalled too long, creep.
    if (car.v < 0.05 && lead) { car.stuckMs += dt * 1000; if (car.stuckMs > UNSTICK_MS) car.v = 0.5; }
    else car.stuckMs = 0;

    advanceDist(car, car.v * dt, dt);
  }

  // Move a vehicle `dist` tiles along its remaining path, smoothing heading so
  // turns sweep through an arc rather than snapping.
  function advanceDist(o, dist, dt) {
    let guard = 0;
    while (dist > 1e-5 && o.path && o.pi < o.path.length && guard++ < 8) {
      const wp = o.path[o.pi];
      const dx = wp.tx - o.tx, dy = wp.ty - o.ty;
      const d = Math.hypot(dx, dy);
      if (d <= dist || d < 1e-4) {
        o.tx = wp.tx; o.ty = wp.ty; o.pi++; dist -= d;
        if (o.pi >= o.path.length) { o.path = null; return; }
      } else {
        o.tx += (dx / d) * dist; o.ty += (dy / d) * dist;
        steer(o, dx / d, dy / d, dt);
        return;
      }
    }
  }

  function steer(o, tx, ty, dt) {
    const k = Math.min(1, (dt || 0.016) * STEER_RATE);
    o.dirx += (tx - o.dirx) * k; o.diry += (ty - o.diry) * k;
    const m = Math.hypot(o.dirx, o.diry) || 1; o.dirx /= m; o.diry /= m;
  }

  // Distance (route tiles) from a bus to the next upcoming station stop, capped
  // at the lookahead we care about — used to brake smoothly into a stop.
  function distToNextStation(bus) {
    const tiles = bus.route.tiles, stations = bus.route.stations;
    let acc = 0, px = bus.tx, py = bus.ty, i = bus.pi;
    for (let s = 0; s < 8; s++) {
      const ni = (i + 1) % tiles.length;
      const wp = tiles[ni];
      acc += Math.hypot(wp.tx - px, wp.ty - py);
      if (stations.has(ni)) return acc;
      px = wp.tx; py = wp.ty; i = ni;
      if (acc > 6) break;
    }
    return Infinity;
  }

  function advanceBus(bus, dt, now) {
    if (bus.v == null) bus.v = 0;
    if (bus.dwellUntil > now) { bus.v = 0; return; }     // boarding at a stop
    // brake into an approaching station; otherwise accelerate to cruise.
    const ds = distToNextStation(bus);
    const target = ds < Infinity ? Math.min(bus.speed, 0.4 + ds * 1.1) : bus.speed;
    const a = target > bus.v ? ACCEL * 0.8 : -BRAKE;
    bus.v = Math.max(0, bus.v + a * dt);

    let dist = bus.v * dt, guard = 0;
    const tiles = bus.route.tiles;
    while (dist > 1e-5 && guard++ < 8) {
      const next = (bus.pi + 1) % tiles.length;
      const wp = tiles[next];
      const dx = wp.tx - bus.tx, dy = wp.ty - bus.ty;
      const d = Math.hypot(dx, dy);
      if (d <= dist || d < 1e-4) {
        bus.tx = wp.tx; bus.ty = wp.ty; bus.pi = next; dist -= d;
        if (bus.route.stations.has(next)) { bus.dwellUntil = now + 1500; bus.v = 0; break; }
      } else {
        bus.tx += (dx / d) * dist; bus.ty += (dy / d) * dist;
        steer(bus, dx / d, dy / d, dt);
        break;
      }
    }
  }

  function update(dt, now, camera) {
    if (!C.graph) return;
    C.graph.ensureBuilt();
    if (now - lastRecalc > RECALC_MS) { recompute(camera); lastRecalc = now; }

    for (let i = 0; i < 3 && cars.size < targetCars; i++) spawnCar();
    if (cars.size > targetCars) {
      const it = cars.keys();
      let over = cars.size - targetCars;
      while (over-- > 0) { const k = it.next(); if (k.done) break; cars.delete(k.value); }
    }

    rebuildGrid();
    for (const car of cars.values()) {
      if (car.alpha < 1) car.alpha = Math.min(1, car.alpha + dt * 2.5);
      if (car.path && car.pi < car.path.length) driveCar(car, dt);
      else { car.v = 0; newCarGoal(car); }   // arrived: idle a beat, then re-route
    }
    for (const bus of buses) advanceBus(bus, dt, now);
  }

  // ---- Drawing (oriented iso boxes) -----------------------------------------
  function rightOffset(o, k) {
    // perpendicular-right of travel in tile space, flips with direction
    return { x: -o.diry * k, y: o.dirx * k };
  }

  function drawVehicle(ctx, o, L, Wd, color, opts) {
    const off = rightOffset(o, CAR_OFFSET);
    const base = C.worldToScreen(o.tx + 0.5 + off.x, o.ty + 0.5 + off.y, 0);
    const f = C.worldToScreen(o.tx + 0.5 + off.x + o.dirx, o.ty + 0.5 + off.y + o.diry, 0);
    let fx = f.x - base.x, fy = f.y - base.y;           // screen px per tile, forward
    const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    const sc = fl;                                       // tile -> px scale
    fx *= sc; fy *= sc;
    const rx = -fy, ry = fx;                             // screen-right, same scale
    const lift = opts.lift || 3.0;
    const corner = (s, t, z) => ({ x: base.x + fx * s + rx * t, y: base.y + fy * s + ry * t - z });

    ctx.save();
    ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;

    // ground shadow
    ctx.fillStyle = 'rgba(28,36,46,0.22)';
    poly(ctx, [corner(-L / 2, -Wd / 2, 0), corner(L / 2, -Wd / 2, 0), corner(L / 2, Wd / 2, 0), corner(-L / 2, Wd / 2, 0)]);
    ctx.fill();

    // body sides (front + right) for a touch of volume
    ctx.fillStyle = shade(color, -22);
    poly(ctx, [corner(L / 2, -Wd / 2, 0), corner(L / 2, Wd / 2, 0), corner(L / 2, Wd / 2, lift), corner(L / 2, -Wd / 2, lift)]);
    ctx.fill();
    poly(ctx, [corner(-L / 2, Wd / 2, 0), corner(L / 2, Wd / 2, 0), corner(L / 2, Wd / 2, lift), corner(-L / 2, Wd / 2, lift)]);
    ctx.fillStyle = shade(color, -34); ctx.fill();

    // roof
    ctx.fillStyle = color;
    poly(ctx, [corner(-L / 2, -Wd / 2, lift), corner(L / 2, -Wd / 2, lift), corner(L / 2, Wd / 2, lift), corner(-L / 2, Wd / 2, lift)]);
    ctx.fill();

    // windshield band near the front
    ctx.fillStyle = 'rgba(190,220,235,0.55)';
    poly(ctx, [corner(L * 0.12, -Wd * 0.42, lift + 0.1), corner(L * 0.34, -Wd * 0.42, lift + 0.1), corner(L * 0.34, Wd * 0.42, lift + 0.1), corner(L * 0.12, Wd * 0.42, lift + 0.1)]);
    ctx.fill();

    if (opts.bus) {
      // window strip down both sides
      ctx.fillStyle = 'rgba(190,220,235,0.5)';
      for (let s = -L * 0.32; s <= L * 0.4; s += L * 0.16) {
        poly(ctx, [corner(s, -Wd / 2 - 0.001, lift * 0.7), corner(s + L * 0.1, -Wd / 2 - 0.001, lift * 0.7), corner(s + L * 0.1, -Wd / 2 - 0.001, lift * 0.95), corner(s, -Wd / 2 - 0.001, lift * 0.95)]);
        ctx.fill();
      }
    } else {
      // headlight up front
      const lp = corner(L / 2, 0, lift * 0.5);
      ctx.fillStyle = '#fff6cf'; ctx.beginPath(); ctx.arc(lp.x, lp.y, 0.9, 0, Math.PI * 2); ctx.fill();
      if (opts.taxi) {
        const rp = corner(0, 0, lift + 1.6);
        ctx.fillStyle = '#2a2d33'; ctx.fillRect(rp.x - 1.4, rp.y - 1.2, 2.8, 1.6);
      }
    }
    ctx.restore();
  }

  function poly(ctx, pts) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  function shade(hex, dl) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return hex;
    const cl = (v) => Math.max(0, Math.min(255, v + dl));
    return 'rgb(' + cl(parseInt(m[1], 16)) + ',' + cl(parseInt(m[2], 16)) + ',' + cl(parseInt(m[3], 16)) + ')';
  }

  function onScreen(o, vt, cw, ch) {
    const s = C.worldToScreen(o.tx + 0.5, o.ty + 0.5, 0);
    const sx = s.x * vt.zoom + vt.offX, sy = s.y * vt.zoom + vt.offY;
    return !(sx < -CULL_MARGIN || sx > cw + CULL_MARGIN || sy < -CULL_MARGIN || sy > ch + CULL_MARGIN);
  }

  function collectDrawables(list, now, camera) {
    const vt = camera ? camera.viewTransform() : null;
    const cw = (canvas && canvas.clientWidth) || 1e5;
    const ch = (canvas && canvas.clientHeight) || 1e5;
    for (const car of cars.values()) {
      if (vt && !onScreen(car, vt, cw, ch)) continue;
      list.push({ depth: C.depthKey(car.tx, car.ty), draw: (ctx) => drawVehicle(ctx, car, car.len, car.wid, car.color, { taxi: car.taxi }) });
    }
    for (const bus of buses) {
      if (vt && !onScreen(bus, vt, cw, ch)) continue;
      list.push({ depth: C.depthKey(bus.tx, bus.ty), draw: (ctx) => drawVehicle(ctx, bus, BUS_LEN, BUS_WID, '#3f7e4a', { bus: true, lift: 5.5 }) });
    }
  }

  function reset() {
    cars.clear();
    buses.length = 0;
    routesVersion = -1;
    lastRecalc = -1e9;
  }

  C.traffic = { update, collectDrawables, reset, carCount: function () { return cars.size; } };
})();
