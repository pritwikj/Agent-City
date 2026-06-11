/* ===========================================================================
   terrain.js — procedural NATURAL TERRAIN for the open countryside that the
   metro sits in: lakes, rolling hills, forests, rocky outcrops, meadows and a
   soft elevation-driven colour map. The Cities-Skylines "the city is dropped
   into real land" feel, on the flat iso ground plane (no true heightmaps — the
   city/road code assumes z=0, so hills are drawn as shaded raised humps that
   never change any tile's elevation).

   How it stays natural rather than salt-and-pepper random:
     - A low-frequency value-noise (fbm) defines an ELEVATION field and a
       MOISTURE field over world tiles. Because the noise is smooth, low cells
       cluster into lake basins, high cells into ridges, wet cells into forests
       — coherent regions, not isolated dots.
     - Terrain is laid on a coarse cell grid; each visible cell reads the two
       fields at its (jittered) centre and emits the matching biome's features.
     - Everything is DETERMINISTIC from world coordinates (a fast integer hash),
       so it is rock-steady under pan/zoom and needs no stored state.

   It never paves over the city: any cell inside the developed footprint (the
   block bbox out past the rail loop, plus the airport) is left as clear ground,
   so the metro grows into open clearings and wilderness rings it. Drawn into
   the shared depth-sorted frame list, so a hill behind a tower is occluded and
   a tree in front of one draws in front. Per-frame culled + budget-capped, with
   zoom level-of-detail (individual trees up close, green blobs far out).
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const canvas = document.getElementById('city-canvas');

  // ---- Tunables -------------------------------------------------------------
  const CELL = 5;                  // tiles per terrain cell (feature spacing)
  const SCALE_E = 0.050;           // elevation noise frequency (lower = bigger regions)
  const SCALE_M = 0.063;           // moisture noise frequency
  const WATER = 0.30;              // E below this = lake
  const SHORE = 0.355;             // E below this (and above WATER) = beach/reeds
  const HILL = 0.685;              // E above this = highland (hills)
  const WET = 0.56;                // M above this = forest-favouring
  const DRY = 0.40;                // M below this = arid (sparse, tan)
  const EXCLUDE_MARGIN = 9;        // tiles of clearing kept around the metro
  const MAX_DRAWABLES = 1700;      // per-frame budget (protects frame time far out)
  const PAD = 6;                   // viewport tile padding

  // ---- Fast deterministic hash + value noise --------------------------------
  function ihash(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0);
  }
  function rand01(x, y) { return ihash(x, y) / 4294967296; }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const n00 = rand01(xi, yi), n10 = rand01(xi + 1, yi);
    const n01 = rand01(xi, yi + 1), n11 = rand01(xi + 1, yi + 1);
    const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
    return a + (b - a) * v;
  }
  function fbm(x, y) {                              // 3 octaves, normalized [0,1]
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < 3; o++) {
      sum += amp * vnoise(x * freq, y * freq);
      norm += amp; amp *= 0.5; freq *= 2.03;
    }
    return sum / norm;
  }

  // ---- City exclusion (kept off the developed footprint) --------------------
  let exRect = null, exAir = null;
  function refreshExclusion() {
    exRect = null; exAir = null;
    if (!C.infra) {
      const blocks = C.usedBlocks ? C.usedBlocks() : [];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of blocks) {
        const o = C.blockOrigin(s);
        x0 = Math.min(x0, o.tx); y0 = Math.min(y0, o.ty);
        x1 = Math.max(x1, o.tx + C.BLOCK_TILES - 1); y1 = Math.max(y1, o.ty + C.BLOCK_TILES - 1);
      }
      if (x0 !== Infinity) exRect = { x0: x0 - EXCLUDE_MARGIN, y0: y0 - EXCLUDE_MARGIN, x1: x1 + EXCLUDE_MARGIN, y1: y1 + EXCLUDE_MARGIN };
      return;
    }
    const b = C.infra.cityBounds && C.infra.cityBounds();
    if (b) exRect = { x0: b.x0 - EXCLUDE_MARGIN, y0: b.y0 - EXCLUDE_MARGIN, x1: b.x1 + EXCLUDE_MARGIN, y1: b.y1 + EXCLUDE_MARGIN };
    const a = C.infra.airport && C.infra.airport();
    if (a) exAir = { x0: a.x0 - 3, y0: a.y0 - 3, x1: a.x1 + 3, y1: a.y1 + 3 };
  }
  function isClear(tx, ty) {
    if (exRect && tx >= exRect.x0 && tx <= exRect.x1 && ty >= exRect.y0 && ty <= exRect.y1) return false;
    if (exAir && tx >= exAir.x0 && tx <= exAir.x1 && ty >= exAir.y0 && ty <= exAir.y1) return false;
    return true;
  }

  // ---- Visible tile AABB (inverse iso of the four screen corners) -----------
  function visibleBounds(camera) {
    const vt = camera.viewTransform();
    const cw = (canvas && canvas.clientWidth) || 800;
    const ch = (canvas && canvas.clientHeight) || 600;
    const HW = C.TILE_W / 2, HH = C.TILE_H / 2;
    let minTx = Infinity, minTy = Infinity, maxTx = -Infinity, maxTy = -Infinity;
    for (const c of [[0, 0], [cw, 0], [0, ch], [cw, ch]]) {
      const wx = (c[0] - vt.offX) / vt.zoom, wy = (c[1] - vt.offY) / vt.zoom;
      const tx = (wx / HW + wy / HH) / 2, ty = (wy / HH - wx / HW) / 2;
      if (tx < minTx) minTx = tx; if (tx > maxTx) maxTx = tx;
      if (ty < minTy) minTy = ty; if (ty > maxTy) maxTy = ty;
    }
    return {
      x0: Math.floor(minTx) - PAD, y0: Math.floor(minTy) - PAD,
      x1: Math.ceil(maxTx) + PAD, y1: Math.ceil(maxTy) + PAD,
    };
  }

  // ---- Palette ---------------------------------------------------------------
  const SHADOW = 'rgba(' + C.PAL.shadow + ',';
  const WATER_DEEP = '#5aa6c8', WATER_MID = '#6fb6d6', WATER_HI = 'rgba(236,250,255,0.30)';
  const SAND = '#d9c89a', SAND_DK = '#c6b384';
  const HILL_BASE = '#6cae57', HILL_MID = '#79bb61', HILL_HI = '#8fcd6f';
  const ROCK = '#8d9094', ROCK_HI = '#abaeb2', ROCK_DK = '#6f7276';
  const T_DARK = ['#3f8a3c', '#4e9a48'], T_MID = ['#58a850', '#64b657'], T_HI = 'rgba(206,240,160,0.5)';

  // ---- Feature drawers (all at z=0; "height" faked with screen-y offsets) ---
  function tintBlob(ctx, tx, ty, r, color) {
    const p = C.worldToScreen(tx, ty, 0);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, r * C.TILE_W * 0.5, r * C.TILE_H * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  }

  function blob(ctx, p, rx, ry, seed, jitter) {       // irregular closed shape
    const N = 9;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const k = 1 - jitter + ((ihash(seed, i) % 1000) / 1000) * jitter * 2;
      const x = p.x + Math.cos(a) * rx * k, y = p.y + Math.sin(a) * ry * k;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function drawWater(ctx, tx, ty, seed) {
    const p = C.worldToScreen(tx + 0.5, ty + 0.5, 0);
    const rx = CELL * C.TILE_W * 0.40, ry = CELL * C.TILE_H * 0.40;
    blob(ctx, p, rx * 1.12, ry * 1.12, seed ^ 0x9e37, 0.16);   // sandy shore
    ctx.fillStyle = SAND_DK; ctx.fill();
    blob(ctx, p, rx, ry, seed, 0.18);                          // water body
    ctx.fillStyle = WATER_MID; ctx.fill();
    ctx.strokeStyle = WATER_DEEP; ctx.lineWidth = 1; ctx.stroke();
    ctx.save(); ctx.clip();                                    // glints inside the lake
    ctx.fillStyle = WATER_HI;
    ctx.beginPath(); ctx.ellipse(p.x - rx * 0.3, p.y - ry * 0.3, rx * 0.42, ry * 0.42, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawReeds(ctx, tx, ty, seed) {
    const p = C.worldToScreen(tx, ty, 0);
    ctx.strokeStyle = '#6f8a45'; ctx.lineWidth = 0.8; ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const ox = ((ihash(seed, i) % 100) / 100 - 0.5) * 8;
      const x = p.x + ox, h = 4 + (ihash(seed, i + 9) % 4);
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x + 0.8, p.y - h); ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  function drawHill(ctx, tx, ty, seed, scale) {
    const p = C.worldToScreen(tx + 0.5, ty + 0.5, 0);
    const rx = CELL * C.TILE_W * 0.34 * scale, ry = CELL * C.TILE_H * 0.34 * scale;
    const lift = ry * 1.4;
    ctx.fillStyle = SHADOW + '0.13)';                          // SW cast shadow
    ctx.beginPath(); ctx.ellipse(p.x - rx * 0.28, p.y + ry * 0.18, rx * 1.02, ry * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = HILL_BASE;                                 // broad base contour
    ctx.beginPath(); ctx.ellipse(p.x, p.y - lift * 0.25, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = HILL_MID;                                  // mid contour, raised
    ctx.beginPath(); ctx.ellipse(p.x + rx * 0.08, p.y - lift * 0.62, rx * 0.7, ry * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = HILL_HI;                                   // sunlit cap
    ctx.beginPath(); ctx.ellipse(p.x + rx * 0.14, p.y - lift * 0.9, rx * 0.36, ry * 0.36, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawTree(ctx, tx, ty, seed, scale) {
    const p = C.worldToScreen(tx, ty, 0);
    const s = (0.8 + (seed % 5) * 0.12) * scale;
    ctx.fillStyle = SHADOW + '0.15)';
    ctx.beginPath(); ctx.ellipse(p.x - 2 * s, p.y + 0.4, 5 * s, 2.3 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#6f5235'; ctx.lineWidth = 1.5 * s; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - 6 * s); ctx.stroke(); ctx.lineCap = 'butt';
    const dk = T_DARK[seed & 1], md = T_MID[seed & 1];
    ctx.fillStyle = dk;
    ctx.beginPath(); ctx.arc(p.x + 1.4 * s, p.y - 8 * s, 3.9 * s, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(p.x - 1.6 * s, p.y - 8.4 * s, 3.7 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = md;
    ctx.beginPath(); ctx.arc(p.x, p.y - 9.7 * s, 4.6 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = T_HI;
    ctx.beginPath(); ctx.arc(p.x - 1.5 * s, p.y - 11 * s, 2.1 * s, 0, Math.PI * 2); ctx.fill();
  }

  function drawForestBlob(ctx, tx, ty, seed) {        // far-LOD: a lumpy canopy
    const p = C.worldToScreen(tx + 0.5, ty + 0.5, 0);
    const rx = CELL * C.TILE_W * 0.34, ry = CELL * C.TILE_H * 0.34;
    ctx.fillStyle = SHADOW + '0.12)';
    ctx.beginPath(); ctx.ellipse(p.x - rx * 0.2, p.y + ry * 0.5, rx, ry * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = T_DARK[seed & 1];
    blob(ctx, { x: p.x, y: p.y - ry * 0.4 }, rx, ry, seed, 0.22); ctx.fill();
    ctx.fillStyle = T_MID[seed & 1];
    ctx.beginPath(); ctx.ellipse(p.x - rx * 0.2, p.y - ry * 0.8, rx * 0.55, ry * 0.55, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawRock(ctx, tx, ty, seed, scale) {
    const p = C.worldToScreen(tx, ty, 0);
    const r = (2.4 + (seed % 3)) * scale;
    ctx.fillStyle = SHADOW + '0.14)';
    ctx.beginPath(); ctx.ellipse(p.x - r * 0.3, p.y + 0.6, r * 1.1, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ROCK_DK;
    ctx.beginPath(); ctx.ellipse(p.x, p.y - r * 0.4, r, r * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ROCK;
    ctx.beginPath(); ctx.ellipse(p.x - r * 0.12, p.y - r * 0.55, r * 0.78, r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ROCK_HI;
    ctx.beginPath(); ctx.ellipse(p.x - r * 0.3, p.y - r * 0.7, r * 0.34, r * 0.26, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawBush(ctx, tx, ty, seed) {
    const p = C.worldToScreen(tx, ty, 0);
    const r = 2.2 + (seed % 2);
    ctx.fillStyle = SHADOW + '0.12)';
    ctx.beginPath(); ctx.ellipse(p.x - 1, p.y + 0.4, r * 1.2, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = T_DARK[seed & 1];
    ctx.beginPath(); ctx.arc(p.x - r * 0.5, p.y - r * 0.5, r * 0.7, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(p.x + r * 0.5, p.y - r * 0.5, r * 0.7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = T_MID[seed & 1];
    ctx.beginPath(); ctx.arc(p.x, p.y - r * 0.9, r * 0.8, 0, Math.PI * 2); ctx.fill();
  }

  function drawFlowers(ctx, tx, ty, seed) {
    const p = C.worldToScreen(tx, ty, 0);
    const cols = ['#e8d24a', '#e57f7f', '#d6d6e6', '#c98fd0'];
    for (let i = 0; i < 5; i++) {
      const ox = ((ihash(seed, i) % 100) / 100 - 0.5) * 11;
      const oy = ((ihash(seed, i + 7) % 100) / 100 - 0.5) * 5;
      ctx.fillStyle = cols[ihash(seed, i + 3) % cols.length];
      ctx.fillRect(p.x + ox, p.y + oy, 1.2, 1.2);
    }
  }

  // ---- Elevation/moisture -> grass colour map (subtle, overlapping blobs) ----
  function groundTint(E, M) {
    if (E < SHORE) return null;                     // water/shore draw their own
    let h, s, l;
    if (E > HILL) { h = 92; s = 30; l = 48; }       // dry highland: olive
    else if (M > WET) { h = 120; s = 42; l = 38; }  // wet lowland: deep green
    else if (M < DRY) { h = 70; s = 34; l = 52; }   // arid: tan-green
    else return null;                               // ordinary meadow: leave base
    return 'hsla(' + h + ',' + s + '%,' + l + '%,0.16)';
  }

  // ---- Collection ------------------------------------------------------------
  let lastVer = -2, lastGround = -2;
  function collectDrawables(list, camera, now) {
    if (!camera) return;
    // refresh the city clearing when the metro footprint changes
    const iv = C.infra && C.infra.version ? C.infra.version() : 0;
    const gv = C.getGroundVersion ? C.getGroundVersion() : 0;
    if (iv !== lastVer || gv !== lastGround) { refreshExclusion(); lastVer = iv; lastGround = gv; }

    const vb = visibleBounds(camera);
    const z = camera.zoom;
    const lod = z >= 0.55 ? 0 : z >= 0.28 ? 1 : 2;
    const cx0 = Math.floor(vb.x0 / CELL), cy0 = Math.floor(vb.y0 / CELL);
    const cx1 = Math.ceil(vb.x1 / CELL), cy1 = Math.ceil(vb.y1 / CELL);

    let budget = MAX_DRAWABLES;
    for (let cy = cy0; cy <= cy1 && budget > 0; cy++) {
      for (let cx = cx0; cx <= cx1 && budget > 0; cx++) {
        const seed = ihash(cx, cy);
        // jittered feature anchor inside the cell
        const jx = (ihash(cx, cy ^ 0x51) % 1000) / 1000, jy = (ihash(cx ^ 0x77, cy) % 1000) / 1000;
        const fx = cx * CELL + 0.6 + jx * (CELL - 1.2);
        const fy = cy * CELL + 0.6 + jy * (CELL - 1.2);
        if (!isClear(fx, fy)) continue;

        const E = fbm(fx * SCALE_E, fy * SCALE_E);
        const M = fbm((fx + 311) * SCALE_M, (fy - 977) * SCALE_M);
        const depth = C.depthKey(fx, fy);

        // ground colour wash (flat, drawn behind raised features)
        const tint = groundTint(E, M);
        if (tint && lod < 2 && budget > 0) {
          list.push({ depth: depth - 1000, draw: (ctx) => tintBlob(ctx, fx + 0.5, fy + 0.5, CELL * 0.95, tint) });
          budget--;
        }

        if (E < WATER) {                                   // ---- LAKE ----
          list.push({ depth: depth - 0.5, draw: (ctx) => drawWater(ctx, cx * CELL, cy * CELL, seed) });
          budget--;
          continue;
        }
        if (E < SHORE) {                                   // ---- BEACH / REEDS ----
          if (lod < 2 && (seed & 3)) { list.push({ depth, draw: (ctx) => drawReeds(ctx, fx, fy, seed) }); budget--; }
          continue;
        }

        const highland = E > HILL;
        const wet = M > WET, dry = M < DRY;

        if (highland) {                                    // ---- HILLS ----
          const scale = 0.8 + (E - HILL) * 1.6;
          list.push({ depth, draw: (ctx) => drawHill(ctx, cx * CELL, cy * CELL, seed, scale) });
          budget--;
          if (lod === 0) {
            if (wet) {                                      // wooded hill
              const n = 2 + (seed % 3);
              for (let i = 0; i < n && budget > 0; i++) {
                const tx = fx + ((ihash(seed, i) % 100) / 100 - 0.5) * 3;
                const ty = fy - 0.6 + ((ihash(seed, i + 5) % 100) / 100 - 0.5) * 2;
                list.push({ depth: C.depthKey(tx, ty), draw: (ctx) => drawTree(ctx, tx, ty, ihash(seed, i), 0.85) });
                budget--;
              }
            } else if (!(seed & 1)) {                       // rocky hill
              const n = 1 + (seed % 3);
              for (let i = 0; i < n && budget > 0; i++) {
                const tx = fx + ((ihash(seed, i + 2) % 100) / 100 - 0.5) * 3.2;
                const ty = fy + ((ihash(seed, i + 8) % 100) / 100 - 0.5) * 2;
                list.push({ depth: C.depthKey(tx, ty), draw: (ctx) => drawRock(ctx, tx, ty, ihash(seed, i), 1) });
                budget--;
              }
            }
          }
          continue;
        }

        if (wet) {                                         // ---- FOREST ----
          if (lod === 2) { list.push({ depth, draw: (ctx) => drawForestBlob(ctx, cx * CELL, cy * CELL, seed) }); budget--; continue; }
          const n = (lod === 0 ? 4 : 2) + (seed % (lod === 0 ? 5 : 3));
          for (let i = 0; i < n && budget > 0; i++) {
            const tx = fx + ((ihash(seed, i) % 100) / 100 - 0.5) * (CELL - 1);
            const ty = fy + ((ihash(seed, i + 5) % 100) / 100 - 0.5) * (CELL - 1);
            list.push({ depth: C.depthKey(tx, ty), draw: (ctx) => drawTree(ctx, tx, ty, ihash(seed, i), lod === 0 ? 1 : 0.9) });
            budget--;
          }
          continue;
        }

        if (lod === 0) {                                   // ---- MEADOW detail ----
          const roll = seed % 100;
          if (dry && roll < 22) { list.push({ depth, draw: (ctx) => drawRock(ctx, fx, fy, seed, 0.8) }); budget--; }
          else if (roll < 18) { list.push({ depth, draw: (ctx) => drawBush(ctx, fx, fy, seed) }); budget--; }
          else if (!dry && roll < 42) { list.push({ depth: depth - 900, draw: (ctx) => drawFlowers(ctx, fx, fy, seed) }); budget--; }
        }
      }
    }
  }

  C.terrain = { collectDrawables };
})();
