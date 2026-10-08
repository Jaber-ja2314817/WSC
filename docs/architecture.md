# Architecture

WSC observes Claude Code and draws it. It never sends anything back to Claude Code.

```
Claude Code sessions ──hook──▶ plugin/hooks/forward.mjs ──POST 127.0.0.1:<port>/v1/events──┐
~/.claude/projects/**/*.jsonl ─────────────── read by backfill ────────────────────────────┤
demo script ───────────────────────────────────────────────────────────────────────────────┤
                                                                                            ▼
          main: adapters → normalizer → StationEvent → StationStore ──IPC snapshot (≤10/s)──▶ renderer
                                                                                            │
                     renderer: layout → director (choreography) → scene (PixiJS) + panels (Preact)
```

## Source adapters

Every input comes in through an adapter. Adapters emit raw records, and the normalizer turns them into `StationEvent`s.

| Adapter             | Input                                           | Where                                           |
| ------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `claude-hooks`      | JSON bodies POSTed by the forwarder             | `src/main/server.ts` → `src/main/station.ts`    |
| `claude-transcript` | transcript JSONL files and subagent `meta.json` | `src/main/backfill.ts`                          |
| `demo`              | a scripted timeline of synthetic events         | `src/shared/demoScript.ts` → `src/main/demo.ts` |

A future Codex adapter (reading `~/.codex/sessions/`) plugs in here without touching the store or the renderer.

**Rule: raw Claude Code formats are parsed only in `src/shared/normalizer/`** (`hook.ts` and `transcript.ts`). Everything downstream sees only `StationEvent`. Both normalizers produce the same dedupe ids (for example `${session}:tool:${toolUseId}:start`), so a tool call reported by a hook and by a transcript counts once. When Claude Code changes, fix the normalizer and update `docs/claude-code-integration.md`.

## Modules

### `src/shared`: pure TypeScript, no Electron, Node or DOM imports, unit-tested

| Module              | Responsibility                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`          | `StationEvent`, `ToolCategory`, agent, session and project state, and `StationSnapshot`                                                  |
| `normalizer/`       | `hook.ts` handles hook payloads; `transcript.ts` handles transcript lines and subagent meta. Both are tolerant and never throw           |
| `toolCategories.ts` | tool name → category, with user overrides. Unknown tools map to `other`                                                                  |
| `redact.ts`         | sanitized tool summaries (basenames, hostnames, truncated and redacted commands) for panels and bubbles                                  |
| `projects.ts`       | working directory → stable `projectId` (12-hex FNV-1a hash) and a display name (folder basename)                                         |
| `store.ts`          | `StationStore`: projects → sessions → agents. Dedupe, out-of-order handling, stale and lost signals, capped activity log                 |
| `layoutTypes.ts`    | layout contract, in tiles                                                                                                                |
| `layout.ts`         | `computeLayout`: center table, lounge, and project zones in stable slots (N, E, S, W, then diagonals and a second ring), desks that grow |
| `astar.ts`          | grid A* with a binary heap, plus `makePathfinder` with an LRU cache                                                                      |
| `bubbles.ts`        | `BubbleQueue`: per-crew and global rate limits, priorities, stacking                                                                     |
| `themeSchema.ts`    | zod schema for `theme.json` and `validateTheme`                                                                                          |
| `settings.ts`       | settings schema and defaults                                                                                                             |
| `demoScript.ts`     | the scripted demo run, covering two projects with a third added live                                                                     |
| `ipc.ts`            | IPC channel names and the `window.wsc` API type                                                                                          |

### `src/main`: Electron main process

| Module           | Responsibility                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`       | app lifecycle, single-instance lock, IPC handlers, and startup args (`--demo`, `--compact`, `--theme=`)                                         |
| `station.ts`     | wires the server, backfill and demo into the store; throttles snapshot pushes; owns the live and demo modes                                     |
| `server.ts`      | `POST /v1/events`, `POST /v1/command` and `GET /v1/health` on 127.0.0.1. Requires the token, rejects any `Origin` header, caps bodies at 256 KB |
| `runtimeFile.ts` | `{port, token, pid, version}` in app-data with mode 0600; written atomically and removed on exit                                                |
| `netGuard.ts`    | cancels every non-local request in the Electron session and denies all permission requests                                                      |
| `backfill.ts`    | rebuilds recent sessions from transcripts at launch and when a session is first seen                                                            |
| `appState.ts`    | stores only the `hasReceivedEvents` flag that drives the first-run screen                                                                       |
| `settings.ts`    | the settings JSON file in app-data                                                                                                              |
| `userThemes.ts`  | loads community themes from the app-data `themes/` folder                                                                                       |
| `tray.ts`        | tray or menu-bar icon with a status dot                                                                                                         |
| `windows.ts`     | normal and compact windows; remembers bounds and mode                                                                                           |
| `demo.ts`        | `DemoPlayer`: plays `demoScript` into the station on timers and loops it                                                                        |

### `src/preload`

Exposes a minimal typed IPC bridge as `window.wsc`. The renderer is sandboxed and context-isolated, and its CSP forbids eval and remote origins.

### `src/renderer`

| Module        | Responsibility                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main.ts` | bootstrap: Pixi app with nearest scaling, theme, director, scene and panels. Recomputes the layout only when its inputs change                               |
| `director/`   | `Director`: maps snapshots to choreography (lounge pool, desk assignment, report trips, bubbles). Has no Pixi imports and is unit-tested                     |
| `scene/`      | `StationScene` and `Camera`: cached floor and wall layers, y-sorted props and crew, nameplates, bubbles, tooltips, and pan/zoom with integer zoom levels     |
| `themes/`     | theme runtime, loader and manager; pure pixel buffers and a crew generator; per-theme generators (`generators/*.ts`); sprite-sheet support for hand-made art |
| `panels/`     | Preact panels: projects, crew, activity log, first-run setup and settings                                                                                    |

The Claude Code plugin is in `plugin/`. It holds the hooks, the forwarder, the `/station` skill and the launcher. The marketplace manifest is at `.claude-plugin/marketplace.json`, with `source: "./plugin"`. See `docs/claude-code-integration.md`.

## Agent lifecycle

```
lounge_idle
  → assigned            (subagent spawned: a free lounge sprite takes its identity; catchphrase)
  → walking_to_zone     (A* to a free desk in the agent's project zone)
  → working(category) ⇄ thinking
  → waiting             (walks to the center to report; highlighted until resolved, then back to the desk)
  → reporting           (at a report spot facing the command table)
  → walking_to_lounge   (done or error) → lounge_idle
stale (no events for 90 s)  → "no signal" indicator; the agent stays where it is
lost  (stale for 15 min)    → treated as done; the sprite returns to the lounge
```

- **Report frequency:**
  - `minimal`: only errors and waits walk to the center.
  - `normal`: done, error and wait.
  - `chatty`: also a short report every few tool calls.
- **Orchestrators:** each session's lead agent has its own seat at the command table, labeled with the project name.
- **Lounge pool:** 6 sprites by default. When more agents spawn than there are free sprites, extra crew arrive through the door, so every real agent is always represented.
- **Layout shifts:** the layout is recomputed when projects, desk counts or sessions change. Absolute tile positions can then shift, but positions relative to the center stay stable. The director offsets sprites and the scene offsets the camera, so nothing visibly jumps; only the new zone unfolds.

## Truth beats animation

The store holds the truth, and the director animates toward it.

- Each crew sprite's status, tool and elapsed time always mirror the latest snapshot, even mid-walk.
- If the state changes during a walk, the sprite retargets.
- Long walks are sped up to about 4 s at most.
- Bursts of state changes snap instead of queueing behind reality.
- With reduce-motion on, agents snap to their destinations.

## Security and privacy

See `SECURITY.md` for the full model. In short:

- **Local only.** The app binds to 127.0.0.1 with a per-launch token and accepts no CORS. Requests that carry a browser `Origin` header are rejected.
- **No outbound traffic.** `netGuard` blocks it in every Electron session. `tests/noNetwork.test.ts` and `tests/e2e/network.spec.ts` cover this.
- **Sanitized summaries only.** The app keeps tool names and summaries from `redact.ts`; user prompts and tool output are never stored. `tests/privacy.test.ts` checks the snapshot and the director's bubbles against a set of secrets.
- **Hooks never change Claude Code.** The forwarder never prints and always exits 0. It is async on every event except `Stop` and `SessionEnd`, which must be synchronous so headless runs report their end. Those two cost about 20 ms when the app is closed.
