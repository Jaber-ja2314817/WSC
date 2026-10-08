## What & why

<!-- What does this change, and why? Link the issue if there is one. -->

## How it was tested

<!-- Unit tests, `npm run demo`, live Claude Code sessions… Screenshots/GIFs for visual changes. -->

## Checklist

- [ ] `npm run lint && npm run typecheck && npm test` pass
- [ ] Logic in `src/shared` has tests; raw Claude Code formats are only parsed in `src/shared/normalizer/`
- [ ] Fixtures are synthetic (no real transcripts, paths, usernames, tokens or tool output)
- [ ] No new network calls, telemetry or non-permissive dependencies
- [ ] `CHANGELOG.md` and docs updated for user-visible changes
- [ ] Theme PRs: preview screenshot, `license`/`author` in `theme.json`, `ASSETS_LICENSES.md` entry for any non-generated art
