/* ===========================================================================
   connectors.js — the connector FREEWAYS that tie each detached satellite town
   back to the downtown core's beltway. The Southern-California shape: a dense
   core ringed by separate suburbs and farm towns, each reached by a long road
   across open country.

   Like every other network in the viz, a connector does NOT pop into existence:
   C.infra.connectors() reports how far each freeway has been paved (paid for by
   the city's accumulated work, after the beltway, nearest town first). We draw
   finished asphalt for the built span, an active ROADWORKS zone (graded sub-base
   + cones + a roller at the work front) where paving is currently happening, and
   a faint surveyed alignment for the stretch still to come. A finished connector
   is folded into the shared pathgraph (see infra.drivableTiles), so ordinary
   cars drive town-to-core on it. Client-side scenery. =========================== */
(function () {
  'use strict';
  const C = window.CITY;
  const ROAD_DEPTH = -1e12 + 1;       // flat road, just over the beltway, behind the scene

  function update() { C.infra.ensure(); }

  function sp(t) { return C.worldToScreen(t.tx + 0.5, t.ty + 0.5, 0); }

  function strokePts(ctx, pts, width, color, dash) {
    if (pts.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke(); ctx.setLineDash([]);
  }
  function pavedPts(ctx, pts) {
    strokePts(ctx, pts, 13, 'rgba(20,26,34,0.18)');           // soft edge
    strokePts(ctx, pts, 10.5, '#3b414a');                     // asphalt
    strokePts(ctx, pts, 1, 'rgba(236,200,86,0.7)', [6, 7]);   // centre line
  }
  function subbasePts(ctx, pts) {
    strokePts(ctx, pts, 11, '#7c6a4f');                       // graded sub-base
    strokePts(ctx, pts, 8.5, '#8a7659');
  }
  function surveyPts(ctx, pts) {
    strokePts(ctx, pts, 5, 'rgba(150,134,96,0.32)', [3, 6]);  // faint future alignment
  }

  function poly(ctx, pts) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  function drawCones(ctx, pts) {
    for (const p of pts) {
      ctx.fillStyle = '#e2622a';
      ctx.beginPath(); ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x - 1.5, p.y); ctx.lineTo(p.x + 1.5, p.y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(p.x - 1, p.y - 2.4, 2, 0.9);
    }
  }
  // A road roller at the paving front — the visible "worker" laying the freeway.
  function drawRoller(ctx, at, dir, now) {
    let dx = dir.dx, dy = dir.dy; const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
    const base = C.worldToScreen(at.tx + 0.5, at.ty + 0.5, 0);
    const fwd = C.worldToScreen(at.tx + 0.5 + dx, at.ty + 0.5 + dy, 0);
    const fx = fwd.x - base.x, fy = fwd.y - base.y;
    const rx = -fy, ry = fx;
    const L = 0.7, Wd = 0.42, lift = 4.4;
    const corner = (u, t, z) => ({ x: base.x + fx * u + rx * t, y: base.y + fy * u + ry * t - z });
    ctx.save();
    ctx.fillStyle = 'rgba(28,36,46,0.22)';
    poly(ctx, [corner(-L / 2, -Wd / 2, 0), corner(L / 2, -Wd / 2, 0), corner(L / 2, Wd / 2, 0), corner(-L / 2, Wd / 2, 0)]); ctx.fill();
    ctx.fillStyle = '#9aa2ab';
    poly(ctx, [corner(L * 0.32, -Wd * 0.6, 0), corner(L * 0.6, -Wd * 0.6, 0), corner(L * 0.6, Wd * 0.6, 0), corner(L * 0.32, Wd * 0.6, 0)]); ctx.fill();
    poly(ctx, [corner(L * 0.32, -Wd * 0.6, lift * 0.8), corner(L * 0.6, -Wd * 0.6, lift * 0.8), corner(L * 0.6, Wd * 0.6, lift * 0.8), corner(L * 0.32, Wd * 0.6, lift * 0.8)]); ctx.fill();
    ctx.fillStyle = '#e0a92e';
    poly(ctx, [corner(-L / 2, Wd / 2, 0), corner(L * 0.3, Wd / 2, 0), corner(L * 0.3, Wd / 2, lift), corner(-L / 2, Wd / 2, lift)]); ctx.fill();
    ctx.fillStyle = '#f0c14a';
    poly(ctx, [corner(-L / 2, -Wd / 2, lift), corner(L * 0.3, -Wd / 2, lift), corner(L * 0.3, Wd / 2, lift), corner(-L / 2, Wd / 2, lift)]); ctx.fill();
    const on = Math.floor(now / 350) % 2 === 0;
    const bp = corner(-L * 0.1, 0, lift + 1.6);
    ctx.fillStyle = on ? '#ffcf4a' : '#8a6a18';
    ctx.beginPath(); ctx.arc(bp.x, bp.y, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawConnector(ctx, c, now) {
    const tiles = c.tiles;
    const n = tiles.length;
    if (n < 2) return;
    const pts = tiles.map(sp);
    if (c.complete) { pavedPts(ctx, pts); return; }
    // not started yet (waiting its turn in the work queue): a surveyed alignment
    // across open country, no crew on site — same as the beltway's future edges.
    if (c.builtFrac <= 0.001) { surveyPts(ctx, pts); return; }
    const built = Math.max(0, Math.min(n, Math.round(c.builtFrac * n)));
    if (built >= 2) pavedPts(ctx, pts.slice(0, built));
    // active roadworks: grading at the front, survey alignment beyond it
    const gradeStart = Math.max(0, built - 1);
    const gradeEnd = Math.min(n, built + 2);
    subbasePts(ctx, pts.slice(gradeStart, gradeEnd));
    if (gradeEnd < n) surveyPts(ctx, pts.slice(gradeEnd - 1));
    drawCones(ctx, pts.slice(gradeStart, gradeEnd));
    const fi = Math.min(n - 1, built);
    drawRoller(ctx, tiles[fi], { dx: tiles[fi].tx - tiles[Math.max(0, fi - 1)].tx, dy: tiles[fi].ty - tiles[Math.max(0, fi - 1)].ty }, now);
  }

  function drawConnectors(ctx, now) {
    const conns = C.infra.connectors();
    for (const c of conns) drawConnector(ctx, c, now);
  }

  function collectDrawables(list, now) {
    list.push({ depth: ROAD_DEPTH, draw: (ctx) => drawConnectors(ctx, now) });
  }

  function reset() { C.infra.ensure(); }

  C.connectors = { update, collectDrawables, reset };
})();
