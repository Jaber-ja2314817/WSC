# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately via GitHub's **Security → Report a vulnerability** on https://github.com/OWNER/wsc. Include the WSC version, OS and Claude Code version, plus steps to reproduce. We aim to acknowledge reports within a week.

Only the latest release is supported with security fixes.

## Security model

WSC is a local, watch-only viewer. Its design goal is that running it can't leak your data, can't be driven by other software, and can't change what Claude Code does.

### Local only

- The ingest server binds to **127.0.0.1 only** and never to `0.0.0.0` or a LAN address.
- **A random token is generated on every launch** and written to a runtime file in the OS app-data folder (`runtime.json`, mode `0600`, deleted on exit). Every request must carry it in the `x-wsc-token` header; the comparison is constant-time.
- **Requests carrying an `Origin` header are rejected** (403), and there are no CORS headers, so web pages in your browser can't talk to the app even though it's on localhost.
- **Bodies are capped at 256 KB.** Malformed input is rejected without crashing.
- **The app makes no outbound network requests.** Every Electron session blocks non-local requests and denies permission requests. The renderer runs sandboxed and context-isolated, with a strict CSP (no eval, no remote origins). `tests/noNetwork.test.ts` (static scan) and `tests/e2e/network.spec.ts` (live app) enforce this.
- There is no telemetry, crash reporting, update check, analytics or account.

### Hooks never change Claude Code

The hook forwarder (`plugin/hooks/forward.mjs`) is a dependency-free Node script.

- It **never writes to stdout or stderr** and **always exits 0**. For some events, Claude Code feeds hook stdout into the model's context and treats exit code 2 as "block"; a viewer must never do either.
- It has a hard 300 ms network timeout, and exits immediately if the app isn't running.
- It only POSTs to `127.0.0.1` on the port from the runtime file.

### Privacy

- **Kept:** the tool name and a short sanitized summary — a file basename, a URL hostname, or a truncated command with tokens, keys, passwords, `Authorization` headers and URL credentials redacted. This applies to the side panel and the speech bubbles. "Show full tool details" is off by default and still redacts.
- **Never kept:** prompt text, tool output and assistant messages.
- **On disk:** WSC writes only `settings.json`, `state.json` (a single "has received events" flag), the runtime file, and themes you install. It never writes event contents to disk.
- **Transcripts:** they are read locally, only to restore agents that were already running when the app started. WSC never modifies them.
- **Tests:** `tests/privacy.test.ts` pushes realistic secrets through both the hook path and the transcript path into the snapshot and the director's bubbles, and asserts none of them survive.

Redaction is pattern-based and can't catch every possible secret format. If you find one that slips through, please report it as a vulnerability.
