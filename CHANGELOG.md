# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
