/* ===========================================================================
   buildings.js — procedural flat-shaded isometric buildings + construction
   stages, with a per-building sprite cache so towers cost one drawImage.

   Every building is derived from lot.building.seed (style, palette tinted by
   district hue, window pattern, roof furniture) so the same save file always
   renders the same skyline.

   Shading model: sun from the upper-NE. Each face gets a vertical gradient
   (lighter near the top, ambient-occluded toward the ground), the top ridge
   catches a bright highlight, and the building casts a soft silhouette shadow
   on the ground (drawn in a separate pass — see drawLotShadow / render.js).

   Construction stages from ratio = progress/required:
     < 0.10  excavation pit
     < 0.25  foundation slab
     < 1.00  floors rising (floorsBuilt = floor(ratio * floors)) + scaffold
     1.00    complete (parapet + roof membrane, windows lit, no scaffold)
   The crane and animated effects are drawn per-frame in effects.js / render.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const w2s = C.worldToScreen;

  // ---- Low-level fill helpers ----------------------------------------------
  function hsl(h, s, l) { return 'hsl(' + h + ',' + s + '%,' + C.clamp(l, 3, 97) + '%)'; }

  function poly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  // Vertical (screen-space) gradient across a face quad, top -> bottom.
  function vGrad(ctx, pts, top, bot) {
    let yMin = Infinity, yMax = -Infinity;
    for (const p of pts) { if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y; }
    const g = ctx.createLinearGradient(0, yMin, 0, yMax + 0.001);
    g.addColorStop(0, top);
    g.addColorStop(1, bot);
    return g;
  }

  // ---- Primitive: flat ground diamond --------------------------------------
  function drawDiamond(ctx, tx, ty, w, d, fill, stroke) {
    const pts = [w2s(tx, ty, 0), w2s(tx + w, ty, 0), w2s(tx + w, ty + d, 0), w2s(tx, ty + d, 0)];
    poly(ctx, pts);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }
  function drawDiamondAt(ctx, tx, ty, w, d, z, fill, stroke) {
    const pts = [w2s(tx, ty, z), w2s(tx + w, ty, z), w2s(tx + w, ty + d, z), w2s(tx, ty + d, z)];
    poly(ctx, pts);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }

  // ---- Primitive: iso box (top + two visible faces, gradient-shaded) --------
  // Visible faces: SW (S-W edge) is lit mid; SE (S-E edge) is the shade side.
  function drawBox(ctx, tx, ty, w, d, z0, h, col) {
    const zT = z0 + h;
    const nT = w2s(tx, ty, zT), eT = w2s(tx + w, ty, zT);
    const sT = w2s(tx + w, ty + d, zT), wT = w2s(tx, ty + d, zT);
    const sB = w2s(tx + w, ty + d, z0), wB = w2s(tx, ty + d, z0), eB = w2s(tx + w, ty, z0);

    // SW (left/front) face — W..S edge
    const left = [wT, sT, sB, wB];
    poly(ctx, left);
    ctx.fillStyle = vGrad(ctx, left, hsl(col.h, col.s, col.l - 4), hsl(col.h, col.s + 4, col.l - 15));
    ctx.fill();

    // SE (right/shade) face — S..E edge
    const right = [sT, eT, eB, sB];
    poly(ctx, right);
    ctx.fillStyle = vGrad(ctx, right, hsl(col.h, col.s, col.l - 13), hsl(col.h, col.s + 6, col.l - 24));
    ctx.fill();

    // top face — gentle gradient front-to-back
    const top = [nT, eT, sT, wT];
    poly(ctx, top);
    ctx.fillStyle = vGrad(ctx, top, hsl(col.h, col.s, col.l + 11), hsl(col.h, col.s, col.l + 4));
    ctx.fill();

    // crisp edges: bright sun ridge on top, soft seams on the corners
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(wT.x, wT.y); ctx.lineTo(nT.x, nT.y); ctx.lineTo(eT.x, eT.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(18,24,32,0.20)';
    ctx.beginPath();
    ctx.moveTo(wT.x, wT.y); ctx.lineTo(sT.x, sT.y); ctx.lineTo(eT.x, eT.y); // top front ridge
    ctx.moveTo(sT.x, sT.y); ctx.lineTo(sB.x, sB.y);                          // front vertical corner
    ctx.stroke();
  }

  // ---- Style derivation -------------------------------------------------------
  // Window/wall STYLE and base palette now follow the building TYPE (its
  // category) rather than a free seed roll, so an office reads as glass, a
  // house as warm brick, a power hall as bare concrete — then a per-seed
  // lightness wobble keeps neighbours of the same type from looking cloned.
  //   style 'glass'    -> curtain wall   (com: office, skyscraper)
  //   style 'brick'    -> punched windows, warm (res: house/apartment, school)
  //   style 'concrete' -> punched/none, cool   (civic: power_station, transit)
  // Colour is per-BUILDING, not per-district — the city is no longer zoned by
  // project, so each category carries an absolute base hue and a small per-seed
  // hue jitter keeps same-type neighbours distinct without going rainbow.
  const CAT_STYLE = {
    res:     { style: 'brick',    hue: 24,  s: 36, l: 56 },  // warm brick / terracotta
    com:     { style: 'glass',    hue: 205, s: 24, l: 62 },  // cool glass
    school:  { style: 'brick',    hue: 8,   s: 32, l: 56 },  // brick red
    power:   { style: 'concrete', hue: 212, s: 8,  l: 64 },  // bare concrete
    transit: { style: 'concrete', hue: 200, s: 16, l: 64 },  // steel grey-blue
  };
  function buildingStyle(lot, _district) {
    const b = lot.building || {};
    const seed = b.seed || 1;
    const type = b.type || 'office';
    const cat = C.buildingCategory(type);
    const cs = CAT_STYLE[cat] || CAT_STYLE.com;
    const hue = (cs.hue + ((seed >>> 12) % 25) - 12 + 360) % 360; // ±12 per-seed
    const col = { h: hue, s: cs.s, l: cs.l + ((seed >>> 4) % 9) - 4 };
    return { style: cs.style, col, seed, hue, type, cat };
  }

  // ---- Windows (two genuinely-visible faces) ---------------------------------
  // SW face: plane ty+d, param along +tx (w tiles). SE face: plane tx+w,
  // param along +ty (d tiles). edgePt returns the screen point at edge param
  // p (in tiles) and height z.
  function edgePt(side, tx, ty, w, d, p, z) {
    return side === 'left' ? w2s(tx + p, ty + d, z) : w2s(tx + w, ty + p, z);
  }

  function drawWindows(ctx, tx, ty, w, d, z0, floors, st) {
    for (const side of ['left', 'right']) {
      const tiles = side === 'left' ? w : d;
      if (st.style === 'glass') curtainWall(ctx, side, tx, ty, w, d, z0, floors, tiles, st);
      else punchedWindows(ctx, side, tx, ty, w, d, z0, floors, tiles, st);
    }
  }

  function curtainWall(ctx, side, tx, ty, w, d, z0, floors, tiles, st) {
    const H = floors * C.FLOOR_H;
    const tl = edgePt(side, tx, ty, w, d, 0, z0 + H);
    const tr = edgePt(side, tx, ty, w, d, tiles, z0 + H);
    const br = edgePt(side, tx, ty, w, d, tiles, z0);
    const bl = edgePt(side, tx, ty, w, d, 0, z0);
    const reflect = side === 'left' ? 0.55 : 0.32; // sun side reflects more sky
    poly(ctx, [tl, tr, br, bl]);
    ctx.fillStyle = vGrad(ctx, [tl, tr, br, bl],
      'rgba(213,234,246,' + reflect + ')', 'rgba(70,96,122,0.34)');
    ctx.fill();

    // mullions
    ctx.strokeStyle = 'rgba(236,243,248,0.30)';
    ctx.lineWidth = 0.7;
    const cols = tiles * 2;
    ctx.beginPath();
    for (let i = 0; i <= cols; i++) {
      const p = (i / cols) * tiles;
      const a = edgePt(side, tx, ty, w, d, p, z0 + H), b = edgePt(side, tx, ty, w, d, p, z0);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let f = 0; f <= floors; f++) {
      const z = z0 + f * C.FLOOR_H;
      const a = edgePt(side, tx, ty, w, d, 0, z), b = edgePt(side, tx, ty, w, d, tiles, z);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    if (!st.complete) return;
    // a scatter of lit panels gives the glass life when finished
    const lit = st.seed >>> 3;
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < cols; c++) {
        if (((lit >>> ((f * 5 + c * 3) % 29)) & 7) !== 0) continue;
        fillCell(ctx, side, tx, ty, w, d, z0, f, c / cols * tiles, (c + 1) / cols * tiles, 0.12, 0.92,
          'rgba(255,238,170,0.72)');
      }
    }
  }

  function punchedWindows(ctx, side, tx, ty, w, d, z0, floors, tiles, st) {
    const lit = st.seed >>> 3;
    const perTile = 2;
    const pane = st.style === 'brick' ? 'rgba(38,52,74,0.62)' : 'rgba(46,62,86,0.55)';
    const frame = 'rgba(244,246,248,0.20)';
    for (let f = 0; f < floors; f++) {
      for (let k = 0; k < tiles; k++) {
        for (let c = 0; c < perTile; c++) {
          const p0 = k + (c + 0.22) / perTile;
          const p1 = k + (c + 0.78) / perTile;
          const isLit = st.complete && (((lit >>> ((f * 7 + (k * perTile + c) * 3) % 28)) & 3) === 0);
          fillCell(ctx, side, tx, ty, w, d, z0, f, p0, p1, 0.30, 0.78,
            isLit ? 'rgba(255,232,150,0.85)' : pane, frame);
        }
      }
    }
  }

  // Fill one window cell on a face: param span [p0,p1] (tiles), vertical span
  // [zLoFrac,zHiFrac] within floor f. Optional frame stroke.
  function fillCell(ctx, side, tx, ty, w, d, z0, f, p0, p1, zLoFrac, zHiFrac, fill, frame) {
    const zLo = z0 + (f + zLoFrac) * C.FLOOR_H;
    const zHi = z0 + (f + zHiFrac) * C.FLOOR_H;
    const a = edgePt(side, tx, ty, w, d, p0, zHi);
    const b = edgePt(side, tx, ty, w, d, p1, zHi);
    const c = edgePt(side, tx, ty, w, d, p1, zLo);
    const e = edgePt(side, tx, ty, w, d, p0, zLo);
    poly(ctx, [a, b, c, e]);
    ctx.fillStyle = fill;
    ctx.fill();
    if (frame) { ctx.strokeStyle = frame; ctx.lineWidth = 0.6; ctx.stroke(); }
  }

  // ---- Parapet + roof membrane (finished buildings) --------------------------
  function drawRoofCap(ctx, tx, ty, w, d, zTop, st) {
    // recessed gravel membrane inside the parapet rim (the box top is the rim).
    // Neutral mid-gray so it reads as a roof, not a void, on light buildings.
    const inset = 0.11;
    drawDiamondAt(ctx, tx + inset, ty + inset, w - 2 * inset, d - 2 * inset, zTop,
      hsl(st.hue, 7, 48), 'rgba(18,22,28,0.22)');
    // bright lip on the NW parapet edge sells the raised rim
    const a = w2s(tx + inset, ty + d - inset, zTop);
    const b = w2s(tx + inset, ty + inset, zTop);
    const e = w2s(tx + w - inset, ty + inset, zTop);
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(e.x, e.y); ctx.stroke();
  }

  // ---- Roof furniture -----------------------------------------------------------
  function drawRoof(ctx, tx, ty, w, d, zTop, st, tier) {
    const s = st.seed;
    if (tier >= 3 && (s & 3) === 0) {
      const p = w2s(tx + w * 0.5, ty + d * 0.5, zTop);
      ctx.strokeStyle = '#9aa2ab';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - 18); ctx.stroke();
      ctx.fillStyle = '#e0524a';
      ctx.beginPath(); ctx.arc(p.x, p.y - 19, 2, 0, Math.PI * 2); ctx.fill();
    } else if ((s & 3) === 1) {
      drawBox(ctx, tx + w * 0.5, ty + d * 0.18, w * 0.3, d * 0.3, zTop, 5, { h: 0, s: 0, l: 74 });
    } else if (tier >= 2 && (s & 3) === 2) {
      drawBox(ctx, tx + w * 0.14, ty + d * 0.52, w * 0.26, d * 0.26, zTop, 9, { h: 26, s: 34, l: 50 });
    } else if (tier >= 3) {
      // rooftop bulkhead / stair head
      drawBox(ctx, tx + w * 0.32, ty + d * 0.32, w * 0.36, d * 0.36, zTop, 6, { h: st.hue, s: 8, l: 58 });
    }
  }

  // ---- Type-specific caps (drawn on a finished building's wall top) ----------

  // House: a hip roof of warm tile + a little chimney, in place of a flat
  // parapet — the silhouette is what reads as "house" at iso scale.
  function drawHouseRoof(ctx, pl, h, st) {
    const { tx, ty, w, d } = pl;
    const rh = C.FLOOR_H * 0.95;
    const apex = w2s(tx + w / 2, ty + d / 2, h + rh);
    const eT = w2s(tx + w, ty, h), sT = w2s(tx + w, ty + d, h), wT = w2s(tx, ty + d, h);
    const rhue = (st.hue + 16) % 360;
    // SW (front-left) slope, then SE (front-right, shade) slope
    poly(ctx, [wT, sT, apex]); ctx.fillStyle = hsl(rhue, 46, 40); ctx.fill();
    poly(ctx, [sT, eT, apex]); ctx.fillStyle = hsl(rhue, 48, 32); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(wT.x, wT.y); ctx.lineTo(apex.x, apex.y); ctx.lineTo(eT.x, eT.y); ctx.stroke();
    // chimney poking from the front-left slope
    drawBox(ctx, tx + w * 0.2, ty + d * 0.62, w * 0.16, d * 0.16, h, C.FLOOR_H * 1.1, { h: st.hue, s: 14, l: 44 });
  }

  // Skyscraper: a glassy setback crown + an antenna mast with a beacon.
  function drawSpire(ctx, pl, h, st) {
    const { tx, ty, w, d } = pl;
    const ins = 0.3;
    drawBox(ctx, tx + ins, ty + ins, w - 2 * ins, d - 2 * ins, h, C.FLOOR_H * 2, { h: st.col.h, s: st.col.s, l: st.col.l - 5 });
    const base = w2s(tx + w / 2, ty + d / 2, h + C.FLOOR_H * 2);
    ctx.strokeStyle = '#aeb6bf'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(base.x, base.y - 28); ctx.stroke();
    ctx.fillStyle = '#e0524a';
    ctx.beginPath(); ctx.arc(base.x, base.y - 29, 2.2, 0, Math.PI * 2); ctx.fill();
  }

  // School: a flagpole + pennant in the district hue on the front-left corner.
  function drawSchoolTrim(ctx, pl, h, st) {
    const base = w2s(pl.tx + 0.14, pl.ty + pl.d - 0.14, h);
    ctx.strokeStyle = '#cfd5db'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(base.x, base.y - 24); ctx.stroke();
    ctx.fillStyle = hsl(st.hue, 58, 52);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y - 24); ctx.lineTo(base.x + 10, base.y - 21); ctx.lineTo(base.x, base.y - 18);
    ctx.closePath(); ctx.fill();
  }

  // ---- Civic painters (full lot — base hall + distinctive silhouette) --------

  // A concrete cooling tower (frustum) standing on the ground, venting steam.
  function drawCoolingTower(ctx, cx, cy, hgt) {
    const base = w2s(cx, cy, 0), top = w2s(cx, cy, hgt);
    const rB = 12, rT = 9, ry = 0.42;
    const body = [
      { x: base.x - rB, y: base.y }, { x: top.x - rT, y: top.y },
      { x: top.x + rT, y: top.y }, { x: base.x + rB, y: base.y },
    ];
    poly(ctx, body);
    ctx.fillStyle = vGrad(ctx, body, 'hsl(210,8%,79%)', 'hsl(210,11%,53%)');
    ctx.fill();
    // shade the SE half
    poly(ctx, [{ x: top.x, y: top.y }, { x: top.x + rT, y: top.y }, { x: base.x + rB, y: base.y }, { x: base.x, y: base.y }]);
    ctx.fillStyle = 'rgba(20,26,34,0.10)'; ctx.fill();
    // dark throat + bright back lip
    ctx.fillStyle = 'rgba(38,44,52,0.92)';
    ctx.beginPath(); ctx.ellipse(top.x, top.y, rT, rT * ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(top.x, top.y, rT, rT * ry, 0, Math.PI, Math.PI * 2); ctx.stroke();
    // steam
    ctx.fillStyle = 'rgba(238,242,246,0.5)';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath(); ctx.arc(top.x + (i - 1) * 4, top.y - 7 - i * 5, 5 - i * 0.8, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawSmokestack(ctx, cx, cy, hgt) {
    const base = w2s(cx, cy, 0), top = w2s(cx, cy, hgt);
    const r = 4.5;
    const body = [
      { x: base.x - r, y: base.y }, { x: top.x - r * 0.8, y: top.y },
      { x: top.x + r * 0.8, y: top.y }, { x: base.x + r, y: base.y },
    ];
    poly(ctx, body);
    ctx.fillStyle = vGrad(ctx, body, 'hsl(210,6%,70%)', 'hsl(210,9%,46%)'); ctx.fill();
    ctx.fillStyle = '#c5483e';
    ctx.fillRect(top.x - r * 0.8, top.y + 5, r * 1.6, 3);
    ctx.fillStyle = 'rgba(38,44,52,0.9)';
    ctx.beginPath(); ctx.ellipse(top.x, top.y, r * 0.8, r * 0.34, 0, 0, Math.PI * 2); ctx.fill();
  }

  // Power station: a low concrete hall with a roller door, a back smokestack
  // and two cooling towers standing in front (front so they occlude correctly).
  function paintPowerStation(ctx, pl, st, floors) {
    const { tx, ty, w, d } = pl;
    const h = floors * C.FLOOR_H;
    drawSmokestack(ctx, tx + w * 0.32, ty + d * 0.28, C.FLOOR_H * 4.6); // behind the hall
    drawBox(ctx, tx, ty, w, d, 0, h, st.col);
    drawRoofCap(ctx, tx, ty, w, d, h, st);
    // roller door on the SW (front) face
    fillCell(ctx, 'left', tx, ty, w, d, 0, 0, w * 0.28, w * 0.72, 0.08, 0.86,
      'rgba(58,64,72,0.7)', 'rgba(228,231,234,0.25)');
    drawCoolingTower(ctx, tx + w * 0.62, ty + d * 0.7, C.FLOOR_H * 5.0);
    drawCoolingTower(ctx, tx + w * 0.3, ty + d * 0.82, C.FLOOR_H * 5.0);
  }

  // Transit hub: a low station box under a wide flat canopy, plus a painted
  // platform edge stripe — reads as a depot/station, not a residence.
  function paintTransit(ctx, pl, st, floors) {
    const { tx, ty, w, d } = pl;
    const h = floors * C.FLOOR_H;
    drawBox(ctx, tx, ty, w, d, 0, h, st.col);
    drawWindows(ctx, tx, ty, w, d, 0, floors, st);
    // overhanging canopy slab on a thin lip
    drawBox(ctx, tx - 0.12, ty - 0.12, w + 0.24, d + 0.24, h, 3, { h: st.hue, s: 14, l: 70 });
    drawRoofCap(ctx, tx - 0.12, ty - 0.12, w + 0.24, d + 0.24, h + 3, st);
    // yellow platform safety stripe along the SE edge
    const a = w2s(tx + w, ty, 0), b = w2s(tx + w, ty + d, 0);
    ctx.strokeStyle = 'rgba(230,193,77,0.85)'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
  }

  // ---- Scaffold wrap (construction) -----------------------------------------------
  function drawScaffold(ctx, tx, ty, w, d, z0, zTop) {
    ctx.strokeStyle = C.PAL.scaffold;
    ctx.lineWidth = 1;
    const steps = Math.max(1, Math.round((zTop - z0) / (C.FLOOR_H * 0.75)));
    for (let i = 0; i <= steps; i++) {
      const z = z0 + ((zTop - z0) * i) / steps;
      const a = w2s(tx, ty + d, z), b = w2s(tx + w, ty + d, z), e = w2s(tx + w, ty, z);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    }
    for (const [cx, cy] of [[0, d], [w, d], [w, 0]]) {
      const lo = w2s(tx + cx, ty + cy, z0), hi = w2s(tx + cx, ty + cy, zTop);
      ctx.beginPath(); ctx.moveTo(lo.x, lo.y); ctx.lineTo(hi.x, hi.y); ctx.stroke();
    }
  }

  // ---- Stage math ------------------------------------------------------------------
  function stageOf(lot) {
    if (lot.state === 'complete') return { key: 'done', ratio: 1 };
    const ratio = C.clamp((lot.progress || 0) / Math.max(1, lot.required || 1), 0, 1);
    if (ratio < 0.10) return { key: 'dig', ratio };
    if (ratio < 0.25) return { key: 'foundation', ratio };
    const floors = (lot.building && lot.building.floors) || 1;
    const built = Math.max(1, Math.floor(ratio * floors));
    return { key: 'rise' + built, ratio, built };
  }

  function buildingHeight(lot) {
    const stage = stageOf(lot);
    if (stage.key === 'dig') return 0;
    if (stage.key === 'foundation') return 4;
    const floors = (lot.building && lot.building.floors) || 1;
    if (stage.key === 'done') return floors * C.FLOOR_H;
    return (stage.built || 1) * C.FLOOR_H;
  }

  // ---- The actual lot painter (uncached core) -----------------------------------------
  function paintLot(ctx, lot, district) {
    const pl = C.lotPlacement(lot);
    const st = buildingStyle(lot, district);
    const stage = stageOf(lot);
    st.complete = stage.key === 'done';
    const floors = (lot.building && lot.building.floors) || 1;
    const tier = (lot.building && lot.building.tier) || 1;
    const type = st.type;
    const cat = st.cat;

    // Parcel ground: planted garden when complete, packed dirt while building.
    // Garden stays green (slight per-seed variation) rather than tracking the
    // district hue — pink/blue lawns read as candy, greens read as a city.
    const groundCol = st.complete
      ? hsl(96 + ((st.seed >>> 5) % 26) - 12, 40, 64)
      : C.PAL.dirt;
    drawDiamond(ctx, pl.parcelTx, pl.parcelTy, 2, 2, groundCol, 'rgba(0,0,0,0.07)');
    if (st.complete) {
      // a hint of paving / planter at the building base
      drawDiamond(ctx, pl.tx - 0.12, pl.ty - 0.12, pl.w + 0.24, pl.d + 0.24, 'rgba(200,205,210,0.55)');
    }

    if (stage.key === 'dig') {
      drawDiamond(ctx, pl.tx + 0.15, pl.ty + 0.15, pl.w * 0.7, pl.d * 0.7, C.PAL.dirtDark);
      drawDiamond(ctx, pl.tx + 0.3, pl.ty + 0.3, pl.w * 0.4, pl.d * 0.4, '#7c5a39');
      return;
    }
    if (stage.key === 'foundation') {
      drawBox(ctx, pl.tx, pl.ty, pl.w, pl.d, 0, 4, { h: 0, s: 0, l: 66 });
      return;
    }
    if (stage.key === 'done') {
      const h = floors * C.FLOOR_H;
      // civic types have their own silhouette (towers / canopy)
      if (cat === 'power') { paintPowerStation(ctx, pl, st, floors); return; }
      if (cat === 'transit') { paintTransit(ctx, pl, st, floors); return; }
      drawBox(ctx, pl.tx, pl.ty, pl.w, pl.d, 0, h, st.col);
      drawWindows(ctx, pl.tx, pl.ty, pl.w, pl.d, 0, floors, st);
      if (type === 'house') {
        drawHouseRoof(ctx, pl, h, st); // pitched roof instead of a flat parapet
      } else {
        drawRoofCap(ctx, pl.tx, pl.ty, pl.w, pl.d, h, st);
        drawRoof(ctx, pl.tx, pl.ty, pl.w, pl.d, h, st, tier);
        if (type === 'skyscraper') drawSpire(ctx, pl, h, st);
        else if (type === 'school') drawSchoolTrim(ctx, pl, h, st);
      }
      return;
    }
    // rising
    const built = stage.built;
    const h = built * C.FLOOR_H;
    drawBox(ctx, pl.tx, pl.ty, pl.w, pl.d, 0, h, st.col);
    drawWindows(ctx, pl.tx, pl.ty, pl.w, pl.d, 0, built, st);
    drawDiamondAt(ctx, pl.tx, pl.ty, pl.w, pl.d, h, 'rgba(196,201,207,0.95)', 'rgba(20,28,36,0.25)');
    const zLo = Math.max(0, h - 2 * C.FLOOR_H);
    drawScaffold(ctx, pl.tx, pl.ty, pl.w, pl.d, zLo, h + C.FLOOR_H * 0.4);
  }

  // ---- Cast shadow (separate ground pass, drawn before buildings) ------------
  // Convex hull (monotone chain) of the footprint base corners plus those
  // corners projected to the ground along the sun direction.
  function convexHull(pts) {
    pts = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [], hi = [];
    for (const p of pts) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
      lo.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
      hi.push(p);
    }
    lo.pop(); hi.pop();
    return lo.concat(hi);
  }

  function drawLotShadow(ctx, lot) {
    const h = buildingHeight(lot);
    if (h < 2) return;
    const pl = C.lotPlacement(lot);
    const dx = C.SUN.shadowDX * h, dy = C.SUN.shadowDY * h;
    const corners = [[pl.tx, pl.ty], [pl.tx + pl.w, pl.ty], [pl.tx + pl.w, pl.ty + pl.d], [pl.tx, pl.ty + pl.d]];
    const pts = [];
    for (const [cx, cy] of corners) {
      const b = w2s(cx, cy, 0);
      pts.push(b, { x: b.x + dx, y: b.y + dy });
    }
    const hull = convexHull(pts);
    poly(ctx, hull);
    ctx.fillStyle = 'rgba(' + C.PAL.shadow + ',0.16)';
    ctx.fill();
  }

  // ---- Sprite cache --------------------------------------------------------------
  // key = lotId|stageKey|zoomBucket -> { canvas, ox, oy } where (ox, oy) is the
  // canvas-pixel position of the lot's PARCEL NW corner ground point.
  const cache = new Map();
  const CACHE_CAP = 500;

  function zoomBucket(zoom) {
    return C.clamp(Math.round(zoom * 2) / 2, 0.5, 2.5);
  }

  function lotSprite(lot, district, zoom) {
    const zb = zoomBucket(zoom);
    const stage = stageOf(lot);
    const key = lot.id + '|' + stage.key + '|' + zb;
    let entry = cache.get(key);
    if (entry) {
      cache.delete(key); cache.set(key, entry); // LRU bump
      return entry;
    }
    const b = lot.building || {};
    const floors = b.floors || 1;
    const cat = C.buildingCategory(b.type || 'office');
    // headroom above the wall top for type-specific caps (towers / spire / canopy)
    let topH = floors * C.FLOOR_H;
    if (cat === 'power') topH = Math.max(topH, C.FLOOR_H * 5.0) + 22;        // cooling towers + steam
    else if (b.type === 'skyscraper') topH += C.FLOOR_H * 2 + 34;           // setback crown + antenna
    else if (cat === 'transit') topH += 14;                                  // canopy lip
    else topH += 24;                                                         // generic roof furniture
    const maxH = topH + 24;
    const wpx = (C.TILE_W * 2 + 8) * zb;
    const hpx = (C.TILE_H * 2 + maxH + 8) * zb;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(wpx);
    cv.height = Math.ceil(hpx);
    const cctx = cv.getContext('2d');
    const pl = C.lotPlacement(lot);
    const origin = w2s(pl.parcelTx, pl.parcelTy, 0);
    const ox = cv.width / 2;
    const oy = cv.height - C.TILE_H * 2 * zb - 4;
    cctx.setTransform(zb, 0, 0, zb, ox - origin.x * zb, oy - origin.y * zb);
    paintLot(cctx, lot, district);
    entry = { canvas: cv, ox, oy, zb };
    cache.set(key, entry);
    if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
    return entry;
  }

  /** Draw a lot via its cached sprite. ctx must be in WORLD transform. */
  function drawLot(ctx, lot, district, zoom) {
    const entry = lotSprite(lot, district, zoom);
    const pl = C.lotPlacement(lot);
    const origin = w2s(pl.parcelTx, pl.parcelTy, 0);
    const s = 1 / entry.zb;
    ctx.drawImage(
      entry.canvas,
      origin.x - entry.ox * s,
      origin.y - entry.oy * s,
      entry.canvas.width * s,
      entry.canvas.height * s
    );
  }

  /** Depth-sort anchor for a lot (south corner of its parcel). */
  function lotDepth(lot) {
    const pl = C.lotPlacement(lot);
    return C.depthKey(pl.parcelTx + 1, pl.parcelTy + 1);
  }

  /** Invalidate cached sprites for a lot (its stage changed). */
  function invalidateLot(lotId) {
    for (const key of [...cache.keys()]) {
      if (key.startsWith(lotId + '|')) cache.delete(key);
    }
  }

  // ---- Crane (per-frame, animated; only on active construction lots) ---------------
  function drawCrane(ctx, lot, now) {
    const stage = stageOf(lot);
    if (stage.key === 'dig' || stage.key === 'done') return;
    const pl = C.lotPlacement(lot);
    const built = stage.built || 0;
    const mastH = Math.max(3, built + 3) * C.FLOOR_H;
    const base = w2s(pl.parcelTx + 1.85, pl.parcelTy + 1.85, 0);
    const top = { x: base.x, y: base.y - mastH };
    // lattice mast
    ctx.strokeStyle = '#d8902c';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(216,144,44,0.5)';
    ctx.lineWidth = 0.7;
    for (let z = base.y; z > top.y; z -= 9) {
      ctx.beginPath(); ctx.moveTo(base.x - 1.6, z); ctx.lineTo(base.x + 1.6, z - 4.5); ctx.stroke();
    }
    // slowly swinging jib
    const ang = Math.sin(now / 4000 + (lot.building.seed % 7)) * 0.9;
    const jibLen = C.TILE_W * 1.1;
    const jx = top.x + Math.cos(ang) * jibLen;
    const jy = top.y + Math.sin(ang) * jibLen * 0.3;
    ctx.strokeStyle = '#d8902c';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(jx, jy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(top.x, top.y);
    ctx.lineTo(top.x - Math.cos(ang) * jibLen * 0.35, top.y - Math.sin(ang) * jibLen * 0.3 * 0.35);
    ctx.stroke();
    const hookY = jy + mastH * 0.45;
    ctx.strokeStyle = 'rgba(60,60,60,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(jx, jy); ctx.lineTo(jx, hookY); ctx.stroke();
    ctx.fillStyle = '#d8902c';
    ctx.fillRect(jx - 2, hookY, 4, 4);
  }

  Object.assign(window.CITY, {
    drawDiamond, drawBox, drawLot, drawLotShadow, drawCrane, lotDepth, stageOf,
    invalidateLot, buildingStyle, buildingHeight,
  });
})();
