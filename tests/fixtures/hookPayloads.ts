// Synthetic hook payloads. Never paste real transcripts or real paths here.

export const CWD_A = '/home/user/projects/alpha';
export const CWD_B = '/home/user/projects/beta';
export const SESSION_A = '00000000-0000-4000-8000-00000000000a';
export const SESSION_B = '00000000-0000-4000-8000-00000000000b';

export interface PayloadOpts {
  session?: string;
  cwd?: string;
  agentId?: string;
  agentType?: string;
}

export function hookPayload(
  event: string,
  extra: Record<string, unknown> = {},
  opts: PayloadOpts = {},
): Record<string, unknown> {
  const session = opts.session ?? SESSION_A;
  return {
    session_id: session,
    transcript_path: `/home/user/.claude/projects/-home-user-projects-alpha/${session}.jsonl`,
    cwd: opts.cwd ?? CWD_A,
    permission_mode: 'default',
    hook_event_name: event,
    ...(opts.agentId ? { agent_id: opts.agentId } : {}),
    ...(opts.agentType ? { agent_type: opts.agentType } : {}),
    ...extra,
  };
}

export const toolPayload = (
  event:
    'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionRequest' | 'PermissionDenied',
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId = 'toolu_test_0001',
  opts: PayloadOpts = {},
): Record<string, unknown> =>
  hookPayload(event, { tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId }, opts);
