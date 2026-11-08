import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROMPT_PREVIEW_MAX,
  firstCwd,
  metaToolUseId,
  normalizeSubagentMeta,
  normalizeTranscriptLine,
  normalizeTranscriptLineFull,
  transcriptUsageOnly,
  type TranscriptContext,
} from '../src/shared/normalizer/transcript';
import { projectIdFor } from '../src/shared/projects';
import { ORCHESTRATOR_ID, type StationEvent } from '../src/shared/types';

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

  it('one message spanning several end_turn lines is one turn end', () => {
    const endTurn = (uuid: string): StationEvent | undefined =>
      normalizeTranscriptLine(
        line({
          type: 'assistant',
          uuid,
          message: { id: 'msg_1', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' },
        }),
        ctx(),
      )[0];
    expect(endTurn('u1')?.id).toBe(`${SESSION}:idle:msg_1`);
    expect(endTurn('u2')?.id).toBe(endTurn('u1')?.id);
  });

  it('marks only the hand-back tool_use as finalizing', () => {
    const toolUse = (name: string): StationEvent | undefined =>
      normalizeTranscriptLine(
        assistant([{ type: 'tool_use', id: 't1', name, input: {} }]),
        ctx({ agentId: 's1' }),
      )[0];
    expect(toolUse('SubagentHandback')?.tool?.finalizing).toBe(true);
    expect(toolUse('Read')?.tool).not.toHaveProperty('finalizing');
  });

  it('sanitizes subagent labels, not just summaries', () => {
    const key = 'API_KEY=fakesecret123';
    const [ev] = normalizeTranscriptLine(
      assistant([
        { type: 'tool_use', id: 't1', name: 'Agent', input: { description: `go ${key}` } },
      ]),
      ctx(),
    );
    expect(ev?.label).toContain('go API_KEY=');
    const [meta] = normalizeSubagentMeta(
      { description: `go ${key}` },
      { sessionId: SESSION, agentId: 's1', cwd: CWD, ts: 1 },
    );
    expect(JSON.stringify([ev, meta])).not.toContain('fakesecret123');
    const long = 'x '.repeat(100);
    const [spawn] = normalizeSubagentMeta(
      { description: long },
      { sessionId: SESSION, agentId: 's1', cwd: CWD, ts: 1 },
    );
    expect(spawn?.label?.length).toBeLessThanOrEqual(60);
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
    expect(normalizeTranscriptLine(line({ type: 'attachment', attachment: {} }), ctx())).toEqual(
      [],
    );
  });

  it('turns a typed prompt into user_prompt without its text', () => {
    const evs = normalizeTranscriptLine(user('a plain prompt'), ctx());
    expect(evs).toEqual([
      expect.objectContaining({ kind: 'user_prompt', id: `${SESSION}:prompt:u1` }),
    ]);
    expect(JSON.stringify(evs)).not.toContain('plain prompt');
  });

  it('ignores attachments', () => {
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

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_creation_input_tokens: 300,
  cache_read_input_tokens: 4000,
  cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
  service_tier: 'standard',
};

const assistantMsg = (
  over: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): string =>
  line({
    type: 'assistant',
    requestId: 'req_fake_1',
    gitBranch: 'feature/x',
    message: {
      id: 'msg_fake_1',
      model: 'claude-fake-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'fake' }],
      usage: USAGE,
      ...over,
    },
    ...extra,
  });

describe('normalizeTranscriptLineFull — extras', () => {
  it('extracts usage, model, branch and project from an assistant line', () => {
    const { events, extras } = normalizeTranscriptLineFull(assistantMsg(), ctx());
    expect(events).toEqual([]);
    expect(extras).toEqual({
      sessionId: SESSION,
      agentId: ORCHESTRATOR_ID,
      ts: Date.parse(TS),
      projectId: projectIdFor(CWD),
      projectName: 'proj-a',
      gitBranch: 'feature/x',
      model: 'claude-fake-1',
      usage: {
        key: 'msg_fake_1:req_fake_1',
        ts: Date.parse(TS),
        sessionId: SESSION,
        agentId: ORCHESTRATOR_ID,
        projectId: projectIdFor(CWD),
        projectName: 'proj-a',
        model: 'claude-fake-1',
        usage: { input: 10, output: 20, cacheCreation: 300, cacheRead: 4000 },
      },
    });
  });

  it('gives repeated content-block lines of one message the same dedupe key', () => {
    const a = normalizeTranscriptLineFull(assistantMsg(), ctx()).extras?.usage?.key;
    const b = normalizeTranscriptLineFull(
      assistantMsg({ content: [{ type: 'tool_use', id: 't9', name: 'Read', input: {} }] }),
      ctx(),
    ).extras?.usage?.key;
    expect(a).toBe('msg_fake_1:req_fake_1');
    expect(b).toBe(a);
  });

  it('keys by message id alone without requestId, and skips usage without message id', () => {
    const noReq = normalizeTranscriptLineFull(assistantMsg({}, { requestId: undefined }), ctx());
    expect(noReq.extras?.usage?.key).toBe('msg_fake_1');
    const noId = normalizeTranscriptLineFull(assistantMsg({ id: undefined }), ctx());
    expect(noId.extras?.usage).toBeUndefined();
    expect(noId.extras?.model).toBe('claude-fake-1');
  });

  it("stamps usage with the file's rank, on both parse paths", () => {
    const ranked = { ...ctx(), usageRank: 1234 };
    expect(normalizeTranscriptLineFull(assistantMsg({}), ranked).extras?.usage?.rank).toBe(1234);
    expect(transcriptUsageOnly(assistantMsg({}), ranked)?.usage?.rank).toBe(1234);
    expect(normalizeTranscriptLineFull(assistantMsg({}), ctx()).extras?.usage).not.toHaveProperty(
      'rank',
    );
  });

  it('treats missing, negative and non-numeric token counts as 0', () => {
    const { extras } = normalizeTranscriptLineFull(
      assistantMsg({ usage: { input_tokens: -5, output_tokens: 'x', cache_read_input_tokens: 7 } }),
      ctx(),
    );
    expect(extras?.usage?.usage).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 7 });
    const fromDetail = normalizeTranscriptLineFull(
      assistantMsg({
        usage: { output_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 9 } },
      }),
      ctx(),
    );
    expect(fromDetail.extras?.usage?.usage.cacheCreation).toBe(9);
    const none = normalizeTranscriptLineFull(assistantMsg({ usage: 'garbage' }), ctx());
    expect(none.extras?.usage).toBeUndefined();
  });

  it('ignores synthetic and all-zero usage', () => {
    const syn = normalizeTranscriptLineFull(assistantMsg({ model: '<synthetic>' }), ctx());
    expect(syn.extras?.model).toBeUndefined();
    expect(syn.extras?.usage).toBeUndefined();
    const zero = normalizeTranscriptLineFull(assistantMsg({ usage: { input_tokens: 0 } }), ctx());
    expect(zero.extras?.usage).toBeUndefined();
  });

  it('attributes subagent usage to the parent session', () => {
    const { extras } = normalizeTranscriptLineFull(
      assistantMsg({}, { agentId: 'agent-sub1', isSidechain: true }),
      ctx(),
    );
    expect(extras?.usage).toMatchObject({ sessionId: SESSION, agentId: 'sub1' });
  });

  it('still returns extras (without project) when no cwd is known', () => {
    const l = JSON.stringify({
      type: 'assistant',
      timestamp: TS,
      sessionId: SESSION,
      message: { id: 'm', model: 'claude-fake-1', content: [], usage: USAGE },
    });
    const { events, extras } = normalizeTranscriptLineFull(l, ctx({ cwd: undefined }));
    expect(events).toEqual([]);
    expect(extras?.projectId).toBeUndefined();
    expect(extras?.usage?.projectId).toBe('unknown');
  });

  it.each([
    'mode',
    'permission-mode',
    'file-history-snapshot',
    'file-history-delta',
    'last-prompt',
    'api-request',
    'api-request-shape',
    'api-request-blob',
    'ai-title',
    'queue-operation',
    'cost-state',
    'atis-latch',
    'brand-new-type',
  ])('silently ignores %s lines', (type) => {
    const l = line({ type, message: { id: 'm', model: 'x', content: [], usage: USAGE } });
    expect(normalizeTranscriptLineFull(l, ctx())).toEqual({ events: [], extras: null });
  });

  it.each([
    '',
    '{"type": "assistant", "timestamp": "2026-01-01T10:00:00.000Z", "message": {"id": "msg_tr',
    '{not json',
    'null',
    '[]',
    JSON.stringify({ type: 'assistant', timestamp: 'nope', message: {} }),
  ])('is total on malformed line %#', (l) => {
    expect(normalizeTranscriptLineFull(l, ctx())).toEqual({ events: [], extras: null });
    expect(transcriptUsageOnly(l, ctx())).toBeNull();
  });

  it('reads gitBranch from user, system and attachment lines too', () => {
    for (const type of ['user', 'system', 'attachment']) {
      const { extras } = normalizeTranscriptLineFull(
        line({ type, gitBranch: 'dev', message: { role: 'user', content: [] } }),
        ctx(),
      );
      expect(extras?.gitBranch).toBe('dev');
    }
  });
});

describe('typed prompts', () => {
  const prompt = (content: unknown, extra: Record<string, unknown> = {}): string =>
    user(content, { promptId: 'pr-1', ...extra });
  const kinds = (l: string, c = ctx()): string[] =>
    normalizeTranscriptLine(l, c).map((e) => e.kind);

  it('uses promptId for the event id so hook and transcript dedupe', () => {
    const [ev] = normalizeTranscriptLine(prompt('hello', { promptSource: 'typed' }), ctx());
    expect(ev).toMatchObject({ kind: 'user_prompt', id: `${SESSION}:prompt:pr-1` });
  });

  it('accepts string content and text-only block arrays', () => {
    expect(kinds(prompt('hello'))).toEqual(['user_prompt']);
    expect(
      kinds(
        prompt([
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ]),
      ),
    ).toEqual(['user_prompt']);
  });

  it('rejects meta, system, tool_result, mixed, empty and command lines', () => {
    expect(kinds(prompt('x', { isMeta: true }))).toEqual([]);
    expect(kinds(prompt('x', { promptSource: 'system' }))).toEqual([]);
    expect(kinds(prompt([{ type: 'tool_result', tool_use_id: 't1' }]))).toEqual(['tool_end']);
    expect(
      kinds(
        prompt([
          { type: 'text', text: 'x' },
          { type: 'tool_result', tool_use_id: 't2' },
        ]),
      ),
    ).toEqual(['tool_end']);
    expect(kinds(prompt([{ type: 'text', text: 'x' }, { type: 'image' }]))).toEqual([]);
    expect(kinds(prompt('   '))).toEqual([]);
    expect(kinds(prompt([]))).toEqual([]);
    expect(kinds(prompt('<command-name>/model</command-name>'))).toEqual([]);
    expect(kinds(prompt('<local-command-stdout>fake</local-command-stdout>'))).toEqual([]);
  });

  it('an interrupted turn is no prompt, it ends the turn for the lead only', () => {
    const interrupted = '[Request interrupted by user]';
    const forTool = '[Request interrupted by user for tool use]';
    const [ev, ...rest] = normalizeTranscriptLine(
      prompt([{ type: 'text', text: interrupted }]),
      ctx(),
    );
    expect(rest).toEqual([]);
    expect(ev).toMatchObject({ kind: 'idle', id: `${SESSION}:idle:u1`, agentId: ORCHESTRATOR_ID });
    expect(kinds(prompt(forTool))).toEqual(['idle']);
    expect(kinds(prompt(interrupted, { isSidechain: true }))).toEqual([]);
    expect(kinds(prompt(interrupted, { agentId: 'agent-s1' }))).toEqual([]);
    expect(kinds(prompt(interrupted), ctx({ agentId: 's1' }))).toEqual([]);
  });

  it('only counts orchestrator prompts (a subagent task prompt is not the user typing)', () => {
    expect(kinds(prompt('do the thing', { agentId: 'agent-s1' }))).toEqual([]);
    expect(kinds(prompt('do the thing'), ctx({ agentId: 's1' }))).toEqual([]);
  });

  it('attaches no preview by default', () => {
    const { extras } = normalizeTranscriptLineFull(prompt('my plan'), ctx());
    expect(extras?.promptPreview).toBeUndefined();
    expect(JSON.stringify(extras)).not.toContain('my plan');
  });

  it('previews are redacted, collapsed and truncated when opted in', () => {
    const text = `Use   api_key=FAKEKEY123456 and\n\n sk-fakefakefake123 then ${'word '.repeat(60)}`;
    const { events, extras } = normalizeTranscriptLineFull(
      prompt(text),
      ctx({ promptPreview: true }),
    );
    const pv = extras?.promptPreview ?? '';
    expect(pv.startsWith('Use api_key=••• and ••• then word')).toBe(true);
    expect(pv).not.toContain('FAKEKEY123456');
    expect(pv).not.toContain('sk-fakefakefake123');
    expect(pv.length).toBe(PROMPT_PREVIEW_MAX);
    expect(pv.endsWith('…')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('Use');
    const short = normalizeTranscriptLineFull(prompt('fix it'), ctx({ promptPreview: true }));
    expect(short.extras?.promptPreview).toBe('fix it');
  });
});

describe('transcriptUsageOnly', () => {
  it('returns usage, model and branch for assistant lines', () => {
    const x = transcriptUsageOnly(assistantMsg(), ctx());
    expect(x).toMatchObject({
      sessionId: SESSION,
      model: 'claude-fake-1',
      gitBranch: 'feature/x',
      usage: { key: 'msg_fake_1:req_fake_1', usage: { input: 10 } },
    });
  });

  it('skips lines without usage, non-assistant lines and prompts', () => {
    expect(transcriptUsageOnly(user('the usage of "assistant" words'), ctx())).toBeNull();
    expect(transcriptUsageOnly(assistant([{ type: 'text', text: 'x' }]), ctx())).toBeNull();
    expect(transcriptUsageOnly(line({ type: 'cost-state', usage: 1 }), ctx())).toBeNull();
  });
});

describe('synthetic dashboard fixture', () => {
  const file = join(import.meta.dirname, 'fixtures', 'transcripts', '_dashboard');
  const lines = readFileSync(join(file, 'dashboard-session.ndjson'), 'utf8').split('\n');
  const c = ctx({ sessionId: 'unused', cwd: undefined, promptPreview: false });

  it('yields one prompt, one usage per API message and no secrets', () => {
    const results = lines.map((l) => normalizeTranscriptLineFull(l, c));
    const events = results.flatMap((r) => r.events);
    expect(events.map((e) => e.kind)).toEqual([
      'user_prompt',
      'tool_start',
      'tool_end',
      'idle',
      'idle',
    ]);
    expect(events[0]?.id).toBe('44444444-4444-4444-8444-444444444444:prompt:prompt-0001');
    const keys = results.flatMap((r) => (r.extras?.usage ? [r.extras.usage.key] : []));
    expect(keys).toEqual([
      'msg_fake_0001:req_fake_0001',
      'msg_fake_0001:req_fake_0001',
      'msg_fake_0001:req_fake_0001',
      'msg_fake_0002:req_fake_0002',
    ]);
    expect(new Set(keys).size).toBe(2);
    const dump = JSON.stringify(results);
    for (const secret of ['FAKE_SECRET_VALUE_123', 'FAKE_BEARER_abcdef123456', 'Deploy with']) {
      expect(dump).not.toContain(secret);
    }
    const fast = lines.map((l) => transcriptUsageOnly(l, c)).filter((x) => x !== null);
    expect(fast.map((x) => x.usage?.key)).toEqual(keys);
  });
});
