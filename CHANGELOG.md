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
