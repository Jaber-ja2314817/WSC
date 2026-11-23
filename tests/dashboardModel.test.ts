import { describe, expect, it } from 'vitest';
import type { HourBucket, SessionSummary, UsageStats } from '../src/shared/dashboardTypes';
import { ZERO_USAGE } from '../src/shared/dashboardTypes';
import {
  OTHER_ID,
  assignSlots,
  filledCells,
  formatCountdown,
  formatDuration,
  sessionDurationMs,
  formatRate,
  formatTokens,
  formatUsd,
  modelRows,
  needsYou,
  percent,
  railReading,
  relativeTime,
  segmentHeights,
  sessionIdFromAgentKey,
  shortModel,
  stackHourly,
  statusLabel,
  statusTone,
  timelineIcon,
  usageLevel,
  barFill,
  formatResetAt,
  planRows,
  hourLabel,
} from '../src/renderer/panels/dashboardModel';

/** The machine's own time zone, to restore after tests that change TZ. */
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const HOUR = 3_600_000;

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [-5, '0'],
    [Number.NaN, '0'],
    [845, '845'],
    [999, '999'],
    [1000, '1k'],
    [1234, '1.2k'],
    [12_345, '12.3k'],
    [845_000, '845k'],
    [999_960, '1M'],
    [1_200_000, '1.2M'],
    [12_500_000, '12.5M'],
    [345_000_000, '345M'],
    [2_100_000_000, '2.1B'],
  ])('%d → %s', (n, out) => expect(formatTokens(n)).toBe(out));

  it('formats rates and money', () => {
    expect(formatRate(12_300)).toBe('12.3k tok/min');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('formatCountdown / formatDuration / relativeTime', () => {
  it('counts down', () => {
    expect(formatCountdown(2 * HOUR + 14 * 60_000 + 30_000)).toBe('2h 14m');
    expect(formatCountdown(14 * 60_000 + 5_000)).toBe('14m 05s');
    expect(formatCountdown(45_500)).toBe('45s');
    expect(formatCountdown(-1000)).toBe('0s');
  });

  it('formats durations', () => {
    expect(formatDuration(40_000)).toBe('40s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(HOUR + 5 * 60_000)).toBe('1h 05m');
    expect(formatDuration(50 * HOUR)).toBe('2d 2h');
  });

  it('formats relative time', () => {
    const now = 1_000_000_000;
    expect(relativeTime(now, now)).toBe('just now');
    expect(relativeTime(now + 5000, now)).toBe('just now');
    expect(relativeTime(now - 45_000, now)).toBe('45s ago');
    expect(relativeTime(now - 3 * 60_000, now)).toBe('3m ago');
    expect(relativeTime(now - 2 * HOUR, now)).toBe('2h ago');
    expect(relativeTime(now - 72 * HOUR, now)).toBe('3d ago');
  });
});

describe('percent + level', () => {
  it('needs a positive limit', () => {
    expect(percent(10, null)).toBeUndefined();
    expect(percent(10, undefined)).toBeUndefined();
    expect(percent(10, 0)).toBeUndefined();
    expect(percent(50, 200)).toBe(25);
    expect(percent(300, 200)).toBe(150);
  });

  it('maps to ok / warn / danger', () => {
    expect(usageLevel(undefined)).toBe('ok');
    expect(usageLevel(74)).toBe('ok');
    expect(usageLevel(75)).toBe('warn');
    expect(usageLevel(89)).toBe('warn');
    expect(usageLevel(90)).toBe('danger');
    expect(usageLevel(140)).toBe('danger');
  });

  it('fills whole cells, at least one when used, capped', () => {
    expect(filledCells(0, 20)).toBe(0);
    expect(filledCells(1, 20)).toBe(1);
    expect(filledCells(50, 20)).toBe(10);
    expect(filledCells(250, 20)).toBe(20);
  });

  it('rail shows % with a limit, tokens without', () => {
    const usage = {
      windowTotal: 1_200_000,
      windowLimit: undefined,
    } as unknown as UsageStats;
    expect(railReading(undefined)).toEqual({ text: '–', level: 'ok' });
    expect(railReading(usage)).toEqual({ text: '1.2M', level: 'ok' });
    expect(railReading({ ...usage, windowLimit: 1_300_000 })).toEqual({
      text: '92%',
      level: 'danger',
    });
  });
});

describe('sessions', () => {
  it('stops counting an idle session at its last activity', () => {
    const base = { startedAt: 1_000, lastActivityAt: 31_000 };
    expect(sessionDurationMs({ ...base, status: 'idle' }, 999_000)).toBe(30_000);
    expect(sessionDurationMs({ ...base, status: 'working' }, 61_000)).toBe(60_000);
    expect(sessionDurationMs({ ...base, status: 'ended', endedAt: 41_000 }, 999_000)).toBe(40_000);
  });

  it('labels and tones statuses', () => {
    expect(statusLabel('waiting')).toBe('waiting for you');
    expect(statusLabel('working')).toBe('working');
    expect(statusLabel('idle')).toBe('idle');
    expect(statusLabel('ended')).toBe('ended');
    expect(statusTone('working')).toBe('working');
    expect(statusTone('waiting')).toBe('waiting');
    expect(statusTone('idle')).toBe('done');
    expect(statusTone('ended')).toBe('stale');
  });

  it('detects a waiting session', () => {
    const s = (status: SessionSummary['status']) => ({ status }) as SessionSummary;
    expect(needsYou(undefined)).toBe(false);
    expect(needsYou([s('working'), s('idle')])).toBe(false);
    expect(needsYou([s('working'), s('waiting')])).toBe(true);
  });

  it('extracts the session id from an agent key (last colon)', () => {
    expect(sessionIdFromAgentKey('11111111-2222-3333-4444-555555555555:orchestrator')).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
    expect(sessionIdFromAgentKey('weird:session:agent-1')).toBe('weird:session');
    expect(sessionIdFromAgentKey('nocolon')).toBeUndefined();
    expect(sessionIdFromAgentKey(':agent')).toBeUndefined();
    expect(sessionIdFromAgentKey(undefined)).toBeUndefined();
  });

  it('shortens model ids', () => {
    expect(shortModel('claude-opus-4-5-20251101')).toBe('opus-4-5');
    expect(shortModel('claude-sonnet-4-5')).toBe('sonnet-4-5');
    expect(shortModel('custom-model')).toBe('custom-model');
  });

  it('sorts per-model rows by total', () => {
    const rows = modelRows({
      a: { ...ZERO_USAGE, input: 10 },
      b: { ...ZERO_USAGE, output: 50, cacheRead: 5 },
    });
    expect(rows.map((r) => [r.model, r.total])).toEqual([
      ['b', 50],
      ['a', 10],
    ]);
    expect(modelRows(undefined)).toEqual([]);
  });

  it('marks failed tools in the timeline', () => {
    expect(timelineIcon('tool')).toBe('▸');
    expect(timelineIcon('tool', true)).toBe('▸');
    expect(timelineIcon('tool', false)).toBe('✕');
    expect(timelineIcon('wait')).toBe('⚑');
  });
});

describe('hourly chart stacking', () => {
  const bucket = (i: number, byProject: Record<string, number>, extra = 0): HourBucket => ({
    start: i * HOUR,
    byProject,
    total: Object.values(byProject).reduce((s, v) => s + v, 0) + extra,
  });

  it('keeps the top N projects and folds the rest into other', () => {
    const hourly = [
      bucket(0, { a: 100, b: 50, c: 10, d: 5 }),
      bucket(1, { a: 20, c: 40, e: 1 }, 7),
    ];
    const names = { a: 'alpha', b: 'beta', c: 'gamma' };
    const chart = stackHourly(hourly, names, 2);
    // a (120) and b (50) beat c (50 → tie broken by id), d, e.
    expect(chart.series.map((s) => s.id)).toEqual(['a', 'b', OTHER_ID]);
    expect(chart.series.map((s) => s.name)).toEqual(['alpha', 'beta', 'other']);
    expect(chart.series[2]!.total).toBe(10 + 5 + 40 + 1 + 7);
    expect(chart.bars[0]!.values).toEqual([100, 50, 15]);
    expect(chart.bars[1]!.values).toEqual([20, 0, 48]);
    expect(chart.max).toBe(165);
    // Every bar's stack adds up to its total.
    for (const b of chart.bars) expect(b.values.reduce((s, v) => s + v, 0)).toBe(b.total);
  });

  it('has no other series when the top N cover everything', () => {
    const chart = stackHourly([bucket(0, { a: 1, b: 2 })], {}, 5);
    expect(chart.series.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(chart.series[0]!.name).toBe(chart.series[0]!.id);
  });

  it('handles an empty day', () => {
    const chart = stackHourly([bucket(0, {}), bucket(1, {})], {});
    expect(chart.series).toEqual([]);
    expect(chart.max).toBe(0);
  });

  it('keeps colour slots stable when ranks change', () => {
    const first = stackHourly([bucket(0, { a: 10, b: 5 })], {}, 5);
    expect(first.slots).toEqual({ a: 0, b: 1 });
    const second = stackHourly([bucket(0, { a: 1, b: 50, c: 20 })], {}, 5, first.slots);
    expect(second.slots).toEqual({ a: 0, b: 1, c: 2 });
    expect(second.series.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('reuses freed slots for newcomers', () => {
    expect(assignSlots({ a: 0, b: 1, c: 2 }, ['c', 'd'], 3)).toEqual({ c: 2, d: 0 });
    expect(assignSlots({ a: 9 }, ['a'], 3)).toEqual({ a: 0 });
  });

  it('computes integer segment heights that add up', () => {
    const h = segmentHeights([30, 20, 10], 120, 96);
    expect(h.every(Number.isInteger)).toBe(true);
    expect(h.reduce((s, v) => s + v, 0)).toBe(48);
    expect(segmentHeights([100, 0.01], 100, 96)).toEqual([95, 1]);
    expect(segmentHeights([0, 0], 100, 96)).toEqual([0, 0]);
    expect(segmentHeights([5], 0, 96)).toEqual([0]);
    // A tiny bar still shows one pixel.
    expect(segmentHeights([1], 1_000_000, 96)).toEqual([1]);
  });
});

describe('hourLabel', () => {
  const withTz = (tz: string, fn: () => void): void => {
    const prev = process.env['TZ'];
    process.env['TZ'] = tz;
    try {
      fn();
    } finally {
      // Windows keeps the last zone after a delete; set the host's zone back first.
      if (prev === undefined) {
        process.env['TZ'] = HOST_TZ;
        delete process.env['TZ'];
      } else process.env['TZ'] = prev;
    }
  };
  const UTC_HOUR = Date.UTC(2026, 0, 15, 9);

  it('reads as an hour in a whole-hour zone', () => {
    withTz('Asia/Riyadh', () => expect(hourLabel(UTC_HOUR)).toBe('12h'));
  });

  it('shows the minutes in a half-hour zone, so the bar matches the local clock', () => {
    withTz('Asia/Kolkata', () => expect(hourLabel(UTC_HOUR)).toBe('14:30'));
  });
});

describe('plan usage bars', () => {
  const T = new Date(2026, 10, 2, 9, 0, 0).getTime();
  const limits = {
    updatedAt: T,
    fiveHour: { usedPct: 77.6, resetsAt: T + 2 * 3_600_000 + 14 * 60_000 },
    sevenDay: { usedPct: 23, resetsAt: new Date(2026, 10, 5, 14, 0, 0).getTime() },
  };

  it('rows: current session first, rounded %, warning levels', () => {
    const rows = planRows(limits, T);
    expect(rows.map((r) => [r.key, r.label, r.pct, r.level, r.reset])).toEqual([
      ['fiveHour', 'Current session', 78, 'warn', false],
      ['sevenDay', 'Weekly · all models', 23, 'ok', false],
    ]);
    expect(
      planRows({ updatedAt: T, sevenDay: { usedPct: 95, resetsAt: T + 1 } }, T)[0],
    ).toMatchObject({ key: 'sevenDay', pct: 95, level: 'danger' });
    expect(planRows(undefined, T)).toEqual([]);
  });

  it('a window whose reset time has passed reads 0 %', () => {
    const [five] = planRows(limits, limits.fiveHour.resetsAt);
    expect(five).toMatchObject({ pct: 0, level: 'ok', reset: true });
  });

  it('formatResetAt: countdown within a day, weekday + time beyond', () => {
    expect(formatResetAt(limits.fiveHour.resetsAt, T)).toBe('resets in 2h 14m');
    expect(formatResetAt(limits.sevenDay.resetsAt, T)).toBe('resets Thu 14:00');
    expect(formatResetAt(T - 1, T)).toMatch(/^reset/);
  });

  it('barFill: 0 stays empty, any usage shows a sliver, capped at 100', () => {
    expect(barFill(0)).toBe(0);
    expect(barFill(1)).toBe(2);
    expect(barFill(55)).toBe(55);
    expect(barFill(130)).toBe(100);
  });

  it('railReading prefers the real 5-hour plan %', () => {
    const usage = { windowTotal: 1_234_567 } as UsageStats;
    expect(railReading(usage, limits, T)).toEqual({ text: '78%', level: 'warn' });
    expect(railReading(undefined, limits, T)).toEqual({ text: '78%', level: 'warn' });
  });
});
