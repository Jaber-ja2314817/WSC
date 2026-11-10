import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelPrice, TokenUsage, UsageRecord } from '../src/shared/dashboardTypes';
import { computeStats, localDayKey, localDayStart, rangeStartFor } from '../src/shared/stats';
import {
  STATS_IDLE_GAP_MS,
  STATS_MAX_DAYS,
  STATS_RANGES,
  STATS_TOP_PROJECTS,
  type StatsOptions,
} from '../src/shared/statsTypes';

// Local wall-clock timestamps, so every test passes in any time zone.
const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m, d, h, min).getTime();
const M = 60_000;

// "Now": Sunday 2026-03-15 14:00 local (synthetic clock).
const NOW = at(2026, 2, 15, 14);
/** Noon, `n` local days before today. */
const daysAgo = (n: number, h = 12, min = 0): number => at(2026, 2, 15 - n, h, min);

let n = 0;
const u = (input: number, output = 0, cacheCreation = 0, cacheRead = 0): TokenUsage => ({
  input,
  output,
  cacheCreation,
  cacheRead,
});
const rec = (ts: number, tokens: number, over: Partial<UsageRecord> = {}): UsageRecord => ({
  key: `msg_fake_${++n}:req_fake`,
  ts,
  sessionId: 'sess-aaaa-1111',
  agentId: 'orchestrator',
  projectId: '/home/user/alpha',
  projectName: 'alpha',
  model: 'claude-fake-1',
  usage: u(tokens),
  ...over,
});
const opts = (over: Partial<StatsOptions> = {}): StatsOptions => ({
  now: NOW,
  range: '30d',
  ...over,
});

/** Deterministic shuffle (LCG), so a failing order can be reproduced. */
function shuffle<T>(list: readonly T[], seed = 7): T[] {
  const out = list.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

describe('day helpers', () => {
  it('formats local day keys and finds local midnight', () => {
    expect(localDayKey(at(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDayKey(at(2026, 11, 31, 0, 0))).toBe('2026-12-31');
    expect(localDayStart(at(2026, 2, 15, 14, 30))).toBe(at(2026, 2, 15, 0));
  });

  it('starts ranges 6 or 29 days before today, none for all', () => {
    expect(rangeStartFor('7d', NOW)).toBe(at(2026, 2, 9, 0));
    expect(rangeStartFor('30d', NOW)).toBe(at(2026, 1, 14, 0));
    expect(rangeStartFor('all', NOW)).toBeUndefined();
  });
});

describe('computeStats: empty history', () => {
  it.each(STATS_RANGES)('%s has zero totals and no optional fields', (range) => {
    const s = computeStats([], opts({ range }));
    expect(s.range).toBe(range);
    expect(s.generatedAt).toBe(NOW);
    expect(s.scanning).toBe(false);
    expect(s.total).toBe(0);
    expect(s.usage).toEqual(u(0));
    expect(s.sessions).toBe(0);
    expect(s.messages).toBe(0);
    expect(s.activeDays).toBe(0);
    expect(s.currentStreak).toBe(0);
    expect(s.longestStreak).toBe(0);
    expect(s.byHour).toEqual(new Array(24).fill(0));
    expect(s.models).toEqual([]);
    expect(s.projects).toEqual([]);
    expect(s.firstActivityAt).toBeUndefined();
    expect(s.mostActiveDay).toBeUndefined();
    expect(s.longestSession).toBeUndefined();
    expect(s.peakHour).toBeUndefined();
    expect(s.favoriteModel).toBeUndefined();
    expect(s.costUsd).toBeUndefined();
  });

  it('zero-fills 7 and 30 days ending today', () => {
    for (const [range, count] of [
      ['7d', 7],
      ['30d', 30],
    ] as const) {
      const s = computeStats([], opts({ range }));
      expect(s.totalDays).toBe(count);
      expect(s.days).toHaveLength(count);
      expect(s.rangeStart).toBe(rangeStartFor(range, NOW));
      expect(s.days[0]?.start).toBe(s.rangeStart);
      expect(s.days.at(-1)?.day).toBe('2026-03-15');
      expect(s.days.every((d) => d.tokens === 0 && d.messages === 0 && d.sessions === 0)).toBe(
        true,
      );
    }
  });

  it('all has no days and no range start', () => {
    const s = computeStats([], opts({ range: 'all' }));
    expect(s.days).toEqual([]);
    expect(s.totalDays).toBe(0);
    expect(s.rangeStart).toBeUndefined();
  });

  it('passes scanning through', () => {
    expect(computeStats([], opts({ scanning: true })).scanning).toBe(true);
  });
});

describe('computeStats: totals', () => {
  it('counts one record everywhere', () => {
    const ts = daysAgo(0, 9, 30);
    const s = computeStats([rec(ts, 1000, { usage: u(400, 500, 100, 9000) })], opts());
    expect(s.usage).toEqual(u(400, 500, 100, 9000));
    expect(s.total).toBe(1000); // cache reads left out
    expect(s.sessions).toBe(1);
    expect(s.messages).toBe(1);
    expect(s.activeDays).toBe(1);
    expect(s.firstActivityAt).toBe(ts);
    expect(s.mostActiveDay).toEqual({ day: '2026-03-15', tokens: 1000 });
    expect(s.longestSession).toEqual({
      shortId: 'sess-aaa',
      projectName: 'alpha',
      startedAt: ts,
      durationMs: 0,
    });
    expect(s.byHour[9]).toBe(1000);
    expect(s.peakHour).toBe(9);
    expect(s.favoriteModel).toBe('claude-fake-1');
    expect(s.models).toEqual([
      { model: 'claude-fake-1', usage: u(400, 500, 100, 9000), total: 1000, share: 1 },
    ]);
    expect(s.projects).toEqual([
      { projectId: '/home/user/alpha', projectName: 'alpha', total: 1000, sessions: 1 },
    ]);
    expect(s.currentStreak).toBe(1);
    expect(s.longestStreak).toBe(1);
    const today = s.days.at(-1);
    expect(today).toMatchObject({ day: '2026-03-15', tokens: 1000, messages: 1, sessions: 1 });
    expect(today?.byModel).toEqual({ 'claude-fake-1': 1000 });
  });

  it("splits at the range's first midnight", () => {
    const first = at(2026, 2, 9, 0);
    const before = rec(first - 1, 10);
    const atStart = rec(first, 20);
    const s = computeStats([before, atStart], opts({ range: '7d' }));
    expect(s.total).toBe(20);
    expect(s.messages).toBe(1);
    expect(s.activeDays).toBe(1);
    expect(s.days[0]).toMatchObject({ day: '2026-03-09', tokens: 20 });
    expect(s.firstActivityAt).toBe(first - 1); // whole history
    expect(s.longestStreak).toBe(2); // 8th and 9th, outside the range or not
  });

  it('counts active days and calendar days per range', () => {
    const records = [0, 3, 10, 40].map((d) => rec(daysAgo(d), 100));
    const week = computeStats(records, opts({ range: '7d' }));
    expect([week.activeDays, week.totalDays, week.total]).toEqual([2, 7, 200]);
    const month = computeStats(records, opts({ range: '30d' }));
    expect([month.activeDays, month.totalDays, month.total]).toEqual([3, 30, 300]);
    const all = computeStats(records, opts({ range: 'all' }));
    expect([all.activeDays, all.totalDays, all.total]).toEqual([4, 41, 400]);
    expect(all.rangeStart).toBe(at(2026, 2, 15 - 40, 0));
    expect(all.days).toHaveLength(41);
    expect(all.days[0]?.day).toBe(localDayKey(daysAgo(40)));
    expect(all.days.filter((d) => d.tokens > 0)).toHaveLength(4);
  });

  it('counts sessions and messages per day', () => {
    const records = [
      rec(daysAgo(1, 9), 10, { sessionId: 'sess-one' }),
      rec(daysAgo(1, 10), 20, { sessionId: 'sess-two', model: 'claude-fake-2' }),
      rec(daysAgo(1, 11), 30, { sessionId: 'sess-one' }),
      rec(daysAgo(0, 8), 5, { sessionId: 'sess-one' }),
    ];
    const s = computeStats(records, opts({ range: '7d' }));
    const yesterday = s.days.at(-2);
    expect(yesterday).toMatchObject({ day: '2026-03-14', sessions: 2, messages: 3, tokens: 60 });
    expect(yesterday?.byModel).toEqual({ 'claude-fake-1': 40, 'claude-fake-2': 20 });
    expect(s.days.at(-1)).toMatchObject({ sessions: 1, messages: 1, tokens: 5 });
    expect(s.sessions).toBe(2);
    expect(s.messages).toBe(4);
  });

  it('sums tokens per local hour and picks the peak hour', () => {
    const records = [
      rec(daysAgo(0, 9, 5), 100),
      rec(daysAgo(1, 14, 0), 300),
      rec(daysAgo(2, 14, 59), 50),
      rec(daysAgo(3, 23, 59), 10),
    ];
    const s = computeStats(records, opts());
    expect(s.byHour).toHaveLength(24);
    expect(s.byHour[9]).toBe(100);
    expect(s.byHour[14]).toBe(350);
    expect(s.byHour[23]).toBe(10);
    expect(s.peakHour).toBe(14);
    // A tie goes to the earlier hour.
    const tie = computeStats([rec(daysAgo(0, 7), 40), rec(daysAgo(0, 3), 40)], opts());
    expect(tie.peakHour).toBe(3);
  });

  it('breaks a busiest-day tie by the earlier day', () => {
    const s = computeStats([rec(daysAgo(1), 50), rec(daysAgo(4), 50), rec(daysAgo(2), 10)], opts());
    expect(s.mostActiveDay).toEqual({ day: localDayKey(daysAgo(4)), tokens: 50 });
  });

  it('leaves out future-dated records and keeps later today', () => {
    const laterToday = at(2026, 2, 15, 23, 30);
    const tomorrow = at(2026, 2, 16, 0);
    const s = computeStats(
      [rec(daysAgo(0, 10), 10), rec(laterToday, 20), rec(tomorrow, 1000)],
      opts({ range: 'all' }),
    );
    expect(s.total).toBe(30);
    expect(s.messages).toBe(2);
    expect(s.days.at(-1)?.day).toBe('2026-03-15');
    expect(s.currentStreak).toBe(1);
  });

  it('skips records with a non-finite timestamp', () => {
    const s = computeStats(
      [rec(NaN, 10), rec(Infinity, 10), rec(-Infinity, 10), rec(daysAgo(0), 7)],
      opts({ range: 'all' }),
    );
    expect(s.total).toBe(7);
    expect(s.totalDays).toBe(1);
  });
});

describe('computeStats: streaks', () => {
  it('runs across a month boundary', () => {
    const now = at(2026, 2, 2, 18);
    const records = [at(2026, 1, 27), at(2026, 1, 28), at(2026, 2, 1), at(2026, 2, 2)].map((ts) =>
      rec(ts, 1),
    );
    const s = computeStats(records, opts({ now }));
    expect(s.currentStreak).toBe(4);
    expect(s.longestStreak).toBe(4);
  });

  it('breaks on a missing day', () => {
    const records = [6, 5, 4, 2, 1, 0].map((d) => rec(daysAgo(d), 1));
    const s = computeStats(records, opts());
    expect(s.currentStreak).toBe(3);
    expect(s.longestStreak).toBe(3);
    const s2 = computeStats(
      [8, 7, 6, 5, 2, 1, 0].map((d) => rec(daysAgo(d), 1)),
      opts(),
    );
    expect(s2.currentStreak).toBe(3);
    expect(s2.longestStreak).toBe(4);
  });

  it('may end yesterday when today has no activity yet', () => {
    const s = computeStats(
      [3, 2, 1].map((d) => rec(daysAgo(d), 1)),
      opts(),
    );
    expect(s.currentStreak).toBe(3);
    const gone = computeStats(
      [4, 3, 2].map((d) => rec(daysAgo(d), 1)),
      opts(),
    );
    expect(gone.currentStreak).toBe(0);
    expect(gone.longestStreak).toBe(3);
  });

  it('is counted over the whole history, not the range', () => {
    const records = Array.from({ length: 12 }, (_, d) => rec(daysAgo(d), 1));
    const s = computeStats(records, opts({ range: '7d' }));
    expect(s.activeDays).toBe(7);
    expect(s.currentStreak).toBe(12);
    expect(s.longestStreak).toBe(12);
  });
});

describe('computeStats: all-time cap', () => {
  it(`keeps at most ${STATS_MAX_DAYS} days while totals cover everything`, () => {
    const records = [rec(daysAgo(500), 1000), rec(daysAgo(200), 10), rec(daysAgo(0), 1)];
    const s = computeStats(records, opts({ range: 'all' }));
    expect(s.totalDays).toBe(501);
    expect(s.activeDays).toBe(3);
    expect(s.total).toBe(1011);
    expect(s.messages).toBe(3);
    expect(s.mostActiveDay).toEqual({ day: localDayKey(daysAgo(500)), tokens: 1000 });
    expect(s.rangeStart).toBe(localDayStart(daysAgo(500)));
    expect(s.days).toHaveLength(STATS_MAX_DAYS);
    expect(s.days.at(-1)?.day).toBe('2026-03-15');
    expect(s.days[0]?.day).toBe(localDayKey(daysAgo(STATS_MAX_DAYS - 1)));
    expect(s.days.reduce((sum, d) => sum + d.tokens, 0)).toBe(11);
    // Consecutive local days, each starting at its own midnight.
    for (let i = 0; i < s.days.length; i++) {
      const d = s.days[i];
      expect(d?.start).toBe(localDayStart(d?.start ?? 0));
      expect(localDayKey(d?.start ?? 0)).toBe(d?.day);
      if (i > 0) expect(d?.start).toBeGreaterThan(s.days[i - 1]?.start ?? Infinity);
    }
    expect(new Set(s.days.map((d) => d.day)).size).toBe(STATS_MAX_DAYS);
  });
});

describe('computeStats: longest session', () => {
  const A = 'sess-aaaa-1111';
  const B = 'sess-bbbb-2222';
  const sessionRecords = (): UsageRecord[] => [
    rec(daysAgo(1, 10, 0), 1, { sessionId: A }),
    rec(daysAgo(1, 10, 10), 1, { sessionId: A }),
    rec(daysAgo(1, 10, 20), 1, { sessionId: A }),
    // Subagent records belong to the parent session (sessionId is the parent's).
    rec(daysAgo(1, 10, 40), 1, { sessionId: A, agentId: 'agent-fake-1' }),
    rec(daysAgo(1, 10, 50), 1, { sessionId: A, agentId: 'agent-fake-1' }),
    // 40 minutes idle: left out.
    rec(daysAgo(1, 11, 30), 1, { sessionId: A }),
    rec(daysAgo(1, 11, 35), 1, { sessionId: A }),
    rec(daysAgo(1, 10, 0), 1, { sessionId: B, projectName: 'beta', projectId: '/home/user/b' }),
    rec(daysAgo(1, 10, 45), 1, { sessionId: B, projectName: 'beta', projectId: '/home/user/b' }),
  ];

  it('sums gaps and leaves out idle ones', () => {
    expect(STATS_IDLE_GAP_MS).toBe(30 * M);
    const s = computeStats(sessionRecords(), opts());
    expect(s.longestSession).toEqual({
      shortId: 'sess-aaa',
      projectName: 'alpha',
      startedAt: daysAgo(1, 10, 0),
      durationMs: 55 * M,
    });
    expect(s.sessions).toBe(2);
  });

  it('does not depend on record order', () => {
    const sorted = computeStats(sessionRecords(), opts());
    for (const seed of [1, 2, 3, 99]) {
      expect(computeStats(shuffle(sessionRecords(), seed), opts())).toEqual(sorted);
    }
    expect(computeStats(sessionRecords().reverse(), opts())).toEqual(sorted);
  });

  it('counts only responses inside the range', () => {
    const records = [
      rec(at(2026, 2, 8, 23, 50), 1, { sessionId: A }),
      rec(at(2026, 2, 9, 0, 10), 1, { sessionId: A }),
      rec(at(2026, 2, 9, 0, 15), 1, { sessionId: A }),
    ];
    const s = computeStats(records, opts({ range: '7d' }));
    expect(s.longestSession?.durationMs).toBe(5 * M);
    expect(s.longestSession?.startedAt).toBe(at(2026, 2, 9, 0, 10));
  });

  it('breaks a duration tie by the earlier start', () => {
    const s = computeStats(
      [
        rec(daysAgo(0, 9), 1, { sessionId: 'sess-late-0000' }),
        rec(daysAgo(0, 8), 1, { sessionId: 'sess-earl-0000' }),
      ],
      opts(),
    );
    expect(s.longestSession?.shortId).toBe('sess-ear');
  });
});

describe('computeStats: models and projects', () => {
  it('orders models by use, shares add up to 1', () => {
    const records = [
      rec(daysAgo(0), 300, { model: 'claude-fake-b' }),
      rec(daysAgo(1), 600, { model: 'claude-fake-a' }),
      rec(daysAgo(2), 100, { model: 'claude-fake-c' }),
      rec(daysAgo(2), 300, { model: 'claude-fake-a' }),
    ];
    const s = computeStats(records, opts());
    expect(s.models.map((m) => m.model)).toEqual([
      'claude-fake-a',
      'claude-fake-b',
      'claude-fake-c',
    ]);
    expect(s.models.map((m) => m.total)).toEqual([900, 300, 100]);
    expect(s.models.reduce((sum, m) => sum + m.share, 0)).toBeCloseTo(1, 10);
    expect(s.models[0]?.share).toBeCloseTo(900 / 1300, 10);
    expect(s.favoriteModel).toBe('claude-fake-a');
  });

  it('breaks a model tie by id', () => {
    const s = computeStats(
      [
        rec(daysAgo(0), 50, { model: 'claude-fake-z' }),
        rec(daysAgo(0), 50, { model: 'claude-fake-m' }),
      ],
      opts(),
    );
    expect(s.models.map((m) => m.model)).toEqual(['claude-fake-m', 'claude-fake-z']);
    expect(s.favoriteModel).toBe('claude-fake-m');
  });

  it('gives a share of 0 when the range has no tokens', () => {
    const s = computeStats([rec(daysAgo(0), 0, { usage: u(0, 0, 0, 500) })], opts());
    expect(s.models).toEqual([
      { model: 'claude-fake-1', usage: u(0, 0, 0, 500), total: 0, share: 0 },
    ]);
  });

  it(`keeps the top ${STATS_TOP_PROJECTS} projects, most used first`, () => {
    const totals = { p1: 10, p2: 70, p3: 30, p4: 50, p5: 30, p6: 60, p7: 5 };
    const records: UsageRecord[] = [];
    for (const [name, total] of Object.entries(totals)) {
      records.push(
        rec(daysAgo(1), total / 2, {
          projectId: `/home/user/${name}`,
          projectName: name,
          sessionId: `sess-${name}-1`,
        }),
        rec(daysAgo(0), total / 2, {
          projectId: `/home/user/${name}`,
          projectName: name,
          sessionId: `sess-${name}-2`,
        }),
      );
    }
    const s = computeStats(shuffle(records), opts());
    expect(s.projects).toHaveLength(STATS_TOP_PROJECTS);
    expect(s.projects.map((p) => p.projectName)).toEqual(['p2', 'p6', 'p4', 'p3', 'p5']);
    expect(s.projects[0]).toEqual({
      projectId: '/home/user/p2',
      projectName: 'p2',
      total: 70,
      sessions: 2,
    });
  });

  it('counts a project session once however its records interleave', () => {
    const p = { projectId: '/home/user/alpha', projectName: 'alpha' };
    const records = [
      rec(daysAgo(0, 9), 1, { ...p, sessionId: 'sess-x' }),
      rec(daysAgo(0, 10), 1, { ...p, sessionId: 'sess-y' }),
      rec(daysAgo(0, 11), 1, { ...p, sessionId: 'sess-x' }),
    ];
    expect(computeStats(records, opts()).projects[0]?.sessions).toBe(2);
  });
});

describe('computeStats: cost', () => {
  const price: ModelPrice = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
  const records = [
    rec(daysAgo(0), 0, { model: 'claude-fake-a', usage: u(1_000_000, 0, 0, 0) }),
    rec(daysAgo(1), 0, { model: 'claude-fake-b', usage: u(0, 1_000_000, 0, 0) }),
  ];

  it('is absent without prices', () => {
    expect(computeStats(records, opts()).costUsd).toBeUndefined();
  });

  it('is present when every model used has a price', () => {
    const s = computeStats(records, opts({ prices: { 'fake-a': price, 'fake-b': price } }));
    expect(s.costUsd).toBeCloseTo(18, 10);
    expect(computeStats(records, opts({ prices: { fake: price } })).costUsd).toBeCloseTo(18, 10);
  });

  it('is absent when any model used has no price', () => {
    expect(computeStats(records, opts({ prices: { 'fake-a': price } })).costUsd).toBeUndefined();
  });

  it('only looks at models used in the range', () => {
    const old = rec(daysAgo(60), 0, { model: 'claude-unpriced', usage: u(5, 0, 0, 0) });
    const s = computeStats([...records, old], opts({ prices: { fake: price } }));
    expect(s.costUsd).toBeCloseTo(18, 10);
  });
});

describe('computeStats: stability', () => {
  const records = [
    rec(daysAgo(0, 9), 100, { sessionId: 'sess-1', model: 'claude-fake-a' }),
    rec(daysAgo(0, 9, 20), 50, { sessionId: 'sess-1', agentId: 'agent-fake' }),
    rec(daysAgo(3, 22), 100, { sessionId: 'sess-2', projectId: '/home/user/b', projectName: 'b' }),
    rec(daysAgo(40, 1), 70, { sessionId: 'sess-3', model: 'claude-fake-c' }),
    rec(daysAgo(3, 8), 100, { sessionId: 'sess-4', projectId: '/home/user/c', projectName: 'c' }),
  ];

  it.each(STATS_RANGES)('%s gives a deeply equal snapshot twice and in any order', (range) => {
    const a = computeStats(records, opts({ range }));
    const b = computeStats(records, opts({ range }));
    expect(b).toEqual(a);
    expect(computeStats(shuffle(records, 5), opts({ range }))).toEqual(a);
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(records);
    computeStats(records, opts({ range: 'all' }));
    expect(records).toEqual(copy);
  });

  it('stays fast over a large history', () => {
    const big: UsageRecord[] = [];
    const start = daysAgo(400);
    for (let i = 0; i < 300_000; i++) {
      big.push(
        rec(start + i * 113_000, 100 + (i % 7), {
          sessionId: `sess-${Math.floor(i / 500)}`,
          projectId: `/home/user/p${i % 9}`,
          projectName: `p${i % 9}`,
          model: i % 3 === 0 ? 'claude-fake-a' : 'claude-fake-b',
        }),
      );
    }
    const t0 = performance.now();
    const s = computeStats(big, opts({ range: 'all' }));
    const ms = performance.now() - t0;
    expect(s.messages).toBe(300_000);
    expect(s.days).toHaveLength(STATS_MAX_DAYS);
    // Generous bound so slow CI machines pass; typically well under 100 ms.
    expect(ms).toBeLessThan(1000);
  });
});

describe('computeStats: daylight saving', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env['TZ'];
    process.env['TZ'] = 'America/New_York';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env['TZ'];
    else process.env['TZ'] = saved;
  });

  it('steps by calendar day across a 23-hour day', () => {
    // US clocks spring forward on 2026-03-08.
    const now = new Date(2026, 2, 20, 12).getTime();
    const lateOnShortDay = new Date(2026, 2, 8, 23, 30).getTime();
    const s = computeStats([rec(lateOnShortDay, 10)], { now, range: '30d' });
    expect(s.days).toHaveLength(30);
    expect(new Set(s.days.map((d) => d.day)).size).toBe(30);
    expect(s.days.find((d) => d.tokens > 0)?.day).toBe('2026-03-08');
    expect(s.byHour[23]).toBe(10);
    const short = s.days.find((d) => d.day === '2026-03-08');
    const next = s.days.find((d) => d.day === '2026-03-09');
    expect((next?.start ?? 0) - (short?.start ?? 0)).toBe(23 * 60 * M);
  });

  it('keeps streaks across a 25-hour day', () => {
    // US clocks fall back on 2026-11-01.
    const now = new Date(2026, 10, 3, 12).getTime();
    const records = [
      new Date(2026, 9, 31, 23, 50).getTime(),
      new Date(2026, 10, 1, 0, 10).getTime(),
      new Date(2026, 10, 2, 0, 5).getTime(),
      new Date(2026, 10, 3, 9).getTime(),
    ].map((ts) => rec(ts, 1));
    const s = computeStats(records, { now, range: '7d' });
    expect(s.currentStreak).toBe(4);
    expect(s.activeDays).toBe(4);
    expect(s.days.slice(-4).map((d) => d.messages)).toEqual([1, 1, 1, 1]);
  });

  it('counts both copies of a repeated hour as that hour, in any order', () => {
    const now = new Date(2026, 10, 3, 12).getTime();
    // 2026-11-01 05:30 and 06:30 UTC are 01:30 EDT and 01:30 EST.
    const records = [Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30)].map((ts) =>
      rec(ts, 5),
    );
    for (const order of [records, records.slice().reverse()]) {
      expect(computeStats(order, { now, range: '7d' }).byHour[1]).toBe(10);
    }
  });
});

describe('computeStats: clock changes that are not on the hour', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env['TZ'];
  });
  afterAll(() => {
    if (saved === undefined) delete process.env['TZ'];
    else process.env['TZ'] = saved;
  });

  /** byHour the slow way: one Date per record. */
  const naiveByHour = (records: readonly UsageRecord[]): number[] => {
    const out = new Array<number>(24).fill(0);
    for (const r of records) out[new Date(r.ts).getHours()]! += r.usage.input;
    return out;
  };

  const cases: { tz: string; utc: number[] }[] = [
    {
      // 2026-09-27: clocks jump from 02:45 to 03:45 (UTC 14:00). Local 02:30, 02:40, 03:50,
      // 03:55 and 04:10: hour 2 lasts 45 minutes, hour 3 only 15.
      tz: 'Pacific/Chatham',
      utc: [
        Date.UTC(2026, 8, 26, 13, 45),
        Date.UTC(2026, 8, 26, 13, 55),
        Date.UTC(2026, 8, 26, 14, 5),
        Date.UTC(2026, 8, 26, 14, 10),
        Date.UTC(2026, 8, 26, 14, 25),
      ],
    },
    {
      // 2026-10-04: clocks jump from 02:00 to 02:30 (UTC 15:30 on Oct 3). Local 01:35, 01:50,
      // 02:40 and 02:55: hour 2 lasts only 30 minutes.
      tz: 'Australia/Lord_Howe',
      utc: [
        Date.UTC(2026, 9, 3, 15, 5),
        Date.UTC(2026, 9, 3, 15, 20),
        Date.UTC(2026, 9, 3, 15, 40),
        Date.UTC(2026, 9, 3, 15, 55),
      ],
    },
  ];

  for (const { tz, utc } of cases) {
    it(`${tz}: every record lands in its own local hour, whatever the order`, () => {
      process.env['TZ'] = tz;
      const now = new Date(2026, 9, 10, 12).getTime();
      const records = utc.map((ts, i) => rec(ts, 10 ** i));
      const want = naiveByHour(records);
      // The hours really are split by the clock change.
      expect(want.filter((v) => v > 0).length).toBeGreaterThanOrEqual(2);
      const orders = [
        records,
        records.slice().reverse(),
        shuffle(records, 3),
        shuffle(records, 11),
      ];
      for (const order of orders) {
        expect(computeStats(order, { now, range: '30d' }).byHour).toEqual(want);
      }
    });
  }
});
