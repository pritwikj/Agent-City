/* ===========================================================================
   config.js — CITY namespace bootstrap: palette, tile metrics, hashing,
   shared tuning mirrors.

   The client renders an isometric "agent city": districts (one per project)
   of city blocks whose buildings are erected by Claude Code tool activity.
   Sessions appear as construction workers, subagents as crew members.
   =========================================================================== */
(function () {
  'use strict';

  // ---- Isometric tile metrics (world-space pixels) -------------------------
  const TILE_W = 64;            // 2:1 diamond
  const TILE_H = 32;
  const FLOOR_H = 14;           // pixels of building height per story
  const BLOCK_TILES = 8;        // a city block is 8x8 tiles
  const PARCEL_GRID = 3;        // 3x3 parcels of 2x2 tiles inside each block
  const LOTS_PER_BLOCK = 9;     // mirrors server TUNING.LOTS_PER_BLOCK

  // ---- Palette — clean, sunny Cities Skylines look --------------------------
  const PAL = {
    skyTop: '#bfe6f7',
    skyBottom: '#eaf6ef',
    grass: '#84c56e',
    grassHi: '#9bd683',
    grassEdge: '#69ab57',
    plaza: '#e8e0cd',
    road: '#4e565f',
    roadEdge: '#3f464e',
    roadLine: '#e6c14d',     // warm centre-line (kept subtle via alpha)
    curb: '#cfd5db',
    sidewalk: '#c3cad1',
    sidewalkEdge: '#a9b2bb',
    dirt: '#c39a6a',
    dirtDark: '#a07a4f',
    foundation: '#a3aab1',
    roofSlab: '#5f656e',     // flat-roof membrane (neutral)
    roofGravel: '#787e87',
    scaffold: '#e8ad3c',
    crane: '#ecbe4c',
    shadow: '20,26,34',      // rgb for cast shadows (used with alpha)
  };

  // Light direction (sun from upper-NE). Shadows fall toward screen SW.
  // Cast-shadow screen offset per pixel of building height (kept moderate so
  // supertall towers don't sling a shadow clear off their block).
  const SUN = { shadowDX: -0.33, shadowDY: 0.22 };

  // ---- Deterministic hashing (FNV-1a 32-bit; identical to server) ----------
  function hash32(str) {
    let h = 0x811c9dc5;
    str = String(str == null ? '' : str);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // ---- Project identity (defensive: accept string or {key,name,path}) ------
  function projectKey(project) {
    if (project == null) return 'unknown';
    if (typeof project === 'string') return project;
    return String(project.key || project.path || project.name || 'unknown');
  }
  function projectName(project) {
    if (project == null) return 'unknown';
    if (typeof project === 'string') {
      const seg = project.replace(/[\\/]+$/, '').split(/[\\/]/);
      return seg[seg.length - 1] || project;
    }
    return String(project.name || project.key || project.path || 'unknown');
  }

  // ---- District hue helpers -------------------------------------------------
  function hueFor(key) { return hash32(key) % 360; }
  function districtColor(hue, s, l) {
    return 'hsl(' + hue + ',' + (s == null ? 55 : s) + '%,' + (l == null ? 55 : l) + '%)';
  }

  // NOTE: tool family deliberately does NOT influence the city. Construction
  // reflects the VOLUME of work, not its kind — reading and editing look the
  // same on site — so there is no tool-family -> activity/colour mapping here.

  // ---- Building types --------------------------------------------------------
  // MIRROR of server/city.js BUILDING_TYPES + TYPE_WEIGHTS (no shared module in
  // a build-step-free project). Real lots arrive with `type` baked in by the
  // server; the client needs the table to map type -> render category, and the
  // demo uses the weighted draw to synthesize the same varied skyline offline.
  // (park/landfill never reach a lot — the server swaps them to a growable type;
  // they appear only as ambient zoning on empty parcels, see render.js.)
  const BUILDING_TYPES = {
    house:         { category: 'res',     floors: [1, 2],   foot: [[1, 1]] },
    apartment:     { category: 'res',     floors: [3, 6],   foot: [[1, 1], [1, 2]] },
    office:        { category: 'com',     floors: [7, 14],  foot: [[1, 2]] },
    skyscraper:    { category: 'com',     floors: [16, 40], foot: [[2, 2]] },
    school:        { category: 'school',  floors: [2, 4],   foot: [[1, 2], [2, 2]] },
    power_station: { category: 'power',   floors: [3, 4],   foot: [[2, 2]] },
    transit:       { category: 'transit', floors: [2, 3],   foot: [[1, 2], [2, 2]] },
    park:          { category: 'park',    floors: [0, 0],   foot: [[2, 2]] },
    landfill:      { category: 'landfill', floors: [0, 0],  foot: [[2, 2]] },
  };
  const TYPE_WEIGHTS = [
    { until: 4,        w: { house: 5, park: 3, apartment: 2, landfill: 1, school: 1 } },
    { until: 10,       w: { apartment: 4, office: 3, school: 2, transit: 2, house: 2, park: 2, power_station: 1 } },
    { until: Infinity, w: { office: 4, skyscraper: 3, power_station: 2, transit: 2, school: 1, park: 1 } },
  ];
  function pickType(seed, n) {
    const pool = TYPE_WEIGHTS.find((b) => n < b.until) || TYPE_WEIGHTS[TYPE_WEIGHTS.length - 1];
    const entries = Object.entries(pool.w);
    let total = 0;
    for (const [, wt] of entries) total += wt;
    let roll = seed % total;
    for (const [type, wt] of entries) {
      if (roll < wt) return type;
      roll -= wt;
    }
    return entries[0][0];
  }
  function floorsForType(type, seed) {
    const [lo, hi] = (BUILDING_TYPES[type] || BUILDING_TYPES.office).floors;
    return hi > lo ? lo + (seed % (hi - lo + 1)) : lo;
  }
  function footprintForType(type, seed) {
    const fps = (BUILDING_TYPES[type] || BUILDING_TYPES.office).foot;
    return fps[seed % fps.length].slice();
  }
  function tierForFloors(floors) {
    if (floors >= 20) return 5;
    if (floors >= 12) return 4;
    if (floors >= 7) return 3;
    if (floors >= 3) return 2;
    return 1;
  }
  function buildingCategory(type) {
    return (BUILDING_TYPES[type] || BUILDING_TYPES.office).category;
  }

  // ---- Shared utils ----------------------------------------------------------
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---- Export ----------------------------------------------------------------
  window.CITY = window.CITY || {};
  Object.assign(window.CITY, {
    TILE_W, TILE_H, FLOOR_H, BLOCK_TILES, PARCEL_GRID, LOTS_PER_BLOCK,
    PAL, SUN,
    BUILDING_TYPES,
    hash32, projectKey, projectName, hueFor, districtColor,
    pickType, floorsForType, footprintForType, tierForFloors, buildingCategory,
    esc, clamp, lerp,
  });
})();
