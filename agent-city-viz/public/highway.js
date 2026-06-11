/* ===========================================================================
   highway.js — the ring highway (beltway), drawn in whatever state of
   CONSTRUCTION the city's workers have reached.

   It does NOT pop into existence: C.infra.highway() reports how many of the
   four ring edges have been paved (paid for by the city's accumulated work) and
   how far the active edge has progressed. We render finished asphalt for done
   edges, an active ROADWORKS zone (graded sub-base + cones + a roller at the
   work front) for the edge under construction, and a faint surveyed alignment
   for edges not yet started.

   Traffic is NOT drawn here any more: a finished beltway edge is folded into the
   shared pathgraph (see infra.drivableTiles + pathgraph.js), so the ordinary
   cars in traffic.js drive on it like any other road. Client-side scenery.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const ROAD_DEPTH = -1e12;          // flat surfaces sit behind the whole scene

  function update() { C.infra.ensure(); }

  // ---- helpers --------------------------------------------------------------
  function edgePoint(a, b, f) { return { tx: a.tx + (b.tx - a.tx) * f, ty: a.ty + (b.ty - a.ty) * f }; }
  function s(p) { return C.worldToScreen(p.tx + 0.5, p.ty + 0.5, 0); }

  function strokeSpan(ctx, a, b, f0, f1, width, color, dash) {
    const p0 = s(edgePoint(a, b, f0)), p1 = s(edgePoint(a, b, f1));
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    ctx.setLineDash([]);
  }

  function pavedSpan(ctx, a, b, f0, f1) {
    strokeSpan(ctx, a, b, f0, f1, 18, 'rgba(20,26,34,0.18)');       // soft edge
    strokeSpan(ctx, a, b, f0, f1, 15, '#3b414a');                   // asphalt
    strokeSpan(ctx, a, b, f0, f1, 1, 'rgba(236,200,86,0.7)', [7, 8]); // centre line
    strokeSpan(ctx, a, b, f0, f1, 0.8, 'rgba(210,215,222,0.4)');    // guardrail glint
  }
  function subbaseSpan(ctx, a, b, f0, f1) {
    strokeSpan(ctx, a, b, f0, f1, 16, '#7c6a4f');                   // graded sub-base
    strokeSpan(ctx, a, b, f0, f1, 13, '#8a7659');
  }
  function surveySpan(ctx, a, b, f0, f1) {
    strokeSpan(ctx, a, b, f0, f1, 6, 'rgba(150,134,96,0.35)', [3, 6]); // faint future alignment
  }

  function poly(ctx, pts) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  // A few traffic cones strung along the active work front.
  function drawCones(ctx, a, b, f0, f1) {
    const n = 4;
    for (let i = 0; i <= n; i++) {
      const f = f0 + (f1 - f0) * (i / n);
      const p = s(edgePoint(a, b, f));
      ctx.fillStyle = '#e2622a';
      ctx.beginPath(); ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x - 1.5, p.y); ctx.lineTo(p.x + 1.5, p.y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(p.x - 1, p.y - 2.4, 2, 0.9);
    }
  }

  // A road roller at the paving front — the visible "worker" laying the highway.
  function drawRoller(ctx, a, b, f, now) {
    const at = edgePoint(a, b, f);
    let dx = b.tx - a.tx, dy = b.ty - a.ty; const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
    const base = C.worldToScreen(at.tx + 0.5, at.ty + 0.5, 0);
    const fwd = C.worldToScreen(at.tx + 0.5 + dx, at.ty + 0.5 + dy, 0);
    let fx = fwd.x - base.x, fy = fwd.y - base.y;
    const rx = -fy, ry = fx;
    const L = 0.7, Wd = 0.42, lift = 4.4;
    const corner = (u, t, z) => ({ x: base.x + fx * u + rx * t, y: base.y + fy * u + ry * t - z });
    ctx.save();
    ctx.fillStyle = 'rgba(28,36,46,0.22)';
    poly(ctx, [corner(-L / 2, -Wd / 2, 0), corner(L / 2, -Wd / 2, 0), corner(L / 2, Wd / 2, 0), corner(-L / 2, Wd / 2, 0)]); ctx.fill();
    // steel drum up front
    ctx.fillStyle = '#9aa2ab';
    poly(ctx, [corner(L * 0.32, -Wd * 0.6, 0), corner(L * 0.6, -Wd * 0.6, 0), corner(L * 0.6, Wd * 0.6, 0), corner(L * 0.32, Wd * 0.6, 0)]); ctx.fill();
    poly(ctx, [corner(L * 0.32, -Wd * 0.6, lift * 0.8), corner(L * 0.6, -Wd * 0.6, lift * 0.8), corner(L * 0.6, Wd * 0.6, lift * 0.8), corner(L * 0.32, Wd * 0.6, lift * 0.8)]); ctx.fill();
    // body (construction yellow)
    ctx.fillStyle = '#e0a92e';
    poly(ctx, [corner(-L / 2, Wd / 2, 0), corner(L * 0.3, Wd / 2, 0), corner(L * 0.3, Wd / 2, lift), corner(-L / 2, Wd / 2, lift)]); ctx.fill();
    ctx.fillStyle = '#f0c14a';
    poly(ctx, [corner(-L / 2, -Wd / 2, lift), corner(L * 0.3, -Wd / 2, lift), corner(L * 0.3, Wd / 2, lift), corner(-L / 2, Wd / 2, lift)]); ctx.fill();
    // amber beacon (blinks)
    const on = Math.floor(now / 350) % 2 === 0;
    const bp = corner(-L * 0.1, 0, lift + 1.6);
    ctx.fillStyle = on ? '#ffcf4a' : '#8a6a18';
    ctx.beginPath(); ctx.arc(bp.x, bp.y, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawHighway(ctx, now) {
    const hw = C.infra.highway();
    const corners = hw.corners;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      if (i < hw.builtEdges) {
        pavedSpan(ctx, a, b, 0, 1);
      } else if (i === hw.activeEdge) {
        const f = hw.activeFrac;
        if (f > 0.01) pavedSpan(ctx, a, b, 0, f);
        const workEnd = Math.min(1, f + 0.12);
        subbaseSpan(ctx, a, b, f, workEnd);
        if (workEnd < 1) surveySpan(ctx, a, b, workEnd, 1);
        drawCones(ctx, a, b, f, workEnd);
        drawRoller(ctx, a, b, f, now);
      } else {
        surveySpan(ctx, a, b, 0, 1);
      }
    }
  }

  function collectDrawables(list, now) {
    list.push({ depth: ROAD_DEPTH, draw: (ctx) => drawHighway(ctx, now) });
  }

  function reset() { C.infra.ensure(); }

  C.highway = { update, collectDrawables, reset };
})();
