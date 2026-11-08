import { describe, expect, it } from 'vitest';
import type { DashboardOptions, TokenUsage, UsageRecord } from '../src/shared/dashboardTypes';
import {
  HOUR_MS,
  MINUTE_MS,
  UsageBook,
  activeWindow,
  burnPerMin,
  computeUsageStats,
  costFor,
  floorHour,
  hourlyBuckets,
  mergePlanLimits,
  priceFor,
  samePlanLimits,
} from '../src/shared/usage';

// 2026-01-01T00:00:00Z — synthetic clock.
const T0 = Date.UTC(2026, 0, 1);
const H = HOUR_MS;
const M = MINUTE_MS;
const WINDOW = 5 * H;

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
  sessionId: 'sess-1',
  agentId: 'orchestrator',
  projectId: 'proj-a',
  projectName: 'alpha',
  model: 'claude-fake-1',
  usage: u(tokens),
  ...over,
});
const bookOf = (...rs: UsageRecord[]): UsageBook => {
  const b = new UsageBook();
  b.add(rs);
  return b;
};
const opts = (now: number, over: Partial<DashboardOptions> = {}): DashboardOptions => ({
  now,
  idleMs: 10 * M,
  windowMs: WINDOW,
  ...over,
});

describe('UsageBook', () => {
  it('dedupes by key and keeps records sorted', () => {
    const a = rec(T0 + 2 * H, 10);
    const b = rec(T0 + H, 20);
    const book = new UsageBook();
    expect(book.add([a, b])).toBe(true);
    expect(book.add([{ ...a }, { ...b, usage: u(5) }])).toBe(false);
    expect(book.size).toBe(2);
    expect(book.records().map((r) => r.ts)).toEqual([T0 + H, T0 + 2 * H]);
    expect(book.sessionUsage('sess-1')).toEqual(u(30));
  });

  it('ignores malformed records', () => {
    const book = new UsageBook();
    const bad = [
      { ...rec(T0, 1), key: '' },
      { ...rec(T0, 1), ts: Number.NaN },
      null as unknown as UsageRecord,
    ];
    expect(book.add(bad)).toBe(false);
    expect(book.size).toBe(0);
  });

  it('prunes old records and their per-session totals', () => {
    const book = bookOf(
      rec(T0, 5, { sessionId: 'old' }),
      rec(T0 + H, 7),
      rec(T0 + 2 * H, 11, { model: 'claude-fake-2' }),
    );
    expect(book.prune(T0 + H)).toBe(1);
    expect(book.size).toBe(2);
    expect(book.sessionUsage('old')).toEqual(u(0));
    expect(book.sessionByModel('sess-1')).toEqual({
      'claude-fake-1': u(7),
      'claude-fake-2': u(11),
    });
    expect(book.prune(T0 + 3 * H)).toBe(2);
    expect(book.sessionByModel('sess-1')).toEqual({});
  });
});

describe('UsageBook — streamed repeats', () => {
  const key = 'msg_fake_stream:req_fake';

  it('keeps the per-field maximum of a repeated message and never double counts', () => {
    const book = bookOf(rec(T0, 0, { key, usage: u(3, 1, 7, 9) }));
    expect(book.add([rec(T0 + 1, 0, { key, usage: u(3, 500, 7, 9) })])).toBe(true);
    expect(book.add([rec(T0 + 2, 0, { key, usage: u(2, 400, 7, 9) })])).toBe(false);
    expect(book.size).toBe(1);
    expect(book.records()[0]?.usage).toEqual(u(3, 500, 7, 9));
    expect(book.sessionUsage('sess-1')).toEqual(u(3, 500, 7, 9));
    expect(book.sessionByModel('sess-1')).toEqual({ 'claude-fake-1': u(3, 500, 7, 9) });
  });

  it('ignores a repeat with non-numeric fields', () => {
    const book = bookOf(rec(T0, 0, { key, usage: u(3, 1) }));
    const bad = { ...u(3, 1), output: Number.NaN };
    expect(book.add([rec(T0, 0, { key, usage: bad })])).toBe(false);
    expect(book.sessionUsage('sess-1')).toEqual(u(3, 1));
  });

  it('moves the grown total when the same repeat also moves the credit', () => {
    const book = bookOf(rec(T0, 0, { key, sessionId: 'resumed', rank: 2, usage: u(0, 1) }));
    book.add([rec(T0, 0, { key, sessionId: 'orig', rank: 1, usage: u(0, 500) })]);
    expect(book.sessionUsage('orig')).toEqual(u(0, 500));
    expect(book.sessionUsage('resumed')).toEqual(u(0));
  });
});

describe('UsageBook — totals of kept sessions', () => {
  it('keeps totals for sessions the caller keeps, until the session is dropped', () => {
    const book = bookOf(
      rec(T0, 5, { sessionId: 'live' }),
      rec(T0 + 2 * H, 7, { sessionId: 'live' }),
    );
    expect(book.prune(T0 + H, (id) => id === 'live')).toBe(1);
    expect(book.size).toBe(1);
    expect(book.sessionUsage('live')).toEqual(u(12));
    book.dropSession('live');
    expect(book.sessionUsage('live')).toEqual(u(0));
  });
});

describe('repeated responses across sessions', () => {
  // A resumed session's transcript repeats the original's history (same key, other session).
  const orig = rec(T0, 100, { key: 'msg_fake_dup:req_fake', sessionId: 'orig', rank: 1 });
  const copy = rec(T0, 100, { key: 'msg_fake_dup:req_fake', sessionId: 'resumed', rank: 2 });

  it('credits the lowest-ranked session whatever the read order', () => {
    for (const order of [
      [orig, copy],
      [copy, orig],
    ]) {
      const book = new UsageBook();
      for (const r of order) book.add([r]);
      expect(book.size).toBe(1);
      expect(book.sessionUsage('orig').input).toBe(100);
      expect(book.sessionUsage('resumed').input).toBe(0);
      expect(book.sessionByModel('resumed')).toEqual({});
      expect(computeUsageStats(book, opts(T0 + M)).windowTotal).toBe(100);
    }
  });

  it('reports a change only when the credit moves', () => {
    const book = bookOf(copy);
    expect(book.add([copy])).toBe(false);
    expect(book.add([{ ...copy, sessionId: 'other', rank: 3 }])).toBe(false);
    expect(book.add([orig])).toBe(true);
    // Without ranks the first reader keeps it.
    const plain = bookOf({ ...copy, rank: undefined });
    expect(plain.add([{ ...orig, rank: undefined }])).toBe(false);
    expect(plain.sessionUsage('resumed').input).toBe(100);
  });

  it('does not change the records it was given', () => {
    const given = { ...copy };
    const book = bookOf(given);
    book.add([orig]);
    expect(given.sessionId).toBe('resumed');
  });
});

describe('usage window', () => {
  it('starts at the first record, floored to the UTC hour', () => {
    const rs = bookOf(rec(T0 + 2 * H + 37 * M, 1), rec(T0 + 3 * H, 1)).records();
    expect(activeWindow(rs, T0 + 4 * H, WINDOW)).toMatchObject({
      start: T0 + 2 * H,
      end: T0 + 7 * H,
    });
    expect(floorHour(T0 + 59 * M)).toBe(T0);
  });

  it('opens a new window at the first record after the previous one expired', () => {
    const rs = bookOf(
      rec(T0 + 10 * M, 100),
      rec(T0 + 4 * H, 100),
      rec(T0 + 6 * H + 15 * M, 7), // previous window ended at 05:00
      rec(T0 + 6 * H + 20 * M, 3),
    ).records();
    const now = T0 + 6 * H + 30 * M;
    expect(activeWindow(rs, now, WINDOW)).toMatchObject({ start: T0 + 6 * H, end: T0 + 11 * H });
    const s = computeUsageStats(bookOf(...rs), opts(now));
    expect(s.windowStart).toBe(T0 + 6 * H);
    expect(s.windowEnd).toBe(T0 + 11 * H);
    expect(s.windowTotal).toBe(10);
    expect(s.windowHours).toBe(5);
  });

  it('has no active window once the last one expired', () => {
    const book = bookOf(rec(T0 + 10 * M, 100));
    expect(activeWindow(book.records(), T0 + 5 * H, WINDOW)).toBeUndefined();
    const s = computeUsageStats(book, opts(T0 + 5 * H));
    expect(s.windowStart).toBeUndefined();
    expect(s.windowEnd).toBeUndefined();
    expect(s.windowTotal).toBe(0);
    expect(s.projectedTotal).toBe(0);
    expect(computeUsageStats(new UsageBook(), opts(T0)).windowStart).toBeUndefined();
  });

  it('ignores records from the future', () => {
    const book = bookOf(rec(T0 + 10 * M, 4), rec(T0 + 3 * H, 50));
    expect(computeUsageStats(book, opts(T0 + H)).windowTotal).toBe(4);
  });
});

describe('burn rate and projection', () => {
  it('averages tokens over the last 10 minutes', () => {
    const now = T0 + H;
    const rs = bookOf(
      rec(now - 10 * M, 1000), // exactly 10 min ago: excluded
      rec(now - 9 * M, 300),
      rec(now - M, 200),
      rec(now, 500),
    ).records();
    expect(burnPerMin(rs, now)).toBe(100);
  });

  it('projects the window total to the reset time', () => {
    const now = T0 + 4 * H; // window 00:00–05:00, 60 min left
    const book = bookOf(rec(T0 + 5 * M, 4000), rec(now - 5 * M, 1000));
    const s = computeUsageStats(book, opts(now, { windowLimit: 10_000, weeklyLimit: 99 }));
    expect(s.windowTotal).toBe(5000);
    expect(s.burnPerMin).toBe(100);
    expect(s.projectedTotal).toBe(5000 + 100 * 60);
    expect(s.windowLimit).toBe(10_000);
    expect(s.weeklyLimit).toBe(99);
  });
});

describe('what counts as used', () => {
  it('leaves cache reads out of every total but keeps them in the breakdown', () => {
    const now = T0 + 30 * M;
    const book = bookOf(rec(T0, 0, { usage: u(1, 20, 300, 100_000) }));
    const s = computeUsageStats(book, opts(now));
    expect(s.windowTotal).toBe(321);
    expect(s.weeklyTotal).toBe(321);
    expect(s.windowUsage.cacheRead).toBe(100_000);
    expect(s.burnPerMin).toBe(0);
    expect(s.hourly.at(-1)?.total).toBe(321);
    expect(book.sessionUsage('sess-1').cacheRead).toBe(100_000);
  });

  it('keeps a cache-read-only record (it still has a price)', () => {
    const book = bookOf(rec(T0, 0, { usage: u(0, 0, 0, 1_000_000) }));
    expect(book.size).toBe(1);
    const p = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
    expect(costFor(book.sessionByModel('sess-1'), { fake: p })).toBeCloseTo(0.3);
  });
});

describe('weekly and hourly', () => {
  it('sums the last 7 days', () => {
    const now = T0 + 8 * 24 * H;
    const book = bookOf(rec(now - 7 * 24 * H, 1000), rec(now - 7 * 24 * H + 1, 10), rec(now, 5));
    const s = computeUsageStats(book, opts(now));
    expect(s.weeklyTotal).toBe(15);
    expect(s.weeklyUsage).toEqual(u(15));
  });

  it('has 24 hour-aligned buckets ending with the current hour, stacked by project', () => {
    const now = T0 + 30 * H + 20 * M;
    const rs = bookOf(
      rec(now - 24 * H, 999), // before the first bucket
      rec(T0 + 7 * H + 5 * M, 3), // first bucket (07:00)
      rec(T0 + 30 * H, 10),
      rec(T0 + 30 * H + 10 * M, 5, { projectId: 'proj-b', projectName: 'beta' }),
    ).records();
    const hourly = hourlyBuckets(rs, now);
    expect(hourly).toHaveLength(24);
    expect(hourly[0]).toEqual({ start: T0 + 7 * H, total: 3, byProject: { 'proj-a': 3 } });
    expect(hourly[23]).toEqual({
      start: T0 + 30 * H,
      total: 15,
      byProject: { 'proj-a': 10, 'proj-b': 5 },
    });
    const s = computeUsageStats(bookOf(...rs), opts(now));
    expect(s.projectNames).toEqual({ 'proj-a': 'alpha', 'proj-b': 'beta' });
  });
});

describe('cost', () => {
  const p = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
  const q = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };

  it('matches the longest model-id substring, case-insensitively', () => {
    const prices = { fake: q, 'claude-fake-1': p };
    expect(priceFor('Claude-Fake-1-20260101', prices)).toBe(p);
    expect(priceFor('claude-fake-2', prices)).toBe(q);
    expect(priceFor('other', prices)).toBeUndefined();
    expect(priceFor('x', undefined)).toBeUndefined();
  });

  it('prices all four token kinds per million', () => {
    expect(costFor({ 'claude-fake-1': u(1e6, 1e6, 1e6, 1e6) }, { 'fake-1': p })).toBeCloseTo(
      3 + 15 + 3.75 + 0.3,
    );
  });

  it('is only defined when every model in range has a price', () => {
    const now = T0 + H;
    const book = bookOf(rec(now - M, 1e6), rec(now - 2 * M, 1e6, { model: 'mystery-model' }));
    expect(computeUsageStats(book, opts(now, { prices: { 'fake-1': p } })).windowCostUsd).toBe(
      undefined,
    );
    const all = computeUsageStats(book, opts(now, { prices: { 'fake-1': p, mystery: q } }));
    expect(all.windowCostUsd).toBeCloseTo(4);
    expect(all.weeklyCostUsd).toBeCloseTo(4);
    expect(computeUsageStats(book, opts(now)).weeklyCostUsd).toBeUndefined();
    expect(costFor({}, {})).toBeUndefined();
    expect(costFor({}, { x: p })).toBe(0);
  });
});

describe('mergePlanLimits', () => {
  const T = 1_800_000_000_000;
  const w = (usedPct: number, resetsAt: number) => ({ usedPct, resetsAt });

  it('takes a newer update per window and keeps a missing window until it resets', () => {
    const prev = { updatedAt: T, fiveHour: w(10, T + 1000), sevenDay: w(40, T + 9000) };
    const next = { updatedAt: T + 10, fiveHour: w(12, T + 1000) };
    expect(mergePlanLimits(prev, next, T + 10)).toEqual({
      updatedAt: T + 10,
      fiveHour: w(12, T + 1000),
      sevenDay: w(40, T + 9000),
    });
    // The weekly window has reset by now: it is dropped, not carried forward.
    expect(mergePlanLimits(prev, next, T + 9000)).toEqual({
      updatedAt: T + 10,
      fiveHour: w(12, T + 1000),
    });
  });

  it('ignores an update older than what is known (out of order)', () => {
    const prev = { updatedAt: T + 50, fiveHour: w(30, T + 1000) };
    const late = { updatedAt: T, fiveHour: w(5, T + 1000) };
    expect(mergePlanLimits(prev, late, T + 60)).toBe(prev);
  });

  it('keeps the higher usage of one window: an idle session reports old numbers', () => {
    const prev = { updatedAt: T, fiveHour: w(55, T + 1000), sevenDay: w(20, T + 9000) };
    const idle = { updatedAt: T + 10, fiveHour: w(40, T + 1000), sevenDay: w(21, T + 9000) };
    expect(mergePlanLimits(prev, idle, T + 10)).toEqual({
      updatedAt: T + 10,
      fiveHour: w(55, T + 1000),
      sevenDay: w(21, T + 9000),
    });
  });

  it('ignores a window that resets earlier than the known one', () => {
    const prev = { updatedAt: T, fiveHour: w(3, T + 18_000) };
    const stale = { updatedAt: T + 10, fiveHour: w(90, T - 1000) };
    expect(mergePlanLimits(prev, stale, T + 10).fiveHour).toEqual(w(3, T + 18_000));
  });

  it('a later reset is a new window, even with lower usage', () => {
    const prev = { updatedAt: T, fiveHour: w(90, T + 1000) };
    const fresh = { updatedAt: T + 10, fiveHour: w(2, T + 18_000) };
    expect(mergePlanLimits(prev, fresh, T + 2000).fiveHour).toEqual(w(2, T + 18_000));
  });

  it('starts from nothing', () => {
    const next = { updatedAt: T, sevenDay: w(1, T + 5) };
    expect(mergePlanLimits(undefined, next, T)).toEqual(next);
  });

  it('samePlanLimits compares numbers, not updatedAt', () => {
    const a = { updatedAt: T, fiveHour: w(1, 2) };
    expect(samePlanLimits(a, { updatedAt: T + 1, fiveHour: w(1, 2) })).toBe(true);
    expect(samePlanLimits(a, { updatedAt: T, fiveHour: w(2, 2) })).toBe(false);
    expect(samePlanLimits(a, { updatedAt: T, fiveHour: w(1, 2), sevenDay: w(1, 2) })).toBe(false);
    expect(samePlanLimits(undefined, a)).toBe(false);
  });
});
