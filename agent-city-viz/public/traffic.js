/* ===========================================================================
   traffic.js — cars and public transit on the shared street graph.

   Cars: spawned on the road network, their count and quality biased by each
   block's neighborhood (more, nicer, taxi-heavy downtown/uptown; fewer, older
   in the working/inner city). They A*-route block to block, ride the road with
   a right-of-travel lane offset (so opposing flows separate into two-way), and
   recycle to a fresh trip on arrival.

   Buses: a couple of looping routes stitched (via A*) between the city's
   transit-type buildings, dwelling briefly at each station; if the city has no
   stations yet they simply circle the downtown core. Each station gets a visible
   roadside shelter (glass back, flat roof, bench, blue sign disc) so the stops
   read as real places rather than invisible pause points.

   Drawn as small oriented iso boxes, depth-sorted into the same frame list as
   buildings and pedestrians. Client-side and ambient — no server involvement.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const B = C.BLOCK_TILES;
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

  // ---- Traffic signals ------------------------------------------------------
  // Block corners shared by 2+ blocks are real crossroads; we signalize them.
  // A 2-phase cycle alternates green between the two travel axes (x then y) with
  // a yellow tail and an all-red clearance. Cars treat a red light as a virtual
  // stationary leader at the stop line, so the existing IDM brakes them to a
  // smooth halt and queues form behind — no separate stopping code path. Phase
  // is a pure function of the clock + a per-intersection hash offset (no
  // per-signal state to manage), so neighbouring lights run out of sync.
  const SIG_G = 5000;              // ms green per axis
  const SIG_Y = 900;               // ms yellow tail
  const SIG_AR = 500;              // ms all-red clearance
  const SIG_HALF = SIG_G + SIG_Y + SIG_AR;
  const SIG_CYCLE = 2 * SIG_HALF;  // x-half then y-half
  const STOP_SETBACK = 0.55;       // tiles the stop line sits before the box

  const NICE_CARS = ['#d8443a', '#2f6fb0', '#e8b53a', '#2a2d33', '#eceef0', '#3a8f5a', '#b0433f'];
  const DULL_CARS = ['#7a7d82', '#5a6a78', '#8a7a5a', '#43474d', '#9a9488', '#6a6f66'];

  // ---- State ----------------------------------------------------------------
  const cars = new Map();
  const buses = [];
  let busStops = [];               // visible roadside shelters at each route station
  const signals = new Map();       // 'ix,iy' -> { tx, ty, off } signalized junctions
  let nextId = 1;
  let lastRecalc = -1e9;
  let routesVersion = -1;
  let allBlocks = [0];
  let targetCars = 0;
  let hwTiles = [];                // drivable highway tiles (beltway, once paved)

  // ---- Recompute (throttled): car budget + bus routes -----------------------
  function recompute(camera) {
    allBlocks = C.usedBlocks(); if (!allBlocks.length) allBlocks = [0];
    hwTiles = (C.infra && C.infra.drivableTiles) ? C.infra.drivableTiles() : [];
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

    buildSignals();

    if (routesVersion !== C.graph.graphVersion()) {
      buildBusRoutes();
      routesVersion = C.graph.graphVersion();
    }
  }

  // A boundary corner (ix,iy) is touched by the 4 blocks around it; when 2+ of
  // them actually exist it's a crossroads worth signalizing (a lone block's
  // corners are just turns — no cross traffic — so they get no lights).
  function buildSignals() {
    const touch = new Map();
    for (const slot of allBlocks) {
      const sp = C.spiralSlot(slot);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const k = (sp.bx + dx) + ',' + (sp.by + dy);
        touch.set(k, (touch.get(k) || 0) + 1);
      }
    }
    signals.clear();
    for (const [k, n] of touch) {
      if (n < 2) continue;
      const c = k.split(',');
      const ix = +c[0], iy = +c[1];
      signals.set(k, { tx: ix * B - 0.5, ty: iy * B - 0.5, off: C.hash32('sig:' + k) % SIG_CYCLE });
    }
  }

  // Phase queries — pure functions of the clock + per-signal offset.
  function axisGreen(axisX, off, now) {            // may this axis proceed (green or yellow)?
    const t = (now + off) % SIG_CYCLE;
    return axisX ? (t < SIG_G + SIG_Y) : (t >= SIG_HALF && t < SIG_HALF + SIG_G + SIG_Y);
  }
  function lampColor(axisX, off, now) {            // for rendering one head
    const t = (now + off) % SIG_CYCLE;
    const base = axisX ? 0 : SIG_HALF;             // local time within this axis's slot
    const lt = ((t - base) % SIG_CYCLE + SIG_CYCLE) % SIG_CYCLE;
    if (lt < SIG_G) return 'g';
    if (lt < SIG_G + SIG_Y) return 'y';
    return 'r';
  }
  function signalAt(tx, ty) {
    return signals.get(Math.round(tx / B) + ',' + Math.round(ty / B)) || null;
  }
  function isCornerTile(tx, ty) {                  // a block-ring corner = intersection tile
    const lx = ((tx % B) + B) % B, ly = ((ty % B) + B) % B;
    return (lx === 0 || lx === B - 1) && (ly === 0 || ly === B - 1);
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
    // A visible shelter beside the road at every station, seated to the right of
    // travel (same side buses pull in on) so they read as real stops, not magic
    // pause points.
    busStops = [];
    const tiles = route.tiles;
    for (const idx of route.stations) {
      const a = tiles[idx], b = tiles[(idx + 1) % tiles.length];
      let dx = b.tx - a.tx, dy = b.ty - a.ty;
      const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
      busStops.push({ tx: a.tx, ty: a.ty, dirx: dx, diry: dy, ox: -dy, oy: dx });
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

  // A trip endpoint: usually a random block-ring tile, but ~30% of the time a
  // finished highway tile so the beltway visibly carries through-traffic.
  function randDestTile() {
    if (hwTiles.length && Math.random() < 0.3) return hwTiles[(Math.random() * hwTiles.length) | 0];
    const slot = allBlocks[(Math.random() * allBlocks.length) | 0];
    const ring = C.ringTiles(slot);
    return ring[(Math.random() * ring.length) | 0];
  }

  function spawnCar() {
    const slot = allBlocks[(Math.random() * allBlocks.length) | 0];
    const t = randDestTile();
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
    const g = randDestTile();
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

  // Nearest red light ahead, expressed as a virtual stationary leader at its
  // stop line. Walks the path to the first signalized corner; if that corner's
  // light is red for the car's approach axis, returns the gap to the stop line.
  // A green light returns null (proceed); a corner the car is already entering
  // is skipped so it clears rather than freezing in the box.
  function signalStop(car, now) {
    if (signals.size === 0) return null;
    const path = car.path;
    if (!path) return null;
    let acc = 0, px = car.tx, py = car.ty, pi = car.pi;
    for (let s = 0; s < LOOK_STEPS + 2 && pi < path.length && acc < LOOK_TILES + 2; s++, pi++) {
      const wp = path[pi];
      const seg = Math.hypot(wp.tx - px, wp.ty - py);
      if (isCornerTile(wp.tx, wp.ty)) {
        const sig = signalAt(wp.tx, wp.ty);
        if (sig) {
          let ax = wp.tx - px, ay = wp.ty - py;             // approach direction
          if (Math.abs(ax) < 1e-6 && Math.abs(ay) < 1e-6) { ax = car.dirx; ay = car.diry; }
          const axisX = Math.abs(ax) >= Math.abs(ay);
          if (!axisGreen(axisX, sig.off, now)) {
            const stopDist = acc + seg - STOP_SETBACK;
            return stopDist > 0.05 ? { gap: stopDist, lv: 0 } : null; // else clearing
          }
          return null;                                       // first light is green → go
        }
      }
      acc += seg; px = wp.tx; py = wp.ty;
    }
    return null;
  }

  // IDM-lite longitudinal control vs the nearest constraint (a car ahead OR a
  // red light, whichever is closer), then move car.v*dt along the polyline.
  function driveCar(car, dt, now) {
    const vmax = desiredSpeed(car);
    const lead = leaderAhead(car);
    const sig = signalStop(car, now);
    const obs = sig && (!lead || sig.gap < lead.gap) ? sig : lead;  // binding obstacle
    let a;
    if (obs) {
      const dv = car.v - obs.lv;                          // closing rate
      const sStar = MIN_GAP + Math.max(0, car.v * HEADWAY + (car.v * dv) / (2 * Math.sqrt(ACCEL * BRAKE)));
      a = ACCEL * (1 - Math.pow(car.v / vmax, 4) - Math.pow(sStar / obs.gap, 2));
    } else {
      a = ACCEL * (1 - Math.pow(car.v / vmax, 4));
    }
    car.v = Math.max(0, car.v + C.clamp(a, -BRAKE * 1.6, ACCEL) * dt);

    // Gridlock relief: creep only when a *car* (not a red light) has us stalled
    // too long — we never auto-run a red.
    const carBound = lead && lead === obs;
    if (car.v < 0.05 && carBound) { car.stuckMs += dt * 1000; if (car.stuckMs > UNSTICK_MS) car.v = 0.5; }
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
      if (car.path && car.pi < car.path.length) driveCar(car, dt, now);
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

  // A roadside signal mast: a short pole with a 3-lamp head. The head shows the
  // x-axis state (green→yellow→red); the y-axis is its complement, so one head
  // reads the whole junction as it cycles.
  const LAMP_ON = { r: '#ff4d3d', y: '#ffd23d', g: '#46e06a' };
  const LAMP_OFF = { r: '#5c2722', y: '#5c4f22', g: '#235c34' };
  function drawSignal(ctx, sig, now) {
    const g = C.worldToScreen(sig.tx - 0.5, sig.ty - 0.5, 0);  // mast at the box's near corner
    const H = 11;
    ctx.save();
    // pole
    ctx.strokeStyle = '#2b3036'; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(g.x, g.y - H); ctx.stroke();
    ctx.lineCap = 'butt';
    // head housing
    const hy = g.y - H - 6.2;
    ctx.fillStyle = '#22262b';
    ctx.fillRect(g.x - 1.7, hy, 3.4, 7.6);
    // lamps
    const active = lampColor(true, sig.off, now);
    const keys = ['r', 'y', 'g'];
    for (let i = 0; i < 3; i++) {
      const k = keys[i], cy = hy + 1.5 + i * 2.4, on = k === active;
      if (on) {
        ctx.globalAlpha = 0.32; ctx.fillStyle = LAMP_ON[k];
        ctx.beginPath(); ctx.arc(g.x, cy, 2.1, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = on ? LAMP_ON[k] : LAMP_OFF[k];
      ctx.beginPath(); ctx.arc(g.x, cy, 0.95, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // A roadside bus shelter: a flat-roofed cantilever on two posts with a glass
  // back panel, plus a sign pole topped by a blue "bus" disc. Built in the
  // station's local tile frame (forward = travel, right = curb side) and
  // projected so it sits level on the pavement like the vehicles.
  function drawBusStop(ctx, stop) {
    const cx = stop.tx + 0.5 + stop.ox * 0.62;   // nudge onto the curb, right of travel
    const cy = stop.ty + 0.5 + stop.oy * 0.62;
    const base = C.worldToScreen(cx, cy, 0);
    const f = C.worldToScreen(cx + stop.dirx, cy + stop.diry, 0);
    let fx = f.x - base.x, fy = f.y - base.y;
    const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    const sc = fl; fx *= sc; fy *= sc;
    const rx = -fy, ry = fx;
    const L = 0.62, Wd = 0.26, H = 9, POST = 8.5;
    const corner = (s, t, z) => ({ x: base.x + fx * s + rx * t, y: base.y + fy * s + ry * t - z });

    ctx.save();
    // shadow
    ctx.fillStyle = 'rgba(28,36,46,0.20)';
    poly(ctx, [corner(-L / 2, -Wd / 2, 0), corner(L / 2, -Wd / 2, 0), corner(L / 2, Wd / 2, 0), corner(-L / 2, Wd / 2, 0)]);
    ctx.fill();
    // glass back panel (curb-side long wall)
    ctx.fillStyle = 'rgba(176,206,224,0.45)';
    poly(ctx, [corner(-L / 2, Wd / 2, 1), corner(L / 2, Wd / 2, 1), corner(L / 2, Wd / 2, POST), corner(-L / 2, Wd / 2, POST)]);
    ctx.fill();
    ctx.strokeStyle = 'rgba(70,90,104,0.55)'; ctx.lineWidth = 0.8; ctx.stroke();
    // posts
    ctx.strokeStyle = '#3a4047'; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
    for (const s of [-L / 2 + 0.05, L / 2 - 0.05]) {
      const a = corner(s, -Wd / 2, 0), b = corner(s, -Wd / 2, POST);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    // flat roof slab
    ctx.fillStyle = '#cfd6db';
    poly(ctx, [corner(-L / 2, -Wd / 2, POST), corner(L / 2, -Wd / 2, POST), corner(L / 2, Wd / 2, POST), corner(-L / 2, Wd / 2, POST)]);
    ctx.fill();
    ctx.fillStyle = '#a9b1b7';                    // roof front edge
    poly(ctx, [corner(-L / 2, -Wd / 2, POST), corner(L / 2, -Wd / 2, POST), corner(L / 2, -Wd / 2, POST - 1.4), corner(-L / 2, -Wd / 2, POST - 1.4)]);
    ctx.fill();
    // bench
    ctx.fillStyle = '#7d6a52';
    poly(ctx, [corner(-L * 0.34, Wd * 0.18, 3), corner(L * 0.34, Wd * 0.18, 3), corner(L * 0.34, Wd / 2, 3), corner(-L * 0.34, Wd / 2, 3)]);
    ctx.fill();
    // sign pole + blue disc at the near end
    const pb = corner(L / 2 + 0.04, -Wd / 2, 0), pt = corner(L / 2 + 0.04, -Wd / 2, POST + 5);
    ctx.strokeStyle = '#4a5158'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(pb.x, pb.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
    ctx.fillStyle = '#2f6fb0';
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#eef3f7';
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 1.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function collectDrawables(list, now, camera) {
    const vt = camera ? camera.viewTransform() : null;
    const cw = (canvas && canvas.clientWidth) || 1e5;
    const ch = (canvas && canvas.clientHeight) || 1e5;
    for (const sig of signals.values()) {
      if (vt && !onScreen(sig, vt, cw, ch)) continue;
      list.push({ depth: C.depthKey(sig.tx, sig.ty), draw: (ctx) => drawSignal(ctx, sig, now) });
    }
    for (const stop of busStops) {
      if (vt && !onScreen(stop, vt, cw, ch)) continue;
      list.push({ depth: C.depthKey(stop.tx, stop.ty), draw: (ctx) => drawBusStop(ctx, stop) });
    }
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
    busStops = [];
    signals.clear();
    routesVersion = -1;
    lastRecalc = -1e9;
  }

  C.traffic = { update, collectDrawables, reset, carCount: function () { return cars.size; } };
})();
