/**
 * ingest.js
 *
 * Async ingest queue. The HTTP handler in index.js returns 202 IMMEDIATELY and
 * hands the raw parsed payload here. Reducing happens off the request path via
 * setImmediate so a hook POST is never blocked by world-model work. This is the
 * #1 reliability requirement (hooks fire synchronously inside Claude Code).
 */

/**
 * @param {import('./worldModel.js').WorldModel} world
 * @param {{ debug?: boolean }} [opts]
 */
export function createIngest(world, opts = {}) {
  const debug = !!opts.debug;
  /** @type {object[]} */
  const queue = [];
  let draining = false;

  function drain() {
    draining = true;
    // Process the whole queue in one microtask burst; each apply is cheap.
    while (queue.length) {
      const event = queue.shift();
      try {
        world.apply(event);
      } catch (err) {
        // Never let one malformed payload take down the server.
        console.error('[ingest] error applying event:', err?.message ?? err);
      }
    }
    draining = false;
  }

  /**
   * Enqueue a parsed hook payload for async reduction. Returns instantly.
   * @param {*} payload
   */
  function enqueue(payload) {
    // Tolerate non-object bodies (empty/odd) without throwing.
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      if (debug) console.log('[ingest] ignored non-object payload');
      return;
    }
    queue.push(payload);
    logCompact(payload, debug);
    if (!draining) setImmediate(drain);
  }

  return { enqueue };
}

/** Compact one-line log so the user can confirm the pipe works. */
function logCompact(payload, debug) {
  const name = payload.hook_event_name ?? 'UNKNOWN';
  const sid = typeof payload.session_id === 'string' ? payload.session_id.slice(0, 8) : '--------';
  const tool = payload.tool_name ? ` tool=${payload.tool_name}` : '';
  const agent = payload.agent_id ? ` agent=${String(payload.agent_id).slice(0, 8)}` : '';
  console.log(`[ingest] ${name} session=${sid}${tool}${agent}`);
  if (debug) console.log('[ingest] payload:', JSON.stringify(payload));
}
