/**
 * reaper.js
 *
 * Orphan reaper. Sessions die without a clean SessionEnd all the time (closed
 * terminal, killed process, slept laptop). This timer ages entities out by
 * `lastSeen` so the decks don't fill with crew that never leave.
 *
 *   silent past DIM_THRESHOLD_MS    -> mark `dimmed` (client sits the sprite)
 *   silent past DESPAWN_THRESHOLD_MS -> remove entity + despawn delta
 *
 * Thresholds are constants here so they're easy to tune in one place.
 */

// ── Thresholds (tunable) ────────────────────────────────────────────────────
export const DIM_THRESHOLD_MS = 45_000; // 45s silent -> dim / sit down
export const DESPAWN_THRESHOLD_MS = 120_000; // 120s silent -> despawn
export const REAP_INTERVAL_MS = 5_000; // how often the reaper runs

/**
 * Start the reaper timer against a WorldModel. Returns a stop() function.
 * @param {import('./worldModel.js').WorldModel} world
 * @param {{ debug?: boolean }} [opts]
 */
export function startReaper(world, opts = {}) {
  const debug = !!opts.debug;

  const tick = () => {
    const now = Date.now();
    const toDespawn = [];

    for (const rec of world.entities.values()) {
      const silent = now - (rec.lastSeen ?? 0);

      if (silent >= DESPAWN_THRESHOLD_MS) {
        toDespawn.push(rec.id);
        continue;
      }

      if (silent >= DIM_THRESHOLD_MS && !rec.dimmed) {
        rec.dimmed = true;
        // Idle-sit flag; status stays whatever it was (usually idle).
        world.emitDelta(rec.id, { dimmed: true, signal: 'dim' });
        if (debug) console.log(`[reaper] dim ${short(rec.id)} (silent ${Math.round(silent / 1000)}s)`);
      }
    }

    // Despawn after iterating so we don't mutate the map mid-loop.
    for (const id of toDespawn) {
      const rec = world.entities.get(id);
      if (!rec) continue;
      world.entities.delete(id);
      world.inFlight.delete(id);
      world.emitDespawn(id);
      if (debug) console.log(`[reaper] despawn ${short(id)} (orphaned)`);

      // If a session was reaped, reap its orphaned subagents too.
      if (rec.kind === 'session') {
        for (const [otherId, other] of world.entities) {
          if (other.kind === 'subagent' && other.parentSessionId === id) {
            world.entities.delete(otherId);
            world.inFlight.delete(otherId);
            world.emitDespawn(otherId);
          }
        }
      }
    }
  };

  const handle = setInterval(tick, REAP_INTERVAL_MS);
  // Don't keep the process alive solely for the reaper.
  if (typeof handle.unref === 'function') handle.unref();

  return function stop() {
    clearInterval(handle);
  };
}

function short(id) {
  return typeof id === 'string' ? id.slice(0, 8) : String(id);
}
