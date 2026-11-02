// Transcript watcher: startup scan, incremental reads and the station/dashboard wiring.
// All transcripts are SYNTHETIC (/home/user/... cwds, fake ids, fake output).
import { appendFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Station } from '../src/main/station';
import {
  classifyTranscriptPath,
  TranscriptWatcher,
  type WatcherBatch,
} from '../src/main/transcriptWatcher';
import type { TranscriptExtras } from '../src/shared/dashboardTypes';
import { ORCHESTRATOR_ID, type StationEvent } from '../src/shared/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();
const SA = 'aaaaaaaa-0000-4000-8000-000000000001';
const SB = 'bbbbbbbb-0000-4000-8000-000000000002';
const SC = 'cccccccc-0000-4000-8000-000000000003';
const PROJ = '-home-user-proj-a';
const CWD = '/home/user/proj-a';

const iso = (ms: number): string => new Date(ms).toISOString();

function toolUse(
  ts: number,
  sessionId: string,
  useId: string,
  name: string,
  input: Record<string, unknown>,
  msgId = `msg_${useId}`,
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${useId}`,
    timestamp: iso(ts),
    sessionId,
    cwd: CWD,
    requestId: `req_${useId}`,
    message: {
      id: msgId,
      role: 'assistant',
      model: 'fake-model-1',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
      content: [{ type: 'tool_use', id: useId, name, input }],
    },
  });
}

function toolResult(ts: number, sessionId: string, useId: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: `r-${useId}`,
    timestamp: iso(ts),
    sessionId,
    cwd: CWD,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: useId, content: 'fake output' }],
    },
  });
}

let root: string;
let batches: WatcherBatch[];
let watcher: TranscriptWatcher | null;

const events = (initial?: boolean): StationEvent[] =>
  batches.filter((b) => initial === undefined || b.initial === initial).flatMap((b) => b.events);
const extras = (initial?: boolean): TranscriptExtras[] =>
  batches.filter((b) => initial === undefined || b.initial === initial).flatMap((b) => b.extras);

const mainPath = (sid: string): string => join(root, PROJ, `${sid}.jsonl`);
const subDir = (sid: string): string => join(root, PROJ, sid, 'subagents');

async function writeLines(path: string, lines: string[], mtime = NOW - MIN): Promise<void> {
  await writeFile(path, lines.map((l) => `${l}\n`).join(''));
  await utimes(path, mtime / 1000, mtime / 1000);
}

function makeWatcher(extra: Partial<ConstructorParameters<typeof TranscriptWatcher>[0]> = {}) {
  watcher = new TranscriptWatcher({
    root,
    live: false,
    now: () => NOW,
    onBatch: (b) => batches.push(b),
    ...extra,
  });
  return watcher;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wsc-watch-'));
  await mkdir(join(root, PROJ), { recursive: true });
  batches = [];
  watcher = null;
});

afterEach(async () => {
  watcher?.close();
  await rm(root, { recursive: true, force: true });
});

describe('classifyTranscriptPath', () => {
  it('recognises orchestrator and subagent transcripts only', () => {
    expect(classifyTranscriptPath(root, mainPath(SA))).toEqual({
      kind: 'main',
      sessionId: SA,
      agentId: ORCHESTRATOR_ID,
    });
    expect(classifyTranscriptPath(root, join(subDir(SA), 'agent-ab12.jsonl'))).toEqual({
      kind: 'sub',
      sessionId: SA,
      agentId: 'ab12',
    });
    expect(classifyTranscriptPath(root, join(subDir(SA), 'agent-ab12.meta.json'))).toBeNull();
    expect(classifyTranscriptPath(root, '/elsewhere/x.jsonl')).toBeNull();
    expect(classifyTranscriptPath(root, join(root, 'x.jsonl'))).toBeNull();
  });
});

describe('TranscriptWatcher startup scan', () => {
  it('reads appends to an already scanned file live, before the scan ends', async () => {
    await writeLines(mainPath(SA), [
      toolUse(NOW - 2 * MIN, SA, 'toolu_a1', 'Read', { file_path: `${CWD}/a.ts` }),
    ]);
    await writeLines(
      mainPath(SB),
      [toolUse(NOW - 3 * HOUR, SB, 'toolu_b1', 'Read', { file_path: `${CWD}/b.ts` })],
      NOW - 3 * HOUR,
    );
    let appended = false;
    const w = makeWatcher({
      onBatch: (b) => {
        batches.push(b);
        if (appended) return;
        appended = true;
        // The newest file is read first. A change lands while it is being read, and one is
        // reported for a file the scan has yet to reach.
        appendFileSync(
          mainPath(SA),
          `${toolUse(Date.now(), SA, 'toolu_live', 'Bash', { command: 'npm test' })}\n`,
        );
        void w.flush(mainPath(SA));
        void w.flush(mainPath(SB));
      },
    });
    await w.start();
    expect(batches.map((b) => [b.initial, b.events.map((e) => e.tool?.useId).join(',')])).toEqual([
      [true, 'toolu_a1'],
      [false, 'toolu_live'],
      [true, 'toolu_b1'],
    ]);
  });

  it('respects the lookback and uses the usage-only path for files older than a day', async () => {
    // Recent: full parse. 3 days old: usage only. 10 days old: skipped.
    await writeLines(mainPath(SA), [
      toolUse(NOW - 2 * MIN, SA, 'toolu_a1', 'Read', { file_path: `${CWD}/a.ts` }),
    ]);
    await writeLines(
      mainPath(SB),
      [toolUse(NOW - 3 * DAY, SB, 'toolu_b1', 'Bash', { command: 'npm test' })],
      NOW - 3 * DAY,
    );
    await writeLines(
      mainPath(SC),
      [toolUse(NOW - 10 * DAY, SC, 'toolu_c1', 'Bash', { command: 'ls' })],
      NOW - 10 * DAY,
    );
    const scanning: boolean[] = [];
    const w = makeWatcher({ lookbackDays: 7, onScanning: (s) => scanning.push(s) });
    await w.start();

    expect(scanning).toEqual([true, false]);
    expect(w.scanning).toBe(false);
    expect(batches.every((b) => b.initial)).toBe(true);
    const evs = events();
    expect(evs.map((e) => e.sessionId)).toEqual([SA]);
    expect(evs[0]).toMatchObject({ kind: 'tool_start', agentId: ORCHESTRATOR_ID });
    const xs = extras();
    expect(new Set(xs.map((x) => x.sessionId))).toEqual(new Set([SA, SB]));
    expect(xs.find((x) => x.sessionId === SB)?.usage?.usage).toEqual({
      input: 10,
      output: 20,
      cacheCreation: 30,
      cacheRead: 40,
    });
  });

  it('a missing root is not an error', async () => {
    const w = makeWatcher({ root: join(root, 'nope') });
    await w.start();
    await w.poll();
    expect(batches).toEqual([]);
  });
});

describe('TranscriptWatcher incremental reads', () => {
  it('picks up appended lines, completing a partial last line later', async () => {
    await writeLines(mainPath(SA), [
      toolUse(NOW - 5 * MIN, SA, 'toolu_1', 'Read', { file_path: `${CWD}/a.ts` }),
    ]);
    const w = makeWatcher();
    await w.start();
    batches = [];

    const line = toolUse(NOW - MIN, SA, 'toolu_2', 'Grep', { pattern: 'fake' });
    await appendFile(mainPath(SA), line.slice(0, 40));
    await w.poll();
    expect(events()).toEqual([]);

    await appendFile(mainPath(SA), `${line.slice(40)}\n${toolResult(NOW, SA, 'toolu_2')}\n`);
    await w.poll();
    const evs = events(false);
    expect(evs.map((e) => e.id)).toEqual([`${SA}:tool:toolu_2:start`, `${SA}:tool:toolu_2:end`]);
    // The tool name carried over from the earlier line in the same file.
    expect(evs[1]?.tool?.name).toBe('Grep');
    expect(batches.every((b) => !b.initial)).toBe(true);

    // Nothing new: nothing emitted.
    batches = [];
    await w.poll();
    expect(batches).toEqual([]);
  });

  it('skips malformed lines', async () => {
    await writeLines(mainPath(SA), [
      '{this is not json',
      toolUse(NOW - 2 * MIN, SA, 'toolu_ok', 'Read', { file_path: `${CWD}/a.ts` }),
      '"just a string"',
      '\u0000\u0001 binary junk',
    ]);
    const w = makeWatcher();
    await w.start();
    expect(events().map((e) => e.id)).toEqual([`${SA}:tool:toolu_ok:start`]);
  });

  it('restarts from the beginning when a file is truncated', async () => {
    await writeLines(mainPath(SA), [
      toolUse(NOW - 3 * MIN, SA, 'toolu_1', 'Read', { file_path: `${CWD}/a.ts` }),
      toolUse(NOW - 2 * MIN, SA, 'toolu_2', 'Read', { file_path: `${CWD}/b.ts` }),
    ]);
    const w = makeWatcher();
    await w.start();
    batches = [];
    await truncate(mainPath(SA), 0);
    await appendFile(
      mainPath(SA),
      `${toolUse(NOW - MIN, SA, 'toolu_3', 'Bash', { command: 'ls' })}\n`,
    );
    await w.poll();
    expect(events(false).map((e) => e.id)).toEqual([`${SA}:tool:toolu_3:start`]);
  });

  it('discovers new files', async () => {
    const w = makeWatcher();
    await w.start();
    expect(batches).toEqual([]);
    await mkdir(join(root, '-home-user-proj-b'), { recursive: true });
    await writeFile(
      join(root, '-home-user-proj-b', `${SB}.jsonl`),
      `${toolUse(NOW - MIN, SB, 'toolu_b', 'Read', { file_path: '/home/user/proj-b/x.ts' })}\n`,
    );
    await w.poll();
    expect(events(false).map((e) => e.sessionId)).toEqual([SB]);
    expect(w.trackedFiles).toBe(1);
  });

  it('flush() reads a single changed file (the fs.watch path)', async () => {
    const w = makeWatcher();
    await w.start();
    await writeFile(
      mainPath(SA),
      `${toolUse(NOW, SA, 'toolu_f', 'Read', { file_path: `${CWD}/f.ts` })}\n`,
    );
    await w.flush(mainPath(SA));
    expect(events(false).map((e) => e.id)).toEqual([`${SA}:tool:toolu_f:start`]);
    await w.flush(join(root, 'not-a-transcript.txt'));
  });

  it('attributes subagent transcripts to the parent session, with spawn and hand-back', async () => {
    await writeLines(mainPath(SA), [
      toolUse(NOW - 5 * MIN, SA, 'toolu_task', 'Agent', { subagent_type: 'researcher' }),
    ]);
    const w = makeWatcher();
    await w.start();
    batches = [];

    await mkdir(subDir(SA), { recursive: true });
    await writeFile(
      join(subDir(SA), 'agent-sub0001.meta.json'),
      JSON.stringify({ agentType: 'researcher', toolUseId: 'toolu_task' }),
    );
    const sub = (ts: number, useId: string, name: string): string =>
      JSON.stringify({
        ...(JSON.parse(toolUse(ts, SA, useId, name, { file_path: `${CWD}/s.ts` })) as object),
        agentId: 'sub0001',
        isSidechain: true,
      });
    await writeFile(
      join(subDir(SA), 'agent-sub0001.jsonl'),
      `${sub(NOW - 4 * MIN, 'toolu_s1', 'Read')}\n`,
    );
    await w.poll();
    let evs = events(false);
    expect(evs.map((e) => e.kind)).toEqual(['agent_spawn', 'tool_start']);
    expect(evs.every((e) => e.sessionId === SA && e.agentId === 'sub0001')).toBe(true);
    expect(evs[0]).toMatchObject({ label: 'researcher', parentAgentId: ORCHESTRATOR_ID });
    expect(extras(false)[0]).toMatchObject({ sessionId: SA, agentId: 'sub0001' });

    batches = [];
    await appendFile(
      join(subDir(SA), 'agent-sub0001.jsonl'),
      `${sub(NOW - 3 * MIN, 'toolu_s2', 'SubagentHandback')}\n`,
    );
    await w.poll();
    evs = events(false);
    expect(evs.map((e) => e.id)).toEqual([
      `${SA}:tool:toolu_s2:start`,
      `${SA}:agent:sub0001:finish`,
    ]);
  });

  it('finishes a subagent that went quiet without a hand-back', async () => {
    let clock = NOW;
    await writeLines(
      mainPath(SA),
      [toolUse(NOW - 40 * MIN, SA, 'toolu_task', 'Agent', { subagent_type: 'researcher' })],
      NOW - 40 * MIN,
    );
    await mkdir(subDir(SA), { recursive: true });
    const sub = (line: string, agentId: string): string =>
      JSON.stringify({ ...(JSON.parse(line) as object), agentId, isSidechain: true });
    // sub0001: its last call got a result; sub0002: a call still running.
    await writeLines(
      join(subDir(SA), 'agent-sub0001.jsonl'),
      [
        sub(
          toolUse(NOW - 35 * MIN, SA, 'toolu_q1', 'Read', { file_path: `${CWD}/q.ts` }),
          'sub0001',
        ),
        sub(toolResult(NOW - 34 * MIN, SA, 'toolu_q1'), 'sub0001'),
      ],
      NOW - 34 * MIN,
    );
    await writeLines(
      join(subDir(SA), 'agent-sub0002.jsonl'),
      [sub(toolUse(NOW - 35 * MIN, SA, 'toolu_q2', 'Bash', { command: 'make' }), 'sub0002')],
      NOW - 34 * MIN,
    );
    const w = makeWatcher({ now: () => clock });
    await w.start();
    const finishes = (initial: boolean): string[] =>
      events(initial)
        .filter((e) => e.kind === 'agent_finish')
        .map((e) => `${e.agentId}@${e.ts}`);
    expect(finishes(true)).toEqual([`sub0001@${NOW - 34 * MIN}`]);

    clock = NOW + 2 * HOUR;
    await w.poll();
    expect(finishes(false)).toEqual([`sub0002@${NOW - 34 * MIN}`]);
    await w.poll();
    expect(finishes(false)).toHaveLength(1);
  });

  it('handles multi-byte UTF-8 split across chunk boundaries', async () => {
    const name = 'ünïcødé-✓-日本語-🚀.ts';
    const lines = [
      toolUse(NOW - 3 * MIN, SA, 'toolu_u1', 'Read', { file_path: `${CWD}/${name}` }),
      toolUse(NOW - 2 * MIN, SA, 'toolu_u2', 'Read', { file_path: `${CWD}/ß-${name}` }),
    ];
    // Odd chunk sizes split code points (and lines) everywhere; both paths must agree.
    for (const chunkBytes of [1, 3, 7, 64]) {
      batches = [];
      await writeLines(mainPath(SA), lines);
      const w = makeWatcher({ chunkBytes });
      await w.start();
      w.close();
      const summaries = events().map((e) => e.tool?.summary ?? '');
      expect(summaries.length).toBe(2);
      expect(summaries[0]).toContain('日本語');
      expect(summaries[1]).toContain('ß-');
      expect(summaries.join('')).not.toContain('�');
    }
  });

  it('close() stops further reads', async () => {
    const w = makeWatcher();
    await w.start();
    w.close();
    await writeFile(mainPath(SA), `${toolUse(NOW, SA, 'toolu_x', 'Read', { file_path: 'x' })}\n`);
    await w.poll();
    expect(batches).toEqual([]);
  });
});

describe('TranscriptWatcher project attribution', () => {
  const withCwd = (line: string, cwd: string): string =>
    JSON.stringify({ ...(JSON.parse(line) as object), cwd });

  it('keeps usage in the session project when it cds into a subfolder', async () => {
    await writeLines(mainPath(SA), [
      toolUse(NOW - 5 * MIN, SA, 'toolu_p1', 'Read', { file_path: 'a.ts' }),
      withCwd(toolUse(NOW - 4 * MIN, SA, 'toolu_p2', 'Read', { file_path: 'b.ts' }), `${CWD}/src`),
    ]);
    await makeWatcher().start();
    const projects = extras().map((x) => x.usage?.projectName);
    expect(projects).toEqual(['proj-a', 'proj-a']);
    expect(new Set(events().map((e) => e.projectName))).toEqual(new Set(['proj-a']));
  });

  it('keeps a subagent running in a worktree in its parent session project', async () => {
    await writeLines(mainPath(SA), [
      toolUse(NOW - 5 * MIN, SA, 'toolu_task2', 'Agent', { subagent_type: 'researcher' }),
    ]);
    await mkdir(subDir(SA), { recursive: true });
    const worktree = `${CWD}/.claude/worktrees/agent-sub0009`;
    await writeLines(join(subDir(SA), 'agent-sub0009.jsonl'), [
      JSON.stringify({
        ...(JSON.parse(
          withCwd(toolUse(NOW - 4 * MIN, SA, 'toolu_w1', 'Read', { file_path: 'x' }), worktree),
        ) as object),
        agentId: 'sub0009',
        isSidechain: true,
      }),
    ]);
    await makeWatcher().start();
    const sub = extras().filter((x) => x.agentId === 'sub0009');
    expect(sub.length).toBeGreaterThan(0);
    expect(sub.every((x) => x.usage?.projectName === 'proj-a')).toBe(true);
    const subEvents = events().filter((e) => e.agentId === 'sub0009');
    expect(subEvents.every((e) => e.projectName === 'proj-a')).toBe(true);
  });
});

describe('Station + watcher + dashboard ledger', () => {
  let station: Station | null = null;

  afterEach(async () => {
    await station?.stop();
    station = null;
  });

  it('startup history reaches only the dashboard; live lines reach the floor if recent', async () => {
    await writeLines(mainPath(SA), [
      toolUse(Date.now() - 2 * HOUR, SA, 'toolu_old', 'Read', { file_path: `${CWD}/a.ts` }),
    ]);
    station = new Station({
      version: 'test',
      offline: true,
      watchTranscripts: true,
      liveWatch: false,
      projectsDir: root,
      onSnapshot: () => undefined,
    });
    await station.start();
    await station.transcriptScan;

    expect(Object.keys(station.snapshot().sessions)).toEqual([]);
    const dash = station.getDashboard();
    expect(dash.scanning).toBe(false);
    expect(dash.usage.weeklyTotal).toBe(60); // cache reads not counted
    expect(dash.sessions.map((s) => s.id)).toContain(SA);

    // A live line older than 30 min: dashboard only. A fresh one: the station floor too.
    await appendFile(
      mainPath(SA),
      `${toolUse(Date.now() - 45 * MIN, SA, 'toolu_stale', 'Read', { file_path: `${CWD}/b.ts` })}\n`,
    );
    await station.pollTranscripts();
    expect(Object.keys(station.snapshot().sessions)).toEqual([]);

    await appendFile(
      mainPath(SA),
      `${toolUse(Date.now(), SA, 'toolu_live', 'Bash', { command: 'npm test' })}\n`,
    );
    await station.pollTranscripts();
    expect(Object.keys(station.snapshot().sessions)).toEqual([SA]);
    expect(station.getDashboard().usage.weeklyTotal).toBe(180);
    const steps = station.getTimeline(SA);
    expect(steps.length).toBeGreaterThan(0);
    expect(station.getTimeline('unknown-session')).toEqual([]);
  });

  it('hook payloads from the command line reach the store and the ledger', async () => {
    station = new Station({ version: 'test', offline: true, onSnapshot: () => undefined });
    await station.start();
    station.ingestHookPayload({
      session_id: SB,
      cwd: '/home/user/proj-b',
      hook_event_name: 'SessionStart',
    });
    station.ingestHookPayload('garbage');
    expect(Object.keys(station.snapshot().sessions)).toEqual([SB]);
    expect(station.getDashboard().sessions.map((s) => s.id)).toEqual([SB]);
  });

  it("credits a resumed session's copied history to the original session", async () => {
    // The resumed file (newer) repeats the original's line — same message and request ids —
    // under its own session id, then adds a turn of its own.
    await writeLines(
      mainPath(SA),
      [toolUse(NOW - 3 * HOUR, SA, 'toolu_orig', 'Read', { file_path: `${CWD}/a.ts` })],
      NOW - 2 * HOUR,
    );
    await writeLines(mainPath(SB), [
      toolUse(NOW - 3 * HOUR, SB, 'toolu_orig', 'Read', { file_path: `${CWD}/a.ts` }),
      toolUse(NOW - 5 * MIN, SB, 'toolu_new', 'Bash', { command: 'npm test' }),
    ]);
    station = new Station({
      version: 'test',
      offline: true,
      watchTranscripts: true,
      liveWatch: false,
      projectsDir: root,
      onSnapshot: () => undefined,
    });
    await station.start();
    await station.transcriptScan;
    const dash = station.getDashboard();
    const output = (id: string): number | undefined =>
      dash.sessions.find((x) => x.id === id)?.usage.output;
    expect(output(SA)).toBe(20);
    expect(output(SB)).toBe(20);
    expect(dash.usage.weeklyTotal).toBe(120);
  });

  it('pushes nothing while the window is hidden, then the current state once', async () => {
    const pushed: string[][] = [];
    const dashes: number[] = [];
    station = new Station({
      version: 'test',
      offline: true,
      onSnapshot: (snap) => pushed.push(Object.keys(snap.sessions)),
      onDashboard: (d) => dashes.push(d.sessions.length),
    });
    await station.start();
    station.setViewHidden(true);
    const before = station.revision;
    station.ingestHookPayload({
      session_id: SB,
      cwd: '/home/user/proj-b',
      hook_event_name: 'SessionStart',
    });
    expect(station.revision).toBeGreaterThan(before);
    await new Promise((r) => setTimeout(r, 250));
    expect(pushed).toEqual([]);
    expect(dashes).toEqual([]);

    station.setViewHidden(false);
    expect(dashes.at(-1)).toBe(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(pushed.at(-1)).toEqual([SB]);
  });

  it('demo mode shows synthetic usage on the dashboard', async () => {
    station = new Station({
      version: 'test',
      offline: true,
      mode: 'demo-pinned',
      onSnapshot: () => undefined,
    });
    await station.start();
    // Let the demo script play for a moment.
    await new Promise((r) => setTimeout(r, 1_500));
    const dash = station.getDashboard();
    expect(dash.sessions.length).toBeGreaterThan(0);
    expect(dash.usage.weeklyTotal).toBeGreaterThan(0);
  });
});

describe('Station plan limits', () => {
  let station: Station | null = null;

  afterEach(async () => {
    await station?.stop();
    station = null;
  });

  const raw = (pct: number, resetS: number) => ({
    session_id: SA,
    rate_limits: { five_hour: { used_percentage: pct, resets_at: resetS } },
  });

  it('shows status line limits on the dashboard and reports changes only', async () => {
    const changes: unknown[] = [];
    station = new Station({
      version: 'test',
      offline: true,
      onSnapshot: () => undefined,
      onPlanLimits: (l) => changes.push(l),
    });
    await station.start();
    expect(station.getDashboard().planLimits).toBeUndefined();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    station.ingestLimits(raw(12.5, reset), Date.now());
    expect(station.getDashboard().planLimits?.fiveHour).toEqual({
      usedPct: 12.5,
      resetsAt: reset * 1000,
    });
    station.ingestLimits(raw(12.5, reset), Date.now() + 1);
    station.ingestLimits({ rate_limits: 'garbage' }, Date.now() + 2);
    expect(changes).toHaveLength(1);
    station.ingestLimits(raw(13, reset), Date.now() + 3);
    expect(changes).toHaveLength(2);
  });

  it('starts from persisted limits', async () => {
    const planLimits = { updatedAt: 1, sevenDay: { usedPct: 40, resetsAt: Date.now() + DAY } };
    station = new Station({
      version: 'test',
      offline: true,
      onSnapshot: () => undefined,
      planLimits,
    });
    await station.start();
    expect(station.getDashboard().planLimits).toEqual(planLimits);
  });
});
