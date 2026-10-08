# Contributing to WSC

Thanks for helping! Bug fixes, features, docs and themes are all welcome. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

**Using Claude Code to contribute?** [CLAUDE.md](CLAUDE.md) is written for it. It covers the architecture map, the non-negotiable rules (watch-only, local-only, privacy, hooks never alter Claude Code) and how to add tools, hook events and themes.

## Dev setup

Requirements: Node.js 20.19+ (CI uses 24) and git. Claude Code is only needed to test hooks live.

```sh
git clone https://github.com/OWNER/wsc && cd wsc
npm install
npm run dev     # app with hot reload, live mode
npm run demo    # app playing the scripted two-project demo (ignores real hooks)
```

npm 11 may report blocked install scripts (esbuild, electron-winstaller). Nothing needs them: esbuild ships prebuilt platform packages, and Electron downloads its binary on first run.

To point a real Claude Code session at your dev build:

```sh
claude --plugin-dir ./plugin
```

## Scripts

| Script                         | What                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `npm run dev`                  | electron-vite dev server + app                                                    |
| `npm run demo`                 | same, in pinned demo mode                                                         |
| `npm run lint`                 | ESLint + Prettier check (`npm run format` fixes formatting)                       |
| `npm run typecheck`            | `tsc --noEmit` for the node and web projects                                      |
| `npm test`                     | Vitest unit tests (`tests/*.test.ts`)                                             |
| `npm run test:e2e`             | build + Playwright Electron tests (smoke, demo, network)                          |
| `npm run build`                | typecheck + production build into `out/`                                          |
| `npm run package`              | electron-builder for the current OS into `dist/`                                  |
| `node scripts/record-demo.mjs` | re-record `docs/media/demo.gif` and the theme screenshots (after `npm run build`) |

## Proposing a feature

Open a **Feature request** issue first for anything bigger than a small fix, so we can agree on scope before you build. Ideas that send prompts to Claude, call model APIs, add network access or add telemetry are out of scope by design. Check the roadmap in the README.

## Pull request checklist

- [ ] `npm run lint && npm run typecheck && npm test` pass (CI runs them on macOS, Windows and Linux).
- [ ] New logic lives in `src/shared` (pure TypeScript) with Vitest tests. Electron and Pixi code stays thin.
- [ ] Raw Claude Code formats are parsed only in `src/shared/normalizer/`.
- [ ] Visual changes are checked with `npm run demo`. Include a screenshot or GIF in the PR.
- [ ] No real transcripts, usernames, home paths, tokens or tool output in fixtures. Use synthetic `/home/user/...` data.
- [ ] No new network calls. `tests/noNetwork.test.ts` will fail if you add one.
- [ ] New dependencies are small, well known and MIT-compatible (MIT, ISC, BSD, Apache-2.0).
- [ ] `CHANGELOG.md` (Unreleased) is updated for user-visible changes, and docs are updated when behavior changes.
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`…).

## Submitting a theme

Themes are the easiest way to contribute. Read the [theme guide](docs/themes.md) and start from the [minimal example](docs/examples/minimal-theme).

1. **Folder:** `themes/<your-theme-id>/` with `theme.json` and, if you use hand-made art, its PNG sprite sheets. The id is lowercase letters, digits, `-` or `_`.
2. **Validate:** install it into your app-data `themes/` folder and switch to it with `/station theme <id>`. An invalid manifest shows a warning banner listing the exact errors.
3. **Cover every state:** your theme must provide every animation and every tool category's gear, and have catchphrases for every moment. The schema enforces this.
4. **Preview:** add a `preview.png` screenshot of the theme in demo mode (`npm run demo`) to the folder.
5. **License:**
   - Set `license` and `author` in `theme.json`.
   - Art must be your own original work, or CC0 / MIT-compatible with attribution.
   - Add an entry to [ASSETS_LICENSES.md](ASSETS_LICENSES.md).
   - No characters, logos or art from games, films or other IP, and no Anthropic or Claude branding.
6. Open a PR using the **Theme submission** issue/PR template.

Community themes can also live in your own repo. Open a PR adding a link to the README's "Community themes" section.

## Releasing (maintainers)

1. Bump `version` in `package.json` and `plugin/.claude-plugin/plugin.json`, and move `CHANGELOG.md` Unreleased to the new version.
2. Tag `vX.Y.Z` and push the tag. `.github/workflows/release.yml` builds macOS (arm64 + x64), Windows and Linux artifacts and uploads them to a draft GitHub release.
3. Review the draft and publish it.

Builds are unsigned. The workflow has commented placeholders for signing secrets.
