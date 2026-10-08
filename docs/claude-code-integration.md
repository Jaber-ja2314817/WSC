# Claude Code integration

**Verified against:** Claude Code **2.1.294**, on 2026-10-08.
**Sources:**

- Official docs at `code.claude.com/docs`: `hooks`, `hooks-guide`, `plugins/*`, `skills`, `sub-agents`, `memory`.
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
| `UserPromptSubmit`           | The orchestrator wakes up (`user_prompt`). We never read `prompt` beyond its existence.                                                                             |
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
| UserPromptSubmit         | none (the prompt text is ignored)                                                       | `user_prompt`                    |
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

## 7. Transcript layout (used for backfill)

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

**Behavior to rely on:**

- Transcripts are **written asynchronously and may lag** behind hooks. [docs]
- Subagent transcripts survive compaction of the main conversation and are deleted after `cleanupPeriodDays`, which defaults to 30. [docs]

**Parser rules:**

- Skip any line that fails `JSON.parse` or has an unknown `type`.
- Never throw.
- Read only the fields needed for state; never retain message text.

## 8. Verified live (Claude Code 2.1.294, 2026-10-08)

Setup: two headless `claude -p --plugin-dir ./plugin` sessions ran at the same time in two temp folders. Each spawned one `general-purpose` subagent that ran `Read` and `Bash(ls)`.

1. **Subagent `session_id` is the parent's.** Every event from inside a subagent carried the parent session id and parent `transcript_path`.
2. **`agent_id` has no `agent-` prefix**, e.g. `a72ab8f117ab00edb`. That is the same string as the transcript `agentId` and the `agent-<id>.jsonl` file name. The prefix-stripping stays as a safety net.
3. **Subagents run in the background.** The orchestrator's `PostToolUse` for `Agent` fires about 10 ms after `SubagentStart`, and its `Stop` can fire while the subagent is still working. A subagent is finished only on `SubagentStop`, never on the `Agent` tool's end.
4. **The hand-back is a tool.** Subagents end by calling a `SubagentHandback` tool (mapped to `delegate`). A `UserPromptSubmit` with no user typing then fires on the orchestrator as the result is delivered.
5. **`PostToolBatch` also fires inside subagents**, with `agent_id`. It is ignored for now.
6. **Project attribution:** the two folders produced two projects, and all 34 events landed in the right one.
7. **Backfill:** transcripts never record a session end. An orchestrator `assistant` record with `stop_reason: "end_turn"` is mapped to `idle`, so closed sessions don't stay "thinking".

## 9. Open questions

1. Do nested subagents (`spawnDepth` > 1) report a parent agent id? For now their parent is `orchestrator`.
2. `PermissionRequest` and `Notification` were not exercised by the headless run, since `-p` mode never prompts. They need an interactive check.
3. Field drift between versions. Re-verify this file on each Claude Code minor upgrade and note the version at the top.
