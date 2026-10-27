# Troubleshooting

Start with `/station status` in Claude Code. It tells you whether the app is running, which port it listens on, and how many events it has received.

## Nothing shows up on the station

1. **Is the app running?** If `/station status` says `WSC: not running.`, run `/station`. If it says the app wasn't found, install it (see [SETUP.md](../SETUP.md#3-download-and-install-the-app)) or set `WSC_APP_PATH` to its location.
2. **Is the plugin enabled?** Run `/plugin` and check that **wsc** is installed and enabled, then run `/reload-plugins`. Hooks only attach to sessions started _after_ the plugin was installed, so restart long-running sessions.
3. **Does Node run for Claude Code?** The forwarder is `node …/forward.mjs`. In the same shell you start Claude Code from, run `node --version`; it must be 20 or newer. If you use a version manager (nvm, fnm, volta), make sure a default version is set for non-interactive shells.
4. **Are hooks disabled?** Look for `"disableAllHooks": true` in `~/.claude/settings.json`, `.claude/settings.json` or `.claude/settings.local.json`.
5. **Try the demo:** `/station demo`. If the demo animates, the app is fine and the problem is the hook path. Use **Test connection** on the first-run screen.

## "Test connection" fails

- **"The runtime file does not point at this app"** means another WSC instance, or a crashed one, left a runtime file behind. Quit every WSC instance and start it again. The file lives at:
  - macOS: `~/Library/Application Support/WSC/runtime.json`
  - Windows: `%APPDATA%\WSC\runtime.json`
  - Linux: `~/.config/WSC/runtime.json`
- **Port in use:** WSC prefers `47821`. If something else holds that port, it picks a free one and writes it to the runtime file, and the hooks follow automatically. You can set a different preferred port in Settings; it applies on the next launch.
- **Firewall or VPN software:** some security tools block even `127.0.0.1` traffic. Allow WSC and Node on localhost.

## Port in use

WSC prefers port `47821` on `127.0.0.1`. If another program holds it, WSC picks a free port and writes it to `runtime.json`; the hooks read that file on every event, so nothing else needs changing. To find out who holds the port:

```sh
lsof -nP -iTCP:47821 -sTCP:LISTEN        # macOS / Linux
netstat -ano | findstr 47821             # Windows
```

You can change the preferred port in Settings. It applies on the next launch.

## Hooks don't fire

- **Plugin edits apply to new sessions.** Installed from a local folder (`/plugin marketplace add ./path/to/wsc`), Claude Code reads `plugin/` straight from that folder: edits take effect at the next session start or after `/reload-plugins` (verified on 2.1.308). Installed from GitHub, it runs from a cache copy in `~/.claude/plugins/cache/…`: run `claude plugin marketplace update wsc && claude plugin update wsc@wsc`, then start a new session.
- **Check what is registered:** type `/hooks` in Claude Code. Every WSC event should list `node …/hooks/forward.mjs`.
- **`disableAllHooks`:** `"disableAllHooks": true` in any settings file (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` or managed settings) turns off every hook, WSC's included.
- **Without the plugin:** run `npm run hooks:install` in a WSC checkout. It merges the same hooks into `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`; pass `-- --settings <path>` for another file), keeps every other setting and hook, and writes a `settings.json.wsc-backup-YYYYMMDD-HHMMSS` copy first. `npm run hooks:uninstall` removes only the WSC entries: hook handlers whose command or arguments point at a `plugin/hooks/forward.mjs` file.

## Stale runtime or lock files

WSC keeps a few small files in its app folder (`~/Library/Application Support/WSC` on macOS, `%APPDATA%\WSC` on Windows, `~/.config/WSC` on Linux):

| File              | Written by                                          | If it is stale                                                                                                                                                          |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.json`    | the app while it runs (`port`, `token`, `pid`)      | Left behind by a crash. Harmless: the hook finds nothing listening and, on `SessionStart`, starts the app, which rewrites the file. Safe to delete while WSC is closed. |
| `launching.json`  | the `SessionStart` hook, right before it starts WSC | Blocks further auto-launches for 15 s so parallel sessions start the app only once. Older markers are ignored and replaced. Safe to delete.                             |
| `launch.json`     | the app on every start (how to start it again)      | Points at a moved or deleted app: the hook ignores it. Start WSC once by hand to rewrite it.                                                                            |
| `hook-errors.log` | the hook, only when an auto-launch fails            | One line per failure (time and error code, never event contents), capped at 64 KB. Safe to delete.                                                                      |

## WSC doesn't start when a session starts

When WSC isn't running, the `SessionStart` hook starts it in the background (the terminal keeps focus) and hands it the new session so it shows up right away.

- **Start WSC once by hand.** The hook finds the app through `launch.json`, which the app writes when it starts. Without it the hook falls back to the usual install locations (`/Applications/WSC.app`, `%LOCALAPPDATA%\Programs\WSC`, `~/Applications/WSC*.AppImage`, `wsc` on `PATH`) and `WSC_APP_PATH`.
- **Read `hook-errors.log`** in the app folder (table above). `autolaunch: app not found` means none of the above pointed at an existing app.
- **Is it turned off?** `WSC_AUTOLAUNCH=0` in the environment Claude Code runs in disables it, and so does turning off the launch-on-session-start setting (`launchOnSessionStart: false` in the app folder's `settings.json`). The focus-on-session-start setting (`focusOnSessionStart`) brings the window to the front instead of opening it in the background.
- **Just started another session?** A launch within the last 15 s blocks new ones (`launching.json`).
- Only new sessions trigger it, and only when the plugin's or installed hooks run (see [Hooks don't fire](#hooks-dont-fire)).

## Every event shows up twice

Claude Code runs plugin hooks and `settings.json` hooks separately, so having both the **wsc** plugin enabled and hooks installed with `npm run hooks:install` (or pasted from the first-run screen) sends each event twice. WSC drops most exact duplicates, but keep only one: either disable the plugin, or run `npm run hooks:uninstall`. The installer refuses to install while `enabledPlugins["wsc@wsc"]` is `true` in the same file, unless you pass `--force`.

## Agents show up on the wrong project

- Projects are grouped by the folder Claude Code **was started in**, taken from the hook's `cwd`. Starting Claude Code in a subfolder creates a separate zone for that subfolder.
- A session that `cd`s elsewhere keeps its original zone. This is on purpose, so crew don't jump between zones mid-task.
- Two sessions in the same folder share one zone. Each still gets its own orchestrator seat at the table.

## An agent is stuck at its desk / shows "no signal"

- **"No signal"** means no events have arrived for that agent for 90 s. Long thinking or a slow command can cause it. It clears when the next event arrives.
- **Lost agents:** after 15 minutes of silence, a subagent is treated as finished and walks back to the lounge. This can happen if its session was closed in a way that sent no final event.
- **Restored sessions:** these are rebuilt from transcripts when the app starts, and transcripts don't record a session ending. A finished session can therefore keep its orchestrator seat until it goes idle.

## The station looks blurry

- WSC uses integer zoom levels for crisp pixels. Press `0` (Fit all) or zoom with `+` and `-` to snap back to a crisp level.
- If your OS display scaling is fractional (for example 125% on Windows), some blur is unavoidable at certain zoom levels. Try another zoom level.

## A community theme doesn't load

An invalid theme falls back to Spaceship and shows a banner listing the errors, for example `palette.accent: must be a #rrggbb color`. Fix those fields in `theme.json` and switch to the theme again. See [docs/themes.md](themes.md).

## macOS says the app is damaged or can't be opened

The builds aren't code-signed yet. Right-click WSC, choose **Open**, then **Open** again. If that doesn't work:

```sh
xattr -dr com.apple.quarantine /Applications/WSC.app
```

## Windows SmartScreen blocks the installer

Click **More info**, then **Run anyway**. Only do this for installers downloaded from the official releases page.

## Linux AppImage won't start

```sh
chmod +x WSC-*.AppImage
./WSC-*.AppImage
```

Some distributions need FUSE (`libfuse2`) to run AppImages.

## Does WSC slow Claude Code down?

No. Every hook runs asynchronously, so Claude Code never waits for it, except `Stop` and `SessionEnd`. Those two run once per turn and once per session, and take about 20 ms when the app is closed, because the forwarder exits as soon as it finds no runtime file. To pause WSC completely, quit the app, or set `"disableAllHooks": true` temporarily.

## Still stuck?

Open a [bug report](https://github.com/OWNER/wsc/issues/new/choose). Include your OS, the WSC version and the Claude Code version. Don't paste real transcripts or tokens; demo-mode screenshots are ideal.
