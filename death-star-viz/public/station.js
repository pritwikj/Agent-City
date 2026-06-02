/* ===========================================================================
   station.js — build the static Death Star cutaway ONCE to an offscreen
   canvas. Per-frame the render loop just drawImage()s this backdrop, then
   draws the dynamic sprite layer on top.

   HIGH-RES pass: the logical grid is now 640x640 (PX=1). Every design-time
   offset from the original 320 layout is multiplied by U (= DSV.DETAIL = 2) so
   the composition is identical but rendered at DOUBLE density — true circle,
   5 hull shading bands, crisp dark rim, dense surface paneling + meridian
   seams, an equatorial trench, layered deck slabs with rivets/grating, walled
   rooms with lit doorways + viewports, five distinct set-piece work stations,
   a deep superlaser crater, surface turbolaser clusters, conduits and pipes.

   Also computes deck geometry (floor Y + interior x-range per deck) and a row
   of console positions per deck, shared via DSV.decks / DSV.consoles. The
   recessed work-screen rectangle (lit by render.js) is defined ONCE here via
   screenRect() and reused there, so backdrop and overlay always align.
   =========================================================================== */
(function () {
  'use strict';
  const DSV = window.DSV;
  const { GRID_W, GRID_H, PX, PAL, DECK_COUNT } = DSV;
  const U = DSV.DETAIL; // 2 — scales the original 320-space design to 640-space

  // Station center + radius in blocks. Square scene, centered, so it's a circle.
  const CX = Math.round(GRID_W * 0.52);
  const CY = Math.round(GRID_H * 0.5);
  const R = Math.round(Math.min(GRID_W, GRID_H) * 0.45);
  const HULL_T = 7 * U; // hull thickness in blocks (5-band shell)

  DSV.consoles = []; // [{ deck, x, y, type }]  (x = console center, y = floor row)

  // The recessed work-screen rectangle for a station at (x, floorY). Shared with
  // render.js (via DSV.screenRect) so the lit overlay lands exactly on the
  // backdrop recess. ~2U wide x 2U tall, sitting at chest height above the desk.
  function screenRect(x, floorY) {
    return { x: x - U + 1, y: floorY - 4 * U, w: 2 * U, h: 2 * U };
  }
  DSV.screenRect = screenRect;

  // px-block helper: fill a single logical block
  function block(ctx, col, row, color) {
    ctx.fillStyle = color;
    ctx.fillRect(col * PX, row * PX, PX, PX);
  }

  // Half-width of the interior circle at a given row (for clipping decks).
  function halfWidthAt(row) {
    const dy = row - CY;
    const inside = R * R - dy * dy;
    if (inside <= 0) return 0;
    return Math.sqrt(inside);
  }

  function innerHalfWidthAt(row) {
    const dy = row - CY;
    const innerR = R - HULL_T;
    const inside = innerR * innerR - dy * dy;
    if (inside <= 0) return 0;
    return Math.sqrt(inside);
  }

  function buildStation() {
    const off = document.createElement('canvas');
    off.width = GRID_W * PX;
    off.height = GRID_H * PX;
    const ctx = off.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // --- space background ---
    ctx.fillStyle = PAL.space;
    ctx.fillRect(0, 0, off.width, off.height);

    // --- starfield (fixed) — ~4x density for the larger grid ---
    let s = 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < 900; i++) {
      const col = Math.floor(rnd() * GRID_W);
      const row = Math.floor(rnd() * GRID_H);
      // keep stars out of the sphere mostly
      const dx = col - CX, dy = row - CY;
      if (dx * dx + dy * dy < (R + 3) * (R + 3) && rnd() > 0.2) continue;
      block(ctx, col, row, rnd() > 0.82 ? PAL.starBright : PAL.star);
    }

    // --- hull ring + interior fill (filled disc, 5 shading bands) ---
    const R2 = R * R;
    const inner = (R - HULL_T);
    const inner2 = inner * inner;
    for (let row = CY - R; row <= CY + R; row++) {
      const hw = halfWidthAt(row);
      if (hw <= 0) continue;
      const x0 = Math.floor(CX - hw);
      const x1 = Math.ceil(CX + hw);
      for (let col = x0; col <= x1; col++) {
        const dx = col - CX, dy = row - CY;
        const d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        const dist = Math.sqrt(d2);
        if (d2 > inner2) {
          // hull shell: 5 bands by light direction (upper-left bright)
          const lightVal = (-dx - dy) / (R * 1.42); // ~ -1..1
          let c;
          if (lightVal > 0.42) c = PAL.hullHi;
          else if (lightVal > 0.14) c = PAL.hull2;
          else if (lightVal > -0.14) c = PAL.hullMid;
          else if (lightVal > -0.42) c = PAL.hull4;
          else c = PAL.hullLo;
          // crisp dark rim on the outermost ring
          if (dist > R - 1.15 * U) c = PAL.hullEdge;
          block(ctx, col, row, c);
        } else {
          // dark cutaway interior — slight vertical wash for depth
          block(ctx, col, row, (row + col) % (7 * U) === 0 ? PAL.interior2 : PAL.interior);
        }
      }
    }

    // --- hull surface paneling: concentric panel rings + radial meridians ---
    // Denser at double res: three concentric seam rings (highlight + groove) and
    // meridian seams every ~12 deg splitting the shell into plates. Brighter on
    // the lit upper-left arc, faint on the dark side.
    for (const rr of [R - 2 * U, R - Math.round(HULL_T * 0.5), R - HULL_T + 2 * U]) {
      const step = 360 / Math.max(60, Math.round(2 * Math.PI * rr / 2));
      for (let a = 0; a < 360; a += step) {
        const rad = (a * Math.PI) / 180;
        const col = Math.round(CX + Math.cos(rad) * rr);
        const row = Math.round(CY + Math.sin(rad) * rr);
        const dx = col - CX, dy = row - CY;
        const lightVal = (-dx - dy) / (R * 1.42);
        if (Math.round(a / step) % 3 === 0) {
          block(ctx, col, row, lightVal > 0.1 ? PAL.panelHi : (lightVal > -0.1 ? PAL.panel : PAL.panelLo));
          const inCol = Math.round(CX + Math.cos(rad) * (rr - 1));
          const inRow = Math.round(CY + Math.sin(rad) * (rr - 1));
          block(ctx, inCol, inRow, PAL.panelLo);
        }
      }
    }
    // radial meridian seams: split the whole shell into plates.
    for (let a = 0; a < 360; a += 12) {
      const rad = (a * Math.PI) / 180;
      for (let rr = R - HULL_T + 1; rr < R - 1; rr++) {
        const col = Math.round(CX + Math.cos(rad) * rr);
        const row = Math.round(CY + Math.sin(rad) * rr);
        const dx = col - CX, dy = row - CY;
        const lightVal = (-dx - dy) / (R * 1.42);
        block(ctx, col, row, lightVal > 0.05 ? PAL.panel : PAL.hullEdge);
      }
    }
    // surface greeble studs: scattered bright rivets along the lit upper arc
    for (let a = 200; a < 340; a += 4) {
      const rad = (a * Math.PI) / 180;
      const rr = R - Math.round(HULL_T * 0.35);
      const col = Math.round(CX + Math.cos(rad) * rr);
      const row = Math.round(CY + Math.sin(rad) * rr);
      if (a % 8 === 0) block(ctx, col, row, PAL.rivet);
    }

    // --- equatorial trench: the iconic channel girdling the station ---
    for (let side = -1; side <= 1; side += 2) {
      for (let row = CY - 2 * U; row <= CY + 2 * U; row++) {
        const hw = halfWidthAt(row);
        if (hw <= 0) continue;
        const outer = side < 0 ? Math.floor(CX - hw) : Math.ceil(CX + hw);
        for (let t = 0; t < HULL_T; t++) {
          const col = outer - side * t;
          let c;
          if (row === CY - 2 * U || row === CY + 2 * U) c = PAL.trenchHi; // lit lip
          else c = PAL.trench;                                            // dark channel
          // greeble ticks: brighter structure on the floor of the trench
          if (Math.abs(row - CY) <= U && t % (3 * U) < U) c = PAL.trenchHi;
          block(ctx, col, row, c);
        }
      }
    }

    // --- decks: evenly spaced horizontal floors, SHIFTED DOWN so the upper
    // dome stays clear for the superlaser dish and the empty lower hemisphere is
    // used. deck 0 sits at `top` (well below the dish), the last deck near `bot`.
    DSV.decks.length = 0;
    const top = CY - R + HULL_T + 60 * U;  // dome clearance above deck 0 (dish)
    const bot = CY + R - HULL_T - 30 * U;  // leave proper room below the last deck
    const span = bot - top;
    const SLAB = 4 * U; // deck slab thickness in blocks
    for (let d = 0; d < DECK_COUNT; d++) {
      const floorY = Math.round(top + (span * d) / (DECK_COUNT - 1));
      const hw = innerHalfWidthAt(floorY) - 1;
      if (hw <= 8 * U) { DSV.decks.push({ index: d, floorY, leftX: CX, rightX: CX }); continue; }
      const leftX = Math.round(CX - hw);
      const rightX = Math.round(CX + hw);

      // deck slab: highlight top edge, mid body, dark base + edge line.
      // Each slab ROW is clipped to the hull interior at ITS OWN depth: the slab
      // descends a few rows below floorY, and below the equator the sphere gets
      // narrower going down, so without this the slab ends would poke through the
      // outer rim. inEdge(row) = interior half-extent (from CX) at that row.
      const inEdge = (row) => innerHalfWidthAt(row) - 1;
      // Span the slab columns out to its WIDEST row, not just the floorY row.
      // Above the equator the hull flares wider as the slab descends, so a loop
      // bounded at floorY leaves a wedge gap at the ends (the per-row clip can
      // only trim, never extend). Looping to the widest row and clipping each
      // row to the hull lets the upper decks meet the circle like the lower ones.
      let slabHw = inEdge(floorY);
      for (let i = 1; i < SLAB; i++) slabHw = Math.max(slabHw, inEdge(floorY + i));
      const slabLeft = Math.round(CX - slabHw);
      const slabRight = Math.round(CX + slabHw);
      for (let col = slabLeft; col <= slabRight; col++) {
        for (let i = 0; i < SLAB; i++) {
          if (Math.abs(col - CX) > inEdge(floorY + i)) continue;
          const c = i === 0 ? PAL.deckHi
                  : i < 2 * U ? PAL.deckMid
                  : i < 3 * U ? PAL.deckLo
                  : PAL.deckEdge;
          block(ctx, col, floorY + i, c);
        }
        // riveted floor: occasional brighter stud on the top edge
        if (col % (9 * U) === 0 && Math.abs(col - CX) <= inEdge(floorY)) block(ctx, col, floorY, PAL.rivet);
        // walkway grating: recessed darker tread every few blocks
        if (col % (3 * U) === 0 && Math.abs(col - CX) <= inEdge(floorY + U)) block(ctx, col, floorY + U, PAL.grate);
        // hazard caution studs along the floor edge
        if (col % (16 * U) === 0 && Math.abs(col - CX) <= inEdge(floorY)) block(ctx, col, floorY, PAL.lamp);
      }
      // safety railings at the open deck edges (posts + top rail cap), each
      // clipped to the hull at its row so they don't punch through the rim.
      for (const ex of [leftX + U, rightX - U]) {
        for (let row = floorY - 4 * U; row < floorY; row++) {
          if (Math.abs(ex - CX) > inEdge(row)) continue;
          block(ctx, ex, row, PAL.railing);
        }
        if (Math.abs(ex - CX) <= inEdge(floorY - 4 * U)) block(ctx, ex, floorY - 4 * U, PAL.stationHi); // rail cap
        if (Math.abs(ex - CX) <= inEdge(floorY - 2 * U)) block(ctx, ex, floorY - 2 * U, PAL.stationHi); // mid rail
      }
      DSV.decks.push({ index: d, floorY, leftX, rightX });
    }

    // --- compartments: frame each deck as a row of walled ROOMS (LEGO cutaway).
    // A CEILING BEAM caps the deck; faint BACK-WALL paneling fills each bay so it
    // doesn't read as empty void; full-height BULKHEAD walls (lit doorway + lintel
    // + ladder + conduit + viewports) divide it into bays between the stations, so
    // the big workstations sit inside real rooms rather than on an open floor. ---
    for (let d = 0; d < DSV.decks.length; d++) {
      const deck = DSV.decks[d];
      const isTop = d === 0;
      const ceilY = isTop ? (CY - R + HULL_T + 2 * U)
                          : DSV.decks[d - 1].floorY + SLAB; // underside of deck above
      const roomTop = isTop ? Math.max(ceilY, deck.floorY - 42 * U) : ceilY;

      const roomWidth = deck.rightX - deck.leftX;

      if (roomWidth < 28 * U) continue;
      const n = Math.max(1, Math.min(5, Math.round(roomWidth / (44 * U)))); // station count
      const margin = 16 * U;
      const doorTop = deck.floorY - 7 * U; // doorway opening height from the floor

      // ceiling beam across the deck interior: a lit rail over a dark soffit,
      // with recessed hung lamps — visually caps the TOP deck as an enclosed
      // room. Lower decks use the floor above as their ceiling instead.
      if (isTop) {
        for (let c = deck.leftX; c <= deck.rightX; c++) {
          if (Math.abs(c - CX) <= innerHalfWidthAt(roomTop) - 1) block(ctx, c, roomTop, PAL.dividerHi);   // lit rail
          if (Math.abs(c - CX) <= innerHalfWidthAt(roomTop + 1) - 1) block(ctx, c, roomTop + 1, PAL.divider);
          if (Math.abs(c - CX) <= innerHalfWidthAt(roomTop + 2) - 1) block(ctx, c, roomTop + 2, PAL.deckEdge); // dark soffit
          if (c % (12 * U) === 6 * U) {
            if (Math.abs(c - CX) <= innerHalfWidthAt(roomTop + 3) - 1) block(ctx, c, roomTop + 3, PAL.lampDim);
            if (Math.abs(c - CX) <= innerHalfWidthAt(roomTop + 4) - 1) block(ctx, c, roomTop + 4, PAL.lamp);
          }
        }
      }
      // back-wall paneling: a sparse riveted grid (NOT continuous lines, so it
      // never reads as a floor) + the odd lit viewport, so each bay has a wall
      // behind its console instead of empty void.
      for (let r = roomTop + 4 * U; r < deck.floorY - 9 * U; r += 3 * U) {
        // Sweep across the whole possible width, clip against the hull at each row.
        // This ensures the back wall perfectly fills the wedge on lower decks
        // where the room ceiling is wider than the floor.
        for (let c = CX % (4 * U); c < off.width; c += 4 * U) {
          if (Math.abs(c - CX) > innerHalfWidthAt(r) - 1) continue;
          block(ctx, c, r, PAL.panelLo);          // rivet stud
          block(ctx, c + 1, r, PAL.interior2);
          if ((r + c) % (12 * U) === 0) block(ctx, c, r, PAL.window); // tiny lit port
        }
      }

      // internal bulkhead walls dividing the bays (between the stations)
      if (n < 2) continue;
      const wallTop = roomTop;
      for (let k = 0; k < n - 1; k++) {
        const xa = deck.leftX + margin + (roomWidth - 2 * margin) * (k / (n - 1));
        const xb = deck.leftX + margin + (roomWidth - 2 * margin) * ((k + 1) / (n - 1));
        const col = Math.round((xa + xb) / 2);
        for (let row = wallTop; row < deck.floorY; row++) {
          if (Math.abs(col - CX) > innerHalfWidthAt(row) - 1) continue;
          if (row >= doorTop) {
            // doorway: lit frame posts on either side, open in the middle
            block(ctx, col - 2 * U, row, PAL.dividerHi);
            block(ctx, col + 2 * U, row, PAL.dividerHi);
          } else {
            for (let w = -U; w <= U; w++) block(ctx, col + w, row, PAL.divider);
            block(ctx, col - U, row, PAL.dividerHi); // lit left edge
            // maintenance ladder rungs climbing the right face
            if ((deck.floorY - row) % (2 * U) === 0 &&
                Math.abs(col + 2 * U - CX) <= innerHalfWidthAt(row) - 1)
              block(ctx, col + 2 * U, row, PAL.stationHi);
            // a glowing conduit run threaded up the wall
            if ((deck.floorY - row) % (3 * U) === U) block(ctx, col, row, PAL.conduitHi);
            // lit viewport ports set into the bulkhead
            if ((deck.floorY - row) % (5 * U) === 2 * U) {
              block(ctx, col - U, row, PAL.window);
              block(ctx, col + U, row, PAL.windowDim);
            }
          }
        }
        // header lintel across the top of the doorway
        for (let c = col - 2 * U; c <= col + 2 * U; c++) {
          if (Math.abs(c - CX) <= innerHalfWidthAt(doorTop - 1) - 1)
            block(ctx, c, doorTop - 1, PAL.dividerHi);
        }
      }
    }

    // --- work stations: fewer, LARGER set-piece rooms (LEGO-cutaway feel).
    // Each shares one contract: a recessed work-screen (screenRect) that the
    // render layer lights up when a sprite operates it. Everything is clipped to
    // the hull interior via put().
    const STATION_TYPES = ['command', 'turbolaser', 'tractor', 'sensor', 'engineering'];

    function clearAbove(col, row) {
      return Math.abs(col - CX) <= innerHalfWidthAt(row) - 1;
    }
    const put = (c, r, color) => { if (clearAbove(c, r)) block(ctx, c, r, color); };
    const fillBlocks = (c0, r0, c1, r1, color) => {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) put(c, r, color);
    };
    const workScreen = (x, floorY) => {
      const s = screenRect(x, floorY);
      fillBlocks(s.x, s.y, s.x + s.w - 1, s.y + s.h - 1, PAL.screenDim);
      // recessed bezel frame around the screen
      for (let c = s.x - 1; c <= s.x + s.w; c++) { put(c, s.y - 1, PAL.bezel); put(c, s.y + s.h, PAL.bezel); }
      for (let r = s.y; r < s.y + s.h; r++) { put(s.x - 1, r, PAL.bezel); put(s.x + s.w, r, PAL.bezel); }
    };

    // Crew standing posts in front of a desk (center x's; render.js offsets each
    // by sprite width). `half` is the flank offset; `count` is 1-3 operators.
    function makeSpots(cx, half, count) {
      if (count <= 1) return [cx];
      if (count === 2) return [cx - half, cx + half];
      return [cx - half, cx, cx + half];
    }

    // Draw a typed workstation centered at x on the floor. These are now LARGE
    // set-piece installations that fill their bay. Returns the crew posts.
    function drawStation(type, x, floorY) {
      if (type === 'command') {
        // command pit: tall two-tier monitor WALL behind a wide control desk
        fillBlocks(x - 12 * U, floorY - 12 * U, x + 12 * U, floorY - 3 * U, PAL.bezel); // monitor housing
        fillBlocks(x - 12 * U, floorY - 12 * U, x + 12 * U, floorY - 12 * U, PAL.stationHi); // top rim
        for (let r = floorY - 11 * U; r <= floorY - 5 * U; r += 2 * U) {                // screen grid
          for (let c = x - 11 * U; c <= x + 10 * U; c += 2 * U) {
            put(c, r, ((r + c) % (3 * U) === 0) ? PAL.screen : PAL.glass);
            put(c + 1, r, PAL.glass);
          }
        }
        put(x - 9 * U, floorY - 11 * U, PAL.alert); put(x + 7 * U, floorY - 9 * U, PAL.blue);
        put(x - 3 * U, floorY - 7 * U, PAL.screen); put(x + 5 * U, floorY - 5 * U, PAL.lens);
        // wide control desk spanning the bay
        fillBlocks(x - 14 * U, floorY - 2 * U, x + 14 * U, floorY - 1, PAL.station);
        fillBlocks(x - 14 * U, floorY - 2 * U, x + 14 * U, floorY - 2 * U, PAL.stationHi);  // desk lip
        for (let c = x - 12 * U; c <= x + 12 * U; c += 2 * U)                               // status lights
          put(c, floorY - 1, (c % (3 * U) === 0) ? PAL.screen : ((c % (4 * U) === 0) ? PAL.alert : PAL.blue));
        workScreen(x, floorY);
        return makeSpots(x, 9 * U, 3);
      } else if (type === 'turbolaser') {
        // heavy gun emplacement: big breech housing + long twin angled cannons
        // with GREEN muzzles + an ammo-feed cabinet and targeting console.
        const dir = x < CX ? 1 : -1;
        fillBlocks(x - 5 * U, floorY - 7 * U, x + 5 * U, floorY - 1, PAL.station);          // breech housing
        fillBlocks(x - 5 * U, floorY - 7 * U, x + 5 * U, floorY - 7 * U, PAL.stationHi);    // mantlet top
        put(x - 5 * U, floorY - 8 * U, PAL.barrel); put(x + 5 * U, floorY - 8 * U, PAL.barrel); // trunnions
        put(x, floorY - 8 * U, PAL.stationHi);                                              // gun cradle
        for (let t = 1; t <= 9 * U; t++) {                                                  // twin angled barrels
          const bcol = x + dir * (4 * U + t);
          put(bcol, floorY - 7 * U - t, PAL.barrel);
          put(bcol, floorY - 6 * U - t, PAL.barrel);
        }
        const mz = x + dir * 13 * U;                                                        // green muzzles
        for (let m = 0; m < U; m++) for (let n2 = 0; n2 < 2 * U; n2++)
          put(mz + dir * m, floorY - 16 * U + n2, PAL.beam);
        // ammo-feed cabinet + targeting console at the base (inner side)
        fillBlocks(x - 8 * U, floorY - 4 * U, x - 6 * U, floorY - 1, PAL.bezel);
        put(x - 7 * U, floorY - 4 * U, PAL.lamp); put(x - 7 * U, floorY - 2 * U, PAL.screen);
        workScreen(x, floorY);
        return makeSpots(x, 8 * U, 2);
      } else if (type === 'tractor') {
        // full-height reactor / tractor-beam column with catwalk rings + a wide
        // base console (the glowing power core of the bay).
        const topRow = Math.max(floorY - 40 * U, CY - R + HULL_T + 3 * U);
        for (let r = floorY - 1; r >= topRow; r--) {
          put(x - 2 * U, r, PAL.station); put(x + 2 * U, r, PAL.stationHi);                 // shaft walls
          put(x - U, r, PAL.bezel);       put(x + U, r, PAL.bezel);
          put(x, r, (r % 2 === 0) ? PAL.lens : PAL.blue);                                   // pulsing core
        }
        for (let r = floorY - 5 * U; r >= topRow; r -= 4 * U) {                             // catwalk rings
          put(x - 3 * U, r, PAL.barrel); put(x + 3 * U, r, PAL.barrel);
          put(x - 2 * U, r, PAL.railing); put(x + 2 * U, r, PAL.railing);
        }
        put(x, topRow - 1, PAL.blue);                                                       // emitter cap
        put(x - U, topRow - 1, PAL.lampDim); put(x + U, topRow - 1, PAL.lampDim);
        fillBlocks(x - 8 * U, floorY - 2 * U, x + 8 * U, floorY - 1, PAL.station);          // base console
        fillBlocks(x - 8 * U, floorY - 2 * U, x + 8 * U, floorY - 2 * U, PAL.stationHi);
        put(x - 5 * U, floorY - 1, PAL.screen); put(x + 5 * U, floorY - 1, PAL.alert);
        put(x - 7 * U, floorY - 1, PAL.blue);   put(x + 7 * U, floorY - 1, PAL.blue);
        workScreen(x, floorY);
        return makeSpots(x, 6 * U, 2);
      } else if (type === 'sensor') {
        // signal-processing bank + feed mast + big sensor dish bowl + console
        fillBlocks(x - 7 * U, floorY - 12 * U, x + 7 * U, floorY - 3 * U, PAL.bezel);       // processor bank
        for (let r = floorY - 11 * U; r <= floorY - 5 * U; r += 2 * U)
          for (let c = x - 6 * U; c <= x + 6 * U; c += 2 * U)
            put(c, r, ((r + c) % (4 * U) === 0) ? PAL.screen : PAL.glass);
        for (let r = floorY - 12 * U; r >= floorY - 16 * U; r--) put(x, r, PAL.stationHi);  // feed mast
        const by = floorY - 16 * U;                                                         // dish bowl
        for (let c = x - 6 * U; c <= x + 6 * U; c++) put(c, by, PAL.barrel);
        for (let c = x - 5 * U; c <= x + 5 * U; c++) put(c, by - 1, PAL.barrel);
        put(x - 4 * U, by - 2, PAL.barrel); put(x + 4 * U, by - 2, PAL.barrel);
        put(x, by - 2, PAL.lamp);                                                          // receiver focus
        fillBlocks(x - 7 * U, floorY - 2 * U, x + 7 * U, floorY - 1, PAL.station);          // console
        fillBlocks(x - 7 * U, floorY - 2 * U, x + 7 * U, floorY - 2 * U, PAL.stationHi);
        put(x - 4 * U, floorY - 1, PAL.blue); put(x + 4 * U, floorY - 1, PAL.screen);
        workScreen(x, floorY);
        return makeSpots(x, 7 * U, 2);
      } else { // engineering — power room: a row of glowing cells + pipework + desk
        const cellTop = floorY - 10 * U;
        for (const cx of [x - 9 * U, x - 3 * U, x + 3 * U, x + 9 * U]) {                    // four power cells
          for (let r = floorY - 3 * U; r >= cellTop; r--) { put(cx, r, PAL.station); put(cx - 1, r, PAL.stationHi); }
          put(cx, cellTop - 1, PAL.blue);   // glowing cap
          put(cx, cellTop - 2, PAL.lens);
          put(cx, floorY - 5 * U, PAL.lamp); // indicator
        }
        for (let c = x - 9 * U; c <= x + 9 * U; c++) {                                      // overhead pipework
          if (c % 2 === 0) put(c, cellTop - 3, PAL.conduit);
          if (c % (3 * U) === 0) put(c, floorY - 6 * U, PAL.conduitHi);
        }
        fillBlocks(x - 7 * U, floorY - 2 * U, x + 7 * U, floorY - 1, PAL.station);          // control desk
        fillBlocks(x - 7 * U, floorY - 2 * U, x + 7 * U, floorY - 2 * U, PAL.stationHi);
        put(x - 3 * U, floorY - 1, PAL.screen); put(x + 3 * U, floorY - 1, PAL.alert);
        workScreen(x, floorY);
        return makeSpots(x, 6 * U, 3);
      }
    }

    DSV.consoles.length = 0;
    for (const deck of DSV.decks) {
      const isTop = deck.index === 0;
      const ceilY = isTop ? (CY - R + HULL_T + 2 * U) : DSV.decks[deck.index - 1].floorY + SLAB;
      const roomTop = isTop ? Math.max(ceilY, deck.floorY - 42 * U) : ceilY;
      const roomWidth = deck.rightX - deck.leftX;

      if (roomWidth < 28 * U) continue;
      // More stations per deck: ~1 per 44 blocks of (320-space) deck, capped at 5
      const n = Math.max(1, Math.min(5, Math.round(roomWidth / (44 * U))));
      const margin = 16 * U;
      for (let k = 0; k < n; k++) {
        const x = n === 1
          ? Math.round((deck.leftX + deck.rightX) / 2)
          : Math.round(deck.leftX + margin + (roomWidth - 2 * margin) * (k / (n - 1)));
        const type = STATION_TYPES[(deck.index + k * 2) % STATION_TYPES.length];
        const spots = drawStation(type, x, deck.floorY);
        DSV.consoles.push({ deck: deck.index, x, y: deck.floorY, type, spots });
      }
    }

    // --- room dressing: supply-crate stacks + canisters tucked into corners ---
    function drawCrates(cx, floorY) {
      const A = '#3a3a44', B = '#45454f';
      for (let r = 0; r < 2 * U; r++) for (let c = 0; c < 2 * U; c++)
        put(cx + c, floorY - 1 - r, (c + r) % 2 === 0 ? A : B);
      // an offset box stacked on top
      for (let r = 0; r < U; r++) for (let c = 0; c < U; c++)
        put(cx + U + c, floorY - 1 - 2 * U - r, B);
    }
    function drawCanister(cx, floorY) {
      for (let r = 0; r < 2 * U; r++) put(cx, floorY - 1 - r, r === 2 * U - 1 ? PAL.stationHi : PAL.station);
      put(cx, floorY - 1 - 2 * U, PAL.blue); // glowing cap
    }
    for (const deck of DSV.decks) {
      const isTop = deck.index === 0;
      const ceilY = isTop ? (CY - R + HULL_T + 2 * U) : DSV.decks[deck.index - 1].floorY + SLAB;
      const roomTop = isTop ? Math.max(ceilY, deck.floorY - 42 * U) : ceilY;
      const roomWidth = deck.rightX - deck.leftX;

      if (deck.rightX - deck.leftX < 40 * U) continue;
      drawCrates(deck.leftX + 6 * U, deck.floorY);          // cargo by the left wall
      drawCanister(deck.rightX - 6 * U, deck.floorY);       // canister by the right wall
      if (deck.rightX - deck.leftX > 120 * U) drawCrates(Math.round((deck.leftX + deck.rightX) / 2) + 18 * U, deck.floorY);
    }

    // --- overhead lighting: lamp fixtures hung beneath each deck slab ---
    for (let di = 0; di < DSV.decks.length - 1; di++) {
      const deck = DSV.decks[di];
      if (deck.rightX - deck.leftX < 24 * U) continue;
      const width = deck.rightX - deck.leftX;
      const lampN = Math.max(2, Math.floor(width / (34 * U)));
      for (let k = 0; k < lampN; k++) {
        const lx = Math.round(deck.leftX + 10 * U + (width - 20 * U) * (k / Math.max(1, lampN - 1)));
        const ly = deck.floorY + 6 * U; // hangs below this slab, above the next deck
        if (Math.abs(lx - CX) > innerHalfWidthAt(ly) - 1) continue;
        block(ctx, lx, deck.floorY + SLAB, PAL.stationHi); // bracket
        block(ctx, lx, deck.floorY + SLAB + 1, PAL.lampDim);
        block(ctx, lx, ly, PAL.lamp);                      // bulb
        block(ctx, lx - 1, ly, PAL.lampDim);               // glow spill
        block(ctx, lx + 1, ly, PAL.lampDim);
      }
    }

    // --- superlaser dish: a concave focusing crater RECESSED INTO the upper-left
    // dome — INTEGRATED with the hull (it sits within the silhouette, flush with
    // the rim), NOT a disc bulging into space. It reads at an ANGLE: an ellipse
    // foreshortened along the radial direction and tilted to the hull tangent
    // (like the LEGO cutaway), with a chunky SEGMENTED IRIS RING, concentric
    // focusing bands, and a dark central well. Clipped to the sphere so the
    // dish is carved into the shell rather than floating on it. ---
    const dAng = -2.30;                              // upper-left on the dome
    const dr = Math.round(R * 0.19);                 // dish radius (tangential axis)
    const dDist = R - Math.round(dr * 0.05);         // tucked tight into the rim band
    const dcx = CX + Math.round(Math.cos(dAng) * dDist);
    const dcy = CY + Math.round(Math.sin(dAng) * dDist);
    const ux = Math.cos(dAng), uy = Math.sin(dAng);  // radial unit (points to space)
    const tx = -Math.sin(dAng), ty = Math.cos(dAng); // tangential unit (along the rim)
    const SQUASH = 0.58;                             // flatter radial axis -> less reach into the decks
    const ringW = 3 * U;                             // iris-ring thickness
    const ringR = 1 + ringW / dr;                    // outer edge of ring, in metric units
    const NSEG = 18;                                 // iris segments (mechanical teeth)
    const inHull = (col, row) => {
      const hx = col - CX, hy = row - CY;
      return hx * hx + hy * hy <= (R - 1) * (R - 1);
    };
    // elliptical metric of a pixel vs the dish: e=1 is the face edge; ang is the
    // angle around the (tilted, squashed) ellipse; spaceSide = facing outward.
    function dishE(col, row) {
      const dx = col - dcx, dy = row - dcy;
      const at = (dx * tx + dy * ty) / dr;            // tangential (full radius)
      const ar = (dx * ux + dy * uy) / (dr * SQUASH); // radial (squashed)
      return { e: Math.sqrt(at * at + ar * ar), ang: Math.atan2(ar, at), spaceSide: (dx * ux + dy * uy) < 0 };
    }
    const ro = Math.ceil(dr + ringW + 2);
    for (let row = dcy - ro; row <= dcy + ro; row++) {
      for (let col = dcx - ro; col <= dcx + ro; col++) {
        if (!inHull(col, row)) continue;              // recessed: never past the silhouette
        const { e, ang, spaceSide } = dishE(col, row);
        if (e > ringR) continue;
        let c;
        if (e > 1) {
          // segmented iris housing ring: alternating teeth, lit on the space side
          const seg = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * NSEG);
          c = (seg % 2 === 0) ? (spaceSide ? PAL.dishRim : PAL.barrel) : PAL.dishLip;
        } else if (e > 0.86) {
          c = spaceSide ? PAL.dishRim : PAL.dishLip;  // lit rim lip
        } else {
          const band = Math.floor((1 - e) * 6);       // concave focusing bands
          c = e < 0.2 ? PAL.dish2 : (band % 2 === 0 ? PAL.dish : PAL.dish2);
        }
        block(ctx, col, row, c);
      }
    }
    // eight focusing-tower emitters around the inner rim (on the tilted ellipse).
    // Each sources a beam; we only DRAW the stud where it stays inside the rim.
    const emitters = [];
    for (let k = 0; k < 8; k++) {
      const th = (k / 8) * Math.PI * 2 + 0.2;
      const at = Math.cos(th) * 0.82 * dr;
      const ar = Math.sin(th) * 0.82 * dr * SQUASH;
      const col = Math.round(dcx + at * tx + ar * ux);
      const row = Math.round(dcy + at * ty + ar * uy);
      emitters.push([col, row]);
      if (inHull(col, row)) { block(ctx, col, row, PAL.emitter); block(ctx, col, row - 1, PAL.emitter); }
    }
    DSV.dish = { cx: dcx, cy: dcy, r: dr };

    // --- surface turbolaser turrets on the upper-RIGHT hull (decorative
    // hardware; moved off the left to make room for the relocated dish) ---
    for (const A of [-1.30, -0.98, -0.66, -0.34]) {
      const ox = Math.cos(A), oy = Math.sin(A);   // outward (radial) direction
      const px = -Math.sin(A), py = Math.cos(A);  // tangential offset for twin barrels
      const bx = CX + ox * (R - 4 * U), by = CY + oy * (R - 4 * U);
      // turret housing: a mantlet with a lit top
      for (let i = -U; i <= U; i++) for (let j = -U; j <= 2 * U; j++) {
        block(ctx, Math.round(bx + px * i - ox * j), Math.round(by + py * i - oy * j),
          j >= 2 * U ? PAL.stationHi : (j > 0 ? PAL.hull4 : PAL.station));
      }
      // twin barrels reaching outward past the hull, with green muzzles
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        for (let t = 1; t <= 9 * U; t++) {
          const c0 = bx + ox * t + px * sgn * 1.4 * U;
          const r0 = by + oy * t + py * sgn * 1.4 * U;
          const col = Math.round(c0), row = Math.round(r0);
          const muzzle = t >= 7 * U;
          block(ctx, col, row, muzzle ? PAL.beam : PAL.barrel);
          block(ctx, Math.round(c0 - px * sgn * 0.7 * U), Math.round(r0 - py * sgn * 0.7 * U),
            muzzle ? PAL.beam : PAL.barrel);
        }
      }
    }

    // --- superlaser beams: the eight rim emitters fire convergent green rays
    // that meet at a single focal node off the upper-LEFT corner, exactly like
    // the LEGO cutaway. Each ray is precomputed as a list of pixel blocks via a
    // DDA walk; render.js lights them by activity. ---
    const fx = Math.round(GRID_W * 0.025);  // focal node deep in the top-left
    const fy = Math.round(GRID_H * 0.03);   // corner, out in space past the dish
    DSV.beam = { fx, fy, rays: [] };
    for (const [ex, ey] of emitters) {
      const ray = [];
      const dxv = fx - ex, dyv = fy - ey;
      const steps = Math.max(Math.abs(dxv), Math.abs(dyv));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        ray.push([Math.round(ex + dxv * t), Math.round(ey + dyv * t)]);
      }
      DSV.beam.rays.push(ray);
    }
    // legacy single-path kept for any older reference: the longest ray
    DSV.beamPath = DSV.beam.rays.reduce((a, b) => (b.length > a.length ? b : a), []);

    // --- hangar detail: shuttle wedge on the lowest deck + lift shaft ---
    const low = DSV.decks[DSV.decks.length - 1];
    if (low && low.rightX - low.leftX > 24 * U) {
      const sx = low.rightX - 22 * U;
      const sy = low.floorY - 1;
      // Lambda-shuttle silhouette (scaled up via U, with body + folded wings)
      const wedge = [
        '....X....',
        '...XXX...',
        '..XXXXX..',
        '.XXXXXXX.',
        'XXXXXXXXX',
        '..XXXXX..',
        '..X.X.X..',
      ];
      for (let r = 0; r < wedge.length; r++) {
        for (let c = 0; c < wedge[r].length; c++) {
          if (wedge[r][c] !== 'X') continue;
          const shade = r < 3 ? '#4e505a' : '#43454f';
          // each glyph cell becomes a U x U block at double res
          for (let yy = 0; yy < U; yy++) for (let xx = 0; xx < U; xx++)
            block(ctx, sx + c * U + xx, sy - (wedge.length - 1 - r) * U - yy, shade);
        }
      }
      // lift shaft (vertical doorway) on left side of lowest deck
      const lsx = low.leftX + 6 * U;
      for (let row = low.floorY - 18 * U; row < low.floorY; row++) {
        if (Math.abs(lsx - CX) > innerHalfWidthAt(row) - 1) continue;
        for (let c = 0; c < 2 * U; c++) block(ctx, lsx + c, row, c < U ? '#24242c' : '#2c2c34');
        // lift-level indicator lights running up the shaft
        if ((low.floorY - row) % (4 * U) === 0) block(ctx, lsx, row, PAL.lamp);
      }
      // crate stack near the shaft for flavor
      const cxr = low.leftX + 12 * U;
      for (let r = 0; r < 2 * U; r++) for (let c = 0; c < 2 * U; c++)
        block(ctx, cxr + c, low.floorY - 1 - r, c < U ? '#3a3a44' : '#44444e');
    }

    // --- inner-hull power conduits: dotted pipe runs hugging the interior wall
    // on both sides, with brighter junction nodes every few blocks. ---
    const topI = CY - R + HULL_T + 2 * U;
    const botI = CY + R - HULL_T - 2 * U;
    for (let side = -1; side <= 1; side += 2) {
      for (let row = topI; row <= botI; row++) {
        const hwInner = innerHalfWidthAt(row);
        if (hwInner <= 4 * U) continue;
        const col = Math.round(CX + side * (hwInner - 1));
        if (row % 2 === 0) block(ctx, col, row, PAL.conduit);
        if (row % (8 * U) === 0) { block(ctx, col - side, row, PAL.conduitHi); block(ctx, col - side * 2, row, PAL.pipeHi); } // junction node
      }
    }
    // --- under-deck service pipes: faint dotted conduit beneath each deck ---
    for (const deck of DSV.decks) {
      if (deck.rightX - deck.leftX < 20 * U) continue;
      const py = deck.floorY + 5 * U;
      if (py >= botI) continue;
      for (let col = deck.leftX + 2 * U; col <= deck.rightX - 2 * U; col++) {
        if (col % (4 * U) === 0) block(ctx, col, py, PAL.pipe);
        if (col % (12 * U) === 0) block(ctx, col, py, PAL.conduitHi);
      }
    }

    return off;
  }

  DSV.buildStation = buildStation;
  DSV.station = { CX, CY, R, HULL_T };
})();
