/**
 * persist.js — durable city save file (data/city.json).
 *
 * Guarantees:
 *   - Atomic writes: serialize to city.json.tmp, then rename over city.json,
 *     so a crash mid-write can never corrupt the save.
 *   - Debounced single writer: 5s after the last change, hard max 30s between
 *     writes while changes keep arriving.
 *   - flushSync() for the SIGINT/SIGTERM path.
 *   - A bad/old save file is quarantined to city.json.bak-<ts>, never parsed
 *     into a crash — the city simply starts fresh.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SAVE_VERSION } from './city.js';

const DEBOUNCE_MS = 5_000;
const MAX_INTERVAL_MS = 30_000;

/**
 * Load and validate a save file. Returns the parsed save or null (fresh city).
 * Never throws.
 */
export function loadCity(filePath, { debug = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null; // no save yet
  }
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== SAVE_VERSION || !Array.isArray(data.districts)) {
      throw new Error(`unsupported save (version=${data?.version})`);
    }
    if (debug) console.log(`[persist] loaded ${data.districts.length} district(s) from ${filePath}`);
    return data;
  } catch (err) {
    const bak = `${filePath}.bak-${Date.now()}`;
    try {
      fs.renameSync(filePath, bak);
      console.error(`[persist] bad save quarantined to ${bak}: ${err?.message ?? err}`);
    } catch {
      console.error(`[persist] bad save (and quarantine failed): ${err?.message ?? err}`);
    }
    return null;
  }
}

/**
 * Subscribe to a CityModel's 'dirty' events and keep the save file current.
 * @returns {{ flushSync: () => void, stop: () => void }}
 */
export function createPersister(city, filePath, { debug = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let timer = null;
  let dirty = false;
  let oldestDirtyAt = 0;

  function writeNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    dirty = false;
    oldestDirtyAt = 0;
    const tmp = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(city.toJSON()));
      fs.renameSync(tmp, filePath);
      if (debug) console.log(`[persist] saved ${filePath}`);
    } catch (err) {
      // A save failure must never take down the ingest pipeline.
      console.error(`[persist] save failed: ${err?.message ?? err}`);
    }
  }

  function schedule() {
    const now = Date.now();
    if (!dirty) {
      dirty = true;
      oldestDirtyAt = now;
    }
    if (timer) clearTimeout(timer);
    // Debounce, but never let pending changes age past MAX_INTERVAL_MS.
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, oldestDirtyAt + MAX_INTERVAL_MS - now));
    timer = setTimeout(writeNow, wait);
    if (typeof timer.unref === 'function') timer.unref();
  }

  const onDirty = () => schedule();
  city.on('dirty', onDirty);

  return {
    flushSync() {
      if (dirty || timer) writeNow();
    },
    stop() {
      city.off('dirty', onDirty);
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
