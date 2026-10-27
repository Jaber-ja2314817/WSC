import { describe, expect, it } from 'vitest';
import { normalizeHookPayload } from '../src/shared/normalizer/hook';
import { projectIdFor } from '../src/shared/projects';
import { ORCHESTRATOR_ID } from '../src/shared/types';
import { CWD_A, CWD_B, SESSION_A, hookPayload, toolPayload } from './fixtures/hookPayloads';

const T = 1_700_000_000_000;
const one = (raw: unknown) => {
  const out = normalizeHookPayload(raw, T);
  expect(out).toHaveLength(1);
  return out[0]!;
};

describe('normalizeHookPayload — event mapping', () => {
  it('SessionStart → session_start', () => {
    const e = one(hookPayload('SessionStart', { source: 'startup' }));
    expect(e).toMatchObject({
      kind: 'session_start',
      source: 'hook',
      ts: T,
      sessionId: SESSION_A,
      agentId: ORCHESTRATOR_ID,
      projectId: projectIdFor(CWD_A),
      projectName: 'alpha',
      id: `${SESSION_A}:session:start:${T}`,
    });
  });

  it('SessionEnd → session_end', () => {
    expect(one(hookPayload('SessionEnd', { reason: 'other' })).kind).toBe('session_end');
  });

  it('UserPromptSubmit → user_prompt without the prompt text', () => {
    const e = one(hookPayload('UserPromptSubmit', { prompt: 'my secret plan' }));
    expect(e.kind).toBe('user_prompt');
    expect(JSON.stringify(e)).not.toContain('secret plan');
  });

  it('UserPromptSubmit uses prompt_id so it dedupes with the transcript prompt', () => {
    const e = one(hookPayload('UserPromptSubmit', { prompt: 'my secret plan', prompt_id: 'pr-1' }));
    expect(e.id).toBe(`${SESSION_A}:prompt:pr-1`);
    expect(JSON.stringify(e)).not.toContain('secret plan');
    const generic = one(hookPayload('UserPromptSubmit', { prompt: 'x', prompt_id: '' }));
    expect(generic.id).toBe(`${SESSION_A}:${ORCHESTRATOR_ID}:user_prompt:${T}`);
  });

  it('PreToolUse → tool_start with sanitized summary', () => {
    const e = one(
      toolPayload('PreToolUse', 'Read', { file_path: '/home/user/projects/alpha/src/auth.ts' }),
    );
    expect(e).toMatchObject({
      kind: 'tool_start',
      id: `${SESSION_A}:tool:toolu_test_0001:start`,
      tool: { name: 'Read', category: 'read', summary: 'auth.ts', useId: 'toolu_test_0001' },
    });
    expect(JSON.stringify(e)).not.toContain('/home/user');
  });

  it('PostToolUse → tool_end ok', () => {
    const e = one(toolPayload('PostToolUse', 'Bash', { command: 'npm test' }));
    expect(e).toMatchObject({
      kind: 'tool_end',
      id: `${SESSION_A}:tool:toolu_test_0001:end`,
      tool: { name: 'Bash', category: 'execute', ok: true },
    });
  });

  it('PostToolUseFailure and PermissionDenied → tool_end not ok', () => {
    const f = one({
      ...toolPayload('PostToolUseFailure', 'Bash', { command: 'x' }),
      is_interrupt: true,
    });
    expect(f.tool?.ok).toBe(false);
    const d = one(toolPayload('PermissionDenied', 'Bash', { command: 'x' }));
    expect(d).toMatchObject({ kind: 'tool_end', tool: { ok: false } });
  });

  it('PermissionRequest → waiting_for_user with tool', () => {
    const e = one(toolPayload('PermissionRequest', 'Bash', { command: 'rm -rf build' }));
    expect(e.kind).toBe('waiting_for_user');
    expect(e.tool?.name).toBe('Bash');
  });

  it.each([
    'permission_prompt',
    'idle_prompt',
    'agent_needs_input',
    'elicitation_dialog',
    'elicitation_url_dialog',
  ])('Notification %s → waiting_for_user', (type) => {
    expect(one(hookPayload('Notification', { notification_type: type, message: 'm' })).kind).toBe(
      'waiting_for_user',
    );
  });

  it('other notifications are ignored', () => {
    expect(
      normalizeHookPayload(hookPayload('Notification', { notification_type: 'auth_success' }), T),
    ).toEqual([]);
    expect(normalizeHookPayload(hookPayload('Notification', {}), T)).toEqual([]);
  });

  it('SubagentStart / SubagentStop → agent_spawn / agent_finish', () => {
    const s = one(
      hookPayload('SubagentStart', {}, { agentId: 'agent-abc123', agentType: 'Explore' }),
    );
    expect(s).toMatchObject({
      kind: 'agent_spawn',
      agentId: 'abc123',
      parentAgentId: ORCHESTRATOR_ID,
      label: 'Explore',
      id: `${SESSION_A}:agent:abc123:spawn`,
    });
    const f = one(
      hookPayload(
        'SubagentStop',
        { last_assistant_message: 'done' },
        { agentId: 'abc123', agentType: 'Explore' },
      ),
    );
    expect(f).toMatchObject({
      kind: 'agent_finish',
      agentId: 'abc123',
      id: `${SESSION_A}:agent:abc123:finish`,
    });
    expect(JSON.stringify(f)).not.toContain('last_assistant');
  });

  it('SubagentStart without agent_id is ignored', () => {
    expect(normalizeHookPayload(hookPayload('SubagentStart'), T)).toEqual([]);
  });

  it('Stop/StopFailure/PreCompact/PostCompact', () => {
    expect(one(hookPayload('Stop')).kind).toBe('idle');
    expect(one(hookPayload('StopFailure', { error: 'rate_limit' })).kind).toBe('agent_error');
    expect(one(hookPayload('PreCompact', { trigger: 'auto' })).kind).toBe('compacting');
    expect(one(hookPayload('PostCompact', { trigger: 'auto' })).kind).toBe('idle');
  });

  it('ignores PostToolBatch, CwdChanged and unknown events', () => {
    expect(normalizeHookPayload(hookPayload('PostToolBatch', { tool_calls: [] }), T)).toEqual([]);
    expect(
      normalizeHookPayload(hookPayload('CwdChanged', { old_cwd: CWD_A, new_cwd: CWD_B }), T),
    ).toEqual([]);
    expect(normalizeHookPayload(hookPayload('SomeFutureEvent'), T)).toEqual([]);
  });
});

describe('normalizeHookPayload — attribution', () => {
  it('attributes tool calls inside a subagent to that subagent', () => {
    const e = one(
      toolPayload('PreToolUse', 'Grep', { pattern: 'x' }, 'toolu_2', {
        agentId: 'def456',
        agentType: 'researcher',
      }),
    );
    expect(e).toMatchObject({
      agentId: 'def456',
      parentAgentId: ORCHESTRATOR_ID,
      label: 'researcher',
    });
  });

  it('attributes main-thread tool calls to the orchestrator', () => {
    const e = one(toolPayload('PreToolUse', 'Grep', { pattern: 'x' }));
    expect(e.agentId).toBe(ORCHESTRATOR_ID);
    expect(e.parentAgentId).toBeUndefined();
  });

  it('labels delegate tool_start with the subagent type', () => {
    const e = one(
      toolPayload('PreToolUse', 'Agent', {
        subagent_type: 'test-writer',
        description: 'Write tests',
        prompt: 'p',
      }),
    );
    expect(e).toMatchObject({ tool: { category: 'delegate' }, label: 'test-writer' });
    const t = one(toolPayload('PreToolUse', 'Task', { description: 'Research docs' }));
    expect(t.label).toBe('Research docs');
  });

  it('unknown tools fall back to other', () => {
    expect(one(toolPayload('PreToolUse', 'BrandNewTool', { a: 1 })).tool).toMatchObject({
      category: 'other',
    });
  });

  it('applies tool overrides', () => {
    const [e] = normalizeHookPayload(toolPayload('PreToolUse', 'BrandNewTool', {}), T, {
      toolOverrides: { BrandNewTool: 'web' },
    });
    expect(e?.tool?.category).toBe('web');
  });

  it('groups by working directory', () => {
    const a = one(hookPayload('SessionStart', {}, { cwd: CWD_A }));
    const b = one(hookPayload('SessionStart', {}, { cwd: CWD_B }));
    const a2 = one(hookPayload('SessionStart', {}, { cwd: `${CWD_A}/` }));
    expect(a.projectId).not.toBe(b.projectId);
    expect(a2.projectId).toBe(a.projectId);
    expect(b.projectName).toBe('beta');
  });

  it('falls back to receivedAt when tool_use_id is missing', () => {
    const raw = hookPayload('PreToolUse', { tool_name: 'Read', tool_input: {} });
    expect(one(raw).id).toBe(`${SESSION_A}:tool:${T}:start`);
  });
});

describe('normalizeHookPayload — malformed input', () => {
  it.each([
    null,
    undefined,
    42,
    'str',
    [],
    [hookPayload('Stop')],
    {},
    { session_id: 1, cwd: '/x', hook_event_name: 'Stop' },
  ])('returns [] for %j', (raw) => expect(normalizeHookPayload(raw, T)).toEqual([]));

  it('returns [] when required fields are missing', () => {
    const p = hookPayload('Stop');
    for (const key of ['session_id', 'cwd', 'hook_event_name']) {
      const copy = { ...p };
      delete copy[key];
      expect(normalizeHookPayload(copy, T)).toEqual([]);
    }
  });

  it('tolerates weird tool_input and huge payloads', () => {
    expect(
      one(hookPayload('PreToolUse', { tool_name: 'Bash', tool_input: 'oops', tool_use_id: 'u' }))
        .tool?.summary,
    ).toBeUndefined();
    const big = toolPayload('PreToolUse', 'Bash', { command: 'x'.repeat(500_000) });
    const e = one(big);
    expect(e.tool!.summary!.length).toBeLessThanOrEqual(60);
  });

  it('does not throw on hostile getters', () => {
    const evil = hookPayload('PreToolUse', { tool_name: 'Read', tool_use_id: 'u' });
    Object.defineProperty(evil, 'tool_input', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    expect(() => normalizeHookPayload(evil, T)).not.toThrow();
  });
});
