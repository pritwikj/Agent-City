/**
 * city.js — authoritative city growth model.
 *
 * The city is the PERSISTENT layer of the viz. The unit of growth is a Claude
 * Code SESSION (its main agent + all of its subagents — their tool work is
 * attributed to the parent session, so they build together). The first time a
 * session does work it is bound to ONE structure to build: ~50/50 by session-id
 * hash it either breaks ground on a NEW building or RENOVATES an existing
 * finished building in that session's district (falling back to new ground if
 * nothing is renovatable). Once that structure tops out, a still-running session
 * picks a finished building to RENOVATE next (raising its tier / floors) — its
 * OWN counts, so it may keep climbing the same one house->apartment->office->
 * skyscraper, or send the crew to improve a neighbour. So a long session either
 * raises a signature tower or spreads upgrades across the district.
 *
 * Tool KIND is irrelevant — every successful PostToolUse is one unit of work
 * whether the agent was reading or editing. Failures log incidents (smoke/fire
 * cues). The city is a single shared neighbourhood — work is NOT zoned by
 * project; every session builds into the one skyline, which grows permanently
 * across server restarts (see persist.js).
 *
 * Layout model (shared contract with the client layout solver):
 *   - The world is a plane of 8x8-tile BLOCKS placed on a deterministic
 *     spiral walk from the origin (block slot 0 = (0,0), then ring 1, ...).
 *   - Each block: 1-tile perimeter road + 6x6 interior = a 3x3 grid of
 *     2x2-tile PARCELS. One lot per parcel, 9 lots per block, filled in
 *     serpentine order. Building footprints ([1,1]|[1,2]|[2,2]) render
 *     inside their parcel.
 *   - district.blocks[] holds the GLOBAL spiral slot indices the district
 *     occupies; each lot stores its block slot + parcel index, so placement
 *     is fully persisted — the client never re-derives it.
 *
 * WS messages emitted (additive to the entity contract; NEVER replayed from
 * the resync ring — every handshake gets a fresh full city snapshot):
 *   { type:"city",      seq, city:{ version, districts:[...] } }
 *   { type:"cityDelta", seq, districtKey, district?, lot:{...full lot...},
 *     event: "progress"|"groundbreak"|"complete"|"incident" }
 */

import { EventEmitter } from 'node:events';

export const SAVE_VERSION = 1;

// ── Tuning (the whole growth economy lives here) ─────────────────────────────
export const TUNING = {
  WORK_PER_TOOL: 1,        // work units per successful PostToolUse
  BASE_REQUIRED: 30,       // building n needs BASE + STEP*n work units...
  REQUIRED_STEP: 15,
  REQUIRED_CAP: 400,       // ...capped so megatowers stay reachable
  LOTS_PER_BLOCK: 9,       // 3x3 parcels per block (see layout model above)
};

// FNV-1a 32-bit — identical to the client's hash32 so seeds/hues agree.
export function hash32(str) {
  let h = 0x811c9dc5;
  str = String(str == null ? '' : str);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// ── Building types (pure-random, maturity-biased selection) ──────────────────
// Every lot rolls a type from a seeded weighted draw whose pool shifts as the
// district matures (n = lot index): young districts favor houses/parks, mature
// ones favor towers/civic infrastructure. `category` drives the client render
// path. NOTE: BUILDING_TYPES + TYPE_WEIGHTS are mirrored verbatim in
// public/config.js — change both together or seeds/renders disagree.
export const BUILDING_TYPES = {
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

// Weighted pools by maturity band; first band whose `until` exceeds n wins.
export const TYPE_WEIGHTS = [
  { until: 4,        w: { house: 5, park: 3, apartment: 2, landfill: 1, school: 1 } },
  { until: 10,       w: { apartment: 4, office: 3, school: 2, transit: 2, house: 2, park: 2, power_station: 1 } },
  { until: Infinity, w: { office: 4, skyscraper: 3, power_station: 2, transit: 2, school: 1, park: 1 } },
];

export function pickType(seed, n) {
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

export function floorsForType(type, seed) {
  const [lo, hi] = (BUILDING_TYPES[type] || BUILDING_TYPES.office).floors;
  return hi > lo ? lo + (seed % (hi - lo + 1)) : lo;
}

export function footprintForType(type, seed) {
  const fps = (BUILDING_TYPES[type] || BUILDING_TYPES.office).foot;
  return fps[seed % fps.length].slice();
}

// A growable building type by district maturity — used when a session's lot
// would otherwise roll a non-growable park/landfill (its work must show).
export function growableFallback(n) {
  if (n < 4) return 'house';
  if (n < 10) return 'apartment';
  return 'office';
}

// ── Zoning ───────────────────────────────────────────────────────────────────
// Each lot gets a FIXED zone (weighted random, like real parcel zoning) that
// CAPS how dense/tall its building can ever become — most of a city is low-rise
// and only a small downtown can ever reach skyscrapers. A building redevelops up
// the density chain (house -> apartment -> office -> skyscraper) only as far as
// its zone allows, then tops out (and sessions move on to other growable lots).
export const DENSITY_CHAIN = ['house', 'apartment', 'office', 'skyscraper'];
export const ZONES = [
  { zone: 'residential', weight: 6, cap: 'apartment' },  // low-rise homes / flats
  { zone: 'commercial',  weight: 3, cap: 'office' },      // mid-rise commercial
  { zone: 'downtown',    weight: 1, cap: 'skyscraper' },  // rare high-rise core
];
const ZONE_CAP = Object.fromEntries(ZONES.map((z) => [z.zone, z.cap]));

/** Weighted pick of a zone from a seed (deterministic). */
export function pickZone(seed) {
  let total = 0;
  for (const z of ZONES) total += z.weight;
  let roll = seed % total;
  for (const z of ZONES) {
    if (roll < z.weight) return z.zone;
    roll -= z.weight;
  }
  return ZONES[0].zone;
}

function densityRank(type) { return DENSITY_CHAIN.indexOf(type); } // -1 if off-chain
function zoneCapType(zone) { return ZONE_CAP[zone] || 'office'; }
function maxFloorsForType(type) { return (BUILDING_TYPES[type] || BUILDING_TYPES.office).floors[1]; }

// Tier survives only as a coarse "bigness" hint for client roof furniture.
export function tierForFloors(floors) {
  if (floors >= 20) return 5;
  if (floors >= 12) return 4;
  if (floors >= 7) return 3;
  if (floors >= 3) return 2;
  return 1;
}

export function requiredFor(n) {
  return Math.min(TUNING.REQUIRED_CAP, TUNING.BASE_REQUIRED + TUNING.REQUIRED_STEP * n);
}

export class CityModel extends EventEmitter {
  /**
   * @param {{ nextSeq: () => number }} seqSource — usually the WorldModel, so
   *   city messages share the same monotonic seq space as entity messages.
   */
  constructor(seqSource) {
    super();
    this.seqSource = seqSource;
    /** @type {Map<string, object>} project key -> district */
    this.districts = new Map();
    /** global spiral block slots already occupied (across all districts) */
    this.usedBlocks = new Set();
    /** @type {Map<string, object>} sessionId -> the lot it is bound to (runtime only) */
    this.sessionLot = new Map();
  }

  // ── persistence interop ────────────────────────────────────────────────────

  /** Hydrate from a parsed save file (validated by persist.loadCity). */
  loadFrom(save) {
    this.districts.clear();
    this.usedBlocks.clear();
    this.sessionLot.clear();
    for (const d of save.districts ?? []) {
      if (!d || typeof d.key !== 'string' || !Array.isArray(d.lots)) continue;
      for (const lot of d.lots) {
        this.normalizeLoadedLot(lot);
        // A reloaded city has no live sessions, so a lot that was mid-build can
        // never be resumed by its old owner — top it out so the skyline reads
        // as standing buildings ready for new sessions to add to / renovate.
        if (lot.state !== 'complete') {
          lot.state = 'complete';
          lot.progress = lot.required;
          lot.everCompleted = true;
          if (lot.completedAt == null) lot.completedAt = save.savedAt ?? Date.now();
        }
      }
      d.completedCount = d.lots.length;
      this.districts.set(d.key, d);
      for (const b of d.blocks ?? []) this.usedBlocks.add(b);
    }
  }

  /** Backfill fields older saves (or the legacy model) may lack. */
  normalizeLoadedLot(lot) {
    if (!lot || !lot.building) return;
    if (typeof lot.upgrades !== 'number') lot.upgrades = 0;
    if (typeof lot.everCompleted !== 'boolean') lot.everCompleted = lot.state === 'complete';
    if (typeof lot.zone !== 'string') {
      // Infer a zone consistent with the building already standing there.
      const f = lot.building.floors || 0;
      lot.zone = f >= 16 ? 'downtown' : f >= 7 ? 'commercial' : 'residential';
    }
    lot.sessionId = null; // owners from a previous run are gone
  }

  toJSON() {
    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      districts: Array.from(this.districts.values()),
    };
  }

  stats() {
    let buildings = 0;
    let underConstruction = 0;
    for (const d of this.districts.values()) {
      for (const lot of d.lots) {
        // An ever-completed lot is a real building even while it is being
        // renovated (state flips back to 'construction' during an upgrade).
        if (lot.everCompleted || lot.state === 'complete') buildings += 1;
        else underConstruction += 1;
      }
    }
    return { buildings, underConstruction, districts: this.districts.size };
  }

  /** Full city snapshot — sent on EVERY WS handshake (never ring-replayed). */
  snapshotCity() {
    return {
      type: 'city',
      seq: this.seqSource.seq ?? 0, // current-as-of; do not advance
      city: {
        version: SAVE_VERSION,
        districts: Array.from(this.districts.values()),
      },
    };
  }

  // ── growth ─────────────────────────────────────────────────────────────────

  /** Smallest spiral block slot not yet occupied by any district. */
  nextFreeBlock() {
    let s = 0;
    while (this.usedBlocks.has(s)) s += 1;
    return s;
  }

  // The city is NO LONGER zoned by project. Every session's work — whatever
  // cwd it came from — funnels into one shared, continuously-growing city, so
  // there is a single district. `project` is still accepted (ingest contract)
  // but no longer places or colours anything; building colour is per-building
  // on the client (see buildingStyle).
  ensureDistrict(_project) {
    const key = 'city';
    let d = this.districts.get(key);
    if (d) return d;
    const block = this.nextFreeBlock();
    this.usedBlocks.add(block);
    d = {
      key,
      name: 'city',
      index: 0,
      blocks: [block],
      hue: 210, // kept for back-compat; the client no longer tints by it
      totalWork: 0,
      totalIncidents: 0,
      completedCount: 0,
      lots: [],
    };
    this.districts.set(key, d);
    // No auto-groundbreak: the first building appears when the first session is
    // bound to a lot (see lotForSession).
    return d;
  }

  /** Start construction on district's next lot; annex a block if full. */
  breakGround(district) {
    const n = district.lots.length;
    const parcel = n % TUNING.LOTS_PER_BLOCK;
    let blockIdx = Math.floor(n / TUNING.LOTS_PER_BLOCK);
    if (blockIdx >= district.blocks.length) {
      const block = this.nextFreeBlock();
      this.usedBlocks.add(block);
      district.blocks.push(block);
    }
    const seed = hash32(`${district.key}:${n}`);
    // A session's structure must be able to reflect the work poured into it, so
    // it never starts as a non-growable park/landfill (those stay as ambient
    // greenery via the client's tree filler). Keep the maturity bias otherwise.
    let type = pickType(seed, n);
    if (type === 'park' || type === 'landfill') type = growableFallback(n);
    // Zoning: a fixed, weighted-random zone caps how dense/tall this lot may get.
    // Clamp the starting building so it never begins above its zone (a low-rise
    // zone can't open as a skyscraper).
    const zone = pickZone(seed >>> 11);
    if (densityRank(type) > densityRank(zoneCapType(zone))) type = zoneCapType(zone);
    const floors = Math.min(floorsForType(type, seed >>> 8), maxFloorsForType(type));
    const lot = {
      id: `d${district.index}:${n}`,
      index: n,
      block: district.blocks[blockIdx],
      parcel,
      zone,
      state: 'construction',
      progress: 0,
      required: requiredFor(n),
      building: {
        seed,
        type,
        tier: tierForFloors(floors),
        floors,
        footprint: footprintForType(type, seed >>> 5),
      },
      sessionId: null,
      upgrades: 0,
      everCompleted: false,
      startedAt: Date.now(),
      completedAt: null,
      incidents: 0,
    };
    district.lots.push(lot);
    this.emitDelta(district, lot, 'groundbreak');
    return lot;
  }

  /**
   * The lot a session is bound to. The first time a session works in a district
   * it is assigned one for life: ~50/50 by hash it renovates a finished building
   * or breaks new ground (falling back to new ground if nothing is renovatable).
   */
  lotForSession(district, sessionId) {
    const key = sessionId || `_anon:${district.key}`;
    const existing = this.sessionLot.get(key);
    if (existing && district.lots[existing.index] === existing) return existing;

    let lot = null;
    if ((hash32(key) & 1) === 1) lot = this.pickUpgradeable(district, key);
    if (!lot) lot = this.breakGround(district);
    lot.sessionId = key;
    this.sessionLot.set(key, lot);
    this.emit('assign', { sessionId: key, districtKey: district.key, lotId: lot.id });
    return lot;
  }

  /**
   * A finished, growable building in the district to renovate. The session's own
   * just-topped-out building is a valid pick, so repeated passes can climb it
   * house->apartment->office->skyscraper rather than capping it.
   */
  pickUpgradeable(district, key) {
    const candidates = district.lots.filter(
      (l) => l.state === 'complete' && this.canGrow(l)
    );
    if (!candidates.length) return null;
    return candidates[hash32(`${key}:up`) % candidates.length];
  }

  /** Move a session (and its crew) onto a different building to renovate. */
  rebindSession(district, sessionId, lot) {
    const key = sessionId || `_anon:${district.key}`;
    lot.sessionId = key;
    this.sessionLot.set(key, lot);
    this.emit('assign', { sessionId: key, districtKey: district.key, lotId: lot.id });
    return lot;
  }

  /** Whether a building can still be made denser/taller within its zone. */
  canGrow(lot) {
    const b = lot.building || {};
    if (b.type === 'park' || b.type === 'landfill') return false;
    const zone = lot.zone || 'commercial';
    const curRank = densityRank(b.type);
    if (curRank >= 0) {
      // Density-chain building: redevelop denser until the zone cap, then add
      // floors until the cap type's ceiling.
      if (curRank < densityRank(zoneCapType(zone))) return true;
      return (b.floors ?? 0) < maxFloorsForType(zoneCapType(zone));
    }
    // Off-chain civic types (school/power/transit) grow within their own band.
    return (b.floors ?? 0) < maxFloorsForType(b.type);
  }

  /**
   * Begin a renovation pass on a finished building: redevelop it one step denser
   * (house->apartment->office->skyscraper) and/or taller. Civic types keep their
   * type but gain floors. The site re-scaffolds until the new height is reached.
   */
  startUpgrade(district, lot, sessionId) {
    const b = lot.building;
    const oldFloors = b.floors || 1;
    lot.upgrades = (lot.upgrades || 0) + 1;
    const seed = b.seed || 1;
    const zone = lot.zone || 'commercial';
    const curRank = densityRank(b.type);
    // Redevelop one density step toward the zone cap; off-chain civic types and
    // already-capped buildings keep their type and just gain floors.
    const nextType = curRank >= 0 && curRank < densityRank(zoneCapType(zone))
      ? DENSITY_CHAIN[curRank + 1]
      : b.type;
    b.type = nextType;
    const ceil = maxFloorsForType(nextType); // each type tops out at its own band
    const typedFloors = floorsForType(nextType, (seed >>> 8) + lot.upgrades);
    b.floors = Math.min(ceil, Math.max(oldFloors + 1, typedFloors));
    b.footprint = footprintForType(nextType, (seed >>> 5) + lot.upgrades);
    b.tier = tierForFloors(b.floors);
    lot.required = requiredFor(b.floors);
    lot.state = 'construction';
    lot.completedAt = null;
    // Resume near the current height so the tower grows rather than resetting.
    lot.progress = Math.min(
      lot.required - 1,
      Math.round((lot.required * oldFloors) / Math.max(1, b.floors))
    );
    if (sessionId) lot.sessionId = sessionId;
    this.emitDelta(district, lot, 'groundbreak');
  }

  /** Top a lot out. Only counts as a new building the first time it completes. */
  finishLot(district, lot) {
    lot.progress = lot.required;
    lot.state = 'complete';
    lot.completedAt = Date.now();
    if (!lot.everCompleted) {
      lot.everCompleted = true;
      district.completedCount += 1;
    }
    this.emitDelta(district, lot, 'complete');
  }

  /** +1 work unit from a successful tool use (tool kind is irrelevant). */
  recordWork({ project, sessionId }) {
    const d = this.ensureDistrict(project);
    let lot = this.lotForSession(d, sessionId);
    // A finished structure + a still-running session: pick a finished, growable
    // building to RENOVATE next. Its OWN building counts, so a session can keep
    // raising the same one into a skyscraper, or send the crew to improve a
    // neighbour. Only drop the unit if nothing anywhere can still grow.
    if (lot.state === 'complete') {
      const target = this.pickUpgradeable(d, `${sessionId}:hop:${lot.id}`);
      if (!target) { this.emit('dirty'); return; }
      lot = this.rebindSession(d, sessionId, target);
      this.startUpgrade(d, lot, lot.sessionId);
    }
    lot.progress += TUNING.WORK_PER_TOOL;
    d.totalWork += TUNING.WORK_PER_TOOL;
    if (lot.progress >= lot.required) this.finishLot(d, lot);
    else this.emitDelta(d, lot, 'progress');
    this.emit('dirty');
  }

  /** A tool failure — smoke/fire on the session's construction site. */
  recordIncident({ project, sessionId }) {
    const d = this.ensureDistrict(project);
    const lot = this.lotForSession(d, sessionId);
    lot.incidents = (lot.incidents || 0) + 1;
    d.totalIncidents += 1;
    this.emitDelta(d, lot, 'incident');
    this.emit('dirty');
  }

  /** Forget a session's binding once it ends (keeps the map from growing). */
  releaseSession(sessionId) {
    if (sessionId) this.sessionLot.delete(sessionId);
  }

  // ── emit ───────────────────────────────────────────────────────────────────

  /**
   * cityDelta carries the FULL lot record (idempotent apply on the client).
   * District meta (sans lots) rides along on lifecycle events so new
   * districts / annexed blocks reach clients without a snapshot.
   */
  emitDelta(district, lot, event) {
    const msg = {
      type: 'cityDelta',
      seq: this.seqSource.nextSeq(),
      districtKey: district.key,
      lot: { ...lot, building: { ...lot.building } },
      event,
    };
    if (event !== 'progress') {
      const { lots, ...meta } = district;
      msg.district = { ...meta, blocks: [...district.blocks] };
    }
    this.emit('message', msg);
  }
}
