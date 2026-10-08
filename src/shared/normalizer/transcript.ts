// Transcript JSONL → StationEvent. Raw transcript formats are parsed only here.
// Layout (verified locally against Claude Code 2.1.294, see docs/claude-code-integration.md):
//   ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl                  — orchestrator
//   ~/.claude/projects/<sanitized-cwd>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json)
// Every function here is total: malformed input yields [] and never throws.
import { projectIdFor, projectNameFor } from '../projects';
import { summarizeTool } from '../redact';
import { categorizeTool } from '../toolCategories';
import { ORCHESTRATOR_ID, type StationEvent, type ToolCategory } from '../types';

export interface TranscriptContext {
  sessionId: string;
  /** ORCHESTRATOR_ID or the subagent id (without the `agent-` prefix). */
  agentId: string;
  cwd?: string;
  label?: string;
  toolOverrides?: Record<string, ToolCategory>;
  /** tool_use id → tool name, filled on tool_use so tool_end can name the tool. */
  toolNames?: Map<string, string>;
}

const DELEGATE_TOOLS = new Set(['Task', 'Agent']);

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

export const stripAgentPrefix = (id: string): string =>
  id.startsWith('agent-') ? id.slice('agent-'.length) : id;

function parseTs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

export function normalizeTranscriptLine(line: string, ctx: TranscriptContext): StationEvent[] {
  try {
    return parseLine(line, ctx);
  } catch {
    return [];
  }
}

function parseLine(line: string, ctx: TranscriptContext): StationEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let rec: unknown;
  try {
    rec = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isRec(rec)) return [];

  const ts = parseTs(rec['timestamp']);
  if (ts === undefined) return [];

  const sessionId = str(rec['sessionId']) ?? ctx.sessionId;
  const lineAgent = str(rec['agentId']);
  const agentId = lineAgent ? stripAgentPrefix(lineAgent) : ctx.agentId;
  const cwd = str(rec['cwd']) ?? ctx.cwd;
  if (!cwd) return [];

  const base = {
    ts,
    source: 'transcript' as const,
    projectId: projectIdFor(cwd),
    projectName: projectNameFor(cwd),
    sessionId,
    agentId,
    ...(agentId !== ORCHESTRATOR_ID ? { parentAgentId: ORCHESTRATOR_ID } : {}),
  };

  const type = rec['type'];
  if (type === 'system') {
    if (rec['subtype'] !== 'compact_boundary') return [];
    const uuid = str(rec['uuid']) ?? String(ts);
    return [{ ...base, id: `${sessionId}:compact:${uuid}`, kind: 'compacting' }];
  }

  const message = rec['message'];
  if (!isRec(message) || !Array.isArray(message['content'])) return [];
  const content = message['content'] as unknown[];
  const out: StationEvent[] = [];

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
        tool: { name, category, summary: summarizeTool(name, input), useId },
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
  return out;
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
