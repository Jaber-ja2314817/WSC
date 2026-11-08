// Claude Code hook payload → StationEvent[].
// The ONLY place that knows the raw hook JSON format (see docs/claude-code-integration.md).
import { projectIdFor, projectNameFor } from '../projects';
import { safeLabel, summarizeTool } from '../redact';
import { categorizeTool } from '../toolCategories';
import {
  ORCHESTRATOR_ID,
  type StationEvent,
  type StationEventKind,
  type ToolCategory,
} from '../types';
import { isFinalTool } from './transcript';

export interface HookNormalizeOptions {
  toolOverrides?: Record<string, ToolCategory>;
  /** Longer summaries (still redacted). Off by default. */
  fullToolDetails?: boolean;
}

const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog',
]);

type Raw = Record<string, unknown>;

const str = (o: Raw, k: string): string | undefined => {
  const v = o[k];
  return typeof v === 'string' && v !== '' ? v : undefined;
};

export function normalizeHookPayload(
  raw: unknown,
  receivedAt: number,
  opts?: HookNormalizeOptions,
): StationEvent[] {
  try {
    return normalize(raw, receivedAt, opts);
  } catch {
    return [];
  }
}

function normalize(raw: unknown, receivedAt: number, opts?: HookNormalizeOptions): StationEvent[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const p = raw as Raw;
  const sessionId = str(p, 'session_id');
  const cwd = str(p, 'cwd');
  const hookEvent = str(p, 'hook_event_name');
  if (!sessionId || !cwd || !hookEvent) return [];

  const rawAgentId = str(p, 'agent_id');
  const isSubagent = rawAgentId !== undefined;
  const agentId = isSubagent ? rawAgentId.replace(/^agent-/, '') : ORCHESTRATOR_ID;
  const agentType = str(p, 'agent_type');
  const label = agentType ? safeLabel(agentType) : '';
  const toolName = str(p, 'tool_name');
  const toolUseId = str(p, 'tool_use_id');

  const base = {
    ts: receivedAt,
    source: 'hook' as const,
    projectId: projectIdFor(cwd),
    projectName: projectNameFor(cwd),
    sessionId,
    agentId,
    ...(isSubagent ? { parentAgentId: ORCHESTRATOR_ID } : {}),
    ...(label ? { label } : {}),
  };

  const genericId = (kind: StationEventKind): string =>
    `${sessionId}:${agentId}:${kind}:${receivedAt}${toolUseId ? `:${toolUseId}` : ''}`;
  const toolKey = toolUseId ?? String(receivedAt);

  const make = (
    kind: StationEventKind,
    id: string,
    extra?: Partial<StationEvent>,
  ): StationEvent[] => [{ ...base, id, kind, ...extra }];

  const tool = (ok?: boolean): StationEvent['tool'] => {
    if (!toolName) return undefined;
    const input = p['tool_input'];
    const summary = summarizeTool(toolName, input, { full: opts?.fullToolDetails === true });
    return {
      name: toolName,
      category: categorizeTool(toolName, opts?.toolOverrides),
      ...(summary !== undefined ? { summary } : {}),
      ...(ok !== undefined ? { ok } : {}),
      ...(toolUseId ? { useId: toolUseId } : {}),
      ...(isFinalTool(toolName) ? { finalizing: true } : {}),
    };
  };

  switch (hookEvent) {
    case 'SessionStart':
      // A compaction restarts nothing: the session carries on, mid-turn.
      if (str(p, 'source') === 'compact') return [];
      return make('session_start', `${sessionId}:session:start:${receivedAt}`);
    case 'SessionEnd':
      return make('session_end', genericId('session_end'));
    case 'UserPromptSubmit': {
      // Never carry the prompt text. `prompt_id` matches the transcript's `promptId`, so the
      // hook and transcript backfill dedupe to one prompt.
      const promptId = str(p, 'prompt_id');
      return make(
        'user_prompt',
        promptId ? `${sessionId}:prompt:${promptId}` : genericId('user_prompt'),
      );
    }
    case 'PreToolUse': {
      if (!toolName) return [];
      const t = tool();
      const extra: Partial<StationEvent> = { tool: t };
      if (t?.category === 'delegate' && (toolName === 'Task' || toolName === 'Agent')) {
        const input = p['tool_input'];
        const i = input && typeof input === 'object' ? (input as Raw) : {};
        const delegateLabel = safeLabel(str(i, 'subagent_type') ?? str(i, 'description') ?? '');
        if (delegateLabel) extra.label = delegateLabel;
      }
      return make('tool_start', `${sessionId}:tool:${toolKey}:start`, extra);
    }
    case 'PostToolUse':
      if (!toolName) return [];
      return make('tool_end', `${sessionId}:tool:${toolKey}:end`, { tool: tool(true) });
    case 'PostToolUseFailure':
    case 'PermissionDenied': {
      if (!toolName) return [];
      const end = make('tool_end', `${sessionId}:tool:${toolKey}:end`, { tool: tool(false) });
      // Esc: no Stop follows, and the transcript's interrupt line has an older time than this.
      const interrupted = !isSubagent && p['is_interrupt'] === true;
      return interrupted ? [...end, ...make('idle', genericId('idle'))] : end;
    }
    case 'PermissionRequest':
      return make('waiting_for_user', genericId('waiting_for_user'), { tool: tool() });
    case 'Notification': {
      const type = str(p, 'notification_type');
      if (!type || !WAITING_NOTIFICATIONS.has(type)) return [];
      return make('waiting_for_user', genericId('waiting_for_user'));
    }
    case 'SubagentStart':
      if (!isSubagent) return [];
      return make('agent_spawn', `${sessionId}:agent:${agentId}:spawn`);
    case 'SubagentStop':
      if (!isSubagent) return [];
      return make('agent_finish', `${sessionId}:agent:${agentId}:finish`);
    case 'Stop':
      return make('idle', genericId('idle'));
    case 'StopFailure':
      return make('agent_error', genericId('agent_error'));
    case 'PreCompact':
      return make('compacting', genericId('compacting'));
    case 'PostCompact':
      return make('idle', genericId('idle'), { idleReason: 'compact' });
    default:
      // PostToolBatch, CwdChanged (session keeps its zone) and unknown events.
      return [];
  }
}

/** Session id + transcript path from a raw hook payload, used to trigger backfill. */
export function hookSessionInfo(
  raw: unknown,
): { sessionId: string; transcriptPath?: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Raw;
  const sessionId = str(o, 'session_id');
  if (!sessionId) return null;
  return { sessionId, transcriptPath: str(o, 'transcript_path') };
}
