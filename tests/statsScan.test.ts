// Stats history scanner, and the Station's getStats wiring.
// All transcripts are SYNTHETIC (/home/user/... cwds, fake ids, fake output).
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_STATS_DAYS, demoStats, demoStatsRecords } from '../src/main/demo';
import { STATS_RELEASE_MS, Station } from '../src/main/station';
import { StatsScanner } from '../src/main/statsScan';
import { tokenTotal } from '../src/shared/dashboardTypes';
import { sumUsage } from '../src/shared/usage';
import { ORCHESTRATOR_ID } from '../src/shared/types';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.now();
const SA = 'aaaaaaaa-0000-4000-8000-000000000001';
const SB = 'bbbbbbbb-0000-4000-8000-000000000002';
const PROJ = '-home-user-proj-a';
const CWD = '/home/user/proj-a';

const iso = (ms: number): string => new Date(ms).toISOString();

interface LineOpts {
  ts?: number;
  sessionId?: string;
  msgId?: string;
  output?: number;
  agentId?: string;
  text?: string;
  model?: string;
}

/** One assistant response line; usage is 10 in + `output` out + 30 cache write + 40 cache read. */
function usageLine(o: LineOpts = {}): string {
  const msgId = o.msgId ?? 'msg_1';
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${msgId}-${o.output ?? 20}`,
    timestamp: iso(o.ts ?? NOW - 10 * MIN),
    sessionId: o.sessionId ?? SA,
    cwd: CWD,
    requestId: `req_${msgId}`,
    ...(o.agentId ? { agentId: o.agentId, isSidechain: true } : {}),
    message: {
      id: msgId,
      role: 'assistant',
      model: o.model ?? 'fake-model-1',
      usage: {
        input_tokens: 10,
        output_tokens: o.output ?? 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
      content: [{ type: 'text', text: o.text ?? 'fake output' }],
    },
  });
}

const userLine = (sessionId = SA): string =>
  JSON.stringify({
    type: 'user',
    uuid: 'u-user',
    timestamp: iso(NOW - 11 * MIN),
    sessionId,
    cwd: CWD,
    message: { role: 'user', content: 'fake prompt' },
  });

let root: string;
let scanner: StatsScanner | null;

const mainPath = (sid: string): string => join(root, PROJ, `${sid}.jsonl`);
const subDir = (sid: string): string => join(root, PROJ, sid, 'subagents');

async function writeLines(path: string, lines: string[], mtime = NOW - MIN): Promise<void> {
  await writeFile(path, lines.map((l) => `${l}\n`).join(''));
  await utimes(path, mtime / 1000, mtime / 1000);
}

function makeScanner(chunkBytes?: number): StatsScanner {
  scanner = new StatsScanner({ root, ...(chunkBytes ? { chunkBytes } : {}) });
  return scanner;
}

const total = (s: StatsScanner): number => tokenTotal(sumUsage(s.records()));
const outputs = (s: StatsScanner): number => sumUsage(s.records()).output;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wsc-stats-'));
  await mkdir(join(root, PROJ), { recursive: true });
  scanner = null;
});

afterEach(async () => {
  scanner?.stop();
  await rm(root, { recursive: true, force: true });
});

describe('StatsScanner', () => {
  it('reads nothing before the first refresh', async () => {
    await writeLines(mainPath(SA), [usageLine()]);
    const s = makeScanner();
    expect(s.records()).toEqual([]);
    expect(s.scanning).toBe(false);
    expect(s.version).toBe(0);
    await s.refresh();
    expect(s.records()).toHaveLength(1);
    expect(total(s)).toBe(60); // this helper sums without cache reads
  });

  it('counts the repeated lines of one response once, keeping its growing output', async () => {
    await writeLines(mainPath(SA), [
      userLine(),
      usageLine({ output: 5, text: 'part one' }),
      usageLine({ output: 20, text: 'part two' }),
      usageLine({ output: 20, text: 'part three' }),
    ]);
    const s = makeScanner();
    await s.refresh();
    expect(s.records()).toHaveLength(1);
    expect(outputs(s)).toBe(20);
    const r = s.records()[0]!;
    expect(r.sessionId).toBe(SA);
    expect(r.projectName).toBe('proj-a');
  });

  it("counts a resumed session's copy of an older file's history once, for the original", async () => {
    await writeLines(mainPath(SA), [usageLine({ msgId: 'msg_orig' })], NOW - 3 * DAY);
    await writeLines(mainPath(SB), [
      usageLine({ msgId: 'msg_orig', sessionId: SB }),
      usageLine({ msgId: 'msg_new', sessionId: SB }),
    ]);
    const s = makeScanner();
    await s.refresh();
    expect(s.records()).toHaveLength(2);
    expect(total(s)).toBe(120);
    const orig = s.records().find((r) => r.key.startsWith('msg_orig'));
    expect(orig?.sessionId).toBe(SA);
  });

  it('credits the older file whatever the read order', async () => {
    // The original is SB, created first; the resumed copy is SA, which is listed (and read)
    // first. Only the files' age can tell them apart.
    await writeLines(
      mainPath(SB),
      [usageLine({ msgId: 'msg_orig', sessionId: SB })],
      NOW - 3 * DAY,
    );
    await writeLines(mainPath(SA), [
      usageLine({ msgId: 'msg_orig' }),
      usageLine({ msgId: 'msg_new' }),
    ]);
    const s = makeScanner();
    await s.refresh();
    expect(s.records()).toHaveLength(2);
    expect(s.records().find((r) => r.key.startsWith('msg_orig'))?.sessionId).toBe(SB);
    expect(s.records().find((r) => r.key.startsWith('msg_new'))?.sessionId).toBe(SA);
  });

  it('credits a subagent or workflow agent to its parent session and project', async () => {
    await writeLines(mainPath(SA), [userLine(), usageLine({ msgId: 'msg_main' })]);
    await mkdir(join(subDir(SA), 'workflows', 'wf_0001'), { recursive: true });
    const sub = JSON.parse(usageLine({ msgId: 'msg_sub', agentId: 'agent-x1' })) as Record<
      string,
      unknown
    >;
    sub['cwd'] = '/home/user/proj-a-worktree';
    await writeLines(join(subDir(SA), 'agent-x1.jsonl'), [JSON.stringify(sub)]);
    await writeLines(join(subDir(SA), 'workflows', 'wf_0001', 'agent-w1.jsonl'), [
      usageLine({ msgId: 'msg_wf', agentId: 'agent-w1' }),
    ]);
    // Not transcripts: ignored.
    await writeFile(join(subDir(SA), 'agent-x1.meta.json'), '{"agentType":"fake"}');
    await writeLines(join(subDir(SA), 'workflows', 'wf_0001', 'journal.jsonl'), [
      usageLine({ msgId: 'msg_journal' }),
    ]);
    const s = makeScanner();
    await s.refresh();
    expect(
      s
        .records()
        .map((r) => r.key.split(':')[0])
        .sort(),
    ).toEqual(['msg_main', 'msg_sub', 'msg_wf']);
    for (const r of s.records()) {
      expect(r.sessionId).toBe(SA);
      expect(r.projectName).toBe('proj-a');
    }
    expect(s.records().find((r) => r.key.startsWith('msg_sub'))?.agentId).toBe('x1');
  });

  it('counts files far older than any lookback', async () => {
    const old = NOW - 400 * DAY;
    await writeLines(mainPath(SA), [usageLine({ ts: old })], old);
    await writeLines(mainPath(SB), [usageLine({ msgId: 'msg_b', sessionId: SB })]);
    const s = makeScanner();
    await s.refresh();
    expect(s.records()).toHaveLength(2);
    expect(s.records()[0]?.ts).toBe(old);
  });

  it('reads an appended file from its offset only', async () => {
    const first = usageLine({ msgId: 'msg_a', output: 20 });
    await writeLines(mainPath(SA), [first]);
    const s = makeScanner();
    await s.refresh();
    expect(outputs(s)).toBe(20);
    // Rewrite the part already read (same length, bigger output) and append a new response.
    // Were the old part read again, the book would raise msg_a's output to 99.
    const rewritten = usageLine({ msgId: 'msg_a', output: 99 });
    expect(rewritten.length).toBe(first.length);
    await writeLines(mainPath(SA), [rewritten, usageLine({ msgId: 'msg_b', output: 7 })], NOW);
    await s.refresh();
    expect(s.records()).toHaveLength(2);
    expect(outputs(s)).toBe(27);
  });

  it('reads a shrunk or replaced file again from the start', async () => {
    await writeLines(mainPath(SA), [usageLine({ msgId: 'msg_a' }), usageLine({ msgId: 'msg_b' })]);
    const s = makeScanner();
    await s.refresh();
    await writeLines(mainPath(SA), [usageLine({ msgId: 'msg_c' })], NOW);
    await s.refresh();
    expect(s.records().map((r) => r.key.split(':')[0])).toEqual(['msg_a', 'msg_b', 'msg_c']);
  });

  it('holds a partial last line until it is completed', async () => {
    const line = usageLine({ msgId: 'msg_p' });
    await writeFile(mainPath(SA), line.slice(0, 40));
    const s = makeScanner();
    await s.refresh();
    expect(s.records()).toEqual([]);
    const v = s.version;
    await s.refresh(); // unchanged: still nothing
    expect(s.version).toBe(v);
    await appendFile(mainPath(SA), `${line.slice(40)}\n`);
    await s.refresh();
    expect(s.records()).toHaveLength(1);
    expect(total(s)).toBe(60);
  });

  it('splits lines and multi-byte characters across chunk borders', async () => {
    // Emoji, CJK and accents: 2-, 3- and 4-byte UTF-8 sequences cut by 7-byte chunks.
    const lines = [
      usageLine({ msgId: 'msg_1', text: 'héllo 你好 \u{1f680}' }),
      usageLine({ msgId: 'msg_2', text: '\u{1f30d}'.repeat(30), model: 'fake-é-model' }),
      usageLine({ msgId: 'msg_3' }),
    ];
    await writeLines(mainPath(SA), lines);
    const s = makeScanner(7);
    await s.refresh();
    expect(s.records()).toHaveLength(3);
    expect(s.records().map((r) => r.model)).toContain('fake-é-model');
    expect(total(s)).toBe(180);
  });

  it('skips malformed lines', async () => {
    await writeLines(mainPath(SA), [
      'not json at all',
      '{"type":"assistant","usage":',
      '{"type":"assistant","message":{"usage":null}}',
      '',
      '\u0000\u0001 "usage" binary-ish',
      usageLine({ msgId: 'msg_ok' }),
      '[1,2,3]',
    ]);
    const s = makeScanner();
    await s.refresh();
    expect(s.records().map((r) => r.key.split(':')[0])).toEqual(['msg_ok']);
  });

  it('skips an over-long line and still counts the lines after it', async () => {
    await writeLines(mainPath(SA), [
      usageLine({ msgId: 'msg_before' }),
      usageLine({ msgId: 'msg_long', text: 'x'.repeat(3000) }),
      usageLine({ msgId: 'msg_after' }),
    ]);
    scanner = new StatsScanner({ root, chunkBytes: 64, maxLineBytes: 1000 });
    await scanner.refresh();
    expect(scanner.records().map((r) => r.key.split(':')[0])).toEqual(['msg_before', 'msg_after']);
    // Under the limit, the same line counts.
    const roomy = new StatsScanner({ root, chunkBytes: 64, maxLineBytes: 10_000 });
    await roomy.refresh();
    expect(roomy.records()).toHaveLength(3);
  });

  it('keeps the records of a deleted file, and reads it again when it comes back', async () => {
    await writeLines(mainPath(SA), [usageLine({ msgId: 'msg_a' })]);
    const s = makeScanner();
    await s.refresh();
    expect(s.records()).toHaveLength(1);
    await unlink(mainPath(SA));
    await s.refresh();
    expect(s.records()).toHaveLength(1);
    const v = s.version;
    await writeLines(mainPath(SA), [usageLine({ msgId: 'msg_a' }), usageLine({ msgId: 'msg_b' })]);
    await s.refresh();
    expect(s.records().map((r) => r.key.split(':')[0])).toEqual(['msg_a', 'msg_b']);
    expect(s.version).toBeGreaterThan(v);
  });

  it('a missing root is not an error', async () => {
    scanner = new StatsScanner({ root: join(root, 'does-not-exist') });
    await expect(scanner.refresh()).resolves.toBeUndefined();
    expect(scanner.records()).toEqual([]);
    expect(scanner.scanning).toBe(false);
  });

  it('shares one scan between concurrent refreshes', async () => {
    await writeLines(mainPath(SA), [usageLine()]);
    const s = makeScanner();
    const a = s.refresh();
    expect(s.scanning).toBe(true);
    const b = s.refresh();
    expect(b).toBe(a);
    await Promise.all([a, b]);
    expect(s.scanning).toBe(false);
    expect(s.records()).toHaveLength(1);
  });

  it('moves the version only when the records changed', async () => {
    await writeLines(mainPath(SA), [usageLine({ msgId: 'msg_a' })]);
    const s = makeScanner();
    await s.refresh();
    const v1 = s.version;
    expect(v1).toBeGreaterThan(0);
    await s.refresh();
    expect(s.version).toBe(v1);
    // A repeat of a known response with nothing new: no change.
    await appendFile(mainPath(SA), `${usageLine({ msgId: 'msg_a', text: 'again' })}\n`);
    await s.refresh();
    expect(s.version).toBe(v1);
    await appendFile(mainPath(SA), `${usageLine({ msgId: 'msg_b' })}\n`);
    await s.refresh();
    expect(s.version).toBeGreaterThan(v1);
  });

  it('stop() ends a running scan early, and later refreshes do nothing', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => usageLine({ msgId: `msg_${i}` }));
    await writeLines(mainPath(SA), lines);
    const s = makeScanner(64);
    const run = s.refresh();
    // Let it read part of the file: it yields to the event loop after every chunk.
    for (let i = 0; i < 10_000 && s.records().length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(s.records().length).toBeGreaterThan(0);
    s.stop();
    await run;
    expect(s.scanning).toBe(false);
    const got = s.records().length;
    expect(got).toBeLessThan(50);
    const v = s.version;
    await writeLines(mainPath(SB), [usageLine({ msgId: 'msg_late', sessionId: SB })]);
    await s.refresh();
    expect(s.records()).toHaveLength(got);
    expect(s.version).toBe(v);
  });

  it('writes nothing to the projects folder', async () => {
    await writeLines(mainPath(SA), [usageLine()]);
    const before = await readdir(join(root, PROJ));
    const s = makeScanner();
    await s.refresh();
    expect(await readdir(join(root, PROJ))).toEqual(before);
    expect(await readdir(root)).toEqual([PROJ]);
  });
});

describe('demoStats', () => {
  it('is deterministic and covers about seven weeks with gaps and three models', () => {
    const now = new Date(2026, 10, 10, 15, 30).getTime();
    const a = demoStatsRecords(now);
    expect(demoStatsRecords(now)).toEqual(a);
    expect(a.length).toBeGreaterThan(200);
    expect(new Set(a.map((r) => r.model)).size).toBe(3);
    expect(new Set(a.map((r) => r.projectName))).toEqual(
      new Set(['moonbase-planner', 'rocket-app', 'asteroid-tools']),
    );
    expect(a.every((r) => r.ts <= now)).toBe(true);
    expect(a.some((r) => r.agentId !== ORCHESTRATOR_ID)).toBe(true);
    const first = Math.min(...a.map((r) => r.ts));
    expect(now - first).toBeGreaterThan((DEMO_STATS_DAYS - 2) * DAY);
    expect(now - first).toBeLessThan((DEMO_STATS_DAYS + 1) * DAY);

    const all = demoStats(now, 'all');
    expect(all.scanning).toBe(false);
    expect(all.total).toBeGreaterThan(0);
    expect(all.activeDays).toBeLessThan(all.totalDays); // a few gaps
    expect(all.activeDays).toBeGreaterThan(all.totalDays - 10);
    expect(all.models).toHaveLength(3);
    expect(all.projects.length).toBe(3);
    expect(all.currentStreak).toBeGreaterThan(0);
    expect(demoStats(now, '7d').totalDays).toBe(7);
  });
});

describe('Station.getStats', () => {
  let station: Station | null = null;

  afterEach(async () => {
    await station?.stop();
    station = null;
  });

  it('demo mode returns demo stats and never touches the projects folder', async () => {
    const missing = join(root, 'never-created');
    station = new Station({
      version: 'test',
      offline: true,
      mode: 'demo-pinned',
      watchTranscripts: true,
      liveWatch: false,
      projectsDir: missing,
      onSnapshot: () => undefined,
    });
    await station.start();
    const spy = vi.spyOn(StatsScanner.prototype, 'refresh');
    const snap = station.getStats('all');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(snap.range).toBe('all');
    expect(snap.scanning).toBe(false);
    expect(snap.total).toBe(demoStats(snap.generatedAt, 'all').total);
    expect(snap.models.map((m) => m.model).sort()).toEqual([
      'demo-model-large',
      'demo-model-medium',
      'demo-model-small',
    ]);
  });

  it('an unpinned demo returns demo stats too', async () => {
    station = new Station({ version: 'test', offline: true, onSnapshot: () => undefined });
    await station.start();
    station.startDemo();
    expect(station.getStats('7d').total).toBeGreaterThan(0);
  });

  it('scans the projects folder on demand, falls back to the default range, and caches', async () => {
    await writeLines(mainPath(SA), [usageLine({ ts: NOW - 5 * MIN })]);
    station = new Station({
      version: 'test',
      offline: true,
      watchTranscripts: true,
      liveWatch: false,
      projectsDir: root,
      onSnapshot: () => undefined,
    });
    await station.start();
    const first = station.getStats('bogus');
    expect(first.range).toBe('30d');
    expect(first.scanning).toBe(true);
    await vi.waitFor(() => expect(station!.getStats('30d').scanning).toBe(false));
    const a = station.getStats('30d');
    expect(a.total).toBe(100);
    expect(a.sessions).toBe(1);
    // Nothing changed: the same snapshot, not a recomputation.
    expect(station.getStats('30d')).toBe(a);
    expect(station.getStats(42)).toBe(a);
    // Another range is computed (and cached) on its own.
    const w = station.getStats('7d');
    expect(w.range).toBe('7d');
    expect(station.getStats('7d')).toBe(w);
    // A settings change can change prices: recompute.
    station.configure({
      prices: { 'fake-model': { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } },
    });
    const priced = station.getStats('30d');
    expect(priced).not.toBe(a);
    expect(priced.costUsd).toBeCloseTo(100 / 1_000_000);
  });

  const liveStation = (): Station =>
    new Station({
      version: 'test',
      offline: true,
      watchTranscripts: true,
      liveWatch: false,
      projectsDir: root,
      onSnapshot: () => undefined,
    });

  it('rescans about once a minute without reporting scanning again', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    try {
      await writeLines(mainPath(SA), [usageLine({ msgId: 'msg_a', ts: NOW - 5 * MIN })]);
      station = liveStation();
      await station.start();
      expect(station.getStats('30d').scanning).toBe(true);
      await vi.waitFor(() => expect(station!.getStats('30d').scanning).toBe(false));
      expect(station.getStats('30d').total).toBe(100);
      await appendFile(mainPath(SA), `${usageLine({ msgId: 'msg_b', ts: NOW - MIN })}\n`);
      // Not due yet: no rescan, the cached snapshot.
      vi.setSystemTime(NOW + 30_000);
      const spy = vi.spyOn(StatsScanner.prototype, 'refresh');
      const cached = station.getStats('30d');
      expect(spy).not.toHaveBeenCalled();
      // Due: the poll starts a rescan, but the view is not told history is being read again.
      vi.setSystemTime(NOW + 61_000);
      expect(station.getStats('30d').scanning).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      await vi.waitFor(() => expect(station!.getStats('30d').total).toBe(200));
      const after = station.getStats('30d');
      expect(after).not.toBe(cached);
      expect(after.scanning).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new local day gives a new snapshot', async () => {
    const lateEvening = new Date(2026, 10, 9, 23, 59, 30).getTime();
    vi.useFakeTimers({ toFake: ['Date'], now: lateEvening });
    try {
      await writeLines(mainPath(SA), [usageLine({ ts: lateEvening - 10 * MIN })]);
      station = liveStation();
      await station.start();
      station.getStats('7d');
      await vi.waitFor(() => expect(station!.getStats('7d').scanning).toBe(false));
      const before = station.getStats('7d');
      expect(before.days.at(-1)?.day).toBe('2026-11-09');
      expect(before.days.at(-1)?.tokens).toBe(100);
      expect(station.getStats('7d')).toBe(before);
      // 40 s later, past midnight: no rescan is due, but "today" moved.
      vi.setSystemTime(lateEvening + 40_000);
      const after = station.getStats('7d');
      expect(after).not.toBe(before);
      expect(after.days.at(-1)?.day).toBe('2026-11-10');
      expect(after.days.at(-2)?.tokens).toBe(100);
      expect(after.currentStreak).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the scanner and its records once the view stops asking, and starts afresh', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
    try {
      await writeLines(mainPath(SA), [usageLine({ ts: NOW - 5 * MIN })]);
      station = liveStation();
      await station.start();
      station.getStats('30d');
      await vi.waitFor(() => expect(station!.getStats('30d').scanning).toBe(false));
      expect(station.getStats('30d').total).toBe(100);
      const stop = vi.spyOn(StatsScanner.prototype, 'stop');
      vi.advanceTimersByTime(STATS_RELEASE_MS - 60_000);
      expect(stop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2 * 60_000);
      expect(stop).toHaveBeenCalledTimes(1);
      stop.mockRestore();
      // The next ask scans from scratch, and says so.
      expect(station.getStats('30d').scanning).toBe(true);
      await vi.waitFor(() => expect(station!.getStats('30d').scanning).toBe(false));
      expect(station.getStats('30d').total).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offline without transcript watching reads nothing', async () => {
    await writeLines(mainPath(SA), [usageLine()]);
    station = new Station({
      version: 'test',
      offline: true,
      projectsDir: root,
      onSnapshot: () => undefined,
    });
    await station.start();
    const spy = vi.spyOn(StatsScanner.prototype, 'refresh');
    const snap = station.getStats('7d');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(snap.scanning).toBe(false);
    expect(snap.total).toBe(0);
  });

  it('stop() stops the scanner', async () => {
    await writeLines(mainPath(SA), [usageLine()]);
    station = new Station({
      version: 'test',
      offline: true,
      watchTranscripts: true,
      liveWatch: false,
      projectsDir: root,
      onSnapshot: () => undefined,
    });
    await station.start();
    const stop = vi.spyOn(StatsScanner.prototype, 'stop');
    station.getStats('7d');
    await station.stop();
    expect(stop).toHaveBeenCalled();
    stop.mockRestore();
    expect(station.getStats('7d').scanning).toBe(false);
    station = null;
  });
});
