# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Live dashboard** in the left column of the station window, sharing state with the station:
  - usage window: tokens across all sessions, reset countdown, burn rate, projected total,
    weekly total, and % bars once you set `windowTokenLimit` / `weeklyTokenLimit`. Totals count
    input + output + cache write; cache reads (re-reads of cached context) are shown separately;
  - session cards: status (working, waiting for you, idle, ended), project, git branch, models,
    current step, duration, tokens and subagents;
  - session detail: workflow timeline and token breakdown per model;
  - tokens per hour for the last 24 h, stacked by project;
  - selecting a session card selects its orchestrator on the station, and vice versa.
- **Live transcript watching:** `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) is read
  incrementally, so sessions appear and update even without hooks. Startup reads the last
  `lookbackDays` (default 7) for usage totals.
- **Auto-launch:** the `SessionStart` hook starts WSC in the background when it isn't running and
  hands it the new session; a running WSC just shows the new session. Settings
  `launchOnSessionStart` (on) and `focusOnSessionStart` (off), env `WSC_AUTOLAUNCH=0`.
- **Live plan usage bars via a status line bridge:** `npm run statusline:install` /
  `statusline:uninstall` add WSC's status line script to `~/.claude/settings.json` (with a backup,
  idempotent; an existing status line is chained and restored on uninstall). It forwards only the
  session id and `rate_limits` (5-hour and 7-day used % and reset times) to the local app.
  The dashboard shows them at the top like the Claude app ("Current session 42% used · resets
  in 2h 14m", "Weekly · all models"), with amber from 75 % and red from 90 %. The collapsed
  rail shows both as vertical bars. The last numbers are kept across restarts; `npm run demo`
  shows sample bars.
- `npm run hooks:install` / `hooks:uninstall`: merge WSC's hooks into `~/.claude/settings.json`
  (with a backup, idempotent) or remove only them, for setups without the plugin.
- New settings: `lookbackDays`, `idleMinutes`, `usageWindowHours`, `windowTokenLimit`,
  `weeklyTokenLimit`, `showPromptPreview` (off), `prices` (empty), `dashboardOpen`.
- Panels and the dashboard now follow the active theme's full palette.

- Right-click a project zone → **Remove from station** hides it and its crew. Older events and
  transcript backfill stay hidden; new activity in that folder brings the zone back.

### Changed

- **Much lighter on CPU and battery.** The station redraws at 30 fps only while something
  moves, at 4–10 fps when the scene is still, and not at all while the window is hidden or
  minimized (before: two to three loops at the display's full refresh rate). While hidden, the
  app also stops building station and dashboard updates. Idle CPU dropped from ~11 % to ~3 %
  with the window visible, and to ~0.4 % hidden.
- **Token numbers rise after this update.** Agents started by a workflow were never counted, so
  every total was too low for anyone using workflows. The dashboard now includes them; the higher
  numbers are the correct ones.
- Only a new or resumed session auto-launches WSC. `/clear` or a compaction in an open session no
  longer brings back an app you quit, and a compaction no longer steals focus or logs a new
  session.
- Plan usage bars merge per window: a later reset wins, then the higher usage, so an idle session
  can't pull a bar back to old numbers.
- A "waiting for you" card goes idle after 24 h of silence.
- Past 8 sessions, orchestrators stand around the command table instead of stacking on one seat.
- `/station demo` now behaves the same whether or not the app was open: it runs until real work
  starts, and the turn that asked for it no longer ends it. `--demo` stays pinned for `npm run demo`.
- Launch at login is hidden on Linux, where it had no effect.
- Requires macOS 13 or newer, as Electron 44 does; the docs said 12.

### Fixed

- Token usage and the hourly chart no longer split a project into fake ones (`src`,
  `agent-a27…`) when a session `cd`s into a subfolder or a subagent runs in a worktree: usage
  stays with the project the session started in.
- A session card with many subagents shows four chips and "+N" instead of a long list.
- A new project zone unfolds again when it appears (it used to pop in).
- A finished subagent no longer flips back to "thinking" when its hand-back result is written.
- Two quick turns in a row stay two prompts and two turn ends on the timeline.
- After a restart, a resumed session no longer takes the original session's tokens. A response
  repeated in several sessions' transcripts is credited to the oldest one.
- A subagent that ends without a hand-back shows as done after 10 quiet minutes, instead of
  staying "stale".
- Right after startup, sessions update live while the history scan is still running (it used
  to wait for the whole scan).
- An idle session card stops counting its duration at the last activity.
- WSC now really exits when it gets `SIGTERM` (`kill`, logout). Before, it removed its runtime
  file but kept running without a server, so hooks and auto-launch could not reach it.
- A typed prompt reported by both the hook and the transcript counts once.

- A project zone no longer grows each time a new agent joins. Crew sit at its free desks, and
  the zone adds space only when every seat is taken. Finished agents no longer count.
- **Packaged builds crashed at startup:** `zod` wasn't bundled into the main process, so an
  installed WSC died before opening a window. A test now fails if the main bundle imports anything
  but `electron` and `node:*`.
- **Hand edits to `settings.json` were lost** on the next in-app change, and a typo in the file
  reset everything. Saves now re-read the file, a file that can't be parsed is kept as
  `settings.json.corrupt-<timestamp>` with a banner, and invalid `prices` stay on disk.
- `/station theme <id>` with the app closed now applies and persists the theme. An unknown id gets
  an error instead of a false "switched", and a theme copied in while WSC runs appears without a
  restart.
- Subagents continued with `SendMessage` can finish again, instead of sitting at a desk for 15
  minutes. Other finish races are gone too: hook and transcript copies of one event, and a late
  hand-back reviving a finished subagent.
- A parallel tool's end, or the tool's own late `PreToolUse`, no longer clears a pending permission
  wait.
- A turn cancelled with Esc reads as your turn, instead of "thinking" until the idle timeout.
- A compaction mid-turn no longer shows "Your turn" or adds "Turn finished".
- Turn ends no longer appear twice in the timeline, and lead steps stay in the timeline of a session
  with hundreds of agents.
- Usage from older Claude Code that streamed `output_tokens` is no longer undercounted, and a short
  `lookbackDays` no longer shrinks the weekly total after the first hour.
- Hour labels are right in half-hour timezones.
- Sessions removed from the station stay gone after a late event, and closing Claude Code no longer
  brings back a removed zone. "Clear idle" also clears those rows from the activity log.
- A session seen for the first time lands in the zone it started in, even after a `cd`.
- The 10 s rescan no longer stalls the app on large histories, which could make hook events time out.
- Lines written during the startup scan reach the station, real sessions no longer leak into a
  demo, the demo no longer grows memory over days, and it no longer raises real notifications.
- **Station floor:** an agent no longer waits at the door beside a free desk. Crew keep their seats
  when a room grows, and removing a project leaves the other zones in place. Orchestrators no longer
  share a seat with seats free. Lowering the lounge size no longer loses sprites or leaves ghost
  desks. Floors survive a lost WebGL context.
- **Camera:** dragging during a zoom no longer leaves a blurry fractional zoom, and the view stays
  on the station when the world shrinks.
- Saved window positions keep the title bar on a display and fit the screen, and an unusual theme
  can no longer stop the render loop or boot.
- The AppImage records its real path, so auto-launch can find it.
- Installers write through a symlinked `settings.json` instead of replacing the link.
- Large hook payloads (up to 1 MiB) are no longer dropped, and `autolaunch: app not found` is logged
  on a fresh install.
- Windows: paths with spaces in source checkouts, and bash-syntax status lines when chained.

### Security

- **Redaction was much too narrow.** It now covers quoted JSON keys, cookies, all `Authorization`
  schemes, connection strings, credential flags, more token formats (temporary AWS keys, GitLab,
  Stripe, Slack, npm, JWTs), PEM private keys and base64 secrets. Subagent labels were not redacted
  at all and now are.
- The hook forwarder, status line bridge and launcher no longer use `fetch`, so
  `NODE_USE_ENV_PROXY` can't send the token and raw hook payloads to a proxy.
- Nothing is sent to a port whose recorded WSC process is dead, so a stale runtime file can't hand
  the token to whatever took that port over.
- Updated `zod` to 4.6.7 (GHSA-mrhx-c7xc-m3w5).

## [0.1.0] - 2026-10-08

First release. Verified against Claude Code 2.1.294.

### Added

- Electron + TypeScript + PixiJS skeleton with a sandboxed renderer, strict CSP and a
  network guard that blocks every non-local request.
- Claude Code integration research (`docs/claude-code-integration.md`) and architecture notes.
- Event pipeline: silent hook forwarder (always exits 0), token/origin-checked ingest server on
  127.0.0.1, runtime file, hook + transcript normalizers, state store, transcript backfill.
- Claude Code plugin manifest and marketplace manifest with 17 hook registrations.
- Station scene (PixiJS): generated pixel-art Spaceship theme, command table, crew lounge, project
  zones that appear live, pan/zoom/fit camera, nameplates with status counts, tooltips.
- Crew director: lounge → assignment → desk → report → lounge choreography, catchphrase and status
  bubbles with rate limiting, reduce-motion support; status always mirrors real state.
- Side panels (projects, crew, filterable activity log), first-run setup screen, demo mode.
- `/station` skill (`/station`, `compact`, `theme <name>`, `demo`, `status`) and launcher.
- Office, Home and Terminal themes (all generated pixel art, each with its own catchphrases); theme
  loader with zod validation and fallback, live switching, user/community themes folder with dev
  hot-reload, `docs/themes.md` and an installable example theme.
- Settings (panel + `settings.json`), compact always-on-top floating mode, tray icon with an
  idle/working/needs-input dot, optional native notifications, remembered window/camera/theme,
  reduce-motion following the OS, launch at login, custom tool → category mappings.
- Privacy tests that push realistic secrets through the hook and transcript paths into the
  snapshot and speech bubbles; redaction now also covers `curl -u user:pass` and `--password <v>`.
- No-network guarantees: static scan of all sources plus an end-to-end test against the live app.
- Packaging (electron-builder: macOS dmg arm64/x64, Windows NSIS, Linux AppImage; plugin shipped
  inside the app) and a tag-triggered release workflow (unsigned builds).
- README with demo GIF and themes gallery, SETUP guide, CONTRIBUTING, SECURITY, Code of Conduct,
  asset licenses, troubleshooting, issue/PR templates, and `scripts/record-demo.mjs`.
- `CLAUDE.md` contributor guide, CI (lint, type-check, tests, build) and a Playwright smoke test.
