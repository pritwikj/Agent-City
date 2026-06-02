# Death Star Viz

Real-time 8-bit Death Star cutaway visualization of Claude Code agents working across projects. See `../agent-viz-spec.md` for the full design.

## Server

The event server ingests Claude Code hook events, folds them into an authoritative in-memory world model, and streams snapshots + deltas to the canvas client over WebSocket. State lives entirely server-side; the browser is a stateless view.

### Run

```bash
npm install      # express + ws (already in package.json)
npm start        # node server/index.js   -> http://localhost:8080/
npm run dev      # node --watch ...
```

On startup it prints a banner with the ingest URL, stream URL, and viz URL.

### Environment variables

| Var | Default | Effect |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listen port. |
| `DEBUG` | _(off)_ | Set `1`/`true` for verbose logging (full payloads, reaper actions, resync details). |

### Endpoints

- `POST /ingest` — accepts a hook JSON payload. **Returns `202` immediately** (before any processing); all reduction happens asynchronously so Claude Code hooks are never blocked. Empty/malformed/odd bodies are tolerated and silently dropped — they never crash the server.
- `GET /health` — `{ ok, entities, seq }`.
- `WS /stream` — the live world stream (see contract below).
- `GET /` (and other paths) — serves the static client from `../public/`.

### Hook configuration

Register HTTP hooks in `~/.claude/settings.json` pointing every lifecycle event at `http://localhost:8080/ingest` (see spec §3). The server dispatches on the payload's `hook_event_name` field.

### World model

A map `entityId -> record`. Sessions are keyed by `session_id`; subagents by `agent_id`.

**Entity record fields:**

| Field | Notes |
|---|---|
| `id` | `session_id` or `agent_id`. |
| `kind` | `"session"` \| `"subagent"`. |
| `agentType` | Subagent type (or null for sessions). |
| `parentSessionId` | For subagents: the owning session. |
| `project` | `{ key, name, path }` derived from `cwd` (`name` = basename, `key`/`path` = full cwd). Subagents inherit their parent's project. |
| `status` | `"spawning"` \| `"working"` \| `"idle"` \| `"finished"`. |
| `currentTool`, `currentToolFamily` | The in-flight tool name + visual family (set by PreToolUse, cleared by PostToolUse). |
| `lastSeen` | ms timestamp, updated on every event for that entity; drives the reaper. |
| `toolCount`, `errorCount` | Counters. |
| `dimmed` | Set by the reaper after the dim threshold; cleared on any fresh activity. |
| `recentEvents` | Ring buffer (cap 10) of `{ t, e }` for generic lifecycle breadcrumbs. |
| `recentToolActions` | Ring buffer (cap 8) of Claude-style action lines `{ t, kind, text, seq }` used to seed per-session dialogue boxes on reconnect. |

Optional extras when present: `model`, `source`, `title`, `agentTranscriptPath`.

**Tool family mapping** (server decides, sent as `currentToolFamily`; case-insensitive):

| Family | Tools |
|---|---|
| `exec` | Bash (shell/exec) |
| `read` | Read, Grep, Glob, LS |
| `edit` | Edit, Write, MultiEdit, NotebookEdit |
| `scan` | WebSearch, WebFetch |
| `delegate` | Task, Agent |
| `generic` | anything else / unknown |

**Reducer highlights** (spec §4):

- **PreToolUse → PostToolUse correlation** uses a per-session **LIFO stack** of in-flight tools (there is no `tool_use_id`). PostToolUse pops; if the stack empties the session goes `idle` and `currentTool` clears, otherwise it resumes showing the tool now on top.
- **`Stop` returns the session to `idle` but never despawns it.** Only `SessionEnd` or the reaper removes a session.
- `SessionEnd` despawns the session **and all its subagents**.
- `SubagentStop` despawns that subagent.
- `PostToolUseFailure` increments `errorCount` and emits an `error` signal, then pops the in-flight tool like a normal PostToolUse.
- Any event for an unknown-but-identifiable session/agent just refreshes `lastSeen`.

### Fleet aggregates

Recomputed and broadcast on the tick:

```
{ activeCount, totalCount, throughput, toolStartsWindow, errorsWindow,
  errorRate, spend, projects:[{ key, name, path, count, working }], windowMs }
```

- `throughput` = tool starts per second over a rolling 10s window.
- `errorRate` = failures / (tool starts + failures) over the rolling windows (0..1).
- `spend` is always `null` (OTel not wired).

### Orphan reaper

A timer ages entities by `lastSeen` (constants in `server/reaper.js`):

| Threshold | Default | Action |
|---|---|---|
| `DIM_THRESHOLD_MS` | 45s | mark `dimmed: true`, emit a delta with `signal: "dim"` (client sits the sprite). |
| `DESPAWN_THRESHOLD_MS` | 120s | remove the entity + emit a despawn (also reaps a reaped session's subagents). |
| `REAP_INTERVAL_MS` | 5s | how often the reaper scans. |

### Broadcast cadence

Fixed ~150ms tick coalesces high-frequency state deltas and pushes aggregates. **Lifecycle beats — `spawn`, `despawn`, and `error` deltas — are broadcast immediately** (the pending coalesce buffer is flushed first to preserve `seq` order).

---

### WebSocket message contract

The client author can rely on these EXACT shapes. Every server message carries a unique, monotonic `seq`.

**Client → server** (optional, as the FIRST message after connect):

```json
{ "lastSeq": 123 }
```

Omit it (or send a non-numeric value) for a fresh connect. If the client sends nothing within ~250ms, the server proceeds as a fresh connect.

**Server → client:**

```jsonc
// Snapshot — sent on a fresh or stale connect, before the live stream:
{ "type": "snapshot", "seq": 42, "entities": [ /* full records */ ], "aggregates": { /* ... */ } }

// Spawn — a new entity appeared; carries the FULL record:
{ "type": "spawn", "seq": 43, "entity": { /* full record */ } }

// Delta — partial update to an existing entity:
{ "type": "delta", "seq": 44, "entityId": "sess-…", "changes": { /* partial record */ } }

// Despawn — entity removed (SessionEnd, SubagentStop, or reaper):
{ "type": "despawn", "seq": 45, "entityId": "sess-…" }

// Aggregates — fleet-wide stats, pushed on the tick:
{ "type": "aggregates", "seq": 46, "aggregates": { /* see Fleet aggregates */ } }
```

**Signals.** A `delta`'s `changes` may carry a transient `signal` for one-shot client cues that are **not** persistent state:

```
"spawn" | "prompt" | "tool_start" | "tool_end" | "error" | "waiting" | "dim"
```

Persistent fields (`status`, `currentTool`, `currentToolFamily`, `errorCount`, `dimmed`, …) are the source of truth; `signal` is a hint the client may flash (e.g. a spark on `error`, a "receiving orders" turn on `prompt`).

The server never sends pixel coordinates — sprite type, deck/slot, and position are client-side concerns derived from the record.

### Reconnect / resync

- The server keeps a **ring buffer of the last 500** entity messages (`spawn` / `delta` / `despawn`), each tagged with its `seq`. Aggregates are not buffered (always recomputable).
- **Reconnect with `lastSeq` still covered by the buffer** → the server replays only the missed messages, then sends a fresh `aggregates`.
- **Fresh connect, or a `lastSeq` that predates the buffer** → the server sends a full `snapshot`.

### Files

| File | Responsibility |
|---|---|
| `server/index.js` | Entry point: Express app, `/ingest`, static mount, WS `/stream`, handshake/resync, tick coalescing, keepalive, banner. |
| `server/worldModel.js` | Authoritative reducer, entity records, seq counter, ring buffer, aggregates. Emits outbound messages. |
| `server/ingest.js` | Async ingest queue (off the request path). |
| `server/reaper.js` | Orphan reaper timer + thresholds. |
| `server/toolFamilies.js` | `tool_name` → visual family mapping. |

---

## Client

The canvas client lives entirely under `public/` and is served statically by the server at http://localhost:8080/.

### How to view

1. Start the server (`npm start`) so it serves `public/` and exposes `ws://localhost:8080/stream`.
2. Open http://localhost:8080/ in a browser.
3. With no server / no live agents the page shows a `CONNECTING…` banner and, after a few failed attempts, automatically falls back to **DEMO MODE** so you always see something.

The view is **non-interactive** — there are no keyboard shortcuts or on-screen controls. The HUD, legend, and per-session dialogue boxes are passive readouts that are always visible.

### Rendering: normalized circular aspect ratio

The scene is composed at a **fixed square logical resolution** (320×320 blocks → a 640×640 offscreen buffer) so the Death Star is a **true circle**, never a squashed ellipse. Each frame the scene buffer is blitted to the window-sized canvas with a **single uniform scale factor** = `min(winW/sceneW, winH/sceneH)`, centered, with **pillarbox / letterbox bars** of the space color (`#0b0b14`) filling the leftover. An integer scale is preferred for crispest pixels, falling back to a uniform float when an integer would waste too much of the window — always one factor for both axes, so the circle never distorts. Recomputed on every window resize. `imageSmoothingEnabled = false` keeps it nearest-neighbor at any scale.

### Resolution / look (16-bit pass)

Pushed from chunky 8-bit toward a richer SNES-era look while staying pixel-art (nearest-neighbor, no anti-aliasing): logical grid roughly doubled (320×320, smaller blocks); hull uses **5 shading bands** with a clean dark rim and subtle paneling/greeble seams on the lit arc; decks are 4-block layered slabs with edge lines and rivets; consoles have a bezel + recessed 2×2 screen with a blinking data pixel; the dish is a ringed focusing array. Sprites are **~2× larger** with added shading per the same Imperial palette.

### Sprite hierarchy — three explicit tiers

The sprite type for each entity is a deterministic, client-side choice (the server doesn't know about Vader vs trooper). Selection lives in `world.js#chooseSpriteType`; the sticky orchestrator tracking + in-place promotion live in `render.js`.

- **Tier 1 — Orchestrator session → DARTH VADER, or ROYAL GUARD if Vader is taken** (`vader` / `guard`, ~6×18). A session becomes an orchestrator the moment it has ≥1 subagent whose `parentSessionId === session.id`. This is **sticky**: render.js records the sessionId in an `orchestrators` list on the first subagent spawn/snapshot and the session keeps its orchestrator sprite for the rest of the run, even after every subagent despawns. Because orchestration is only known once a subagent appears, the session's humanoid sprite is **promoted in place**: same entityId, deck, slot, x, facing, and accent are kept — only `spriteType` swaps and the animation frame resets (no relocate, no respawn). **Only one Vader exists at a time** (`render.js#vaderHolder`): the first orchestrator becomes Vader; while a Vader already stands on a floor, the next orchestrator (on another floor) is promoted to a crimson **Imperial Royal Guard** instead. The Vader mantle is released when that Vader despawns (so a later orchestrator can take it) and on snapshot. The Vader sprite reads by silhouette: domed helmet with flared angular cheeks (mask), near-black armor `#1a1a1f`, a flowing cape `#101015` that hides the legs so he **glides** (no walk cycle), a chest control box (`#e23b3b` ×2 + `#7ec850` + `#3a78d6` pixels), and a thin red lightsaber (`#e23b3b` blade / `#ff6b6b` core) held low when idle and **raised in the `work` pose**. The Royal Guard (`guard`) is a conical red helmet (`#c23030`) with a dark visor slit over a floor-length crimson robe (`#a82828` with mid/shadow folds) that also **glides**, plus a tall force pike (`#7a7e8a`, silver tip `#cfd6e0`) held along its right side and lit in the `work` pose. Poses for both: idle, 2 glide frames, work, stumble.
- **Tier 2 — Regular session → Imperial Officer OR Stormtrooper** (`officer` / `trooper`), chosen by hashing `session_id` (stable across reconnects). The **gunner is retired from session selection** (sprite kept in code, never assigned). The window/session's identity rides on the single accent pixel (officer rank-badge / trooper pauldron) — each session has its own color, matching its floor.
- **Tier 3 — Subagent → Astromech OR KX-series security droid** (`astromech` / `kx`), chosen by hashing `agent_id` (falling back to `agentType`); ~2 in 3 are astromech, the rest KX. Astromech **rolls + bobs**; the new **KX-series security droid** (~6×16, K-2SO-style) is a tall lanky matte-black humanoid (`#222229`/`#1a1a1f`) with thin angular limbs, joint-shade pixels, and two lit photoreceptor eyes (`#c9d2e0`) — it **walks** with long stiff strides (idle upright, work reaches toward the console), accent pixel on the chest. The **protocol droid is retired from subagent selection** (sprite kept in code, never assigned). Droids still spawn beside their parent.

`gunner`, `protocol`, and `commander` sprites remain defined in `sprites.js` but are no longer assigned to any entity. The `guard` (Royal Guard) sprite IS assigned — to the second and later orchestrators.

### Demo / mock mode (`?demo=1` only)

Open http://localhost:8080/?demo=1 to run a self-contained mock that needs no server. A timer-driven generator emits real `snapshot` / `spawn` / `delta` / `despawn` / `aggregates` messages to exercise every code path and showcase the full hierarchy: the initial snapshot includes **two** orchestrators on **different floors** — the first → Vader (with both an astromech and a KX droid under it), the second → a Royal Guard (Vader already taken) — plus a few plain officer/trooper sessions; ticks then bias new subagents toward sessions that haven't orchestrated yet so you see **in-place Vader/Guard promotions**, and subagents despawn while their parent keeps its orchestrator sprite (sticky). Also covers walk-on, walk-to-console, all six tool families, rapid-flip bursts (debounce test), error/alert, and despawn/walk-off. Demo mode also auto-engages if the WebSocket can't connect after 3 tries. If a real server later goes LIVE, demo state is cleared and replaced by a real snapshot. There is **no key toggle** — demo is available only via the URL param.

### HUD

- Top-center: connection status (`CONNECTING…` / `LIVE` / `DEMO MODE`).
- Top-right: active sessions, droids, throughput, rolling error rate.
- Bottom-left: window legend (accent color → session name → floor).
- Bottom-right: per-session dialogue boxes (one per `session_id`), each with its own rolling Claude-style action lines.
- Over each sprite's head: a floating **action label** — the hybrid "&lt;Verb&gt; &lt;target&gt;" phrase the server derives from the in-flight tool (e.g. `Reading world.js`, `Running npm test`, `Delegating → searcher`). Idle crew read `Standing by` (dimmed); a failed tool flashes `⚠ tool failed` (red); subagents show `⟳ <agentType>`. Labels are crisp DOM text (`#labels` overlay) positioned each frame with the same uniform scale/offset as the canvas blit, so they track the pixel sprites at any zoom. Accent color tints each label's left border.

### Files

| File | Responsibility |
|------|----------------|
| `public/index.html` | Single static entry: one `<canvas>` + HUD/legend/per-session dialogue container DOM (no controls/CRT). |
| `public/style.css` | Fixed dark game palette, HUD styling. Canvas is sized in JS; no CSS stretch. |
| `public/world.js` | Config + palette, deterministic FNV-1a hashing, session→deck/accent (one floor per window, recycled on despawn), sprite→slot, sprite-type choice, family→screen-color, and the demo mock server. |
| `public/sprites.js` | Pixel-grid sprite definitions + `drawSprite` (fillRect blocks) for all roster types and poses (16-bit sized). |
| `public/station.js` | Builds the static cutaway ONCE to an offscreen canvas; computes deck geometry + console positions + dish + beam path. |
| `public/render.js` | Sprite/agent manager (state→motion, debounce, slots, walk-on/off, task animations), native-res scene compose + uniform-scale blit, `requestAnimationFrame` loop, resize handling. |
| `public/client.js` | WebSocket consumer with seq tracking + backoff reconnect, demo fallback, message dispatch, HUD/legend/per-session dialogue wiring. No interactivity. |

### Contract consumed

Matches the server contract above: connects to `ws://localhost:8080/stream`, sends `{ lastSeq }` on open (omitted first load), tracks the highest `seq` for reconnect, and handles `snapshot` / `spawn` / `delta` / `despawn` / `aggregates`. Honors the transient delta `signal` (`error` → stumble, `dim`/`dimmed` → sit/dim) and `project` as `{ key, name, path }`. Parsing is defensive: any field may be missing, `project` may be a string or object, batched arrays and unknown message types are tolerated.

### Spec features implemented

- Normalized **circular** rendering: fixed square scene scaled by a single uniform factor, centered, pillar/letterboxed; recomputed on resize.
- Two render layers: static station cached offscreen; per-frame work = compose dynamic sprites onto the scene buffer + one uniform-scale blit.
- Pixel crispness: `imageSmoothingEnabled = false` everywhere + CSS `image-rendering: pixelated`; sprite positions rounded to whole blocks.
- 16-bit cutaway: 5-band shaded hull ring with greebles + clean rim, dark interior, 5 deck floors clipped to the circle, room dividers with lit edges + doorways, ringed superlaser dish in the upper-LEFT firing eight green rays that converge on a pulsing focal node off the top-left corner (matching the LEGO cutaway), hangar shuttle wedge + lift shaft + crate stack, denser starfield. Imperial palette with extra shade steps.
- Three-tier sprite hierarchy (see *Sprite hierarchy* above): Tier 1 orchestrator → **Darth Vader** (or a **Royal Guard** if a Vader already holds another floor — one Vader at a time; sticky, promoted in place); Tier 2 session → officer/trooper; Tier 3 subagent → astromech/KX-series droid. Each has idle / 2 walk / work / stumble poses; Vader/Guard glide (saber raised / pike lit in work), astromech rolls + bobs, KX walks with stiff strides. Mouse droids remain as ambient life. Per-window accent = the single pauldron/badge/panel/chest pixel (subagents inherit their parent session's accent).
- Deterministic, collision-free placement: **one floor (deck) per window/session** (distinct decks by `session_id` hash + free-floor probe, stable across reconnects; fall back to sharing only when live sessions outnumber decks; decks recycle on despawn). Subagents share their parent session's floor. Each session→accent, and each sprite→slot by hash; per-deck slot cap with `+N` overflow marker.
- Snapshot places sprites directly in current state with NO walk-on; only `spawn` animates the walk-on.
- State→motion decoupled: server sets intent, the loop owns position/interpolation/walk cycle; rapid `working` flips debounced and pinned to the console (no ping-pong).
- Per-tool task animations: exec (screen blink), read (steady), edit (spark blocks), scan (screen sweep), delegate (droid beside parent); bezelled console screen lights in the tool-family color with a blinking data pixel.
- Error → stumble frame + red console sparks; error-rate spike → pulsing red hull-rim alert tint. Dim signal sits/dims the sprite.
- Fleet aggregate drives superlaser lens brightness + beam intensity.
- Passive HUD (sessions/droids/throughput/error rate), project legend, and per-session dialogue boxes.

### Deferred / simplified

- `+N` overflow is a small marker block (deck capacity is 9 before shrink); sprites don't yet shrink or wrap to a second row.
- Commander sprite is implemented and drawable but not auto-promoted to a role by default (reserved per spec; can be wired to the orchestrator session or global alert later).
- `spend` aggregate is unused (server always sends null; OTel not wired).
- CRT scanline overlay and all keyboard/UI toggles were removed per the no-interactivity requirement.
