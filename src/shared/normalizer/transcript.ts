// Transcript JSONL → StationEvent. Raw transcript formats are parsed only here.
// Layout (verified locally against Claude Code 2.1.294, see docs/claude-code-integration.md):
//   ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl                  — orchestrator
//   ~/.claude/projects/<sanitized-cwd>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json)
// Every function here is total: malformed input yields [] and never throws.
// Lines also yield TranscriptExtras (usage, model, git branch) — never message text, except an
// opt-in, redacted prompt preview. Verified against Claude Code 2.1.308 (keys only).
import { rawTokenTotal, type TokenUsage, type TranscriptExtras } from '../dashboardTypes';
import { projectIdFor, projectNameFor } from '../projects';
import { redactSecrets, summarizeTool } from '../redact';
import { categorizeTool } from '../toolCategories';
import { ORCHESTRATOR_ID, type StationEvent, type ToolCategory } from '../types';

export interface TranscriptContext {
  sessionId: string;
  /** ORCHESTRATOR_ID or the subagent id (without the `agent-` prefix). */
  agentId: string;
  cwd?: string;
  label?: string;
  toolOverrides?: Record<string, ToolCategory>;
  /** Longer summaries (still redacted). Off by default. */
  fullToolDetails?: boolean;
  /** tool_use id → tool name, filled on tool_use so tool_end can name the tool. */
  toolNames?: Map<string, string>;
  /** Attach a redacted, truncated preview of typed prompts to extras. Off by default. */
  promptPreview?: boolean;
  /** UsageRecord.rank for this file's usage (its creation time). */
  usageRank?: number;
}

export interface TranscriptLineResult {
  events: StationEvent[];
  /** Non-event facts (usage, model, branch); null for unparseable or non-message lines. */
  extras: TranscriptExtras | null;
}

const DELEGATE_TOOLS = new Set(['Task', 'Agent']);
/** Line types that belong to the conversation; everything else is bookkeeping and ignored. */
const MESSAGE_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);
/** Claude Code's model id for locally generated messages (errors, interrupts): no API usage. */
const SYNTHETIC_MODEL = '<synthetic>';
export const PROMPT_PREVIEW_MAX = 120;
/** Project of a usage record whose line (and context) has no cwd. */
export const UNKNOWN_PROJECT_ID = 'unknown';
export const UNKNOWN_PROJECT_NAME = 'unknown';
/** User lines that look typed but are command plumbing, not prompts that start a turn. */
const NOT_A_PROMPT =
  /^\s*(?:<(?:command-name|command-message|command-args|local-command-[a-z]+|bash-input|bash-stdout|bash-stderr)>|\[Request interrupted)/;

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
/** Token counts: anything but a finite, non-negative number counts as 0. */
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

export const stripAgentPrefix = (id: string): string =>
  id.startsWith('agent-') ? id.slice('agent-'.length) : id;

function parseTs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

export function normalizeTranscriptLine(line: string, ctx: TranscriptContext): StationEvent[] {
  return normalizeTranscriptLineFull(line, ctx).events;
}

/** Events plus non-event extras for one JSONL line. Total: never throws. */
export function normalizeTranscriptLineFull(
  line: string,
  ctx: TranscriptContext,
): TranscriptLineResult {
  try {
    return parseLine(line, ctx);
  } catch {
    return { events: [], extras: null };
  }
}

/**
 * Fast path for the startup scan of large histories: usage, model and branch only.
 * A cheap substring prefilter skips JSON.parse for the vast majority of lines.
 */
export function transcriptUsageOnly(line: string, ctx: TranscriptContext): TranscriptExtras | null {
  try {
    if (typeof line !== 'string') return null;
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
    const rec: unknown = JSON.parse(line);
    if (!isRec(rec) || rec['type'] !== 'assistant') return null;
    const head = lineHead(rec, ctx);
    if (!head) return null;
    const message = rec['message'];
    if (!isRec(message)) return null;
    const extras = baseExtras(rec, head);
    addAssistantFacts(extras, rec, message, head);
    return extras.usage ? extras : null;
  } catch {
    return null;
  }
}

interface LineHead {
  ts: number;
  sessionId: string;
  agentId: string;
  cwd: string | undefined;
  rank: number | undefined;
}

function lineHead(rec: Rec, ctx: TranscriptContext): LineHead | undefined {
  const ts = parseTs(rec['timestamp']);
  if (ts === undefined) return undefined;
  const sessionId = str(rec['sessionId']) ?? ctx.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  const lineAgent = str(rec['agentId']);
  const agentId = lineAgent ? stripAgentPrefix(lineAgent) : ctx.agentId;
  return { ts, sessionId, agentId, cwd: str(rec['cwd']) ?? ctx.cwd, rank: ctx.usageRank };
}

function baseExtras(rec: Rec, head: LineHead): TranscriptExtras {
  const extras: TranscriptExtras = {
    sessionId: head.sessionId,
    agentId: head.agentId,
    ts: head.ts,
  };
  if (head.cwd) {
    extras.projectId = projectIdFor(head.cwd);
    extras.projectName = projectNameFor(head.cwd);
  }
  const branch = str(rec['gitBranch']);
  if (branch) extras.gitBranch = branch;
  return extras;
}

function parseUsage(u: unknown): TokenUsage | undefined {
  if (!isRec(u)) return undefined;
  let cacheCreation = count(u['cache_creation_input_tokens']);
  const detail = u['cache_creation'];
  if (cacheCreation === 0 && isRec(detail)) {
    cacheCreation =
      count(detail['ephemeral_5m_input_tokens']) + count(detail['ephemeral_1h_input_tokens']);
  }
  return {
    input: count(u['input_tokens']),
    output: count(u['output_tokens']),
    cacheCreation,
    cacheRead: count(u['cache_read_input_tokens']),
  };
}

/** Model + usage of an assistant line. One API message spans several lines: dedupe by key. */
function addAssistantFacts(extras: TranscriptExtras, rec: Rec, message: Rec, head: LineHead): void {
  const model = str(message['model']);
  if (!model || model === SYNTHETIC_MODEL) return;
  extras.model = model;
  const messageId = str(message['id']);
  const usage = parseUsage(message['usage']);
  if (!messageId || !usage || rawTokenTotal(usage) === 0) return;
  const requestId = str(rec['requestId']);
  extras.usage = {
    key: requestId ? `${messageId}:${requestId}` : messageId,
    ts: head.ts,
    sessionId: head.sessionId,
    agentId: head.agentId,
    projectId: extras.projectId ?? UNKNOWN_PROJECT_ID,
    projectName: extras.projectName ?? UNKNOWN_PROJECT_NAME,
    model,
    usage,
  };
  if (head.rank !== undefined && Number.isFinite(head.rank)) extras.usage.rank = head.rank;
}

/** The text of a prompt the user typed, or undefined for meta, system and tool-result lines. */
function typedPromptText(rec: Rec, message: Rec): string | undefined {
  if (rec['isMeta'] === true || rec['isCompactSummary'] === true) return undefined;
  if (rec['promptSource'] === 'system') return undefined;
  const content = message['content'];
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content) && content.length > 0) {
    const parts: string[] = [];
    for (const item of content) {
      if (!isRec(item) || item['type'] !== 'text' || typeof item['text'] !== 'string') {
        return undefined;
      }
      parts.push(item['text']);
    }
    text = parts.join('\n');
  } else {
    return undefined;
  }
  if (!text.trim() || NOT_A_PROMPT.test(text)) return undefined;
  return text;
}

/** Redacted, single-line, at most PROMPT_PREVIEW_MAX chars. */
export function promptPreviewOf(text: string): string {
  const oneLine = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > PROMPT_PREVIEW_MAX
    ? `${oneLine.slice(0, PROMPT_PREVIEW_MAX - 1)}…`
    : oneLine;
}

function parseLine(line: string, ctx: TranscriptContext): TranscriptLineResult {
  const none: TranscriptLineResult = { events: [], extras: null };
  if (typeof line !== 'string') return none;
  const trimmed = line.trim();
  if (!trimmed) return none;
  let rec: unknown;
  try {
    rec = JSON.parse(trimmed);
  } catch {
    return none;
  }
  if (!isRec(rec)) return none;
  const type = rec['type'];
  if (typeof type !== 'string' || !MESSAGE_TYPES.has(type)) return none;

  const head = lineHead(rec, ctx);
  if (!head) return none;
  const { ts, sessionId, agentId, cwd } = head;
  const extras = baseExtras(rec, head);
  const message = rec['message'];
  if (type === 'assistant' && isRec(message)) addAssistantFacts(extras, rec, message, head);
  if (!cwd) return { events: [], extras };

  const base = {
    ts,
    source: 'transcript' as const,
    projectId: projectIdFor(cwd),
    projectName: projectNameFor(cwd),
    sessionId,
    agentId,
    ...(agentId !== ORCHESTRATOR_ID ? { parentAgentId: ORCHESTRATOR_ID } : {}),
  };

  if (type === 'system') {
    if (rec['subtype'] !== 'compact_boundary') return { events: [], extras };
    const uuid = str(rec['uuid']) ?? String(ts);
    return {
      events: [{ ...base, id: `${sessionId}:compact:${uuid}`, kind: 'compacting' }],
      extras,
    };
  }

  if (!isRec(message)) return { events: [], extras };
  const out: StationEvent[] = [];

  if (type === 'user') {
    const prompt = typedPromptText(rec, message);
    if (prompt !== undefined && agentId === ORCHESTRATOR_ID) {
      const key = str(rec['promptId']) ?? str(rec['uuid']) ?? String(ts);
      // Never carry the prompt text in the event.
      out.push({ ...base, id: `${sessionId}:prompt:${key}`, kind: 'user_prompt' });
      if (ctx.promptPreview === true) {
        const preview = promptPreviewOf(prompt);
        if (preview) extras.promptPreview = preview;
      }
    }
  }

  if (!Array.isArray(message['content'])) return { events: out, extras };
  const content = message['content'] as unknown[];

  if (type === 'assistant') {
    for (const item of content) {
      if (!isRec(item) || item['type'] !== 'tool_use') continue;
      const useId = str(item['id']);
      const name = str(item['name']);
      if (!useId || !name) continue;
      ctx.toolNames?.set(useId, name);
      const input = item['input'];
      const isDelegate = DELEGATE_TOOLS.has(name);
      const category: ToolCategory = isDelegate
        ? 'delegate'
        : categorizeTool(name, ctx.toolOverrides);
      const ev: StationEvent = {
        ...base,
        id: `${sessionId}:tool:${useId}:start`,
        kind: 'tool_start',
        tool: {
          name,
          category,
          summary: summarizeTool(name, input, { full: ctx.fullToolDetails === true }),
          useId,
        },
      };
      if (isDelegate && isRec(input)) {
        const label = str(input['subagent_type']) ?? str(input['description']);
        if (label) ev.label = label;
      }
      out.push(ev);
    }
    // The lead finished its turn and is waiting for the next prompt. Transcripts never record
    // a session end, so this is what keeps a backfilled, already-closed session from "thinking".
    if (agentId === ORCHESTRATOR_ID && message['stop_reason'] === 'end_turn') {
      const uuid = str(rec['uuid']) ?? String(ts);
      out.push({ ...base, id: `${sessionId}:idle:${uuid}`, kind: 'idle' });
    }
  } else if (type === 'user') {
    for (const item of content) {
      if (!isRec(item) || item['type'] !== 'tool_result') continue;
      const useId = str(item['tool_use_id']);
      if (!useId) continue;
      const name = ctx.toolNames?.get(useId) ?? 'unknown';
      const category: ToolCategory = DELEGATE_TOOLS.has(name)
        ? 'delegate'
        : name === 'unknown'
          ? 'other'
          : categorizeTool(name, ctx.toolOverrides);
      out.push({
        ...base,
        id: `${sessionId}:tool:${useId}:end`,
        kind: 'tool_end',
        tool: { name, category, ok: item['is_error'] !== true, useId },
      });
    }
  }
  return { events: out, extras };
}

/** Subagent `agent-<id>.meta.json` → agent_spawn. */
export function normalizeSubagentMeta(
  meta: unknown,
  ctx: { sessionId: string; agentId: string; cwd: string; ts: number },
): StationEvent[] {
  try {
    const agentId = stripAgentPrefix(ctx.agentId);
    const m = isRec(meta) ? meta : {};
    const label = str(m['agentType']) ?? str(m['description']);
    const ev: StationEvent = {
      id: `${ctx.sessionId}:agent:${agentId}:spawn`,
      ts: ctx.ts,
      source: 'transcript',
      projectId: projectIdFor(ctx.cwd),
      projectName: projectNameFor(ctx.cwd),
      sessionId: ctx.sessionId,
      agentId,
      parentAgentId: ORCHESTRATOR_ID,
      kind: 'agent_spawn',
    };
    if (label) ev.label = label;
    return [ev];
  } catch {
    return [];
  }
}

/** The tool_use id that spawned this subagent, if the meta records it. */
export function metaToolUseId(meta: unknown): string | undefined {
  return isRec(meta) ? str(meta['toolUseId']) : undefined;
}

/** First `cwd` value found in a JSONL chunk, if any. */
export function firstCwd(lines: string[]): string | undefined {
  for (const line of lines) {
    try {
      const rec: unknown = JSON.parse(line);
      if (isRec(rec)) {
        const cwd = str(rec['cwd']);
        if (cwd) return cwd;
      }
    } catch {
      // skip malformed line
    }
  }
  return undefined;
}
