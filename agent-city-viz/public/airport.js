/* ===========================================================================
   airport.js — the city airport, CONSTRUCTED in stages rather than spawned.

   C.infra.airport() (null until the city is big enough, and only funded after
   the rail loop is finished — see infra.js) reports a 0..1 build progress paid
   for by the city's accumulated work. Stages reveal in order: clear & grade the
   field → pave the apron, taxiway and runway → raise the terminal (under
   scaffold) → build the control tower → roll out the parked aircraft. Only once
   the airfield is complete does the active aircraft begin its endless takeoff ↔
   landing cycle. Client-side scenery; reuses C.drawBox / C.drawDiamond.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const canvas = document.getElementById('city-canvas');
  const FH = C.FLOOR_H;
  const APRON_DEPTH = -1e12 + 20;
  const CULL_MARGIN = 120;

  const PH = { roll: 4.0, climb: 2.6, gap: 2.6, approach: 2.8, rollout: 3.6, dwell: 1.8 };
  const CYCLE = PH.roll + PH.climb + PH.gap + PH.approach + PH.rollout + PH.dwell;
  const CLIMB_RUN = 11, CLIMB_Z = 95;

  let t = 0;

  function update(dt) {
    C.infra.ensure();
    const ap = C.infra.airport();
    t = (ap && ap.complete) ? (t + dt) % CYCLE : 0;
  }

  // ---- flat surfaces (progressive) -----------------------------------------
  function strokeRunwayLine(ctx, ap) {
    const a = C.worldToScreen(ap.runX0 + 0.4, ap.runY + 0.5, 0);
    const b = C.worldToScreen(ap.runX1 - 0.4, ap.runY + 0.5, 0);
    ctx.strokeStyle = 'rgba(236,238,242,0.8)'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
  }

  function drawApron(ctx) {
    const ap = C.infra.airport();
    if (!ap) return;
    const p = ap.progress;
    // field: bare graded earth early, grassed once built
    C.drawDiamond(ctx, ap.x0 - 0.5, ap.y0 - 0.5, (ap.x1 - ap.x0) + 1, (ap.y1 - ap.y0) + 1,
      p < 0.2 ? '#b39b6e' : '#7cbb66', 'rgba(0,0,0,0.07)');
    if (p >= 0.2) C.drawDiamond(ctx, ap.x0, ap.y0 + 0.3, 3.2, (ap.y1 - ap.y0) - 0.6, '#cdd2d8', 'rgba(0,0,0,0.08)'); // apron
    if (p >= 0.3) C.drawDiamond(ctx, ap.x0 + 3, ap.runY + 0.1, ap.runX0 - ap.x0 - 2.6, 0.8, '#b8bdc4'); // taxiway
    if (p >= 0.3) C.drawDiamond(ctx, ap.runX0, ap.runY - 0.2, ap.runX1 - ap.runX0, 1.4,
      p >= 0.45 ? '#43484f' : '#6f6a5a', 'rgba(0,0,0,0.18)'); // runway (sub-base then asphalt)
    if (p >= 0.45) {
      for (const x of [ap.runX0 + 0.3, ap.runX1 - 0.6]) C.drawDiamond(ctx, x, ap.runY - 0.05, 0.3, 1.1, 'rgba(236,238,242,0.85)');
      strokeRunwayLine(ctx, ap);
    }
    // grading equipment + cones while the field is still being made
    if (p < 0.5) drawDigger(ctx, ap.x0 + 5.5, ap.runY + 2.4, p);
  }

  // ---- shapes ---------------------------------------------------------------
  function poly(ctx, pts) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  function drawDigger(ctx, tx, ty, p) {
    const base = C.worldToScreen(tx + 0.5, ty + 0.5, 0);
    ctx.fillStyle = 'rgba(28,36,46,0.22)';
    ctx.beginPath(); ctx.ellipse(base.x, base.y, 7, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e0a92e'; ctx.fillRect(base.x - 4, base.y - 6, 7, 5);          // cab/body
    ctx.fillStyle = '#c8901f'; ctx.fillRect(base.x - 4, base.y - 1.4, 8, 1.8);      // tracks
    ctx.strokeStyle = '#caa84a'; ctx.lineWidth = 1.4;                                // arm + bucket
    const sw = Math.sin(p * 60) * 2;
    ctx.beginPath(); ctx.moveTo(base.x + 2, base.y - 5); ctx.lineTo(base.x + 7 + sw, base.y - 2); ctx.stroke();
    ctx.fillStyle = '#9a7a1a'; ctx.fillRect(base.x + 6 + sw, base.y - 2.5, 2.2, 2.2);
  }

  function drawPlane(ctx, tx, ty, dirx, z, alpha, scale) {
    scale = scale || 1;
    const base = C.worldToScreen(tx + 0.5, ty + 0.5, 0);
    const fwd = C.worldToScreen(tx + 0.5 + dirx, ty + 0.5, 0);
    const fx = (fwd.x - base.x) * scale, fy = (fwd.y - base.y) * scale;
    const rx = -fy, ry = fx;
    const P = (a, c, zz) => ({ x: base.x + fx * a + rx * c, y: base.y + fy * a + ry * c - (zz || 0) });
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    if (z < 70) {
      ctx.globalAlpha = (alpha == null ? 1 : alpha) * Math.max(0, 0.28 - z / 260);
      ctx.fillStyle = 'rgba(24,30,40,1)';
      poly(ctx, [P(1.1, 0, 0), P(-0.1, -1.0, 0), P(-1.1, 0, 0), P(-0.1, 1.0, 0)]); ctx.fill();
      ctx.globalAlpha = alpha == null ? 1 : alpha;
    }
    ctx.fillStyle = '#d3d8de';
    poly(ctx, [P(0.12, -1.0, z), P(0.5, -0.12, z), P(0.5, 0.12, z), P(0.12, 1.0, z)]); ctx.fill();
    ctx.fillStyle = '#c3c9d0';
    poly(ctx, [P(-0.78, -0.45, z), P(-0.62, -0.08, z), P(-0.62, 0.08, z), P(-0.78, 0.45, z)]); ctx.fill();
    ctx.fillStyle = '#f3f5f7';
    poly(ctx, [P(1.18, 0, z), P(0.2, -0.16, z), P(-1.0, -0.12, z), P(-1.12, 0, z), P(-1.0, 0.12, z), P(0.2, 0.16, z)]); ctx.fill();
    ctx.strokeStyle = '#2f6fb0'; ctx.lineWidth = 1;
    const c0 = P(1.0, 0, z), c1 = P(-1.0, 0, z);
    ctx.beginPath(); ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.stroke();
    ctx.fillStyle = '#e9edf1';
    poly(ctx, [P(-1.05, 0, z), P(-1.05, 0, z + 6 * scale), P(-0.72, 0, z + 1 * scale)]); ctx.fill();
    ctx.strokeStyle = '#2f6fb0'; ctx.stroke();
    ctx.restore();
  }

  // scaffold wrap on a rising structure
  function scaffold(ctx, tx, ty, w, d, h) {
    const C2 = C.worldToScreen;
    ctx.strokeStyle = C.PAL.scaffold; ctx.lineWidth = 1;
    const steps = Math.max(1, Math.round(h / (FH * 0.8)));
    for (let i = 0; i <= steps; i++) {
      const z = (h * i) / steps;
      const a = C2(tx, ty + d, z), b = C2(tx + w, ty + d, z), e = C2(tx + w, ty, z);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    }
  }

  function drawTerminal(ctx, ap) {
    const p = ap.progress;
    if (p < 0.5) return;
    const tf = Math.max(0, Math.min(1, (p - 0.5) / 0.25));
    const ty0 = ap.y0 + 0.7, dep = (ap.y1 - ap.y0) - 1.4;
    const full = FH * 2.6, h = full * tf;
    C.drawBox(ctx, ap.x0 + 0.4, ty0, 1.6, dep, 0, Math.max(2, h), { h: 205, s: 12, l: 72 });
    if (tf >= 1) C.drawDiamond(ctx, ap.x0 + 0.5, ty0 + 0.1, 1.4, dep - 0.2, 'rgba(150,160,170,0.4)');
    else scaffold(ctx, ap.x0 + 0.4, ty0, 1.6, dep, h);
  }

  function drawTower(ctx, ap) {
    const p = ap.progress;
    if (p < 0.62) return;
    const tf = Math.max(0, Math.min(1, (p - 0.62) / 0.2));
    const tx0 = ap.x0 + 2.3, ty0 = ap.y0 + 0.7;
    const shaftH = FH * 6 * tf;
    C.drawBox(ctx, tx0, ty0, 0.5, 0.5, 0, Math.max(2, shaftH), { h: 210, s: 8, l: 66 });
    if (tf < 1) { scaffold(ctx, tx0, ty0, 0.5, 0.5, shaftH); return; }
    C.drawBox(ctx, tx0 - 0.18, ty0 - 0.18, 0.86, 0.86, FH * 6, FH * 1.2, { h: 200, s: 18, l: 58 });
    const top = C.worldToScreen(tx0 + 0.25, ty0 + 0.25, FH * 7.2);
    ctx.strokeStyle = '#9aa2ab'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(top.x, top.y - 9); ctx.stroke();
    ctx.fillStyle = '#e0524a'; ctx.beginPath(); ctx.arc(top.x, top.y - 10, 1.6, 0, Math.PI * 2); ctx.fill();
  }

  function onScreen(tx, ty, vt, cw, ch, z) {
    const ss = C.worldToScreen(tx + 0.5, ty + 0.5, z || 0);
    const sx = ss.x * vt.zoom + vt.offX, sy = ss.y * vt.zoom + vt.offY;
    return !(sx < -CULL_MARGIN || sx > cw + CULL_MARGIN || sy < -CULL_MARGIN || sy > ch + CULL_MARGIN);
  }

  function planeState(ap) {
    let u = t; const lerp = C.lerp;
    if (u < PH.roll) { const k = u / PH.roll; return { tx: lerp(ap.runX0, ap.runX1, k * k * 0.6 + k * 0.4), z: 0, dirx: 1, alpha: 1, vis: true }; }
    u -= PH.roll;
    if (u < PH.climb) { const k = u / PH.climb; return { tx: lerp(ap.runX1, ap.runX1 + CLIMB_RUN, k), z: CLIMB_Z * k * k, dirx: 1, alpha: 1 - k * 0.9, vis: true }; }
    u -= PH.climb;
    if (u < PH.gap) return { vis: false };
    u -= PH.gap;
    if (u < PH.approach) { const k = u / PH.approach; return { tx: lerp(ap.runX1 + CLIMB_RUN, ap.runX1, k), z: CLIMB_Z * (1 - k) * (1 - k), dirx: -1, alpha: 0.1 + k * 0.9, vis: true }; }
    u -= PH.approach;
    if (u < PH.rollout) { const k = u / PH.rollout; return { tx: lerp(ap.runX1, ap.runX0, k * k * 0.4 + k * 0.6), z: 0, dirx: -1, alpha: 1, vis: true }; }
    return { tx: ap.runX0, z: 0, dirx: 1, alpha: 1, vis: true };
  }

  function collectDrawables(list, now, camera) {
    const ap = C.infra.airport();
    if (!ap) return;
    list.push({ depth: APRON_DEPTH, draw: (ctx) => drawApron(ctx) });
    const vt = camera ? camera.viewTransform() : null;
    const cw = (canvas && canvas.clientWidth) || 1e5;
    const ch = (canvas && canvas.clientHeight) || 1e5;

    list.push({ depth: C.depthKey(ap.x0 + 1.2, ap.y1 - 0.7), draw: (ctx) => drawTerminal(ctx, ap) });
    list.push({ depth: C.depthKey(ap.x0 + 2.5, ap.y0 + 0.9), draw: (ctx) => drawTower(ctx, ap) });

    if (ap.progress >= 0.85) {
      const parked = [{ tx: ap.x0 + 1.4, ty: ap.runY - 2.0 }, { tx: ap.x0 + 1.4, ty: ap.runY + 1.4 }];
      for (const pk of parked) list.push({ depth: C.depthKey(pk.tx, pk.ty), draw: (ctx) => drawPlane(ctx, pk.tx, pk.ty, 1, 0, 1, 0.82) });
    }

    if (ap.complete) {
      const st = planeState(ap);
      if (st.vis && (!vt || onScreen(st.tx, ap.runY, vt, cw, ch, st.z))) {
        const depth = C.depthKey(st.tx, ap.runY) + st.z * 50;
        list.push({ depth, draw: (ctx) => drawPlane(ctx, st.tx, ap.runY, st.dirx, st.z, st.alpha, 1) });
      }
    }
  }

  function reset() { t = 0; }

  C.airport = { update, collectDrawables, reset };
})();
