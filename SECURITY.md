# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately via GitHub's **Security → Report a vulnerability** on https://github.com/Jaber-ja2314817/WSC. Include the WSC version, OS and Claude Code version, plus steps to reproduce. We aim to acknowledge reports within a week.

Only the latest release is supported with security fixes.

## Security model

WSC is a local, watch-only viewer. Its design goal is that running it can't leak your data, can't be driven by other software, and can't change what Claude Code does.

### Local only

- The ingest server binds to **127.0.0.1 only** and never to `0.0.0.0` or a LAN address.
- **A random token is generated on every launch** and written to a runtime file in the OS app-data folder (`runtime.json`, mode `0600`, deleted on exit). Every request must carry it in the `x-wsc-token` header; the comparison is constant-time.
- **Requests carrying an `Origin` header are rejected** (403), and there are no CORS headers, so web pages in your browser can't talk to the app even though it's on localhost.
- **Bodies are capped at 1 MiB.** Malformed input is rejected without crashing.
- **The app makes no outbound network requests.** Every Electron session blocks non-local requests and denies permission requests. The renderer runs sandboxed and context-isolated, with a strict CSP (no eval, no remote origins). `tests/noNetwork.test.ts` (static scan) and `tests/e2e/network.spec.ts` (live app) enforce this.
- There is no telemetry, crash reporting, update check, analytics or account.

### Hooks never change Claude Code

The hook forwarder (`plugin/hooks/forward.mjs`) is a dependency-free Node script.

- It **never writes to stdout or stderr** and **always exits 0**. For some events, Claude Code feeds hook stdout into the model's context and treats exit code 2 as "block"; a viewer must never do either.
- It has a hard 300 ms deadline, and exits immediately if the app isn't running.
- It only POSTs to `127.0.0.1` on the port from the runtime file, over `node:http` with no agent, so proxy settings such as `NODE_USE_ENV_PROXY` can't redirect the token or the payload. It sends nothing if the process recorded in that file is gone.
- **Auto-launch:** on `SessionStart` only, when the app isn't running, it reads `hook_event_name` and `source` from the payload and starts the app detached, from `launch.json` (written by the app itself, mode `0600`). The `SessionStart` payload is passed on the app's command line (`--hook-payload`, base64url, ≤ 16 KB), so it is visible in the local process list for as long as WSC runs; it holds the session id, working folder and transcript path, never prompt text. A failed launch appends one line (time and error code) to `hook-errors.log`.

### Privacy

- **Kept:** the tool name and a short sanitized summary — a file basename, a URL hostname, or a truncated command with tokens, keys, passwords, `Authorization` and cookie headers, private keys and URL credentials redacted. Subagent labels are redacted the same way. This applies to the side panel and the speech bubbles. "Show full tool details" is off by default and still redacts.
- **Never kept:** prompt text, tool output and assistant messages. The one opt-in exception is `showPromptPreview` (off by default): a redacted, 120-character preview of the latest typed prompt, kept in memory only.
- **On disk:** WSC writes only `settings.json`, `window-state.json`, `state.json` (a "has received events" flag and the last plan usage numbers), the runtime file, `launch.json` (how to start the app), and themes you install; the hook writes `launching.json` (a timestamp) and, on failure, `hook-errors.log`. It never writes event contents to disk.
- **Transcripts:** they are read locally and incrementally (only appended bytes), never modified. WSC keeps token counts, model ids, git branch names, timestamps and the same sanitized tool summaries as for hooks — all in memory.
- **Tests:** `tests/privacy.test.ts` pushes realistic secrets through both the hook path and the transcript path into the snapshot and the director's bubbles, and asserts none of them survive.

Redaction is pattern-based and can't catch every possible secret format. If you find one that slips through, please report it as a vulnerability.
