# CLAUDE.md — WSC (Work Space Claude)

WSC is an Electron desktop app that shows Claude Code agents as a 2D pixel-art crew on a station.

- The orchestrator sits at the center table.
- Idle crew wait in the lounge.
- Subagents walk out to the zone for their project, which is grouped by working directory.

It is fed by an async hook plugin and by transcript backfill. Repo: `OWNER/wsc`. License: MIT.

## Non-negotiables

- **Watch-only.** Never send prompts to Claude, never control agents, never edit user files.
- **Zero cost.** Never call any model API.
- **Local only.**
  - Bind to `127.0.0.1` only, with a token on every request, and reject any `Origin` header.
  - No outbound network, no telemetry, no analytics, no accounts.
- **Never slow down or alter Claude Code.** The hook forwarder:
  - runs async;
  - times out within 300 ms or less;
  - **always exits 0**;
  - **never writes to stdout or stderr**.
- **Privacy.**
  - Keep only the tool name and a sanitized summary from `src/shared/redact.ts`, in panels _and_ bubbles.
  - "Show full tool details" is off by default.
  - Never write event contents to disk, except the debug log, which is off by default.
- **2D pixel art only.**
  - No 3D or smooth vector looks; crisp integer scaling.
  - Art is generated in code or is original/CC0 art listed in `ASSETS_LICENSES.md`.
- **No Anthropic or Claude logos, trademarks or mascots**, and no third-party IP characters.

## Commands

```
npm install        # install deps
npm run dev        # run the app with hot reload
npm run demo       # run the app in scripted demo mode (two projects, live third zone)
npm run lint       # eslint + prettier check
npm run typecheck  # tsc --noEmit for node and web projects
npm test           # vitest unit tests
npm run test:e2e   # build + Playwright Electron smoke test
npm run build      # electron-vite build → out/
npm run package    # electron-builder → dist/ (dmg / nsis / AppImage)
```

## Architecture map

See `docs/architecture.md`; the Claude Code formats are documented in `docs/claude-code-integration.md`.

- `src/shared/` is pure TypeScript with no Electron or DOM imports. Every module has tests.
  - `types.ts`, `normalizer.ts`, `toolCategories.ts`, `projects.ts`, `store.ts`
  - `layout.ts`, `astar.ts`, `bubbles.ts`, `redact.ts`
- `src/main/` holds the main process: `server.ts`, `runtimeFile.ts`, `netGuard.ts`, `backfill.ts`, `tray.ts`, `windows.ts`.
- `src/preload/` is the typed IPC bridge. The renderer is sandboxed with contextIsolation on.
- `src/renderer/` holds `scene/` (PixiJS), `director/` (choreography), `themes/` (loader and generator) and `panels/` (Preact).
- `plugin/` is the Claude Code plugin:
  - `.claude-plugin/plugin.json`
  - `hooks/hooks.json` and `hooks/forward.mjs`
  - `skills/station/SKILL.md`
  - `scripts/launch.mjs`
- The marketplace manifest is at `.claude-plugin/marketplace.json` and points to `./plugin`.
- `themes/<id>/` holds `theme.json` plus assets. The built-in themes are `spaceship` (default), `office`, `home` and `terminal`.

**Rule:** raw Claude Code hook and transcript formats are parsed **only** in `src/shared/normalizer.ts`. Everything else consumes `StationEvent`.

**Rule:** truth beats animation. The store is the source of truth, and the director shortens or skips walks rather than lag behind it.

## Conventions

- TypeScript `strict`.
  - TypeScript is **pinned to 6.0.x**, because typescript-eslint does not support TS 7.
  - Don't bump it until typescript-eslint supports TS 7.
- Put logic in `src/shared` with Vitest tests next to it under `tests/`. Keep Electron and Pixi code thin.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`) and small PRs.
- Update `CHANGELOG.md` (Keep a Changelog format) for user-visible changes.
- Update `docs/` whenever behavior changes.
  - Hook format changes require updating `docs/claude-code-integration.md`, including the verified version.
- Dependencies must be minimal, well known, and permissively licensed (MIT-compatible).

## How to add…

- **A tool → category mapping:**
  1. Add it to `src/shared/toolCategories.ts`.
  2. Add a test case.
  3. Unknown tools must keep falling back to `other`.
- **A hook event:**
  1. Register it in `plugin/hooks/hooks.json`, as an async command hook running the same `forward.mjs`.
  2. Handle it in `src/shared/normalizer.ts` and add tests with a **synthetic** payload.
  3. Document its fields in `docs/claude-code-integration.md`.
- **A theme:** follow `docs/themes.md`. The theme folder holds `theme.json` and assets. The manifest is zod-validated, and a broken theme falls back to the default theme.
- **Catchphrases:** edit `phrases.<moment>` in the theme's `theme.json`. Each moment is a list, and one entry is picked at random.

## Testing

- `npm run lint && npm run typecheck && npm test` must pass before every commit.
- Required coverage:
  - every event kind;
  - unknown tools;
  - malformed input;
  - dedupe;
  - out-of-order events;
  - two concurrent projects;
  - redaction in both panels and bubbles;
  - no outbound network.
- Check visual changes with `npm run demo`. It covers two projects, a waiting agent, an error and a third zone added live.
- Test fixtures must be **synthetic**: use `/home/user/...` paths, fake ids and fake output.

## Never

- Commit real transcripts, real usernames or home paths, tokens, or secrets.
- Add network calls or telemetry, or bind to anything other than `127.0.0.1`.
- Add stdout or stderr output, or a non-zero exit code, to `plugin/hooks/forward.mjs`.
- Parse raw Claude Code formats outside the normalizer.
- Add dependencies with non-permissive licenses, or art you can't license.
- Overwrite a user's `~/.claude/settings.json`. Merge into it, or tell the user what to change.
