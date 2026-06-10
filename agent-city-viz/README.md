# Agent City

Real-time **isometric city visualization** of Claude Code agents. Every tool call Claude completes is one unit of construction work: buildings rise lot by lot, top out, and new lots break ground. The city is **persistent** — the skyline keeps growing across server restarts, for as long as you keep using Claude Code.

- **Sessions** appear as construction workers (hard hat, vest tinted by district).
- **Orchestrator sessions** (ones that spawn subagents) become the foreman (white hat, clipboard).
- **Subagents** are crew members working beside their parent.
- **Projects** (cwd) are districts — each gets its own city block(s).
- **Tool failures** cause incidents: smoke and fire on the construction site.
- Tool activity chirps into speech bubbles above workers and the Chirper feed panel.

## Run

```bash
npm install      # express + ws (already in package.json)
npm start        # node server/index.js   -> http://localhost:8080/
npm run dev      # node --watch ...
```

Demo without live sessions: `http://localhost:8080/?demo=1` (also the automatic fallback when the server is unreachable). Demo never touches the save file.

### Environment variables

| Var | Default | Effect |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listen port. |
| `DEBUG` | _(off)_ | Set `1`/`true` for verbose logging (payloads, reaper, resync, saves). |

## Server

The event server ingests Claude Code hook events, folds them into an in-memory world model (live entities) plus a persistent **city model** (districts/lots/buildings), and streams both to the canvas client over WebSocket. The browser is a stateless view.

### Endpoints

- `POST /ingest` — accepts a hook JSON payload. **Returns `202` immediately**; all reduction is async so Claude Code hooks are never blocked. Malformed bodies are tolerated and dropped.
- `GET /health` — `{ ok, entities, seq, buildings, underConstruction, districts }`.
- `WS /stream` — the live stream (contract below).
- `GET /` — serves the static client from `public/`.

### Hook configuration

Register HTTP hooks in `~/.claude/settings.json` pointing every lifecycle event (SessionStart/End, UserPromptSubmit, Pre/PostToolUse, PostToolUseFailure, SubagentStart/Stop, Notification, Stop) at `http://localhost:8080/ingest`. The server dispatches on `hook_event_name`. If the server isn't running, hooks fail fast and Claude Code is unaffected.

### Persistence

City state is saved to `data/city.json` (git-ignored):

```jsonc
{ "version": 1, "savedAt": 0, "districts": [{
    "key": "/path/to/project", "name": "project", "index": 0,
    "blocks": [0],                  // global spiral block slots
    "hue": 212, "totalWork": 0, "totalIncidents": 0, "completedCount": 0,
    "lots": [{
      "id": "d0:0", "index": 0, "block": 0, "parcel": 0,
      "state": "construction",      // | "complete"
      "progress": 12, "required": 30,
      "building": { "seed": 123, "tier": 1, "floors": 2, "footprint": [1, 1] },
      "startedAt": 0, "completedAt": null, "incidents": 0
    }]
}]}
```

Writes are debounced (5s, max 30s) and atomic (tmp + rename); `SIGINT`/`SIGTERM` flush synchronously. A corrupt or wrong-version save is quarantined to `city.json.bak-<ts>` and the city starts fresh — a bad save can never crash ingest.

### Growth tuning (server/city.js `TUNING`)

| Knob | Value | Meaning |
|---|---|---|
| `WORK_PER_TOOL` | 1 | work units per successful `PostToolUse` |
| required(n) | `min(400, 30 + 15n)` | work to finish a district's n-th building |
| tier(n) | `min(5, 1 + n/4)` | height class; floors 1–2 / 3–6 / 7–12 / 12–22 / 20–40 |
| footprint | t1–3 `[1,1]`, t4 `[1,2]`, t5 `[2,2]` | tiles inside the lot's 2×2 parcel |
| `LOTS_PER_BLOCK` | 9 | 3×3 parcels per 8×8-tile block |

Retuning only affects future lots; persisted progress is never invalidated.

## WebSocket contract

Client → server (optional first message): `{ "lastSeq": <n> }`.

Server → client (every message carries a monotonic `seq`):

```jsonc
// entity stream (unchanged from the original viz)
{ "type": "snapshot",  "entities": [...], "aggregates": {...} }
{ "type": "spawn",     "entity": {...} }
{ "type": "delta",     "entityId": "...", "changes": { ..., "signal": "tool_start|tool_end|error|..." } }
{ "type": "despawn",   "entityId": "..." }
{ "type": "aggregates","aggregates": { ..., "city": { "buildings": 1, "underConstruction": 1, "districts": 1 } } }

// city stream (additive)
{ "type": "city",      "city": { "version": 1, "districts": [...] } }   // full snapshot, EVERY handshake
{ "type": "cityDelta", "districtKey": "...", "district": { /* meta, on non-progress events */ },
  "lot": { /* full lot record — idempotent apply */ },
  "event": "progress" | "groundbreak" | "complete" | "incident" }
```

City messages are **never** replayed from the resync ring buffer; reconnects always receive a fresh `city` snapshot after the entity snapshot/replay.

## Client (`public/`)

Vanilla JS, no build step. Crisp flat-shaded vector isometric on Canvas 2D (devicePixelRatio-aware). Load order: `config.js` → `iso.js` (projection/spiral/camera) → `citymodel.js` (mirror + layout solver) → `buildings.js` (procedural buildings + sprite cache) → `effects.js` → `citizens.js` → `bubbles.js` → `render.js` → `demo.js` → `client.js`.

- Camera auto-fits the growing city; drag to pan, wheel to zoom (auto-fit resumes after 30s idle).
- Depth sorting: painter's algorithm on south-anchor keys; citizens walk only on a block's perimeter road ring, never inside parcels — the invariant that keeps multi-tile towers sorting correctly.
- Buildings are cached per `(lot, stage, zoomBucket)` offscreen canvases; ground (roads/grass) is a static layer rebuilt only when blocks appear.
- Construction stages: excavation → foundation → floors rising (scaffold + animated crane) → topping-out confetti → complete (windows lit).

_The original Death Star design lives in git history; `../agent-viz-spec.md` documents that earlier spec and is historical._
