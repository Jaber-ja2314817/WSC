import { describe, expect, it } from 'vitest';
import {
  firstCwd,
  metaToolUseId,
  normalizeSubagentMeta,
  normalizeTranscriptLine,
  type TranscriptContext,
} from '../src/shared/normalizer/transcript';
import { projectIdFor } from '../src/shared/projects';
import { ORCHESTRATOR_ID } from '../src/shared/types';

const SESSION = 'sess-0001';
const CWD = '/home/user/proj-a';
const TS = '2026-01-01T10:00:00.000Z';

const ctx = (over: Partial<TranscriptContext> = {}): TranscriptContext => ({
  sessionId: SESSION,
  agentId: ORCHESTRATOR_ID,
  cwd: CWD,
  toolNames: new Map(),
  ...over,
});

const line = (rec: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: TS, sessionId: SESSION, cwd: CWD, uuid: 'u1', ...rec });

const assistant = (content: unknown[], extra: Record<string, unknown> = {}): string =>
  line({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
const user = (content: unknown, extra: Record<string, unknown> = {}): string =>
  line({ type: 'user', message: { role: 'user', content }, ...extra });

describe('normalizeTranscriptLine', () => {
  it('maps an assistant tool_use to tool_start with hook-compatible id', () => {
    const [ev, ...rest] = normalizeTranscriptLine(
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: { file_path: '/home/user/proj-a/src/auth.ts' },
        },
      ]),
      ctx(),
    );
    expect(rest).toHaveLength(0);
    expect(ev).toMatchObject({
      id: `${SESSION}:tool:toolu_1:start`,
      ts: Date.parse(TS),
      source: 'transcript',
      kind: 'tool_start',
      sessionId: SESSION,
      agentId: ORCHESTRATOR_ID,
      projectId: projectIdFor(CWD),
      projectName: 'proj-a',
      tool: { name: 'Read', category: 'read', useId: 'toolu_1' },
    });
    expect(ev?.tool?.summary).toContain('auth.ts');
    expect(ev?.tool?.summary).not.toContain('/home/user');
  });

  it('carries the tool name over to tool_end via ctx.toolNames', () => {
    const c = ctx();
    normalizeTranscriptLine(
      assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }]),
      c,
    );
    const [end] = normalizeTranscriptLine(
      user([{ type: 'tool_result', tool_use_id: 't2', is_error: true }]),
      c,
    );
    expect(end).toMatchObject({
      id: `${SESSION}:tool:t2:end`,
      kind: 'tool_end',
      tool: { name: 'Bash', category: 'execute', ok: false, useId: 't2' },
    });
  });

  it('falls back to unknown/other when the tool name is not known', () => {
    const [end] = normalizeTranscriptLine(
      user([{ type: 'tool_result', tool_use_id: 'tx' }]),
      ctx(),
    );
    expect(end?.tool).toMatchObject({ name: 'unknown', category: 'other', ok: true });
  });

  it('marks Task/Agent tool_use as delegate with a label', () => {
    const evs = normalizeTranscriptLine(
      assistant([
        {
          type: 'tool_use',
          id: 'k1',
          name: 'Task',
          input: { subagent_type: 'researcher', description: 'R' },
        },
        { type: 'tool_use', id: 'k2', name: 'Agent', input: { description: 'Write tests' } },
      ]),
      ctx(),
    );
    expect(evs.map((e) => [e.tool?.category, e.label])).toEqual([
      ['delegate', 'researcher'],
      ['delegate', 'Write tests'],
    ]);
  });

  it('attributes subagent lines by agentId, stripping the agent- prefix', () => {
    const [ev] = normalizeTranscriptLine(
      assistant([{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'x' } }], {
        agentId: 'agent-abc123',
        isSidechain: true,
      }),
      ctx(),
    );
    expect(ev).toMatchObject({
      agentId: 'abc123',
      parentAgentId: ORCHESTRATOR_ID,
      tool: { category: 'search' },
    });
  });

  it('emits idle when the orchestrator ends its turn, but not for subagents', () => {
    const endTurn = (extra: Record<string, unknown> = {}): string =>
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'x' }],
          stop_reason: 'end_turn',
        },
        ...extra,
      });
    const evs = normalizeTranscriptLine(endTurn(), ctx());
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      kind: 'idle',
      agentId: ORCHESTRATOR_ID,
      id: `${SESSION}:idle:u1`,
    });
    expect(normalizeTranscriptLine(endTurn({ agentId: 'abc' }), ctx())).toEqual([]);
  });

  it('maps compact_boundary to compacting', () => {
    const [ev] = normalizeTranscriptLine(
      line({ type: 'system', subtype: 'compact_boundary', uuid: 'c1' }),
      ctx(),
    );
    expect(ev).toMatchObject({ kind: 'compacting', id: `${SESSION}:compact:c1` });
    expect(normalizeTranscriptLine(line({ type: 'system', subtype: 'other' }), ctx())).toEqual([]);
  });

  it('ignores text, thinking, plain prompts and attachments', () => {
    expect(
      normalizeTranscriptLine(
        assistant([
          { type: 'text', text: 'hi' },
          { type: 'thinking', thinking: 'x' },
        ]),
        ctx(),
      ),
    ).toEqual([]);
    expect(normalizeTranscriptLine(user('a plain prompt'), ctx())).toEqual([]);
    expect(normalizeTranscriptLine(line({ type: 'attachment', attachment: {} }), ctx())).toEqual(
      [],
    );
  });

  it.each([
    '',
    '   ',
    '{not json',
    '[1,2,3]',
    'null',
    '42',
    '"str"',
    JSON.stringify({ type: 'assistant' }),
    JSON.stringify({
      type: 'assistant',
      timestamp: 'not a date',
      cwd: CWD,
      message: { content: [] },
    }),
    JSON.stringify({ type: 'assistant', timestamp: TS, cwd: CWD, message: { content: 'str' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: TS,
      cwd: CWD,
      message: { content: [null, 1, { type: 'tool_use' }] },
    }),
  ])('returns [] for malformed line %#', (l) => {
    expect(normalizeTranscriptLine(l, ctx())).toEqual([]);
  });

  it('skips lines without any cwd', () => {
    const l = JSON.stringify({
      type: 'assistant',
      timestamp: TS,
      message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
    });
    expect(normalizeTranscriptLine(l, ctx({ cwd: undefined }))).toEqual([]);
    expect(normalizeTranscriptLine(l, ctx())).toHaveLength(1);
  });
});

describe('normalizeSubagentMeta', () => {
  const mctx = { sessionId: SESSION, agentId: 'agent-aaaa1111', cwd: CWD, ts: 1000 };

  it('emits agent_spawn labelled with agentType', () => {
    expect(
      normalizeSubagentMeta({ agentType: 'researcher', description: 'd', toolUseId: 't' }, mctx),
    ).toEqual([
      {
        id: `${SESSION}:agent:aaaa1111:spawn`,
        ts: 1000,
        source: 'transcript',
        projectId: projectIdFor(CWD),
        projectName: 'proj-a',
        sessionId: SESSION,
        agentId: 'aaaa1111',
        parentAgentId: ORCHESTRATOR_ID,
        kind: 'agent_spawn',
        label: 'researcher',
      },
    ]);
  });

  it('falls back to description, then no label', () => {
    expect(normalizeSubagentMeta({ description: 'Write tests' }, mctx)[0]?.label).toBe(
      'Write tests',
    );
    expect(normalizeSubagentMeta(undefined, mctx)[0]?.label).toBeUndefined();
    expect(normalizeSubagentMeta('garbage', mctx)).toHaveLength(1);
  });

  it('metaToolUseId reads toolUseId safely', () => {
    expect(metaToolUseId({ toolUseId: 'toolu_x' })).toBe('toolu_x');
    expect(metaToolUseId(null)).toBeUndefined();
    expect(metaToolUseId({ toolUseId: 5 })).toBeUndefined();
  });
});

describe('firstCwd', () => {
  it('returns the first cwd and skips malformed lines', () => {
    expect(
      firstCwd(['{bad', JSON.stringify({ x: 1 }), JSON.stringify({ cwd: '/home/user/x' })]),
    ).toBe('/home/user/x');
    expect(firstCwd(['{bad'])).toBeUndefined();
  });
});
