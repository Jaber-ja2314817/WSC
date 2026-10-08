# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Electron + TypeScript + PixiJS skeleton with a sandboxed renderer, strict CSP and a
  network guard that blocks every non-local request.
- Claude Code integration research (`docs/claude-code-integration.md`) and architecture notes.
- Event pipeline: silent hook forwarder (always exits 0), token/origin-checked ingest server on
  127.0.0.1, runtime file, hook + transcript normalizers, state store, transcript backfill.
- Claude Code plugin manifest and marketplace manifest with 17 hook registrations.
- `CLAUDE.md` contributor guide, CI (lint, type-check, tests, build) and a Playwright smoke test.
