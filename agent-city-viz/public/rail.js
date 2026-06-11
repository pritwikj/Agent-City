/* ===========================================================================
   rail.js — the commuter rail loop, its stations, and the train, drawn in
   whatever state of CONSTRUCTION the city has reached.

   Like the highway, the rail loop is BUILT, not spawned: C.infra.rail() (null
   until the city is big enough — see infra.js) reports how many of the four
   loop edges have been laid and how far the active edge has progressed, all
   paid for by the city's accumulated work AFTER the beltway is finished. We draw
   finished track (ballast + ties + steel) for done edges, a graded trackbed with
   sleepers stacked at the work front for the active edge, and a faint survey
   line for the rest. Stations appear only on finished track; the train begins
   running its circuit only once the whole loop is complete. Client-side scenery.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const canvas = document.getElementById('city-canvas');

  const TRACK_DEPTH = -1e12 + 10;
  const CULL_MARGIN = 90;
  const RAIL_GAUGE = 0.16;
  const CAR_LEN = 1.5, CAR_GAP = 0.25, CAR_WID = 0.46;
  const N_CARS = 4;
  const CRUISE = 4.0;
  const DWELL_MS = 1600;
  const STATION_FRACS = [0.1, 0.42, 0.74];

  const train = { lead: 0, v: 0, dwellUntil: 0, alpha: 0, stations: [] };
  let infraVer = -1;

  function rebuild() {
    const loop = C.infra.rail();
    train.lead = 0; train.v = 0; train.dwellUntil = 0; train.alpha = 0;
    train.stations = loop ? STATION_FRACS.map((f) => f * loop.total) : [];
    infraVer = C.infra.version();
  }

  function distToStation(loop) {
    let best = Infinity;
    for (const s of train.stations) {
      let d = s - train.lead;
      d = ((d % loop.total) + loop.total) % loop.total;
      if (d < best) best = d;
    }
    return best;
  }

  function update(dt, now) {
    C.infra.ensure();
    if (infraVer !== C.infra.version()) rebuild();
    const loop = C.infra.rail();
    if (!loop || !loop.complete) { train.v = 0; train.alpha = 0; return; }  // no service until built
    if (train.alpha < 1) train.alpha = Math.min(1, train.alpha + dt * 1.6);
    if (train.dwellUntil > now) { train.v = 0; return; }
    const ds = distToStation(loop);
    if (ds < 0.25 && train.v < 0.6) { train.dwellUntil = now + DWELL_MS; train.v = 0; return; }
    const target = ds < 4 ? Math.min(CRUISE, 0.5 + ds * 1.1) : CRUISE;
    const a = target > train.v ? 3.0 : -4.5;
    train.v = Math.max(0, train.v + a * dt);
    train.lead += train.v * dt;
  }

  // ---- drawing helpers ------------------------------------------------------
  function edgePoint(a, b, f) { return { tx: a.tx + (b.tx - a.tx) * f, ty: a.ty + (b.ty - a.ty) * f }; }

  function strokeBetween(ctx, p0, p1, w, color, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = w;
    if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    ctx.setLineDash([]);
  }

  function railSpan(ctx, a, b, f0, f1, laid) {
    const c0 = edgePoint(a, b, f0), c1 = edgePoint(a, b, f1);
    const s0 = C.worldToScreen(c0.tx + 0.5, c0.ty + 0.5, 0);
    const s1 = C.worldToScreen(c1.tx + 0.5, c1.ty + 0.5, 0);
    ctx.lineCap = 'butt';
    strokeBetween(ctx, s0, s1, 11, 'rgba(20,26,34,0.16)');     // shadow
    strokeBetween(ctx, s0, s1, 9, laid ? '#8a7d63' : '#7c6a4f'); // ballast / graded bed
    strokeBetween(ctx, s0, s1, 8, 'rgba(70,52,36,0.6)', [1.4, 3.4]); // ties
    if (!laid) return;
    let dx = b.tx - a.tx, dy = b.ty - a.ty; const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
    for (const sgn of [-1, 1]) {
      const r0 = C.worldToScreen(c0.tx + 0.5 - dy * sgn * RAIL_GAUGE, c0.ty + 0.5 + dx * sgn * RAIL_GAUGE, 0);
      const r1 = C.worldToScreen(c1.tx + 0.5 - dy * sgn * RAIL_GAUGE, c1.ty + 0.5 + dx * sgn * RAIL_GAUGE, 0);
      strokeBetween(ctx, r0, r1, 1, 'rgba(196,202,210,0.85)');
    }
  }

  function surveySpan(ctx, a, b, f0, f1) {
    const c0 = edgePoint(a, b, f0), c1 = edgePoint(a, b, f1);
    strokeBetween(ctx, C.worldToScreen(c0.tx + 0.5, c0.ty + 0.5, 0), C.worldToScreen(c1.tx + 0.5, c1.ty + 0.5, 0),
      5, 'rgba(150,134,96,0.32)', [3, 6]);
  }

  // stacked sleepers at the work front
  function drawWorkFront(ctx, a, b, f) {
    const p = C.worldToScreen(edgePoint(a, b, f).tx + 0.5, edgePoint(a, b, f).ty + 0.5, 0);
    ctx.fillStyle = '#6f5234';
    for (let i = 0; i < 3; i++) ctx.fillRect(p.x - 4 + i * 3, p.y - 1 - i, 2.4, 1.4);
  }

  function drawTrack(ctx) {
    const loop = C.infra.rail();
    if (!loop) return;
    ctx.save(); ctx.lineJoin = 'round';
    for (let i = 0; i < 4; i++) {
      const a = loop.corners[i], b = loop.corners[(i + 1) % 4];
      if (i < loop.builtEdges) { railSpan(ctx, a, b, 0, 1, true); }
      else if (i === loop.activeEdge) {
        const f = loop.activeFrac;
        if (f > 0.01) railSpan(ctx, a, b, 0, f, true);
        const end = Math.min(1, f + 0.12);
        railSpan(ctx, a, b, f, end, false);
        if (end < 1) surveySpan(ctx, a, b, end, 1);
        drawWorkFront(ctx, a, b, f);
      } else { surveySpan(ctx, a, b, 0, 1); }
    }
    ctx.restore();
  }

  function poly(ctx, pts) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  function drawStation(ctx, sArc) {
    const loop = C.infra.rail();
    const p = C.infra.posOnLoop(loop, sArc);
    const nx = -p.diry, ny = p.dirx;
    const cx = p.tx + 0.5 + nx * 0.5, cy = p.ty + 0.5 + ny * 0.5;
    const a = C.worldToScreen(cx - p.dirx * 1.1, cy - p.diry * 1.1, 0);
    const b = C.worldToScreen(cx + p.dirx * 1.1, cy + p.diry * 1.1, 0);
    ctx.fillStyle = 'rgba(196,201,208,0.95)';
    ctx.strokeStyle = 'rgba(40,46,54,0.3)'; ctx.lineWidth = 0.8;
    poly(ctx, [
      C.worldToScreen(cx - p.dirx * 1.1 - nx * 0.32, cy - p.diry * 1.1 - ny * 0.32, 0),
      C.worldToScreen(cx + p.dirx * 1.1 - nx * 0.32, cy + p.diry * 1.1 - ny * 0.32, 0),
      C.worldToScreen(cx + p.dirx * 1.1 + nx * 0.32, cy + p.diry * 1.1 + ny * 0.32, 0),
      C.worldToScreen(cx - p.dirx * 1.1 + nx * 0.32, cy - p.diry * 1.1 + ny * 0.32, 0),
    ]); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#9aa2ab'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x, a.y - 11);
    ctx.moveTo(b.x, b.y); ctx.lineTo(b.x, b.y - 11); ctx.stroke();
    ctx.strokeStyle = '#3f6f9e'; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(a.x, a.y - 11); ctx.lineTo(b.x, b.y - 11); ctx.stroke();
  }

  function drawCar(ctx, sArc, lead) {
    const loop = C.infra.rail();
    const p = C.infra.posOnLoop(loop, sArc);
    const base = C.worldToScreen(p.tx + 0.5, p.ty + 0.5, 0);
    const fwd = C.worldToScreen(p.tx + 0.5 + p.dirx, p.ty + 0.5 + p.diry, 0);
    let fx = fwd.x - base.x, fy = fwd.y - base.y;
    const rx = -fy, ry = fx;
    const L = CAR_LEN, Wd = CAR_WID, lift = 6.2;
    const corner = (a, t, z) => ({ x: base.x + fx * a + rx * t, y: base.y + fy * a + ry * t - z });
    ctx.save();
    ctx.globalAlpha = train.alpha;
    ctx.fillStyle = 'rgba(24,30,40,0.22)';
    poly(ctx, [corner(-L / 2, -Wd / 2, 0), corner(L / 2, -Wd / 2, 0), corner(L / 2, Wd / 2, 0), corner(-L / 2, Wd / 2, 0)]); ctx.fill();
    ctx.fillStyle = '#9aa3ad';
    poly(ctx, [corner(L / 2, -Wd / 2, 0), corner(L / 2, Wd / 2, 0), corner(L / 2, Wd / 2, lift), corner(L / 2, -Wd / 2, lift)]); ctx.fill();
    poly(ctx, [corner(-L / 2, Wd / 2, 0), corner(L / 2, Wd / 2, 0), corner(L / 2, Wd / 2, lift), corner(-L / 2, Wd / 2, lift)]);
    ctx.fillStyle = '#828b95'; ctx.fill();
    ctx.fillStyle = '#cfd6dd';
    poly(ctx, [corner(-L / 2, -Wd / 2, lift), corner(L / 2, -Wd / 2, lift), corner(L / 2, Wd / 2, lift), corner(-L / 2, Wd / 2, lift)]); ctx.fill();
    ctx.fillStyle = '#c2402f';
    poly(ctx, [corner(-L / 2, Wd / 2 - 0.02, lift * 0.62), corner(L / 2, Wd / 2 - 0.02, lift * 0.62), corner(L / 2, Wd / 2 - 0.02, lift * 0.82), corner(-L / 2, Wd / 2 - 0.02, lift * 0.82)]); ctx.fill();
    ctx.fillStyle = 'rgba(180,214,232,0.62)';
    for (let a = -L * 0.34; a <= L * 0.36; a += L * 0.16) {
      poly(ctx, [corner(a, Wd / 2 - 0.03, lift * 0.84), corner(a + L * 0.1, Wd / 2 - 0.03, lift * 0.84), corner(a + L * 0.1, Wd / 2 - 0.03, lift * 0.96), corner(a, Wd / 2 - 0.03, lift * 0.96)]); ctx.fill();
    }
    if (lead) { const lp = corner(L / 2, 0, lift * 0.5); ctx.fillStyle = '#fff4c8'; ctx.beginPath(); ctx.arc(lp.x, lp.y, 1, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  function carPos(i) { return train.lead - i * (CAR_LEN + CAR_GAP); }

  function onScreen(tx, ty, vt, cw, ch) {
    const ss = C.worldToScreen(tx + 0.5, ty + 0.5, 0);
    const sx = ss.x * vt.zoom + vt.offX, sy = ss.y * vt.zoom + vt.offY;
    return !(sx < -CULL_MARGIN || sx > cw + CULL_MARGIN || sy < -CULL_MARGIN || sy > ch + CULL_MARGIN);
  }

  function collectDrawables(list, now, camera) {
    const loop = C.infra.rail();
    if (!loop) return;
    list.push({ depth: TRACK_DEPTH, draw: (ctx) => drawTrack(ctx) });
    const vt = camera ? camera.viewTransform() : null;
    const cw = (canvas && canvas.clientWidth) || 1e5;
    const ch = (canvas && canvas.clientHeight) || 1e5;
    // stations only on finished track
    const builtLen = C.infra.lenToEdge(loop, loop.builtEdges);
    for (const sArc of train.stations) {
      if (sArc > builtLen) continue;
      const p = C.infra.posOnLoop(loop, sArc);
      if (vt && !onScreen(p.tx, p.ty, vt, cw, ch)) continue;
      list.push({ depth: C.depthKey(p.tx, p.ty) - 1, draw: (ctx) => drawStation(ctx, sArc) });
    }
    if (!loop.complete) return;          // train runs only once the loop is whole
    for (let i = 0; i < N_CARS; i++) {
      const sArc = carPos(i);
      const p = C.infra.posOnLoop(loop, sArc);
      if (vt && !onScreen(p.tx, p.ty, vt, cw, ch)) continue;
      const isLead = i === 0;
      list.push({ depth: C.depthKey(p.tx, p.ty), draw: (ctx) => drawCar(ctx, sArc, isLead) });
    }
  }

  function reset() { infraVer = -1; rebuild(); }

  C.rail = { update, collectDrawables, reset };
})();
