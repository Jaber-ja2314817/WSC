import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionLedger, WAITING_CAP_MS, describeStep } from '../src/shared/dashboard';
import type { DashboardOptions, TranscriptExtras, UsageRecord } from '../src/shared/dashboardTypes';
import { normalizeHookPayload } from '../src/shared/normalizer/hook';
import { normalizeTranscriptLineFull } from '../src/shared/normalizer/transcript';
import { StationStore } from '../src/shared/store';
import {
  ORCHESTRATOR_ID,
  type StationEvent,
  type StationSnapshot,
  type ToolCategory,
} from '../src/shared/types';
import { ev, resetSeq, tool } from './fixtures/events';

const MIN = 60_000;
const IDLE = 10 * MIN;
const EMPTY: StationSnapshot = {
  projects: {},
  sessions: {},
  agents: {},
  log: [],
  eventsReceived: 0,
};
const opts = (now: number, over: Partial<DashboardOptions> = {}): DashboardOptions => ({
  now,
  idleMs: IDLE,
  windowMs: 5 * 60 * MIN,
  ...over,
});

const toolStart = (
  name: string,
  category: ToolCategory,
  summary: string,
  useId: string,
  over: Partial<StationEvent> = {},
): StationEvent =>
  ev({ kind: 'tool_start', tool: tool(name, category, { summary, useId }), ...over });

const usageRec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  key: 'msg_fake_1:req_fake_1',
  ts: 1_000,
  sessionId: 'sess-1',
  agentId: ORCHESTRATOR_ID,
  projectId: 'proj-a',
  projectName: 'project-a',
  model: 'claude-fake-1',
  usage: { input: 10, output: 20, cacheCreation: 30, cacheRead: 40 },
  ...over,
});
const extra = (over: Partial<TranscriptExtras> = {}): TranscriptExtras => ({
  sessionId: 'sess-1',
  agentId: ORCHESTRATOR_ID,
  ts: 1_000,
  projectId: 'proj-a',
  projectName: 'project-a',
  ...over,
});

beforeEach(() => resetSeq());

describe('describeStep', () => {
  it.each([
    ['Edit', 'app.ts', 'Editing app.ts'],
    ['Write', 'new.ts', 'Editing new.ts'],
    ['MultiEdit', 'a.ts', 'Editing a.ts'],
    ['NotebookEdit', 'n.ipynb', 'Editing n.ipynb'],
    ['Bash', 'npm test', 'Running npm test'],
    ['Read', 'auth.ts', 'Reading auth.ts'],
    ['Grep', 'TODO', 'Searching TODO'],
    ['Glob', '**/*.ts', 'Searching **/*.ts'],
    ['WebFetch', 'example.org', 'Browsing example.org'],
    ['WebSearch', 'pixel art', 'Browsing pixel art'],
    ['TodoWrite', undefined, 'TodoWrite'],
    ['Skill', 'x', 'Skill x'],
    ['mcp__db__query', 'db: query', 'db: query'],
  ])('%s → %s', (name, summary, text) => {
    const t = summary === undefined ? { name } : { name, summary };
    expect(describeStep({ status: 'working', tool: t })).toBe(text);
  });

  it('aggregates reads, names spawned agents and covers non-working states', () => {
    expect(describeStep({ status: 'working', tool: { name: 'Read' }, readCount: 3 })).toBe(
      'Reading 3 files',
    );
    expect(
      describeStep({ status: 'working', tool: { name: 'Task', summary: 's', label: 'Explore' } }),
    ).toBe('Spawned Explore');
    expect(describeStep({ status: 'working', tool: { name: 'Agent' } })).toBe('Spawned agent');
    expect(describeStep({ status: 'working' })).toBe('Thinking');
    expect(describeStep({ status: 'waiting' })).toBe('Waiting for you');
    expect(describeStep({ status: 'waiting', turnEnded: true })).toBe('Your turn');
    expect(describeStep({ status: 'idle' })).toBe('Idle');
    expect(describeStep({ status: 'ended' })).toBe('Ended');
  });
});

describe('SessionLedger — sessions and dedupe', () => {
  it('dedupes events by id per session and reports changes', () => {
    const l = new SessionLedger();
    const e = ev({ kind: 'session_start', ts: 100 });
    expect(l.applyEvents([e])).toBe(true);
    expect(l.applyEvents([e, { ...e }])).toBe(false);
    expect(l.timeline('sess-1')).toHaveLength(1);
    expect(l.applyEvents([null as unknown as StationEvent, { ...e, id: '' }])).toBe(false);
  });

  it('tracks start/last activity, fixed project, branch, models and usage', () => {
    const l = new SessionLedger();
    l.applyEvents([ev({ kind: 'user_prompt', ts: 5_000 })]);
    l.applyExtras([
      extra({ ts: 3_000, gitBranch: 'main' }),
      extra({ ts: 6_000, gitBranch: 'feature', model: 'claude-fake-1', usage: usageRec() }),
      extra({ ts: 6_000, model: 'claude-fake-1', usage: usageRec() }), // repeat line
      extra({
        ts: 7_000,
        agentId: 'sub1',
        projectId: 'proj-other',
        model: 'claude-fake-2',
        usage: usageRec({ key: 'k2', agentId: 'sub1', model: 'claude-fake-2' }),
      }),
      extra({
        ts: 7_500,
        model: 'claude-fake-2',
        usage: usageRec({ key: 'k3', model: 'claude-fake-2' }),
      }),
    ]);
    const [s] = l.snapshot(EMPTY, opts(8_000)).sessions;
    expect(s).toMatchObject({
      id: 'sess-1',
      shortId: 'sess-1',
      projectId: 'proj-a',
      projectName: 'project-a',
      gitBranch: 'feature',
      startedAt: 3_000,
      lastActivityAt: 7_500,
      models: ['claude-fake-2', 'claude-fake-1'],
      usage: { input: 30, output: 60, cacheCreation: 90, cacheRead: 120 },
    });
    expect(Object.keys(s?.usageByModel ?? {})).toEqual(['claude-fake-1', 'claude-fake-2']);
    expect(s?.costUsd).toBeUndefined();
  });

  it('omits usageByModel for a single model and prices sessions when all models are priced', () => {
    const l = new SessionLedger();
    l.applyExtras([
      extra({
        model: 'claude-fake-1',
        usage: usageRec({ usage: { input: 1e6, output: 0, cacheCreation: 0, cacheRead: 0 } }),
      }),
    ]);
    const p = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
    const [s] = l.snapshot(EMPTY, opts(2_000, { prices: { 'fake-1': p } })).sessions;
    expect(s?.usageByModel).toBeUndefined();
    expect(s?.costUsd).toBeCloseTo(3);
  });

  it('keeps two concurrent sessions in two projects apart', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'user_prompt', ts: 1_000, sessionId: 'sa', projectId: 'pa', projectName: 'A' }),
      ev({ kind: 'user_prompt', ts: 1_100, sessionId: 'sb', projectId: 'pb', projectName: 'B' }),
      toolStart('Bash', 'execute', 'npm test', 'u1', { sessionId: 'sa', ts: 1_200 }),
      toolStart('Edit', 'write', 'b.ts', 'u2', { sessionId: 'sb', ts: 1_300 }),
      // a later cd does not move the session
      ev({
        kind: 'tool_end',
        ts: 1_400,
        sessionId: 'sb',
        projectId: 'pc',
        tool: tool('Edit', 'write', { useId: 'u2', ok: true }),
      }),
    ]);
    const snap = l.snapshot(EMPTY, opts(2_000));
    const byId = Object.fromEntries(snap.sessions.map((s) => [s.id, s]));
    expect(byId['sa']).toMatchObject({ projectId: 'pa', currentStep: 'Running npm test' });
    expect(byId['sb']).toMatchObject({ projectId: 'pb', currentStep: 'Thinking' });
    expect(l.timeline('sa').map((t) => t.kind)).toEqual(['tool', 'prompt']);
    expect(l.timeline('sb')[0]).toMatchObject({ kind: 'tool', ok: true });
  });
});

describe('SessionLedger — timeline', () => {
  it('maps every event kind and only updates ok on tool_end', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'session_start', ts: 1 }),
      ev({ kind: 'user_prompt', ts: 2 }),
      toolStart('Read', 'read', 'auth.ts', 'r1', { ts: 3 }),
      ev({ kind: 'tool_end', ts: 4, tool: tool('Read', 'read', { useId: 'r1', ok: false }) }),
      ev({ kind: 'agent_spawn', ts: 5, agentId: 'sub1', label: 'researcher' }),
      toolStart('Grep', 'search', 'TODO', 'g1', { ts: 6, agentId: 'sub1' }),
      ev({ kind: 'agent_finish', ts: 7, agentId: 'sub1' }),
      ev({ kind: 'waiting_for_user', ts: 8, tool: tool('Bash', 'execute') }),
      ev({ kind: 'compacting', ts: 9 }),
      ev({ kind: 'agent_error', ts: 10, agentId: 'sub2' }),
      ev({ kind: 'idle', ts: 11 }),
      ev({ kind: 'idle', ts: 11, agentId: 'sub1' }), // subagent idle: no step
      ev({ kind: 'session_end', ts: 12 }),
    ]);
    const steps = l.timeline('sess-1');
    expect(steps.map((s) => [s.kind, s.text])).toEqual([
      ['end', 'session ended'],
      ['turn_end', 'Turn finished'],
      ['error', 'error'],
      ['compact', 'compacting context'],
      ['wait', 'waiting for you · Bash'],
      ['subagent_done', 'finished'],
      ['tool', 'Grep · TODO'],
      ['subagent', 'spawned researcher'],
      ['tool', 'Read · auth.ts'],
      ['prompt', 'New prompt'],
      ['start', 'session started'],
    ]);
    expect(steps.find((s) => s.text === 'Read · auth.ts')?.ok).toBe(false);
    expect(steps.find((s) => s.kind === 'subagent')).toMatchObject({
      agentId: 'sub1',
      agentLabel: 'researcher',
    });
    expect(steps.find((s) => s.kind === 'prompt')?.agentLabel).toBeUndefined();
    expect(l.timeline('sess-1', 2).map((s) => s.kind)).toEqual(['end', 'turn_end']);
    expect(l.timeline('nope')).toEqual([]);
  });

  it('sorts out-of-order events and applies an early tool_end when its start arrives', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'tool_end', ts: 30, tool: tool('Bash', 'execute', { useId: 'b1', ok: false }) }),
      ev({ kind: 'idle', ts: 40 }),
      ev({ kind: 'user_prompt', ts: 10 }),
      toolStart('Bash', 'execute', 'make', 'b1', { ts: 20 }),
    ]);
    const steps = l.timeline('sess-1');
    expect(steps.map((s) => s.ts)).toEqual([40, 20, 10]);
    expect(steps[1]?.ok).toBe(false);
    // The late prompt does not override the later turn end.
    expect(l.snapshot(EMPTY, opts(100)).sessions[0]?.currentStep).toBe('Your turn');
  });

  it('collapses hook + transcript copies of one prompt and turn end (±10 s)', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'user_prompt', ts: 10_500, id: 'hook-prompt', source: 'hook' }),
      ev({ kind: 'user_prompt', ts: 10_000, id: 'tx-prompt', source: 'transcript' }),
      ev({ kind: 'idle', ts: 30_000, id: 'tx-idle', source: 'transcript' }),
      ev({ kind: 'idle', ts: 31_000, id: 'hook-idle', source: 'hook' }),
      ev({ kind: 'idle', ts: 31_000, agentId: 'sub1' }),
      // a real second turn, well apart
      ev({ kind: 'user_prompt', ts: 60_000, id: 'hook-prompt-2', source: 'hook' }),
    ]);
    const steps = l.timeline('sess-1');
    expect(steps.map((s) => [s.kind, s.ts])).toEqual([
      ['prompt', 60_000],
      ['turn_end', 30_000],
      ['prompt', 10_000],
    ]);
  });

  it('keeps quick consecutive turns from one source apart', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'user_prompt', ts: 0, id: 'tx-p1', source: 'transcript' }),
      ev({ kind: 'idle', ts: 2_000, id: 'tx-i1', source: 'transcript' }),
      ev({ kind: 'user_prompt', ts: 4_000, id: 'tx-p2', source: 'transcript' }),
      ev({ kind: 'idle', ts: 7_000, id: 'tx-i2', source: 'transcript' }),
      // The hook's copies of both turns still collapse into them, one each.
      ev({ kind: 'user_prompt', ts: 300, id: 'hook-p1', source: 'hook' }),
      ev({ kind: 'user_prompt', ts: 4_200, id: 'hook-p2', source: 'hook' }),
    ]);
    expect(l.timeline('sess-1').map((s) => [s.kind, s.ts])).toEqual([
      ['turn_end', 7_000],
      ['prompt', 4_000],
      ['turn_end', 2_000],
      ['prompt', 0],
    ]);
  });

  it('caps the timeline per session, dropping the oldest', () => {
    const l = new SessionLedger({ timelineCap: 5 });
    l.applyEvents(
      Array.from({ length: 12 }, (_, i) => toolStart('Bash', 'execute', `c${i}`, `u${i}`)),
    );
    const steps = l.timeline('sess-1');
    expect(steps).toHaveLength(5);
    expect(steps[0]?.text).toBe('Bash · c11');
    expect(steps[4]?.text).toBe('Bash · c7');
  });
});

describe('SessionLedger — timeline under many subagents', () => {
  const subTool = (i: number): StationEvent =>
    toolStart('Read', 'read', 'a.ts', `u${i}`, { ts: 2_000 + i, agentId: `a${i % 7}` });

  it("subagents don't flood the lead's steps out of the timeline", () => {
    const l = new SessionLedger({ timelineCap: 10 });
    l.applyEvents([ev({ kind: 'user_prompt', ts: 1_000 })]);
    l.applyEvents(Array.from({ length: 50 }, (_, i) => subTool(i)));
    const steps = l.timeline('sess-1');
    expect(steps).toHaveLength(10);
    expect(steps.at(-1)?.kind).toBe('prompt');
    expect(steps[0]?.ts).toBe(2_049);
  });

  it("the lead's steps give way once they hold half the cap", () => {
    const l = new SessionLedger({ timelineCap: 4 });
    l.applyEvents([1, 2, 3].map((n) => ev({ kind: 'user_prompt', ts: 1_000 + n * 20_000 })));
    l.applyEvents([subTool(100000), subTool(100001)]);
    const steps = l.timeline('sess-1');
    expect(steps).toHaveLength(4);
    expect(steps.filter((s) => s.agentId === ORCHESTRATOR_ID)).toHaveLength(2);
  });
});

describe('SessionLedger — status', () => {
  const T = 1_000_000;
  const statusOf = (l: SessionLedger, now: number, station = EMPTY): string | undefined =>
    l.snapshot(station, opts(now)).sessions[0]?.status;

  it('ended from the ledger, reopened by a later prompt', () => {
    const l = new SessionLedger();
    l.applyEvents([ev({ kind: 'user_prompt', ts: T }), ev({ kind: 'session_end', ts: T + 5 })]);
    expect(statusOf(l, T + 10)).toBe('ended');
    expect(l.snapshot(EMPTY, opts(T + 10)).sessions[0]).toMatchObject({
      endedAt: T + 5,
      currentStep: 'Ended',
    });
    // a late tool_end (async hook) does not reopen it
    l.applyEvents([ev({ kind: 'tool_end', ts: T + 7, tool: tool('Bash', 'execute') })]);
    expect(statusOf(l, T + 10)).toBe('ended');
    l.applyEvents([ev({ kind: 'user_prompt', ts: T + 20 })]);
    expect(statusOf(l, T + 21)).toBe('working');
  });

  it('ended when the store says so', () => {
    const l = new SessionLedger();
    const store = new StationStore();
    const evs = [ev({ kind: 'user_prompt', ts: T })];
    l.applyEvents(evs);
    store.applyMany(evs);
    const snap = store.snapshot();
    snap.sessions['sess-1']!.endedAt = T + 1;
    expect(statusOf(l, T + 2, snap)).toBe('ended');
  });

  it('store: waiting beats working; working/thinking/stale-but-recent count as working', () => {
    const l = new SessionLedger();
    const store = new StationStore({ staleMs: 60_000 });
    const evs = [
      ev({ kind: 'user_prompt', ts: T }),
      toolStart('Edit', 'write', 'app.ts', 'e1', { ts: T + 1 }),
      ev({ kind: 'agent_spawn', ts: T + 2, agentId: 'sub1', label: 'Explore' }),
    ];
    l.applyEvents(evs);
    store.applyMany(evs);
    expect(statusOf(l, T + 3, store.snapshot())).toBe('working');
    expect(l.snapshot(store.snapshot(), opts(T + 3)).sessions[0]?.currentStep).toBe(
      'Editing app.ts',
    );
    const wait = ev({ kind: 'waiting_for_user', ts: T + 4, agentId: 'sub1' });
    l.applyEvents([wait]);
    store.apply(wait);
    const s = l.snapshot(store.snapshot(), opts(T + 5)).sessions[0];
    expect(s).toMatchObject({ status: 'waiting', currentStep: 'Waiting for you' });
    expect(s?.subagents).toEqual([
      { id: 'sub1', label: 'Explore', status: 'waiting', toolCalls: 0 },
    ]);
  });

  it('store: a waiting agent stops counting once the session has been silent for a day', () => {
    const l = new SessionLedger();
    const store = new StationStore();
    const evs = [ev({ kind: 'waiting_for_user', ts: T })];
    l.applyEvents(evs);
    store.applyMany(evs);
    const at = (now: number) =>
      l.snapshot(store.snapshot(), opts(now, { sessionHorizonMs: 7 * WAITING_CAP_MS })).sessions[0];
    expect(at(T + WAITING_CAP_MS - 1)?.status).toBe('waiting');
    expect(at(T + WAITING_CAP_MS)).toMatchObject({ status: 'idle', currentStep: 'Idle' });
    expect(at(T + 3 * WAITING_CAP_MS)?.status).toBe('idle');
  });

  it('a compaction finishing mid-turn is not a turn end', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'user_prompt', ts: T }),
      ev({ kind: 'compacting', ts: T + 1 }),
      ev({ kind: 'idle', ts: T + 2, idleReason: 'compact' }),
    ]);
    expect(statusOf(l, T + 3)).toBe('working');
    expect(l.snapshot(EMPTY, opts(T + 3)).sessions[0]?.currentStep).not.toBe('Your turn');
    expect(l.timeline('sess-1').some((s) => s.kind === 'turn_end')).toBe(false);
  });

  it('a compaction between turns goes back to the turn it interrupted', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'user_prompt', ts: T }),
      ev({ kind: 'idle', ts: T + 1 }),
      ev({ kind: 'compacting', ts: T + 2, source: 'hook' }),
      ev({ kind: 'compacting', ts: T + 2, source: 'transcript' }),
      ev({ kind: 'idle', ts: T + 3, idleReason: 'compact' }),
    ]);
    expect(l.snapshot(EMPTY, opts(T + 4)).sessions[0]).toMatchObject({
      status: 'waiting',
      currentStep: 'Your turn',
    });
    expect(l.timeline('sess-1').filter((s) => s.kind === 'turn_end')).toHaveLength(1);
  });

  it('a compaction from an earlier turn does not leak into a later one', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'user_prompt', ts: T }),
      ev({ kind: 'idle', ts: T + 1 }),
      ev({ kind: 'compacting', ts: T + 2 }),
      ev({ kind: 'idle', ts: T + 3, idleReason: 'compact' }),
      ev({ kind: 'user_prompt', ts: T + 4 }),
      ev({ kind: 'compacting', ts: T + 5 }),
      ev({ kind: 'idle', ts: T + 6, idleReason: 'compact' }),
    ]);
    expect(statusOf(l, T + 7)).toBe('working');
  });

  it('stale store agents count as working only while recent', () => {
    const l = new SessionLedger();
    const store = new StationStore({ staleMs: 60_000 });
    const evs = [ev({ kind: 'user_prompt', ts: T }), toolStart('Bash', 'execute', 'sleep', 'b')];
    evs[1]!.ts = T + 1;
    l.applyEvents(evs);
    store.applyMany(evs);
    store.tick(T + 2 * MIN);
    expect(store.snapshot().agents['sess-1:orchestrator']?.status).toBe('stale');
    expect(statusOf(l, T + 2 * MIN, store.snapshot())).toBe('working');
    expect(l.snapshot(store.snapshot(), opts(T + 2 * MIN)).sessions[0]?.currentStep).toBe(
      'Running sleep',
    );
    expect(statusOf(l, T + IDLE + 1, store.snapshot())).toBe('idle');
  });

  it('turn ended → waiting ("Your turn") until idle', () => {
    const l = new SessionLedger();
    const store = new StationStore();
    const evs = [ev({ kind: 'user_prompt', ts: T }), ev({ kind: 'idle', ts: T + 1 })];
    l.applyEvents(evs);
    store.applyMany(evs);
    const s = l.snapshot(store.snapshot(), opts(T + 2)).sessions[0];
    expect(s).toMatchObject({ status: 'waiting', currentStep: 'Your turn' });
    expect(statusOf(l, T + 1 + IDLE)).toBe('idle');
  });

  it('ledger only: recent tool activity is working, then idle; waiting event is waiting', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'user_prompt', ts: T }),
      toolStart('Read', 'read', 'a.ts', 'r1', { ts: T + 1 }),
      toolStart('Read', 'read', 'b.ts', 'r2', { ts: T + 2 }),
      toolStart('Read', 'read', 'c.ts', 'r3', { ts: T + 3 }),
    ]);
    expect(l.snapshot(EMPTY, opts(T + 4)).sessions[0]).toMatchObject({
      status: 'working',
      currentStep: 'Reading 3 files',
      toolCalls: 3,
    });
    expect(statusOf(l, T + 3 + IDLE)).toBe('idle');
    l.applyEvents([ev({ kind: 'waiting_for_user', ts: T + 5 })]);
    expect(l.snapshot(EMPTY, opts(T + 6)).sessions[0]).toMatchObject({
      status: 'waiting',
      currentStep: 'Waiting for you',
    });
    // a new prompt resets the read run
    l.applyEvents([
      ev({ kind: 'user_prompt', ts: T + 7 }),
      toolStart('Read', 'read', 'd.ts', 'r4', { ts: T + 8 }),
    ]);
    expect(l.snapshot(EMPTY, opts(T + 9)).sessions[0]?.currentStep).toBe('Reading d.ts');
  });

  it('a fresh session with no prompt is idle', () => {
    const l = new SessionLedger();
    l.applyEvents([ev({ kind: 'session_start', ts: T })]);
    expect(statusOf(l, T + 1)).toBe('idle');
  });

  it('subagents fall back to ledger status, stale when quiet, done when the session ended', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'agent_spawn', ts: T, agentId: 'a1', label: 'one' }),
      toolStart('Bash', 'execute', 'x', 'u1', { ts: T + 1, agentId: 'a1' }),
      ev({ kind: 'agent_spawn', ts: T + 2, agentId: 'a2', label: 'two' }),
      ev({ kind: 'agent_finish', ts: T + 3, agentId: 'a2' }),
    ]);
    expect(l.snapshot(EMPTY, opts(T + 4)).sessions[0]?.subagents).toEqual([
      { id: 'a1', label: 'one', status: 'working', toolCalls: 1 },
      { id: 'a2', label: 'two', status: 'done', toolCalls: 0 },
    ]);
    expect(l.snapshot(EMPTY, opts(T + 1 + IDLE)).sessions[0]?.subagents[0]?.status).toBe('stale');
    l.applyEvents([ev({ kind: 'session_end', ts: T + 5 })]);
    expect(l.snapshot(EMPTY, opts(T + 6)).sessions[0]?.subagents[0]?.status).toBe('done');
  });
});

describe('SessionLedger — subagent hand-back', () => {
  it("the hand-back call's result after agent_finish keeps the subagent done", () => {
    const T = 1_000_000;
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'agent_spawn', ts: T, agentId: 'a1', label: 'one' }),
      toolStart('SubagentHandback', 'other', '', 'u-hb', { ts: T + 10, agentId: 'a1' }),
      ev({ kind: 'agent_finish', ts: T + 10, agentId: 'a1' }),
      ev({
        kind: 'tool_end',
        ts: T + 60,
        agentId: 'a1',
        tool: { name: 'SubagentHandback', category: 'other', useId: 'u-hb' },
      }),
    ]);
    expect(l.snapshot(EMPTY, opts(T + 100)).sessions[0]?.subagents[0]?.status).toBe('done');
  });

  it('one finish arriving twice around a tool result is one timeline step', () => {
    const T = 1_000_000;
    const FINISH = 'sess-1:agent:a1:finish';
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'agent_spawn', ts: T, agentId: 'a1', label: 'one' }),
      toolStart('SubagentHandback', 'other', '', 'u-hb', { ts: T + 30, agentId: 'a1' }),
      ev({ id: FINISH, kind: 'agent_finish', ts: T + 10, agentId: 'a1', source: 'transcript' }),
      ev({
        kind: 'tool_end',
        ts: T + 40,
        agentId: 'a1',
        tool: { name: 'SubagentHandback', category: 'other', useId: 'u-hb' },
      }),
      ev({ id: FINISH, kind: 'agent_finish', ts: T + 50, agentId: 'a1', source: 'hook' }),
    ]);
    const done = l.timeline('sess-1').filter((s) => s.kind === 'subagent_done');
    expect(done).toHaveLength(1);
  });

  it('a second id for a finish that already landed adds no step', () => {
    const T = 1_000_000;
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'agent_spawn', ts: T, agentId: 'a1', label: 'one' }),
      ev({ id: 'sess-1:agent:a1:finish', kind: 'agent_finish', ts: T + 10, agentId: 'a1' }),
      ev({ id: 'sess-1:agent:a1:finish:1', kind: 'agent_finish', ts: T + 11, agentId: 'a1' }),
    ]);
    const done = l.timeline('sess-1').filter((s) => s.kind === 'subagent_done');
    expect(done).toHaveLength(1);
  });

  it('a hand-back landing after agent_finish does not revive the subagent', () => {
    const T = 1_000_000;
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'agent_spawn', ts: T, agentId: 'a1', label: 'one' }),
      ev({ kind: 'agent_finish', ts: T + 10, agentId: 'a1' }),
      ev({
        kind: 'tool_start',
        ts: T + 20,
        agentId: 'a1',
        tool: { name: 'SubagentHandback', category: 'delegate', useId: 'u-hb', finalizing: true },
      }),
    ]);
    expect(l.snapshot(EMPTY, opts(T + 100)).sessions[0]?.subagents[0]?.status).toBe('done');
  });
});

describe('SessionLedger — resumed subagents', () => {
  const T = 1_000_000;
  const FINISH = 'sess-1:agent:a1:finish';
  const finish = (ts: number, source: StationEvent['source'] = 'hook'): StationEvent =>
    ev({ id: FINISH, kind: 'agent_finish', ts, agentId: 'a1', source });
  const statusOf = (l: SessionLedger, now: number): string | undefined =>
    l.snapshot(EMPTY, opts(now)).sessions[0]?.subagents[0]?.status;
  const doneSteps = (l: SessionLedger) =>
    l.timeline('sess-1').filter((s) => s.kind === 'subagent_done');

  it('a resumed subagent goes active on new work and finishes again with its fixed id', () => {
    const l = new SessionLedger();
    l.applyEvents([ev({ kind: 'agent_spawn', ts: T, agentId: 'a1', label: 'one' }), finish(T + 1)]);
    expect(statusOf(l, T + 2)).toBe('done');
    l.applyEvents([toolStart('Read', 'read', 'a.ts', 'u1', { ts: T + 10, agentId: 'a1' })]);
    expect(statusOf(l, T + 11)).toBe('working');
    expect(l.applyEvents([finish(T + 20)])).toBe(true);
    expect(statusOf(l, T + 21)).toBe('done');
    const ids = doneSteps(l).map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('the twin of a finish that landed still changes nothing', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'agent_spawn', ts: T, agentId: 'a1', label: 'one' }),
      finish(T + 1, 'transcript'),
    ]);
    expect(l.applyEvents([finish(T + 2)])).toBe(false);
    expect(doneSteps(l)).toHaveLength(1);
  });

  it('a finish rejected for being older is completed by its twin, with one step', () => {
    const l = new SessionLedger();
    l.applyEvents([
      ev({ kind: 'agent_spawn', ts: T, agentId: 'a1', label: 'one' }),
      toolStart('Read', 'read', 'a.ts', 'u1', { ts: T + 30, agentId: 'a1' }),
      finish(T + 10, 'transcript'),
    ]);
    expect(statusOf(l, T + 31)).toBe('working');
    l.applyEvents([finish(T + 40)]);
    expect(statusOf(l, T + 41)).toBe('done');
    expect(doneSteps(l)).toHaveLength(1);
  });

  it('an orchestrator event with a repeated id stays deduped', () => {
    const l = new SessionLedger();
    const e = ev({ kind: 'agent_finish', ts: T });
    l.applyEvents([e]);
    expect(l.applyEvents([{ ...e, ts: T + 1 }])).toBe(false);
  });
});

describe('SessionLedger — snapshot list', () => {
  it('sorts active first, applies the horizon and the max', () => {
    const now = 100 * 60 * MIN;
    const l = new SessionLedger();
    const at = (sessionId: string, kind: StationEvent['kind'], ts: number): StationEvent =>
      ev({ kind, ts, sessionId });
    l.applyEvents([
      at('idle-recent', 'session_start', now - 30 * MIN),
      at('ended', 'session_start', now - 3 * MIN),
      at('ended', 'session_end', now - 2 * MIN),
      at('work-old', 'user_prompt', now - 5 * MIN),
      at('work-new', 'user_prompt', now - MIN),
      at('ancient', 'session_start', now - 30 * 60 * MIN),
    ]);
    const snap = l.snapshot(EMPTY, opts(now));
    expect(snap.generatedAt).toBe(now);
    expect(snap.scanning).toBe(false);
    expect(snap.sessions.map((s) => s.id)).toEqual([
      'work-new',
      'work-old',
      'ended',
      'idle-recent',
    ]);
    expect(l.snapshot(EMPTY, opts(now, { maxSessions: 2 })).sessions).toHaveLength(2);
    expect(
      l.snapshot(EMPTY, opts(now, { sessionHorizonMs: 31 * 60 * MIN })).sessions.map((s) => s.id),
    ).toContain('ancient');
  });

  it('includes usage stats and prunes old sessions and usage', () => {
    const l = new SessionLedger();
    l.applyExtras([
      extra({ ts: 1_000, model: 'm', usage: usageRec({ ts: 1_000 }) }),
      extra({
        sessionId: 's2',
        ts: 50_000,
        model: 'm',
        usage: usageRec({ key: 'k2', ts: 50_000, sessionId: 's2' }),
      }),
    ]);
    expect(l.snapshot(EMPTY, opts(60_000)).usage.windowTotal).toBe(120); // cache reads not counted
    l.prune(60_000, 20_000);
    expect(l.usageBook.size).toBe(1);
    expect(l.snapshot(EMPTY, opts(60_000)).sessions.map((s) => s.id)).toEqual(['s2']);
  });
});

describe('SessionLedger — pruning', () => {
  it("a live session's card keeps its total as its oldest records age out", () => {
    const l = new SessionLedger();
    l.applyExtras([
      extra({ ts: 1_000, model: 'm', usage: usageRec({ ts: 1_000 }) }),
      extra({ ts: 50_000, model: 'm', usage: usageRec({ key: 'k2', ts: 50_000 }) }),
    ]);
    const card = () => l.snapshot(EMPTY, opts(60_000)).sessions[0]?.usage;
    const before = card();
    l.prune(60_000, 20_000);
    expect(l.usageBook.size).toBe(1);
    expect(card()).toEqual(before);
    expect(l.usageBook.sessionByModel('sess-1')).toEqual({
      'claude-fake-1': { input: 20, output: 40, cacheCreation: 60, cacheRead: 80 },
    });
  });

  it('releases the totals when the session itself goes', () => {
    const l = new SessionLedger();
    l.applyExtras([
      extra({ ts: 1_000, model: 'm', usage: usageRec({ ts: 1_000 }) }),
      extra({ ts: 50_000, model: 'm', usage: usageRec({ key: 'k2', ts: 50_000 }) }),
    ]);
    l.prune(60_000, 20_000);
    l.prune(200_000, 20_000);
    expect(l.usageBook.size).toBe(0);
    expect(l.usageBook.sessionUsage('sess-1').output).toBe(0);
  });
});

describe('SessionLedger — privacy', () => {
  const SECRET_PROMPT = 'deploy with password=FAKE_PROMPT_SECRET_42';
  const SECRET_CMD = 'curl -H "Authorization: Bearer FAKE_BEARER_TOKEN_9876543210" x';

  it('no prompt text or raw tool input reaches the snapshot or timeline (preview off)', () => {
    const hook = (name: string, extra: Record<string, unknown>) => ({
      session_id: 'sess-p',
      cwd: '/home/user/proj-p',
      hook_event_name: name,
      ...extra,
    });
    const events = [
      ...normalizeHookPayload(hook('UserPromptSubmit', { prompt: SECRET_PROMPT }), 1_000),
      ...normalizeHookPayload(
        hook('PreToolUse', {
          tool_name: 'Bash',
          tool_input: { command: SECRET_CMD },
          tool_use_id: 't1',
        }),
        1_001,
      ),
    ];
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 'sess-p',
      cwd: '/home/user/proj-p',
      promptId: 'p1',
      message: { role: 'user', content: SECRET_PROMPT },
    });
    const full = normalizeTranscriptLineFull(line, {
      sessionId: 'sess-p',
      agentId: ORCHESTRATOR_ID,
    });
    const l = new SessionLedger();
    l.applyEvents([...events, ...full.events]);
    l.applyExtras(full.extras ? [full.extras] : []);
    const dump = JSON.stringify([l.snapshot(EMPTY, opts(2_000)), l.timeline('sess-p')]);
    expect(dump).not.toContain('FAKE_PROMPT_SECRET_42');
    expect(dump).not.toContain('FAKE_BEARER_TOKEN_9876543210');
    expect(dump).not.toContain('deploy with');
  });

  it('previews are redacted and hidden when the option is false', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 'sess-p',
      cwd: '/home/user/proj-p',
      message: { role: 'user', content: SECRET_PROMPT },
    });
    const full = normalizeTranscriptLineFull(line, {
      sessionId: 'sess-p',
      agentId: ORCHESTRATOR_ID,
      promptPreview: true,
    });
    const l = new SessionLedger();
    l.applyExtras(full.extras ? [full.extras] : []);
    const now = Date.parse('2026-01-01T00:01:00.000Z');
    const shown = l.snapshot(EMPTY, opts(now)).sessions[0]?.promptPreview;
    expect(shown).toBe('deploy with password=•••');
    const hidden = l.snapshot(EMPTY, opts(now, { showPromptPreview: false }));
    expect(JSON.stringify(hidden)).not.toContain('deploy with');
  });

  it('the synthetic fixture yields one usage per API message', () => {
    const file = join(
      import.meta.dirname,
      'fixtures',
      'transcripts',
      '_dashboard',
      'dashboard-session.ndjson',
    );
    const ctx = { sessionId: 'x', agentId: ORCHESTRATOR_ID, toolNames: new Map<string, string>() };
    const results = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => normalizeTranscriptLineFull(l, ctx));
    const l = new SessionLedger();
    l.applyEvents(results.flatMap((r) => r.events));
    l.applyExtras(results.flatMap((r) => (r.extras ? [r.extras] : [])));
    const now = Date.parse('2026-01-01T12:10:00.000Z');
    const snap = l.snapshot(EMPTY, opts(now));
    const [s] = snap.sessions;
    expect(s).toMatchObject({
      projectName: 'proj-dash',
      gitBranch: 'main',
      models: ['claude-fake-model-1'],
      usage: { input: 15, output: 27, cacheCreation: 300, cacheRead: 4000 },
      status: 'waiting',
      currentStep: 'Your turn',
      toolCalls: 1,
    });
    expect(snap.usage.windowTotal).toBe(342); // 4000 cache reads not counted
    expect(snap.usage.windowUsage.cacheRead).toBe(4000);
    expect(JSON.stringify([snap, l.timeline(s?.id ?? '')])).not.toMatch(
      /FAKE_SECRET_VALUE_123|FAKE_BEARER|Deploy with/,
    );
  });
});
