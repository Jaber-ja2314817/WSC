import { describe, expect, it } from 'vitest';
import { ZERO_USAGE } from '../src/shared/dashboardTypes';
import type { StatsDay, StatsSnapshot } from '../src/shared/statsTypes';
import {
  HEAT_CELL_MAX,
  HEAT_CELL_MIN,
  HEAT_WIDTH_PX,
  MONTH_LABEL_PX,
  STATS_POLL_IDLE_MS,
  STATS_POLL_SCANNING_MS,
  barPx,
  dayBars,
  dayReading,
  formatDate,
  formatDay,
  heatCellPx,
  heatGrid,
  heatLevel,
  heatThresholds,
  hourBars,
  hourOfDayLabel,
  hourSpan,
  keptStats,
  parseDay,
  plural,
  rangeTitle,
  sharePct,
  statsFootnote,
  statsModelRows,
  statsPhase,
  statsPollDelay,
  statsProjectRows,
  statsTiles,
} from '../src/renderer/panels/statsModel';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Contiguous synthetic days from a local calendar date, with the given token counts. */
function daysFrom(y: number, m: number, d: number, tokens: number[]): StatsDay[] {
  return tokens.map((t, i): StatsDay => {
    const date = new Date(y, m - 1, d + i);
    return {
      day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      start: date.getTime(),
      tokens: t,
      sessions: t > 0 ? 1 : 0,
      messages: t > 0 ? 2 : 0,
      byModel: t > 0 ? { 'claude-test-model': t } : {},
    };
  });
}

function snap(over: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return {
    range: '30d',
    generatedAt: new Date(2026, 10, 10, 12).getTime(),
    scanning: false,
    usage: ZERO_USAGE,
    total: 0,
    sessions: 0,
    messages: 0,
    activeDays: 0,
    totalDays: 30,
    currentStreak: 0,
    longestStreak: 0,
    byHour: Array.from({ length: 24 }, () => 0),
    models: [],
    projects: [],
    days: [],
    ...over,
  };
}

const FULL = snap({
  rangeStart: new Date(2026, 9, 12).getTime(),
  firstActivityAt: new Date(2026, 8, 3, 9).getTime(),
  usage: { input: 1000, output: 200_000, cacheCreation: 1_000_000, cacheRead: 9_000_000 },
  total: 1_201_000,
  sessions: 14,
  messages: 321,
  activeDays: 12,
  currentStreak: 3,
  longestStreak: 1,
  mostActiveDay: { day: '2026-11-03', tokens: 1_234_567 },
  longestSession: {
    shortId: 'abcd1234',
    projectName: 'demo-project',
    startedAt: new Date(2026, 10, 3, 9).getTime(),
    durationMs: (2 * 60 + 5) * 60_000,
  },
  byHour: Array.from({ length: 24 }, (_, h) => (h === 14 ? 900_000 : h === 9 ? 100 : 0)),
  peakHour: 14,
  favoriteModel: 'claude-opus-4-5-20251101',
  models: [
    {
      model: 'claude-opus-4-5-20251101',
      usage: { input: 900, output: 150_000, cacheCreation: 800_000, cacheRead: 5 },
      total: 950_900,
      share: 0.7917,
    },
    {
      model: 'claude-haiku-4-5',
      usage: { input: 100, output: 50_000, cacheCreation: 200_000, cacheRead: 0 },
      total: 250_100,
      share: 0.0041,
    },
  ],
  projects: [
    { projectId: '/home/user/proj-a', projectName: 'proj-a', total: 1_000_000, sessions: 10 },
    { projectId: '/home/user/proj-b', projectName: 'proj-b', total: 201_000, sessions: 1 },
  ],
});

describe('statsPollDelay', () => {
  it('polls fast while scanning, slowly otherwise', () => {
    expect(statsPollDelay(snap({ scanning: true }))).toBe(STATS_POLL_SCANNING_MS);
    expect(STATS_POLL_SCANNING_MS).toBe(1500);
    expect(statsPollDelay(snap())).toBe(STATS_POLL_IDLE_MS);
    expect(STATS_POLL_IDLE_MS).toBe(60_000);
  });

  it('falls back to the slow delay without a snapshot', () => {
    expect(statsPollDelay(null)).toBe(STATS_POLL_IDLE_MS);
    expect(statsPollDelay(undefined)).toBe(STATS_POLL_IDLE_MS);
  });
});

describe('keptStats', () => {
  it('keeps the last snapshot only for the station mode it came from', () => {
    expect(keptStats({ snap: FULL, demo: true }, true)).toBe(FULL);
    expect(keptStats({ snap: FULL, demo: false }, false)).toBe(FULL);
    // Demo numbers never pass for real history, nor real projects show during a demo.
    expect(keptStats({ snap: FULL, demo: true }, false)).toBeNull();
    expect(keptStats({ snap: FULL, demo: false }, true)).toBeNull();
    expect(keptStats({ snap: FULL }, false)).toBeNull();
    expect(keptStats({ snap: null, demo: false }, false)).toBeNull();
  });
});

describe('statsPhase', () => {
  it('first load, unavailable, empty, scanning and full', () => {
    expect(statsPhase(null, false)).toBe('loading');
    expect(statsPhase(null, true)).toBe('unavailable');
    expect(statsPhase(FULL, true)).toBe('unavailable');
    expect(statsPhase(snap(), false)).toBe('empty');
    expect(statsPhase(snap({ scanning: true }), false)).toBe('loading');
    expect(statsPhase({ ...FULL, scanning: true }, false)).toBe('scanning');
    expect(statsPhase(FULL, false)).toBe('full');
  });
});

describe('words and dates', () => {
  it('plural', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(0, 'day')).toBe('0 days');
    expect(plural(4, 'session')).toBe('4 sessions');
  });

  it('parseDay rejects malformed days', () => {
    expect(parseDay('2026-11-03')).toEqual({ y: 2026, m: 11, d: 3 });
    expect(parseDay('2026-11-3')).toBeUndefined();
    expect(parseDay('')).toBeUndefined();
  });

  it('formatDay reads like "Tue 3 Nov"', () => {
    expect(formatDay('2026-11-03')).toBe('Tue 3 Nov');
    expect(formatDay('2026-01-01')).toBe('Thu 1 Jan');
    expect(formatDay('nonsense')).toBe('nonsense');
  });

  it('formatDate is local', () => {
    expect(formatDate(new Date(2026, 9, 3, 23, 59).getTime())).toBe('3 Oct 2026');
  });

  it('rangeTitle names the range, and the start of "All"', () => {
    expect(rangeTitle('7d')).toBe('Last 7 days');
    expect(rangeTitle('30d', FULL)).toBe('Last 30 days');
    expect(rangeTitle('all')).toBe('All history');
    expect(rangeTitle('all', { ...FULL, range: 'all' })).toBe('Since 12 Oct 2026');
    // A snapshot of another range (still loading) does not lend its start.
    expect(rangeTitle('all', FULL)).toBe('All history');
  });

  it('dayReading', () => {
    expect(dayReading({ day: '2026-11-03', tokens: 1_234_567, sessions: 4 })).toBe(
      'Tue 3 Nov · 1.2M tokens · 4 sessions',
    );
    expect(dayReading({ day: '2026-11-03', tokens: 845, sessions: 1 })).toBe(
      'Tue 3 Nov · 845 tokens · 1 session',
    );
    expect(dayReading({ day: '2026-11-04', tokens: 0, sessions: 0 })).toBe(
      'Wed 4 Nov · no activity',
    );
  });

  it('sharePct', () => {
    expect(sharePct(0)).toBe('0%');
    expect(sharePct(Number.NaN)).toBe('0%');
    expect(sharePct(0.004)).toBe('<1%');
    expect(sharePct(0.7917)).toBe('79%');
    expect(sharePct(1)).toBe('100%');
  });
});

describe('hours', () => {
  it('labels', () => {
    expect(hourOfDayLabel(0)).toBe('00h');
    expect(hourOfDayLabel(14)).toBe('14h');
    expect(hourSpan(9)).toBe('09:00–10:00');
    expect(hourSpan(23)).toBe('23:00–24:00');
  });

  it('24 bars, axis every 6 h, the peak marked, whole pixels', () => {
    const bars = hourBars(FULL.byHour, FULL.peakHour, 64);
    expect(bars).toHaveLength(24);
    expect(bars.filter((b) => b.label).map((b) => b.label)).toEqual(['00h', '06h', '12h', '18h']);
    expect(bars.filter((b) => b.mark).map((b) => b.key)).toEqual(['h14']);
    expect(bars[14]!.px).toBe(64);
    expect(bars[9]!.px).toBe(1); // tiny but non-zero: still visible
    expect(bars[0]!.px).toBe(0);
    for (const b of bars) expect(Number.isInteger(b.px)).toBe(true);
    expect(bars[14]!.reading).toBe('14:00–15:00 · 900k tokens · peak');
    expect(bars[0]!.reading).toBe('00:00–01:00 · no tokens');
  });

  it('copes with a short or empty byHour', () => {
    const bars = hourBars([], undefined, 64);
    expect(bars).toHaveLength(24);
    expect(bars.every((b) => b.px === 0 && !b.mark)).toBe(true);
  });

  it('barPx', () => {
    expect(barPx(0, 10, 50)).toBe(0);
    expect(barPx(5, 10, 50)).toBe(25);
    expect(barPx(10, 0, 50)).toBe(0);
  });
});

describe('dayBars (7d)', () => {
  it('one bar per day, weekday labels, today marked', () => {
    const days = daysFrom(2026, 11, 4, [0, 10, 20, 0, 40, 5, 80]);
    const bars = dayBars(days, 72);
    expect(bars.map((b) => b.label)).toEqual(['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue']);
    expect(bars.map((b) => b.mark)).toEqual([false, false, false, false, false, false, true]);
    expect(bars[6]!.px).toBe(72);
    expect(bars[0]!.px).toBe(0);
    expect(bars[1]!.reading).toBe('Thu 5 Nov · 10 tokens · 1 session');
  });
});

describe('heat levels', () => {
  it('all zero: no thresholds, everything level 0', () => {
    const t = heatThresholds([0, 0, 0]);
    expect(t).toEqual([]);
    expect(heatLevel(0, t)).toBe(0);
    expect(heatLevel(5, t)).toBe(0);
  });

  it('all days equal: all at the top level', () => {
    const t = heatThresholds([7, 7, 7, 0]);
    expect([7, 7, 7].map((v) => heatLevel(v, t))).toEqual([4, 4, 4]);
    expect(heatLevel(0, t)).toBe(0);
  });

  it('one outlier does not flatten the other days', () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10_000];
    const t = heatThresholds(values);
    expect(heatLevel(10_000, t)).toBe(4);
    expect(heatLevel(10, t)).toBe(2);
    expect(heatLevel(10, t)).toBeGreaterThan(0);
  });

  it('spread values use all four levels, in order', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const t = heatThresholds(values);
    expect(t).toEqual([1, 3, 5, 7]);
    expect(values.map((v) => heatLevel(v, t))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('ignores negative and non-finite values', () => {
    const t = heatThresholds([-5, Number.NaN, Number.POSITIVE_INFINITY, 3]);
    expect(t).toEqual([3, 3, 3, 3]);
    expect(heatLevel(-1, t)).toBe(0);
    expect(heatLevel(Number.NaN, t)).toBe(0);
  });
});

describe('heatGrid', () => {
  it('aligns weeks to Monday, with partial first and last weeks', () => {
    // Wed 4 Nov 2026 … Tue 17 Nov 2026 (14 days).
    const days = daysFrom(
      2026,
      11,
      4,
      Array.from({ length: 14 }, (_, i) => i + 1),
    );
    const g = heatGrid(days);
    expect(g.weeks).toBe(3);
    expect(g.rows).toHaveLength(7);
    for (const r of g.rows) expect(r).toHaveLength(3);
    // First week: Mon and Tue are outside the range, Wed is the first day.
    expect(g.rows[0]![0]).toBeNull();
    expect(g.rows[1]![0]).toBeNull();
    expect(g.rows[2]![0]!.day.day).toBe('2026-11-04');
    // Last week: Mon 16, Tue 17, then nothing.
    expect(g.rows[0]![2]!.day.day).toBe('2026-11-16');
    expect(g.rows[1]![2]!.day.day).toBe('2026-11-17');
    expect(g.rows[2]![2]).toBeNull();
    expect(g.rows[6]![2]).toBeNull();
    // Every day sits exactly once, at the position `cells` reports.
    const placed = g.rows.flat().filter((c) => c !== null);
    expect(placed).toHaveLength(14);
    days.forEach((d, i) => {
      const at = g.cells[i]!;
      expect(g.rows[at.row]![at.week]!.day).toBe(d);
      expect(g.rows[at.row]![at.week]!.index).toBe(i);
    });
    expect(g.rowLabels).toEqual(['Mon', '', 'Wed', '', 'Fri', '', '']);
  });

  it('a range starting on Monday has no leading gap', () => {
    const g = heatGrid(daysFrom(2026, 11, 2, [1, 2, 3, 4, 5, 6, 7]));
    expect(g.weeks).toBe(1);
    expect(g.rows.map((r) => r[0]?.day.day)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
  });

  it('can start weeks on Sunday', () => {
    const g = heatGrid(daysFrom(2026, 11, 2, [1, 2]), 0);
    expect(g.rows[1]![0]!.day.day).toBe('2026-11-02');
    expect(g.rowLabels[0]).toBe('Sun');
  });

  it('cells carry their level and reading', () => {
    const g = heatGrid(daysFrom(2026, 11, 2, [0, 5, 500]));
    expect(g.rows[0]![0]!.level).toBe(0);
    expect(g.rows[0]![0]!.reading).toBe('Mon 2 Nov · no activity');
    expect(g.rows[2]![0]!.level).toBe(4);
    expect(g.rows[2]![0]!.reading).toBe('Wed 4 Nov · 500 tokens · 1 session');
  });

  it('month labels sit over the week holding the 1st', () => {
    // Mon 12 Oct … Tue 10 Nov 2026 (30 days): 1 Nov is a Sunday, in week column 2.
    const g = heatGrid(
      daysFrom(
        2026,
        10,
        12,
        Array.from({ length: 30 }, () => 1),
      ),
    );
    expect(g.weeks).toBe(5);
    // 18 px columns: "Oct" over column 0 fits before "Nov" two columns later.
    expect(heatCellPx(5)).toEqual({ cell: 16, gap: 2 });
    expect(g.months).toEqual([
      { week: 0, label: 'Oct' },
      { week: 2, label: 'Nov' },
    ]);
  });

  it("leaves the first column's month out when it would touch the next label", () => {
    // Mon 19 Oct … Tue 17 Nov 2026 (30 days): 1 Nov is in week column 1, 18 px along.
    const g = heatGrid(
      daysFrom(
        2026,
        10,
        19,
        Array.from({ length: 30 }, () => 1),
      ),
    );
    expect(g.weeks).toBe(5);
    expect(g.months).toEqual([{ week: 1, label: 'Nov' }]);
  });

  it('month labels never overlap on a long heatmap', () => {
    // From Mon 10 Nov 2025 for 50 weeks: 1 Dec 2025 (a Monday) is in column 3, 15 px along.
    const days = daysFrom(
      2025,
      11,
      10,
      Array.from({ length: 50 * 7 }, (_, i) => (i % 3) + 1),
    );
    const g = heatGrid(days);
    const { cell, gap } = heatCellPx(g.weeks);
    expect(g.months[0]).toEqual({ week: 3, label: 'Dec' });
    for (let i = 1; i < g.months.length; i++) {
      const gapPx = (g.months[i]!.week - g.months[i - 1]!.week) * (cell + gap);
      expect(gapPx).toBeGreaterThanOrEqual(MONTH_LABEL_PX);
    }
  });

  it('the first column is named when the next label is far enough away', () => {
    // Mon 5 Oct … 10 Nov: 1 Nov falls in week column 3.
    const g = heatGrid(
      daysFrom(
        2026,
        10,
        5,
        Array.from({ length: 37 }, () => 1),
      ),
    );
    expect(g.months).toEqual([
      { week: 0, label: 'Oct' },
      { week: 3, label: 'Nov' },
    ]);
  });

  it('a column holding the 1st names its own month', () => {
    // Thu 1 Oct … 10 Nov.
    const g = heatGrid(
      daysFrom(
        2026,
        10,
        1,
        Array.from({ length: 41 }, () => 1),
      ),
    );
    expect(g.months[0]).toEqual({ week: 0, label: 'Oct' });
    expect(g.months.map((m) => m.label)).toEqual(['Oct', 'Nov']);
  });

  it('a full year fits 53 or 54 columns that fit the column width', () => {
    const days = daysFrom(
      2025,
      11,
      5,
      Array.from({ length: 371 }, (_, i) => i % 5),
    );
    const g = heatGrid(days);
    expect(g.weeks).toBeGreaterThanOrEqual(53);
    expect(g.weeks).toBeLessThanOrEqual(54);
    expect(g.months.length).toBeGreaterThanOrEqual(12);
    const { cell, gap } = heatCellPx(g.weeks);
    expect(g.weeks * (cell + gap)).toBeLessThanOrEqual(HEAT_WIDTH_PX + gap);
  });

  it('a gap in the input leaves a hole instead of shifting days', () => {
    const days = daysFrom(2026, 11, 2, [1, 2, 3]);
    const g = heatGrid([days[0]!, days[2]!]);
    expect(g.rows[0]![0]!.day.day).toBe('2026-11-02');
    expect(g.rows[1]![0]).toBeNull();
    expect(g.rows[2]![0]!.day.day).toBe('2026-11-04');
  });

  it('no days: an empty grid', () => {
    const g = heatGrid([]);
    expect(g.weeks).toBe(0);
    expect(g.rows).toEqual([]);
    expect(g.months).toEqual([]);
  });
});

describe('heatCellPx', () => {
  it('whole pixels within bounds, and the grid fits', () => {
    for (const weeks of [1, 2, 5, 6, 10, 20, 21, 30, 53, 54]) {
      const { cell, gap } = heatCellPx(weeks);
      expect(Number.isInteger(cell)).toBe(true);
      expect(cell).toBeGreaterThanOrEqual(HEAT_CELL_MIN);
      expect(cell).toBeLessThanOrEqual(HEAT_CELL_MAX);
      expect(weeks * (cell + gap) - gap).toBeLessThanOrEqual(HEAT_WIDTH_PX);
    }
    expect(heatCellPx(5)).toEqual({ cell: HEAT_CELL_MAX, gap: 2 });
    expect(heatCellPx(53)).toEqual({ cell: 4, gap: 1 });
  });
});

describe('statsTiles', () => {
  const byKey = (s: StatsSnapshot) => Object.fromEntries(statsTiles(s).map((t) => [t.key, t]));

  it('full snapshot', () => {
    const t = byKey(FULL);
    expect(t.total!.value).toBe('1.2M');
    expect(t.total!.wide).toBe(true);
    expect(t.total!.sub).toBe('321 responses · cache reads not counted');
    expect(t.sessions!.value).toBe('14');
    expect(t.active!.value).toBe('12 / 30');
    expect(t.streak!.value).toBe('3 days');
    expect(t.longestStreak!.value).toBe('1 day');
    expect(t.longestSession!.value).toBe('2h 05m');
    expect(t.longestSession!.sub).toBe('demo-project');
    expect(t.busiest!.value).toBe('Tue 3 Nov');
    expect(t.busiest!.sub).toBe('1.2M tokens');
    expect(t.peak!.value).toBe('14:00–15:00');
    expect(t.peak!.sub).toBe('900k tokens');
    expect(t.model!.value).toBe('opus-4-5');
    expect(t.model!.sub).toBe('79% of tokens');
    expect(t.cost).toBeUndefined();
  });

  it('streaks say they cover the whole history, except under All', () => {
    for (const range of ['7d', '30d'] as const) {
      const t = byKey({ ...FULL, range });
      expect(t.streak!.sub).toBe('all history');
      expect(t.longestStreak!.sub).toBe('all history');
    }
    const all = byKey({ ...FULL, range: 'all' });
    expect(all.streak!.sub).toBeUndefined();
    expect(all.longestStreak!.sub).toBeUndefined();
  });

  it('cost only when present', () => {
    const t = byKey({ ...FULL, costUsd: 12.5 });
    expect(t.cost!.value).toBe('$12.50');
  });

  it('empty range wording', () => {
    const t = byKey(snap());
    expect(t.total!.value).toBe('0');
    expect(t.sessions!.value).toBe('0');
    expect(t.active!.value).toBe('0 / 30');
    expect(t.streak!.value).toBe('0 days');
    for (const k of ['longestSession', 'busiest', 'peak', 'model']) {
      expect(t[k]!.value).toBe('–');
      expect(t[k]!.sub).toBe('none yet');
    }
  });

  it('scanning wording for values not found yet', () => {
    const t = byKey(snap({ scanning: true, total: 10, messages: 1, sessions: 1 }));
    expect(t.total!.value).toBe('10');
    for (const k of ['longestSession', 'busiest', 'peak', 'model']) {
      expect(t[k]!.value).toBe('…');
      expect(t[k]!.sub).toBe('still reading…');
    }
  });
});

describe('model and project rows', () => {
  it('model rows: short name, share, in / out / cache write', () => {
    const rows = statsModelRows(FULL.models);
    expect(rows[0]).toMatchObject({
      name: 'opus-4-5',
      pct: '79%',
      cells: 16,
      input: '900',
      output: '150k',
      cacheWrite: '800k',
      total: '951k',
    });
    expect(rows[1]).toMatchObject({ name: 'haiku-4-5', pct: '<1%', cells: 1 });
  });

  it('project rows relative to the top project', () => {
    const rows = statsProjectRows(FULL.projects);
    expect(rows.map((r) => r.cells)).toEqual([20, 4]);
    expect(rows[0]).toMatchObject({ name: 'proj-a', total: '1M', sessions: '10 sessions' });
    expect(rows[1]!.sessions).toBe('1 session');
    expect(statsProjectRows([])).toEqual([]);
  });
});

describe('statsFootnote', () => {
  it('names the oldest transcript and the conventions', () => {
    const text = statsFootnote(FULL);
    expect(text).toContain('since 3 Sep 2026');
    expect(text).toContain('Claude Code deletes old transcripts');
    expect(text).toContain('Cache reads are not counted');
  });

  it('without history', () => {
    expect(statsFootnote(snap())).not.toContain('since');
  });
});
