// Pure view-model helpers for the Stats view of the dashboard column (no DOM, no Preact).
// Tested under node. Reads only StatsSnapshot fields (numbers, model ids, project names).
import type {
  StatsDay,
  StatsModel,
  StatsProject,
  StatsRange,
  StatsSnapshot,
} from '@shared/statsTypes';
import {
  filledCells,
  formatDuration,
  formatTokens,
  formatUsd,
  segmentHeights,
  shortModel,
} from './dashboardModel';

// ── polling ──────────────────────────────────────────────────────────────────

/** Ask again this soon while main is still reading the history. */
export const STATS_POLL_SCANNING_MS = 1500;
/** Otherwise refresh about once a minute (new activity, a new day). */
export const STATS_POLL_IDLE_MS = 60_000;

/** Delay before the next `getStats` call, given the last answer (null: failed or unavailable). */
export function statsPollDelay(snap: StatsSnapshot | null | undefined): number {
  return snap?.scanning ? STATS_POLL_SCANNING_MS : STATS_POLL_IDLE_MS;
}

/** The last snapshot kept across tab switches, and the station mode it came from. */
export interface StatsMemory {
  snap: StatsSnapshot | null;
  /** True: demo stats; false: real history; undefined: not known yet. */
  demo?: boolean | undefined;
}

/**
 * The kept snapshot, unless it came from the other station mode: the demo's made-up history
 * must never pass for the user's own, nor the user's real projects show up during a demo.
 */
export function keptStats(memory: StatsMemory, demo: boolean | undefined): StatsSnapshot | null {
  return memory.demo === demo ? memory.snap : null;
}

export type StatsPhase = 'unavailable' | 'loading' | 'empty' | 'scanning' | 'full';

/**
 * What the view shows. `failed`: the last call returned null or was rejected (or the API has
 * no getStats). A scan that has found nothing yet is still "loading", not "empty".
 */
export function statsPhase(snap: StatsSnapshot | null | undefined, failed: boolean): StatsPhase {
  if (failed) return 'unavailable';
  if (!snap) return 'loading';
  const empty = snap.total <= 0 && snap.messages <= 0 && snap.sessions <= 0;
  if (empty) return snap.scanning ? 'loading' : 'empty';
  return snap.scanning ? 'scanning' : 'full';
}

// ── words and dates ──────────────────────────────────────────────────────────

export const STATS_RANGE_LABEL: Record<StatsRange, string> = {
  '7d': '7d',
  '30d': '30d',
  all: 'All',
};
const RANGE_TITLE: Record<StatsRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All history',
};

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "1 session" · "4 sessions". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** `YYYY-MM-DD` → year, month (1–12), day. Undefined for anything else. */
export function parseDay(day: string): Ymd | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Whole days since 1970-01-01 for a calendar date (no time zone or DST involved). */
function dayNumber(p: Ymd): number {
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday, from the calendar date alone. */
export function weekdayOf(p: Ymd): number {
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

/** "2026-11-03" → "Tue 3 Nov". */
export function formatDay(day: string): string {
  const p = parseDay(day);
  if (!p) return day;
  return `${WEEKDAY_SHORT[weekdayOf(p)]} ${p.d} ${MONTH_SHORT[p.m - 1]}`;
}

/** Local "3 Oct 2026". */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/** Heading for the range: "Last 30 days" · "Since 3 Oct 2026" (all history). */
export function rangeTitle(range: StatsRange, snap?: StatsSnapshot | null): string {
  if (range === 'all' && snap?.range === 'all' && snap.rangeStart !== undefined) {
    return `Since ${formatDate(snap.rangeStart)}`;
  }
  return RANGE_TITLE[range];
}

/** "Tue 3 Nov · 1.2M tokens · 4 sessions" · "Wed 4 Nov · no activity". */
export function dayReading(d: Pick<StatsDay, 'day' | 'tokens' | 'sessions'>): string {
  const head = formatDay(d.day);
  if (d.tokens <= 0 && d.sessions <= 0) return `${head} · no activity`;
  return `${head} · ${formatTokens(d.tokens)} tokens · ${plural(d.sessions, 'session')}`;
}

// ── hours ────────────────────────────────────────────────────────────────────

/** Axis label for an hour of day: 0 → "00h", 14 → "14h". */
export function hourOfDayLabel(h: number): string {
  return `${String(h).padStart(2, '0')}h`;
}

/** 14 → "14:00–15:00"; 23 → "23:00–24:00". */
export function hourSpan(h: number): string {
  const a = String(h).padStart(2, '0');
  const b = String(h + 1).padStart(2, '0');
  return `${a}:00–${b}:00`;
}

/** Hours labelled under the 24-bar chart. */
export const HOUR_AXIS = [0, 6, 12, 18];

export interface Bar {
  key: string;
  /** Bar height in whole pixels. */
  px: number;
  value: number;
  /** Short axis text under the bar ('' for none). */
  label: string;
  /** Full text for hover, focus and screen readers. */
  reading: string;
  /** Highlighted bar (the peak hour, today). */
  mark: boolean;
}

/** One whole-pixel bar height, any non-zero value at least 1 px. */
export function barPx(value: number, max: number, height: number): number {
  return segmentHeights([value], max, height)[0] ?? 0;
}

/** 24 bars for tokens per hour of day; the peak hour is marked. */
export function hourBars(
  byHour: readonly number[],
  peakHour: number | undefined,
  height: number,
): Bar[] {
  const values = Array.from({ length: 24 }, (_, h) => Math.max(0, byHour[h] ?? 0));
  const max = Math.max(0, ...values);
  return values.map((v, h) => ({
    key: `h${h}`,
    px: barPx(v, max, height),
    value: v,
    label: HOUR_AXIS.includes(h) ? hourOfDayLabel(h) : '',
    reading: `${hourSpan(h)} · ${v > 0 ? `${formatTokens(v)} tokens` : 'no tokens'}${
      h === peakHour ? ' · peak' : ''
    }`,
    mark: h === peakHour && v > 0,
  }));
}

/** One bar per day (the 7-day range reads better as bars than as a two-column heatmap). */
export function dayBars(days: readonly StatsDay[], height: number): Bar[] {
  const max = Math.max(0, ...days.map((d) => d.tokens));
  const last = days.length - 1;
  return days.map((d, i) => {
    const p = parseDay(d.day);
    return {
      key: d.day,
      px: barPx(d.tokens, max, height),
      value: d.tokens,
      label: p ? WEEKDAY_SHORT[weekdayOf(p)]! : d.day,
      reading: dayReading(d),
      mark: i === last,
    };
  });
}

// ── heatmap ──────────────────────────────────────────────────────────────────

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Smallest value of levels 1–4 (ascending; empty when every day is zero). Levels are the
 * quartiles of the range's distinct non-zero values, so one outlier does not flatten the rest
 * and days with equal values always share a level (all equal → all level 4).
 */
export function heatThresholds(values: readonly number[]): number[] {
  const distinct = [...new Set(values.filter((v) => Number.isFinite(v) && v > 0))].sort(
    (a, b) => a - b,
  );
  const k = distinct.length;
  if (k === 0) return [];
  const out: number[] = [];
  for (let level = 1; level <= 4; level++) {
    // First distinct value (rank r, 1-based) whose quartile ceil(4r / k) reaches this level.
    const r = Math.floor(((level - 1) * k) / 4) + 1;
    out.push(distinct[Math.min(k, r) - 1]!);
  }
  return out;
}

export function heatLevel(value: number, thresholds: readonly number[]): HeatLevel {
  if (!(value > 0) || thresholds.length === 0) return 0;
  let level = 1;
  for (let i = 1; i < thresholds.length; i++) if (value >= thresholds[i]!) level = i + 1;
  return level as HeatLevel;
}

export interface HeatCell {
  /** Index into the snapshot's `days`. */
  index: number;
  day: StatsDay;
  level: HeatLevel;
  reading: string;
}

export interface HeatGrid {
  /** Number of week columns. */
  weeks: number;
  /** 7 weekday rows (starting on `weekStart`) × `weeks` columns; null outside the range. */
  rows: (HeatCell | null)[][];
  /** Weekday names for the row heads; '' for unlabelled rows. */
  rowLabels: string[];
  /** Month names placed over the first week column that holds the 1st of that month. */
  months: { week: number; label: string }[];
  thresholds: number[];
  /** Position of each day: `cells[i]` is days[i]'s row and week. */
  cells: { row: number; week: number }[];
}

/** Weeks start on Monday. */
export const HEAT_WEEK_START = 1;

/**
 * Lay the range's days out as a calendar heatmap: weeks are columns, weekdays rows. The first
 * and last weeks may be partial (cells outside the range are null). Days are placed by their
 * date, so a gap in the input leaves a hole rather than shifting later days. Month labels are
 * placed for the cell size heatCellPx gives at `widthPx`, so they never overlap.
 */
export function heatGrid(
  days: readonly StatsDay[],
  weekStart = HEAT_WEEK_START,
  widthPx = HEAT_WIDTH_PX,
): HeatGrid {
  const thresholds = heatThresholds(days.map((d) => d.tokens));
  const rowLabels = Array.from({ length: 7 }, (_, r) =>
    r % 2 === 0 && r < 6 ? WEEKDAY_SHORT[(weekStart + r) % 7]! : '',
  );
  const parsed = days.map((d) => parseDay(d.day));
  const first = parsed.find((p) => p !== undefined);
  if (!first) return { weeks: 0, rows: [], rowLabels, months: [], thresholds, cells: [] };
  const dn0 = dayNumber(first);
  const offset = (weekdayOf(first) - weekStart + 7) % 7;

  const cells: { row: number; week: number }[] = [];
  let lastPos = 0;
  for (const p of parsed) {
    const pos = p ? offset + dayNumber(p) - dn0 : -1;
    cells.push(pos >= 0 ? { row: pos % 7, week: Math.floor(pos / 7) } : { row: -1, week: -1 });
    if (pos > lastPos) lastPos = pos;
  }
  const weeks = Math.floor(lastPos / 7) + 1;
  const rows: (HeatCell | null)[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: weeks }, () => null),
  );
  // Month of the first in-range day per column, and whether that column holds a 1st.
  const firstOfMonth: (number | undefined)[] = Array.from({ length: weeks }, () => undefined);
  const colMonth: (number | undefined)[] = Array.from({ length: weeks }, () => undefined);
  const colTopRow: number[] = Array.from({ length: weeks }, () => 7);
  days.forEach((day, index) => {
    const at = cells[index]!;
    const p = parsed[index];
    if (!p || at.row < 0) return;
    rows[at.row]![at.week] = {
      index,
      day,
      level: heatLevel(day.tokens, thresholds),
      reading: dayReading(day),
    };
    if (p.d === 1) firstOfMonth[at.week] = p.m;
    if (at.row < colTopRow[at.week]!) {
      colTopRow[at.week] = at.row;
      colMonth[at.week] = p.m;
    }
  });

  const { cell, gap } = heatCellPx(weeks, widthPx);
  const pitch = cell + gap;
  const labelled: { week: number; label: string }[] = [];
  // Name the first column's month too, when its label fits before the next one.
  const c0 = colMonth[0];
  if (firstOfMonth[0] === undefined && c0 !== undefined) {
    labelled.push({ week: 0, label: MONTH_SHORT[c0 - 1]! });
  }
  for (let w = 0; w < weeks; w++) {
    const m = firstOfMonth[w];
    if (m !== undefined) labelled.push({ week: w, label: MONTH_SHORT[m - 1]! });
  }
  // Labels sit at week * pitch px: leave out any that would touch the one before it. Only the
  // added first-column label can (a month spans at least four columns of 5 px or more).
  const months: { week: number; label: string }[] = [];
  for (let i = 0; i < labelled.length; i++) {
    const next = labelled[i + 1];
    const cur = labelled[i]!;
    if (i === 0 && next && (next.week - cur.week) * pitch < MONTH_LABEL_PX) continue;
    const prev = months[months.length - 1];
    if (prev && (cur.week - prev.week) * pitch < MONTH_LABEL_PX) continue;
    months.push(cur);
  }
  return { weeks, rows, rowLabels, months, thresholds, cells };
}

/** Room a month label needs: three letters of the 10 px font, plus a little space. */
export const MONTH_LABEL_PX = 20;

/** Room for the week columns inside the column (after the weekday heads, any scrollbar). */
export const HEAT_WIDTH_PX = 272;
export const HEAT_CELL_MIN = 4;
export const HEAT_CELL_MAX = 16;

/** Whole-pixel cell size and gap so `weeks` columns fit `widthPx`. */
export function heatCellPx(weeks: number, widthPx = HEAT_WIDTH_PX): { cell: number; gap: number } {
  const gap = weeks > 20 ? 1 : 2;
  if (weeks <= 0) return { cell: HEAT_CELL_MAX, gap };
  const cell = Math.floor((widthPx + gap) / weeks) - gap;
  return { cell: Math.max(HEAT_CELL_MIN, Math.min(HEAT_CELL_MAX, cell)), gap };
}

// ── tiles ────────────────────────────────────────────────────────────────────

export interface StatsTile {
  key: string;
  label: string;
  value: string;
  sub?: string;
  /** Full-width hero tile. */
  wide?: boolean;
}

/** "62%" · "<1%" · "0%". */
export function sharePct(share: number): string {
  if (!(share > 0)) return '0%';
  if (share < 0.01) return '<1%';
  return `${Math.round(share * 100)}%`;
}

/**
 * Headline tiles. Missing values read "–" once the scan is done, "…" while it runs; counts
 * found so far are real but may still grow (the view shows a "still reading" marker).
 */
export function statsTiles(snap: StatsSnapshot): StatsTile[] {
  const none = snap.scanning ? '…' : '–';
  const pending = snap.scanning ? 'still reading…' : 'none yet';
  const streakSub = snap.range === 'all' ? undefined : 'all history';
  const tiles: StatsTile[] = [
    {
      key: 'total',
      label: 'Total tokens',
      value: formatTokens(snap.total),
      sub: `${plural(snap.messages, 'response')} · cache reads not counted`,
      wide: true,
    },
    { key: 'sessions', label: 'Sessions', value: String(snap.sessions) },
    {
      key: 'active',
      label: 'Active days',
      value: `${snap.activeDays} / ${snap.totalDays}`,
    },
    // Streaks count the whole history, so a 7-day range can show a 10-day streak: say so.
    {
      key: 'streak',
      label: 'Current streak',
      value: plural(snap.currentStreak, 'day'),
      ...(streakSub ? { sub: streakSub } : {}),
    },
    {
      key: 'longestStreak',
      label: 'Longest streak',
      value: plural(snap.longestStreak, 'day'),
      ...(streakSub ? { sub: streakSub } : {}),
    },
    snap.longestSession
      ? {
          key: 'longestSession',
          label: 'Longest session',
          value: formatDuration(snap.longestSession.durationMs),
          sub: snap.longestSession.projectName,
        }
      : { key: 'longestSession', label: 'Longest session', value: none, sub: pending },
    snap.mostActiveDay
      ? {
          key: 'busiest',
          label: 'Busiest day',
          value: formatDay(snap.mostActiveDay.day),
          sub: `${formatTokens(snap.mostActiveDay.tokens)} tokens`,
        }
      : { key: 'busiest', label: 'Busiest day', value: none, sub: pending },
    snap.peakHour !== undefined
      ? {
          key: 'peak',
          label: 'Peak hour',
          value: hourSpan(snap.peakHour),
          sub: `${formatTokens(snap.byHour[snap.peakHour] ?? 0)} tokens`,
        }
      : { key: 'peak', label: 'Peak hour', value: none, sub: pending },
    snap.favoriteModel
      ? {
          key: 'model',
          label: 'Favourite model',
          value: shortModel(snap.favoriteModel),
          sub: `${sharePct(snap.models[0]?.share ?? 0)} of tokens`,
        }
      : { key: 'model', label: 'Favourite model', value: none, sub: pending },
  ];
  if (snap.costUsd !== undefined) {
    tiles.push({
      key: 'cost',
      label: 'Est. cost',
      value: formatUsd(snap.costUsd),
      sub: 'configured prices',
    });
  }
  return tiles;
}

// ── models and projects ──────────────────────────────────────────────────────

/** Cells in the share bars. */
export const SHARE_CELLS = 20;

export interface StatsModelRow {
  model: string;
  name: string;
  pct: string;
  cells: number;
  input: string;
  output: string;
  cacheWrite: string;
  total: string;
}

export function statsModelRows(models: readonly StatsModel[]): StatsModelRow[] {
  return models.map((m) => ({
    model: m.model,
    name: shortModel(m.model),
    pct: sharePct(m.share),
    cells: filledCells(m.share * 100, SHARE_CELLS),
    input: formatTokens(m.usage.input),
    output: formatTokens(m.usage.output),
    cacheWrite: formatTokens(m.usage.cacheCreation),
    total: formatTokens(m.total),
  }));
}

export interface StatsProjectRow {
  id: string;
  name: string;
  total: string;
  sessions: string;
  /** Bar cells relative to the top project. */
  cells: number;
}

export function statsProjectRows(projects: readonly StatsProject[]): StatsProjectRow[] {
  const max = Math.max(0, ...projects.map((p) => p.total));
  return projects.map((p) => ({
    id: p.projectId,
    name: p.projectName,
    total: formatTokens(p.total),
    sessions: plural(p.sessions, 'session'),
    cells: max > 0 ? filledCells((p.total / max) * 100, SHARE_CELLS) : 0,
  }));
}

// ── small print ──────────────────────────────────────────────────────────────

export function statsFootnote(snap: Pick<StatsSnapshot, 'firstActivityAt'>): string {
  const since =
    snap.firstActivityAt !== undefined ? ` (since ${formatDate(snap.firstActivityAt)})` : '';
  return (
    `Counted from the transcripts still on this machine${since}. Claude Code deletes old ` +
    `transcripts, so “All” only reaches back that far. Cache reads are not counted.`
  );
}
