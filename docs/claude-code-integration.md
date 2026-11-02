# Claude Code integration

**Verified against:** Claude Code **2.1.294**, on 2026-10-08 (live). Re-checked for **2.1.308** on 2026-10-22: hook event names and fields against the docs, transcript shapes locally (§7). Live hook run on 2.1.308: see §8.
**Sources:**

- Official docs at `code.claude.com/docs`: `hooks`, `hooks-guide`, `plugins/*`, `skills`, `sub-agents`, `memory`, `statusline` (§11, 2026-11-02).
- Local inspection of transcript file _shapes_: keys and types only, no content.

Facts are tagged by where they come from:

- **[docs]** comes from the official docs.
- **[observed]** was seen locally on 2.1.294.
- **[decision]** is our own choice.

This file is the contract for `src/shared/normalizer.ts`. That is the only code that parses raw Claude Code formats. When Claude Code changes, update this file and the normalizer together.

---

## 1. Hook events we subscribe to

| Event                        | Why                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`               | Seat the orchestrator and create or reuse the project zone. `source` is one of `startup`, `resume`, `clear`, `compact` or `fork`. [docs]                            |
| `SessionEnd`                 | Every agent reports in, then the seat empties. `reason` is one of `clear`, `resume`, `logout`, `prompt_input_exit` or `other`. The default timeout is 1.5 s. [docs] |
| `UserPromptSubmit`           | The orchestrator wakes up (`user_prompt`). We never read `prompt`; `prompt_id` keys the event so the transcript's copy of the same prompt dedupes.                  |
| `PreToolUse`                 | `tool_start` with a category.                                                                                                                                       |
| `PostToolUse`                | `tool_end` with `ok: true`.                                                                                                                                         |
| `PostToolUseFailure`         | `tool_end` with `ok: false`. If `is_interrupt` is false, the bubble shows an error. [docs]                                                                          |
| `PostToolBatch`              | "Chatty" report frequency: the agent reports after each batch. [docs]                                                                                               |
| `PermissionRequest`          | `waiting_for_user`.                                                                                                                                                 |
| `PermissionDenied`           | Clears the waiting state; the bubble shows the denial.                                                                                                              |
| `Notification`               | `waiting_for_user` for the types listed in §4; otherwise ignored.                                                                                                   |
| `SubagentStart`              | `agent_spawn`. A lounge sprite takes the agent's identity.                                                                                                          |
| `SubagentStop`               | `agent_finish`. The agent reports, then returns to the lounge.                                                                                                      |
| `Stop`                       | The orchestrator goes `idle`.                                                                                                                                       |
| `StopFailure`                | `agent_error` on the orchestrator. `error` holds values such as `rate_limit` or `overloaded`. [docs]                                                                |
| `PreCompact` / `PostCompact` | `compacting` starts and ends.                                                                                                                                       |
| `CwdChanged`                 | Recorded only. See §3.                                                                                                                                              |

Events we deliberately skip: `Setup`, `UserPromptExpansion`, `MessageDisplay`, `InstructionsLoaded`, `ConfigChange`, `DirectoryAdded`, `FileChanged`, `Worktree*`, `*ModelSwitch`, `Elicitation*`, `Task*` and `TeammateIdle`. Adding one means changing `plugin/hooks/hooks.json`, then the normalizer, then this file.

## 2. Fields we read

Every event carries these common fields [docs]: `session_id`, `transcript_path`, `cwd`, `hook_event_name`.

- `permission_mode` and `prompt_id` are also present on most events.
- `agent_id` and `agent_type` are present **only when the hook fires inside a subagent**.

| Event                    | Extra fields read                                                                       | → `StationEvent.kind`            |
| ------------------------ | --------------------------------------------------------------------------------------- | -------------------------------- |
| SessionStart             | `source`                                                                                | `session_start`                  |
| SessionEnd               | `reason`                                                                                | `session_end`                    |
| UserPromptSubmit         | `prompt_id` (id only; the prompt text is ignored)                                       | `user_prompt`                    |
| PreToolUse               | `tool_name`, `tool_input` (summarized and redacted), `tool_use_id`                      | `tool_start`                     |
| PostToolUse              | `tool_name`, `tool_use_id`, `duration_ms`                                               | `tool_end` (ok)                  |
| PostToolUseFailure       | `tool_name`, `tool_use_id`, `is_interrupt` (the error text is dropped)                  | `tool_end` (not ok)              |
| PostToolBatch            | `tool_calls[].tool_name` / `tool_use_id`                                                | batch marker (no kind; internal) |
| PermissionRequest        | `tool_name`, `tool_input` (summarized)                                                  | `waiting_for_user`               |
| PermissionDenied         | `tool_name`, `tool_use_id`                                                              | `tool_end` (not ok)              |
| Notification             | `notification_type` (we never show `message`)                                           | `waiting_for_user`, or ignored   |
| SubagentStart            | `agent_id`, `agent_type`                                                                | `agent_spawn`                    |
| SubagentStop             | `agent_id`, `agent_type`, `agent_transcript_path` (`last_assistant_message` is dropped) | `agent_finish`                   |
| Stop                     | `stop_hook_active`                                                                      | `idle`                           |
| StopFailure              | `error` (only the enum value)                                                           | `agent_error`                    |
| PreCompact / PostCompact | `trigger`                                                                               | `compacting` / `idle`            |
| CwdChanged               | `old_cwd`, `new_cwd`                                                                    | none (logged only)               |

Unknown events, unknown fields and malformed payloads are ignored, never thrown.

How tool-use ids are handled:

- `tool_use_id` is the dedupe key between hook events and transcript events. The id format is `${sessionId}:${agentId}:${tool_use_id}:${phase}`.
- Each tool use needs a separate start and end id, so the phase is part of the key.

Synthetic example of a PreToolUse from inside a subagent:

```json
{
  "session_id": "s-0001",
  "transcript_path": "/home/user/.claude/projects/-home-user-demo/s-0001.jsonl",
  "cwd": "/home/user/demo",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "agent_id": "a1b2c3",
  "agent_type": "Explore",
  "tool_name": "Read",
  "tool_input": { "file_path": "/home/user/demo/src/auth.ts" },
  "tool_use_id": "toolu_01EXAMPLE"
}
```

## 3. Attribution

**Which agent?**

- `agent_id` present: the event belongs to that subagent. Its `parentAgentId` is `orchestrator`, and its label is `agent_type`. [docs]
- `agent_id` absent: the event belongs to the session's lead agent, `agentId = "orchestrator"`. [docs]
- We never guess from timing. If an event cannot be attributed, it goes to the orchestrator.

**Which project?**

- `projectId` is the first 12 hex characters of `sha256(realpath(cwd))`. The display name is `basename(cwd)`. [decision]
- Two sessions in the same folder share a zone; a new folder creates a new zone.
- The project is fixed at the session's first event.

**CwdChanged** [decision]:

- The session **stays in its original project zone**.
- Moving the crew between zones whenever someone runs `cd` in the middle of a task would be noisy and misleading.
- A later event with a different `cwd` in the same session also stays in the original zone.

## 4. Waiting-for-user detection

These set `waiting_for_user` on the attributed agent:

- `PermissionRequest`
- `Notification` where `notification_type` is one of `permission_prompt`, `idle_prompt`, `agent_needs_input` or `elicitation_dialog` [docs]

The next of these events on the same agent clears it: `PreToolUse`, `PostToolUse*`, `PermissionDenied`, `UserPromptSubmit`, `Stop` or `SubagentStop`.

Other notification types, such as `auth_success` and the `quota_*` types, are ignored.

## 5. Hook type: async command hook

Decision: use **`type: "command"`** with **`"async": true`**, running `node "${CLAUDE_PLUGIN_ROOT}/hooks/forward.mjs"`.

**Exception, verified live:** `Stop` and `SessionEnd` are **synchronous**, with `timeout: 2`. In headless runs (`claude -p`), the process exits before async hooks for the final turn get to run, so the last `Stop` and the `SessionEnd` never arrived. Run synchronously, they arrive reliably. The cost is one Node start per turn end: about 20 ms measured with the app closed, because the forwarder exits as soon as it finds no runtime file. `tests/hooksConfig.test.ts` pins this split.

- **async** [docs]: the hook runs in the background, so Claude Code never waits on it. This is the strongest "never slow Claude Code down" guarantee.
- **Why not `type: "http"`?** HTTP hooks exist [docs], but their `url` is static config. Our port can fall back from 47821 to a free port, and the token changes on every launch; both live in the runtime file. HTTP headers can only interpolate environment variables named in `allowedEnvVars`, so they cannot read a file.
- **Forwarder contract**, regardless of async:
  - It is dependency-free Node.
  - It has a ≤300 ms request timeout.
  - It **always exits 0** and **never writes to stdout or stderr**.
  - If the runtime file is missing or the connection fails, it exits immediately.

**Why the forwarder never prints** [docs]:

- On exit 0, stdout from `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion` and `PostModelSwitch` is **added to Claude's context**.
- JSON on stdout is **parsed as a decision** on many events.
- Exit 2 **blocks** `PreToolUse`, `Stop`, `PreCompact` and others.
- Any output could change what Claude does. A watch-only tool must never do that.

## 6. Plugin layout

Verified against the docs [docs]:

```
.claude-plugin/
  marketplace.json    # { name: "wsc", owner: {name}, plugins: [{ name: "wsc", source: "./plugin" }] }
plugin/
  .claude-plugin/plugin.json   # { "name": "wsc", "version", "description", "license": "MIT", ... }
  hooks/hooks.json             # { "hooks": { "<Event>": [ { "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/forward.mjs\"", "async": true } ] } ] } }
  hooks/forward.mjs
  skills/station/SKILL.md      # /station skill (commands are merged into skills)
  scripts/launch.mjs
```

How the plugin is located and loaded:

- A relative `source` resolves from the marketplace root, the directory that contains `.claude-plugin/`. Paths containing `..` are rejected.
- `${CLAUDE_PLUGIN_ROOT}` is the absolute path of the installed plugin version. Quote it in commands.

Install steps:

- `/plugin marketplace add OWNER/wsc`, then `/plugin install wsc@wsc`.
- From a shell: `claude plugin marketplace add OWNER/wsc && claude plugin install wsc@wsc`.

Local development: `claude --plugin-dir ./plugin`. After editing, run `/reload-plugins`.

**`/station` namespacing caveat** [docs; to be **verified live in M4**]:

- Plugin skills are invoked as `/plugin-name:skill-name`, so the canonical command is **`/wsc:station`**.
- The skill leaves model invocation on, so "open the station" also works.
- If bare `/station` does not resolve, document an optional user-level skill at `~/.claude/skills/station/SKILL.md` that wraps the plugin script.

**Manual install (no plugin):**

- Merge the same event map into `~/.claude/settings.json` under `"hooks"`.
- Use an absolute path to `forward.mjs` instead of `${CLAUDE_PLUGIN_ROOT}`.
- Never overwrite the user's file.
- `"disableAllHooks": true` turns all hooks off temporarily. [docs]

## 7. Transcript layout (used for backfill, live watching and usage)

```
~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl                          # main thread  [docs+observed]
~/.claude/projects/<sanitized-cwd>/<sessionId>/subagents/agent-<id>.jsonl     # subagent     [docs+observed]
~/.claude/projects/<sanitized-cwd>/<sessionId>/subagents/agent-<id>.meta.json # subagent meta [observed]
```

**`<sanitized-cwd>`** [observed]: the absolute cwd with `/` replaced by `-`, for example `-home-user-demo`. Prefer the `transcript_path` from hook input over building this path.

**`meta.json` keys** [observed]: `agentType`, `description`, `toolUseId`, `spawnDepth`, `worktreePath`, `spawnedWithWorktree`, `worktreeBranch`, `requestShape`, `requestNonInteractive`.

- `toolUseId` links the subagent to the parent's `Agent` / `Task` tool_use.

**JSONL line keys** [observed]: `type`, `uuid`, `parentUuid`, `timestamp` (ISO), `sessionId`, `agentId` (subagent files only), `cwd`, `isSidechain`, `version`, `message`.

- `type` is one of `user`, `assistant`, `attachment` or `system`.
- `message.content` is a string, or an array of blocks typed `text`, `thinking`, `tool_use` (`id`, `name`, `input`) or `tool_result` (`tool_use_id`, `is_error`).
- Compaction appears as `{"type":"system","subtype":"compact_boundary"}`. [docs]
- Many other `type`s exist and are ignored, e.g. `mode`, `permission-mode`, `file-history-snapshot`, `last-prompt`, `ai-title`, `api-request*`, `queue-operation`, `cost-state`. [observed 2.1.308]

**Fields used by the dashboard** [observed 2.1.308, undocumented — the docs describe only `transcript_path`]:

- `assistant` lines: `requestId`, `message.id`, `message.model`, `message.stop_reason`, `gitBranch`, and `message.usage` with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` (plus nested `cache_creation`, `server_tool_use` and others we ignore).
- **One API message is written once per content block** (up to 5 lines seen), each with the same `message.id` + `requestId` and identical `usage`. Usage is counted once per `${message.id}:${requestId}`. Records with model `<synthetic>` or all-zero usage are skipped.
- `user` lines carry `promptId` on every line of a turn, including tool results. A **typed prompt** is a `user` line whose `isMeta` isn't true, whose `promptSource` isn't `system` (values seen: `typed`, `system`, absent), and whose content is a string or text blocks only. It becomes `user_prompt` with id `${sessionId}:prompt:${promptId}`, which matches the hook's `prompt_id` id.
- Subagent files carry the parent `sessionId`, so their usage counts toward the parent session.

**Behavior to rely on:**

- Transcripts are **written asynchronously and may lag** behind hooks. [docs]
- Subagent transcripts survive compaction of the main conversation and are deleted after `cleanupPeriodDays`, which defaults to 30. [docs]

**Parser rules:**

- Skip any line that fails `JSON.parse` or has an unknown `type`.
- Never throw.
- Read only the fields needed for state; never retain message text. The opt-in `showPromptPreview` setting keeps a redacted, 120-character preview of the latest typed prompt in memory.
- Startup reads files changed within `lookbackDays`; files older than 24 h go through a usage-only fast path that skips any line without `"usage"` before decoding it. After that only appended bytes are read.

## 8. Verified live (Claude Code 2.1.294, 2026-10-08)

Setup: two headless `claude -p --plugin-dir ./plugin` sessions ran at the same time in two temp folders. Each spawned one `general-purpose` subagent that ran `Read` and `Bash(ls)`.

1. **Subagent `session_id` is the parent's.** Every event from inside a subagent carried the parent session id and parent `transcript_path`.
2. **`agent_id` has no `agent-` prefix**, e.g. `a72ab8f117ab00edb`. That is the same string as the transcript `agentId` and the `agent-<id>.jsonl` file name. The prefix-stripping stays as a safety net.
3. **Subagents run in the background.** The orchestrator's `PostToolUse` for `Agent` fires about 10 ms after `SubagentStart`, and its `Stop` can fire while the subagent is still working. A subagent is finished only on `SubagentStop`, never on the `Agent` tool's end.
4. **The hand-back is a tool.** Subagents end by calling a `SubagentHandback` tool (mapped to `delegate`). A `UserPromptSubmit` with no user typing then fires on the orchestrator as the result is delivered.
5. **`PostToolBatch` also fires inside subagents**, with `agent_id`. It is ignored for now.
6. **Project attribution:** the two folders produced two projects, and all 34 events landed in the right one.
7. **`/station` resolves without the namespace.** With the plugin loaded, both `/station status` and `/wsc:station status` ran the skill and printed the launcher's one line. Bare `/station` stops working only if another skill named `station` exists.
8. **Backfill quirks seen on real data:**
   - Transcript file mtimes can be recent while every record is months old, so recency is judged by record timestamps.
   - Finished subagents always end with a `SubagentHandback` call.
   - A subagent silent for 10 minutes or more is treated as finished (the live transcript watcher waits 60 minutes while one of its tool calls has no result yet).
   - The hand-back call's own `tool_result` is written after the subagent finished; it must not turn the subagent back to "thinking".
   - A resumed (or background) session's transcript repeats earlier history with the same `message.id` + `requestId` under its own `sessionId`; the usage is credited to the session whose transcript file was created first.
   - In the store, an agent stale for 15 minutes or more is marked done ("lost signal"), so it never occupies a desk forever.
   - A session that `cd`s keeps its original zone; later events carry the new `cwd`, and the store pins them to the session's first project.
9. **Backfill:** transcripts never record a session end. An orchestrator `assistant` record with `stop_reason: "end_turn"` is mapped to `idle`, so closed sessions don't stay "thinking".

## 9. Open questions

1. Do nested subagents (`spawnDepth` > 1) report a parent agent id? For now their parent is `orchestrator`.
2. `PermissionRequest` and `Notification` were not exercised by the headless run, since `-p` mode never prompts. They need an interactive check.
3. Field drift between versions. Re-verify this file on each Claude Code minor upgrade and note the version at the top.

## 10. Auto-launch on `SessionStart` [decision]

- The forwarder reads `hook_event_name` and nothing else from the payload. When it is `SessionStart` and the app isn't running (no runtime file, or the POST is refused), it starts the app detached and exits; it still never prints and always exits 0. Measured: about 30 ms including Node startup.
- **Where the app is:** `launch.json` in the app folder, written by the app on every start (`{version, command, args, macBundle?}`). Fallbacks: `WSC_APP_PATH`, the usual install locations, then a source checkout. On macOS a bundle is started with `open -g` so the terminal keeps focus.
- **Arguments:** `--from-hook --hook-payload=<base64url of the raw SessionStart JSON>` (omitted above 16 KB). The app feeds the payload through `normalizeHookPayload` like any other hook, so the session shows up before its transcript exists. `--from-hook` keeps the window from taking focus unless `focusOnSessionStart` is on.
- **One instance:** a `launching.json` marker blocks a second launch for 15 s (older markers are stale and replaced), and Electron's single-instance lock forwards a racing launch's argv to the running app.
- **Opt out:** setting `launchOnSessionStart: false` or env `WSC_AUTOLAUNCH=0`.

## 11. Status line bridge: real plan usage [docs; verified against the docs on 2026-11-02]

The plan usage the Claude app shows (the 5-hour and 7-day limits) is not in hooks or transcripts. Claude Code only hands it to the **status line** command, as part of the JSON object it pipes to that command's stdin on every status line refresh. The status line is therefore the only local source of the real plan %. Plugins can't define a status line, so `npm run statusline:install` puts `plugin/statusline/statusline.mjs` into the user's `settings.json` (`scripts/install-statusline.mjs`, merge logic in `scripts/statusline-settings.mjs`).

Fields we read from the status line input (everything else is ignored and never leaves the script):

| Field                                   | Type                           | Notes                                                         |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| `session_id`                            | string                         | Passed through when it is a string.                           |
| `rate_limits`                           | object                         | Absent for non-subscribers and before the first API response. |
| `rate_limits.five_hour.used_percentage` | number, 0–100                  | Each window may be absent.                                    |
| `rate_limits.five_hour.resets_at`       | number, Unix epoch **seconds** |                                                               |
| `rate_limits.seven_day.used_percentage` | number, 0–100                  |                                                               |
| `rate_limits.seven_day.resets_at`       | number, Unix epoch **seconds** |                                                               |

- **What is sent** [decision]: when `rate_limits` is an object, `POST http://127.0.0.1:<port>/v1/limits` with `x-wsc-token` and body `{"session_id": "…", "rate_limits": {…}}` (`session_id` omitted when missing). `rate_limits` is passed as is; the app validates it. Nothing else from the input is sent. No `rate_limits` → no request. WSC not running → nothing happens; the bridge never launches the app.
- **Contract** (like the hook forwarder): node builtins only, never writes to stderr, always exits 0, 250 ms POST timeout and a 300 ms hard deadline.
- **Chaining an existing status line** [decision]: Claude Code runs one status line command. If the user already has one, the installer rewrites it to `node "<script>" --then <base64url of the original command>` and keeps the other keys (`padding`, `refreshInterval`, …). The bridge runs the original command through the shell with the same stdin bytes, concurrently with the POST, and prints its stdout (the only stdout the bridge ever writes); its stderr is discarded. The command gets 3 s; on timeout or a spawn error the bridge prints nothing. Without `--then` the bridge prints nothing, so installing it alone leaves an empty status line. `npm run statusline:uninstall` restores the original command exactly, or removes `statusLine` when there was none.
- A WSC status line is recognised by `plugin/statusline/statusline.mjs` in its command (backslashes normalised), the same way hook entries are recognised.
