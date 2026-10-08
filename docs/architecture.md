# Architecture

WSC observes Claude Code and draws it. It never sends anything back.

```
Claude Code sessions ──async hook──▶ plugin/hooks/forward.mjs ──POST 127.0.0.1:<port>/v1/events──┐
~/.claude/projects/**/*.jsonl ──────────────────── read by backfill ─────────────────────────────┤
demo script ─────────────────────────────────────────────────────────────────────────────────────┤
                                                                                                 ▼
                      main: source adapters → normalizer → StationEvent → store ──IPC snapshot/diff──▶ renderer
                                                                                                 │
                                          renderer: director (choreography) → scene (PixiJS) + panels (Preact)
```

## Source adapters

Every input comes in through an adapter. Each adapter emits raw records, and the normalizer turns them into `StationEvent`s.

| Adapter             | Input                                           | Where                                   |
| ------------------- | ----------------------------------------------- | --------------------------------------- |
| `claude-hooks`      | JSON bodies POSTed by the forwarder             | `src/main/server.ts`                    |
| `claude-transcript` | transcript JSONL files and subagent `meta.json` | `src/main/backfill.ts`                  |
| `demo`              | a scripted timeline of synthetic events         | `scripts/demo` and `src/shared/demo.ts` |

A future Codex adapter (reading `~/.codex/sessions/`) plugs in here without touching the store or the renderer.

**Rule: raw Claude Code formats are parsed only in `src/shared/normalizer.ts`.** Everything downstream sees only `StationEvent`. When Claude Code changes, fix that one file and update `docs/claude-code-integration.md`.

## Modules

### `src/shared` — pure TypeScript, no Electron or DOM imports, fully unit-tested

| Module              | Responsibility                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`          | `StationEvent`, `ToolCategory`, agent and project state types                                                               |
| `normalizer.ts`     | raw hook payloads and transcript lines → `StationEvent`; tolerant, never throws                                             |
| `toolCategories.ts` | tool name → category (`read`, `search`, `write`, `execute`, `web`, `delegate`, `plan`, `mcp`, `other`), plus user overrides |
| `projects.ts`       | cwd → `projectId` (sha256 prefix) and display name                                                                          |
| `store.ts`          | projects → sessions → agents; dedupe by id; out-of-order handling by `ts`; lifecycle                                        |
| `layout.ts`         | center table, lounge and zone placement in a stable order; growing desks (≥16 per zone, ≥6 zones)                           |
| `astar.ts`          | grid A* with a binary-heap open set                                                                                         |
| `bubbles.ts`        | bubble selection and per-agent and global rate limiting                                                                     |
| `redact.ts`         | sanitized tool summaries: basenames, truncated commands, secret patterns                                                    |

### `src/main` — Electron main process

| Module           | Responsibility                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`      | `POST /v1/events` and `GET /v1/health` on 127.0.0.1. Checks the token, rejects any `Origin` header, caps bodies at 256 KB |
| `runtimeFile.ts` | `{port, token, pid, version}` in app-data with mode 0600; removed on exit; stale files detected                           |
| `netGuard.ts`    | blocks every non-local request in the Electron session and denies permission requests                                     |
| `backfill.ts`    | reads transcripts when the app launches and when a session is first seen                                                  |
| `tray.ts`        | tray or menu-bar icon with a status dot                                                                                   |
| `windows.ts`     | normal and compact windows; persists size, position, mode and camera                                                      |

### `src/preload`

Exposes a minimal typed IPC bridge. The renderer is sandboxed and context-isolated.

### `src/renderer`

| Module      | Responsibility                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `scene/`    | PixiJS v8 stage: nearest-neighbor filtering, integer scale, pan and zoom camera, zones, furniture  |
| `director/` | maps state changes to choreography: which sprite plays which agent, its walks, reports and bubbles |
| `themes/`   | loads `themes/*/theme.json` (zod-validated), generates or loads sprites, switches theme live       |
| `panels/`   | Preact panels: projects, crew, activity log, settings, first-run screen                            |

The plugin lives in `plugin/`. It contains the forwarder, the `/station` skill and the launcher. See `docs/claude-code-integration.md`.

## Agent lifecycle

```
lounge_idle
  → assigned            (orchestrator delegates; catchphrase)
  → walking_to_zone     (A* from the lounge to a free desk in the agent's project zone)
  → working(category) ⇄ thinking
  → waiting_for_user    (walks to the center; highlighted until resolved)
  → reporting           (at the center table, facing the orchestrator)
  → walking_to_lounge   (task done) | walking_to_zone (more work)
  → lounge_idle
error → reporting (error bubble) → lounge_idle
stale (no events for 90 s by default) → "?" indicator, the agent stays where it is
```

- Agents report on finish, error and waiting.
- With report frequency set to `chatty`, they also report after each tool batch.
- When a session ends, all its agents report and return to the lounge, and the orchestrator seat empties after a delay.
- The lounge holds a pool of stand-in sprites, 6 by default. When more agents spawn than there are free sprites, extra crew arrive through the door, so every real agent is always shown.

## Truth beats animation

The store holds the truth. The director animates toward it. If events arrive faster than walks can play, the director shortens or skips walks; it never queues behind reality. Status icons, bubbles and panels always show the store's current state, even mid-walk. With reduce-motion on, agents snap to their positions instead of walking.

## Security and privacy

- The app binds only to 127.0.0.1, requires a token, and accepts no CORS.
- It makes no outbound requests; `netGuard` enforces this and a test covers it.
- It keeps only sanitized summaries of tool use and never writes event contents to disk. The one exception is an optional debug log, off by default.
