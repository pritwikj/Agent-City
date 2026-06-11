/* ===========================================================================
   rail.js — the commuter-rail NETWORK: a softened loop around the core, a
   circling train, a depot BUILDING at each stop, subway-style spur stubs that
   poke into the blocks, and a branch line + shuttle out to every satellite town.

   Nothing appears at once. infra.js reports how far the loop has paved
   (loopFrac), how built each core depot is (depotProg[]), and for each suburb
   branch how far the line is laid + how built its depot is — all paid for by the
   city's accumulated work AFTER the beltway. We render whatever state the crews
   have reached: graded trackbed + survey line ahead of the work front, depots
   under a crane until finished, the main train running only on the whole loop,
   and a small shuttle ping-ponging each branch once its track is down.

   A transit API (C.rail.transit) lets population.js route commuters onto the
   network: walk to a depot, board when a train dwells there, ride, alight, walk.
   Client-side scenery — no server changes, no persistence.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const canvas = document.getElementById('city-canvas');

  const TRACK_DEPTH = -1e12 + 10;
  const CULL_MARGIN = 90;
  const RAIL_GAUGE = 0.16;
  const CAR_LEN = 1.5, CAR_GAP = 0.25, CAR_WID = 0.46;
  const N_CARS = 4;            // cars on the main loop train
  const SHUTTLE_CARS = 2;      // cars on a suburb shuttle (short, so reversing reads fine)
  const CRUISE = 4.0;         // loop train cruise (tiles/s)
  const SHUTTLE_CRUISE = 3.0;
  const DWELL_MS = 1600;

  // Main loop train and per-branch shuttles.
  const train = { lead: 0, v: 0, dwellUntil: 0, alpha: 0, atStation: -1 };
  let shuttles = [];           // [{pos,v,dir,dwellUntil,atEnd,alpha}] parallel to rail.branchGeo
  let stationPts = [];         // ready depots, for the rider API
  let infraVer = -1;

  function rebuild() {
    const rail = C.infra.rail();
    train.lead = 0; train.v = 0; train.dwellUntil = 0; train.alpha = 0; train.atStation = -1;
    const n = rail ? rail.branchGeo.length : 0;
    shuttles = [];
    for (let i = 0; i < n; i++) shuttles.push({ pos: 0, v: 0, dir: 1, dwellUntil: 0, atEnd: -1, alpha: 0 });
    stationPts = [];
    infraVer = C.infra.version();
  }

  // Nearest stop ahead of the loop train, as {d: arc distance, i: station index}.
  function nearestStationFwd(rail) {
    let bd = Infinity, bi = -1;
    for (let i = 0; i < rail.stations.length; i++) {
      let d = rail.stations[i].sArc - train.lead;
      d = ((d % rail.total) + rail.total) % rail.total;
      if (d < bd) { bd = d; bi = i; }
    }
    return { d: bd, i: bi };
  }

  // A shuttle runs its branch out-and-back, dwelling at each end.
  function updateShuttle(sh, path, now, dt) {
    if (sh.alpha < 1) sh.alpha = Math.min(1, sh.alpha + dt * 1.6);
    if (sh.dwellUntil > now) { sh.v = 0; return; }   // dwelling — atEnd holds
    sh.atEnd = -1;
    const target = sh.dir > 0 ? path.total : 0;
    const d = Math.abs(target - sh.pos);
    if (d < 0.25 && sh.v < 0.6) {
      sh.dwellUntil = now + DWELL_MS; sh.v = 0;
      sh.atEnd = sh.dir > 0 ? 1 : 0;   // 1 = suburb end, 0 = core end
      sh.dir = -sh.dir;                // reverse for the return leg
      return;
    }
    const t = d < 4 ? Math.min(SHUTTLE_CRUISE, 0.5 + d * 1.1) : SHUTTLE_CRUISE;
    const a = t > sh.v ? 2.6 : -4.0;
    sh.v = Math.max(0, sh.v + a * dt);
    sh.pos = Math.max(0, Math.min(path.total, sh.pos + sh.dir * sh.v * dt));
  }

  function rebuildStationPts(rail) {
    stationPts = [];
    if (!rail.complete) return;
    rail.stations.forEach((s, i) => {
      if (rail.depotProg[i] >= 1) stationPts.push({ sid: s.sid, tx: s.depot.tx, ty: s.depot.ty, core: true, line: 'core' });
    });
    rail.branchGeo.forEach((br, i) => {
      const bs = rail.branches[i];
      if (bs.paveFrac >= 1 && bs.depotProg >= 1 && rail.depotProg[br.coreIdx] >= 1) {
        stationPts.push({ sid: br.sid, tx: br.depot.tx, ty: br.depot.ty, core: false, line: br.sid, coreSid: br.coreSid });
      }
    });
  }

  function update(dt, now) {
    C.infra.ensure();
    if (infraVer !== C.infra.version()) rebuild();
    const rail = C.infra.rail();
    if (!rail) return;

    // main loop train — runs only once the whole loop is laid
    if (!rail.complete) { train.v = 0; train.alpha = 0; train.atStation = -1; }
    else {
      if (train.alpha < 1) train.alpha = Math.min(1, train.alpha + dt * 1.6);
      if (train.dwellUntil > now) { train.v = 0; }   // dwelling — atStation holds
      else {
        train.atStation = -1;
        const ns = nearestStationFwd(rail);
        if (ns.d < 0.25 && train.v < 0.6) { train.dwellUntil = now + DWELL_MS; train.v = 0; train.atStation = ns.i; }
        else {
          const target = ns.d < 4 ? Math.min(CRUISE, 0.5 + ns.d * 1.1) : CRUISE;
          const a = target > train.v ? 3.0 : -4.5;
          train.v = Math.max(0, train.v + a * dt);
          train.lead += train.v * dt;
        }
      }
    }

    // suburb shuttles — each runs once its branch line is fully laid
    for (let i = 0; i < rail.branchGeo.length; i++) {
      const sh = shuttles[i]; if (!sh) continue;
      if (rail.branches[i].paveFrac < 1) { sh.alpha = 0; sh.atEnd = -1; continue; }
      updateShuttle(sh, rail.branchGeo[i], now, dt);
    }

    rebuildStationPts(rail);
  }

  // ---- drawing primitives ---------------------------------------------------
  const w2s = (tx, ty, z) => C.worldToScreen(tx, ty, z || 0);
  const hsl = (h, s, l) => 'hsl(' + h + ',' + s + '%,' + l + '%)';
  function poly(ctx, pts) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  function strokeBetween(ctx, p0, p1, w, color, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = w;
    if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    ctx.setLineDash([]);
  }
  function edgePoint(a, b, f) { return { tx: a.tx + (b.tx - a.tx) * f, ty: a.ty + (b.ty - a.ty) * f }; }

  // A length of finished (laid) or graded (unlaid) track between two world tiles.
  function drawRailWorld(ctx, a, b, laid) {
    const s0 = w2s(a.tx + 0.5, a.ty + 0.5, 0), s1 = w2s(b.tx + 0.5, b.ty + 0.5, 0);
    ctx.lineCap = 'butt';
    strokeBetween(ctx, s0, s1, 11, 'rgba(20,26,34,0.16)');
    strokeBetween(ctx, s0, s1, 9, laid ? '#8a7d63' : '#7c6a4f');
    strokeBetween(ctx, s0, s1, 8, 'rgba(70,52,36,0.6)', [1.4, 3.4]);
    if (!laid) return;
    let dx = b.tx - a.tx, dy = b.ty - a.ty; const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
    for (const sgn of [-1, 1]) {
      const r0 = w2s(a.tx + 0.5 - dy * sgn * RAIL_GAUGE, a.ty + 0.5 + dx * sgn * RAIL_GAUGE, 0);
      const r1 = w2s(b.tx + 0.5 - dy * sgn * RAIL_GAUGE, b.ty + 0.5 + dx * sgn * RAIL_GAUGE, 0);
      strokeBetween(ctx, r0, r1, 1, 'rgba(196,202,210,0.85)');
    }
  }
  function drawSurveyWorld(ctx, a, b) {
    strokeBetween(ctx, w2s(a.tx + 0.5, a.ty + 0.5, 0), w2s(b.tx + 0.5, b.ty + 0.5, 0),
      5, 'rgba(150,134,96,0.32)', [3, 6]);
  }
  function drawWorkFront(ctx, p) {
    const s = w2s(p.tx + 0.5, p.ty + 0.5, 0);
    ctx.fillStyle = '#6f5234';
    for (let i = 0; i < 3; i++) ctx.fillRect(s.x - 4 + i * 3, s.y - 1 - i, 2.4, 1.4);
  }

  // Track along a closed loop up to arc length `built`, with a work front + survey
  // line ahead of it; the rest of the ring is still being graded.
  function drawLoop(ctx, loop, built) {
    ctx.save(); ctx.lineJoin = 'round';
    let s = 0;
    for (let i = 0; i < loop.corners.length; i++) {
      const a = loop.corners[i], b = loop.corners[(i + 1) % loop.corners.length], eLen = loop.seg[i];
      if (built >= s + eLen) drawRailWorld(ctx, a, b, true);
      else if (built > s) {
        const f = (built - s) / eLen, mid = edgePoint(a, b, f);
        drawRailWorld(ctx, a, mid, true);
        const end = Math.min(1, f + 0.12);
        drawRailWorld(ctx, mid, edgePoint(a, b, end), false);
        if (end < 1) drawSurveyWorld(ctx, edgePoint(a, b, end), b);
        drawWorkFront(ctx, mid);
      } else drawSurveyWorld(ctx, a, b);
      s += eLen;
    }
    ctx.restore();
  }

  // Track along an OPEN branch polyline up to fraction paveFrac of its length.
  function drawBranch(ctx, br, paveFrac) {
    ctx.save(); ctx.lineJoin = 'round';
    const built = paveFrac * br.total;
    let s = 0;
    for (let i = 0; i < br.corners.length - 1; i++) {
      const a = br.corners[i], b = br.corners[i + 1], eLen = br.seg[i];
      if (built >= s + eLen) drawRailWorld(ctx, a, b, true);
      else if (built > s) {
        const f = (built - s) / eLen, mid = edgePoint(a, b, f);
        drawRailWorld(ctx, a, mid, true);
        const end = Math.min(1, f + 0.18);
        drawRailWorld(ctx, mid, edgePoint(a, b, end), false);
        if (end < 1) drawSurveyWorld(ctx, edgePoint(a, b, end), b);
        drawWorkFront(ctx, mid);
      } else drawSurveyWorld(ctx, a, b);
      s += eLen;
    }
    ctx.restore();
  }

  // ---- station depot (an actual little building, raised by a crew) ----------
  function railBox(ctx, tx, ty, w, d, z0, h, hue, sat, lit) {
    const zT = z0 + h;
    const nT = w2s(tx, ty, zT), eT = w2s(tx + w, ty, zT), sT = w2s(tx + w, ty + d, zT), wT = w2s(tx, ty + d, zT);
    const sB = w2s(tx + w, ty + d, z0), wB = w2s(tx, ty + d, z0), eB = w2s(tx + w, ty, z0);
    ctx.fillStyle = hsl(hue, sat, lit - 6); poly(ctx, [wT, sT, sB, wB]); ctx.fill();   // SW face
    ctx.fillStyle = hsl(hue, sat, lit - 15); poly(ctx, [sT, eT, eB, sB]); ctx.fill();  // SE face
    ctx.fillStyle = hsl(hue, sat, lit + 8); poly(ctx, [nT, eT, sT, wT]); ctx.fill();   // top
    ctx.strokeStyle = 'rgba(18,24,32,0.18)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(wT.x, wT.y); ctx.lineTo(sT.x, sT.y); ctx.lineTo(eT.x, eT.y); ctx.stroke();
  }

  // Axis-aligned footprint for a depot centred at (cx,cy), W along the track
  // tangent t and D inward along the normal n (both cardinal unit vectors).
  function depotAABB(cx, cy, t, n, W, D) {
    const xs = [], ys = [];
    for (const a of [-W / 2, W / 2]) for (const b of [0, D]) {
      xs.push(cx + t.x * a + n.x * b); ys.push(cy + t.y * a + n.y * b);
    }
    const tx = Math.min.apply(null, xs), ty = Math.min.apply(null, ys);
    return { tx, ty, w: Math.max.apply(null, xs) - tx, d: Math.max.apply(null, ys) - ty };
  }

  function drawCrane(ctx, aabb, Hfull, prog) {
    ctx.strokeStyle = 'rgba(120,110,90,0.75)'; ctx.lineWidth = 1;
    const corners = [[aabb.tx, aabb.ty], [aabb.tx + aabb.w, aabb.ty], [aabb.tx + aabb.w, aabb.ty + aabb.d], [aabb.tx, aabb.ty + aabb.d]];
    for (const [x, y] of corners) {
      const b = w2s(x, y, 0), tp = w2s(x, y, Hfull);
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(tp.x, tp.y); ctx.stroke();
    }
    const base = w2s(aabb.tx, aabb.ty, 0), mast = w2s(aabb.tx, aabb.ty, Hfull + 16);
    ctx.strokeStyle = '#d8a23a'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(mast.x, mast.y); ctx.stroke();
    const jib = w2s(aabb.tx + aabb.w + 0.8, aabb.ty, Hfull + 16);
    ctx.beginPath(); ctx.moveTo(mast.x, mast.y); ctx.lineTo(jib.x, jib.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(50,55,60,0.6)'; ctx.lineWidth = 0.6;
    const hook = w2s(aabb.tx + aabb.w * 0.6, aabb.ty, Hfull * prog + 2);
    ctx.beginPath(); ctx.moveTo((mast.x + jib.x) / 2, (mast.y + jib.y) / 2); ctx.lineTo(hook.x, hook.y); ctx.stroke();
  }

  // center: depot tile point; nrm: city-side normal {nx,ny}; prog 0..1; hue tints the headhouse.
  // A station = raised platform (track-side safety edge) + a signed headhouse with
  // a doorway + a posted canopy over the platform. While building, a crane stands in.
  function drawDepot(ctx, center, nrm, prog, hue) {
    const n = { x: nrm.nx, y: nrm.ny };
    const t = { x: -n.y, y: n.x };                         // along-track tangent
    const C2 = (a, b, z) => w2s(center.tx + t.x * a + n.x * b, center.ty + t.y * a + n.y * b, z);
    const quad = (p0, p1, p2, p3, fill, stroke) => {
      poly(ctx, [p0, p1, p2, p3]);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.8; ctx.stroke(); }
    };
    // raised platform slab + a yellow safety edge along the track side
    quad(C2(-1.3, -0.35, 0.5), C2(1.3, -0.35, 0.5), C2(1.3, 0.55, 0.5), C2(-1.3, 0.55, 0.5), 'rgba(198,203,210,0.96)', 'rgba(40,46,54,0.3)');
    quad(C2(-1.3, -0.33, 0.55), C2(1.3, -0.33, 0.55), C2(1.3, -0.2, 0.55), C2(-1.3, -0.2, 0.55), 'rgba(216,182,72,0.9)');

    // headhouse, inward of the platform; height rises with build progress
    const hc = { tx: center.tx + n.x * 0.62, ty: center.ty + n.y * 0.62 };
    const aabb = depotAABB(hc.tx, hc.ty, t, n, 1.8, 1.0);
    const Hfull = 20, h = Math.max(2, Hfull * Math.min(1, prog));
    railBox(ctx, aabb.tx, aabb.ty, aabb.w, aabb.d, 0, h, hue, 14, 64);

    if (prog < 1) { drawCrane(ctx, aabb, Hfull, prog); return; }   // still under construction

    const fr = aabb.ty + aabb.d;                                   // front (south) wall line
    // overhanging roof slab
    quad(w2s(aabb.tx - 0.12, aabb.ty - 0.12, h + 0.4), w2s(aabb.tx + aabb.w + 0.12, aabb.ty - 0.12, h + 0.4),
      w2s(aabb.tx + aabb.w + 0.12, fr + 0.12, h + 0.4), w2s(aabb.tx - 0.12, fr + 0.12, h + 0.4), hsl(hue, 10, 42));
    // blue station sign band + a dark doorway on the front face
    quad(w2s(aabb.tx + 0.15, fr, h * 0.72), w2s(aabb.tx + aabb.w - 0.15, fr, h * 0.72),
      w2s(aabb.tx + aabb.w - 0.15, fr, h * 0.52), w2s(aabb.tx + 0.15, fr, h * 0.52), '#3f6f9e');
    quad(w2s(aabb.tx + aabb.w * 0.42, fr, 0), w2s(aabb.tx + aabb.w * 0.6, fr, 0),
      w2s(aabb.tx + aabb.w * 0.6, fr, h * 0.42), w2s(aabb.tx + aabb.w * 0.42, fr, h * 0.42), '#2b2f36');

    // platform canopy: a thin semi-transparent roof on four posts (riders show beneath)
    const zCan = 8.5;
    ctx.strokeStyle = 'rgba(120,128,138,0.85)'; ctx.lineWidth = 1;
    for (const [a, b] of [[-1.05, -0.25], [1.05, -0.25], [-1.05, 0.45], [1.05, 0.45]]) {
      const p0 = C2(a, b, 0.5), p1 = C2(a, b, zCan);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    }
    quad(C2(-1.25, -0.35, zCan), C2(1.25, -0.35, zCan), C2(1.25, 0.55, zCan), C2(-1.25, 0.55, zCan), 'rgba(74,84,96,0.6)', 'rgba(255,255,255,0.18)');
  }

  // ---- train / shuttle cars -------------------------------------------------
  // A car has an undercarriage skirt, a light body with a window band + livery
  // stripe, and a vented roof; the lead car gets a cab windshield + headlights.
  // Drawn against the CAMERA-facing side/end (sign of the screen vectors) so it
  // reads correctly whichever way the train rounds the loop.
  function drawCar(ctx, p, alpha, lead) {
    const base = w2s(p.tx + 0.5, p.ty + 0.5, 0);
    const fwd = w2s(p.tx + 0.5 + p.dirx, p.ty + 0.5 + p.diry, 0);
    const fx = fwd.x - base.x, fy = fwd.y - base.y, rx = -fy, ry = fx;
    const hL = CAR_LEN / 2, hW = CAR_WID / 2;
    const c = (a, t, z) => ({ x: base.x + fx * a + rx * t, y: base.y + fy * a + ry * t - z });
    const quad = (p0, p1, p2, p3, fill) => { poly(ctx, [p0, p1, p2, p3]); ctx.fillStyle = fill; ctx.fill(); };
    const tN = (fx >= 0 ? 1 : -1) * hW;        // camera-facing long side
    const aE = (fy >= 0 ? 1 : -1) * hL;        // camera-facing end
    const zF = 1.7, zS = 3.3, zH = 6.0, zT = 7.4;   // skirt top, sill, window head, roof
    ctx.save();
    ctx.globalAlpha = alpha;
    // ground shadow
    quad(c(-hL, -hW, 0), c(hL, -hW, 0), c(hL, hW, 0), c(-hL, hW, 0), 'rgba(24,30,40,0.22)');
    // near long side: dark skirt + light body
    quad(c(-hL, tN, 0), c(hL, tN, 0), c(hL, tN, zF), c(-hL, tN, zF), '#363d45');
    quad(c(-hL, tN, zF), c(hL, tN, zF), c(hL, tN, zT), c(-hL, tN, zT), lead ? '#dde3e8' : '#d2d8df');
    // camera-facing end: skirt + body
    quad(c(aE, -hW, 0), c(aE, hW, 0), c(aE, hW, zF), c(aE, -hW, zF), '#2f353d');
    quad(c(aE, -hW, zF), c(aE, hW, zF), c(aE, hW, zT), c(aE, -hW, zT), lead ? '#c8ced5' : '#bcc3cb');
    // roof + a raised vent strip
    quad(c(-hL, -hW, zT), c(hL, -hW, zT), c(hL, hW, zT), c(-hL, hW, zT), '#b3bac2');
    quad(c(-hL * 0.8, -hW * 0.5, zT + 0.7), c(hL * 0.8, -hW * 0.5, zT + 0.7), c(hL * 0.8, hW * 0.5, zT + 0.7), c(-hL * 0.8, hW * 0.5, zT + 0.7), '#c9d0d6');
    // livery stripe + window band on the near side (slightly inset)
    const ti = tN - (fx >= 0 ? 1 : -1) * 0.03;
    quad(c(-hL, ti, zS - 0.7), c(hL, ti, zS - 0.7), c(hL, ti, zS - 0.3), c(-hL, ti, zS - 0.3), '#c2402f');
    const win = (a0, a1) => quad(c(a0, ti, zS), c(a1, ti, zS), c(a1, ti, zH), c(a0, ti, zH), '#2b4150');
    if (lead) {
      win(-hL * 0.84, -hL * 0.16); win(hL * 0.12, hL * 0.62);
      if (fy > 0) {   // loco front faces the camera: windshield + headlights
        quad(c(aE - 0.03, -hW * 0.7, zS + 0.4), c(aE - 0.03, hW * 0.7, zS + 0.4), c(aE - 0.03, hW * 0.7, zH + 0.5), c(aE - 0.03, -hW * 0.7, zH + 0.5), '#1d3240');
        const h1 = c(aE, -hW * 0.55, zF + 0.5), h2 = c(aE, hW * 0.55, zF + 0.5);
        ctx.fillStyle = '#fff4c8'; ctx.beginPath(); ctx.arc(h1.x, h1.y, 0.9, 0, 7); ctx.arc(h2.x, h2.y, 0.9, 0, 7); ctx.fill();
      }
    } else {
      win(-hL * 0.82, -hL * 0.46); win(-hL * 0.32, hL * 0.02); win(hL * 0.16, hL * 0.5); win(hL * 0.64, hL * 0.88);
    }
    ctx.restore();
  }

  function carPos(i) { return train.lead - i * (CAR_LEN + CAR_GAP); }

  function onScreen(tx, ty, vt, cw, ch) {
    const ss = w2s(tx + 0.5, ty + 0.5, 0);
    const sx = ss.x * vt.zoom + vt.offX, sy = ss.y * vt.zoom + vt.offY;
    return !(sx < -CULL_MARGIN || sx > cw + CULL_MARGIN || sy < -CULL_MARGIN || sy > ch + CULL_MARGIN);
  }

  function collectDrawables(list, now, camera) {
    const rail = C.infra.rail();
    if (!rail) return;
    const vt = camera ? camera.viewTransform() : null;
    const cw = (canvas && canvas.clientWidth) || 1e5, ch = (canvas && canvas.clientHeight) || 1e5;
    const builtArc = rail.loopFrac * rail.total;

    // loop + branch track (under everything)
    list.push({ depth: TRACK_DEPTH, draw: (ctx) => drawLoop(ctx, rail, builtArc) });
    rail.branchGeo.forEach((br, i) => {
      if (rail.branches[i].paveFrac > 0) list.push({ depth: TRACK_DEPTH + 1 + i, draw: (ctx) => drawBranch(ctx, br, rail.branches[i].paveFrac) });
    });

    // core depots: platform appears once the loop reaches the stop; the building
    // then rises under a crane.
    rail.stations.forEach((s, i) => {
      if (!rail.complete && builtArc < s.sArc) return;
      if (vt && !onScreen(s.depot.tx, s.depot.ty, vt, cw, ch)) return;
      list.push({
        depth: C.depthKey(s.depot.tx + 1, s.depot.ty + 1), draw: (ctx) => {
          drawRailWorld(ctx, s.loop, s.spurEnd, true);   // subway-style siding into the city
          drawDepot(ctx, s.depot, s.normal, rail.depotProg[i], 210);
        },
      });
    });
    // suburb depots: shown once their branch line is fully laid
    rail.branchGeo.forEach((br, i) => {
      if (rail.branches[i].paveFrac < 1) return;
      if (vt && !onScreen(br.depot.tx, br.depot.ty, vt, cw, ch)) return;
      list.push({ depth: C.depthKey(br.depot.tx + 1, br.depot.ty + 1), draw: (ctx) => drawDepot(ctx, br.depot, br.normal, rail.branches[i].depotProg, 28) });
    });

    // main loop train
    if (rail.complete) {
      for (let i = 0; i < N_CARS; i++) {
        const p = C.infra.posOnLoop(rail, carPos(i));
        if (vt && !onScreen(p.tx, p.ty, vt, cw, ch)) continue;
        list.push({ depth: C.depthKey(p.tx, p.ty), draw: (ctx) => drawCar(ctx, p, train.alpha, i === 0) });
      }
    }
    // suburb shuttles
    rail.branchGeo.forEach((br, i) => {
      const sh = shuttles[i];
      if (!sh || rail.branches[i].paveFrac < 1) return;
      for (let c = 0; c < SHUTTLE_CARS; c++) {
        const p = C.infra.posOnPath(br, sh.pos - sh.dir * c * (CAR_LEN + CAR_GAP));
        if (vt && !onScreen(p.tx, p.ty, vt, cw, ch)) continue;
        const pp = sh.dir >= 0 ? p : { tx: p.tx, ty: p.ty, dirx: -p.dirx, diry: -p.diry };
        list.push({ depth: C.depthKey(p.tx, p.ty), draw: (ctx) => drawCar(ctx, pp, sh.alpha, c === 0) });
      }
    });
  }

  function reset() { infraVer = -1; rebuild(); }

  // ---- transit API (consumed by population.js) ------------------------------
  // Riders pick a line ('core' loop, or a branch 'b<k>'), walk to a depot, board
  // when a train dwells there (dwellSid matches their stop), ride, and alight.
  function dwellSid(line) {
    const rail = C.infra.rail();
    if (!rail) return -1;
    if (line === 'core') {
      if (train.atStation < 0) return -1;
      return rail.depotProg[train.atStation] >= 1 ? rail.stations[train.atStation].sid : -1;
    }
    const k = parseInt(line.slice(1), 10);
    const sh = shuttles[k], br = rail.branchGeo[k];
    if (!sh || !br || sh.atEnd < 0) return -1;
    if (sh.atEnd === 1) return br.sid;                                  // suburb end
    return rail.depotProg[br.coreIdx] >= 1 ? br.coreSid : -1;          // core end
  }

  C.rail = {
    update, collectDrawables, reset,
    transit: {
      ready: function () { const r = C.infra.rail(); return !!(r && r.complete && stationPts.length >= 2); },
      stations: function () { return stationPts; },
      dwellSid: dwellSid,
    },
  };
})();
