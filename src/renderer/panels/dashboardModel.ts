// Pure view-model helpers for the dashboard column (no DOM, no Preact). Tested under node.
import {
  tokenTotal,
  type DashStatus,
  type HourBucket,
  type SessionSummary,
  type TimelineKind,
  type TokenUsage,
  type UsageStats,
} from '@shared/dashboardTypes';
import type { AgentStatus } from '@shared/types';

/** Below this window width the dashboard auto-collapses to its rail (stage keeps room). */
export const DASHBOARD_AUTO_COLLAPSE_PX = 1000;
/** Chart: projects with their own colour; the rest fold into "other". */
export const CHART_TOP_N = 5;
export const OTHER_ID = '__other__';

// ── numbers ──────────────────────────────────────────────────────────────────

function trim1(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** 845 · 12.3k · 845k · 1.2M · 12.5M · 2.1B. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (let i = 0; i < units.length; i++) {
    const [div, suffix] = units[i]!;
    if (n < div) continue;
    const v = n / div;
    const rounded = v < 100 ? Math.round(v * 10) / 10 : Math.round(v);
    // 999,960 would read "1000k": promote to the next unit.
    if (rounded >= 1000 && i > 0) {
      const [up, upSuffix] = units[i - 1]!;
      return `${trim1(Math.round((n / up) * 10) / 10)}${upSuffix}`;
    }
    return `${trim1(rounded)}${suffix}`;
  }
  return String(Math.round(n));
}

/** "12.3k tok/min" · "0 tok/min". */
export function formatRate(perMin: number): string {
  return `${formatTokens(perMin)} tok/min`;
}

/** "$1.23" · "$0.004" → "<$0.01". */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** Countdown to a reset: "2h 14m", "14m 05s", "45s", "0s". */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/**
 * How long a session has run. Transcripts never record an end, so an idle session without
 * a SessionEnd stops counting at its last activity instead of growing forever.
 */
export function sessionDurationMs(
  s: Pick<SessionSummary, 'status' | 'startedAt' | 'lastActivityAt' | 'endedAt'>,
  now: number,
): number {
  const end = s.endedAt ?? (s.status === 'idle' ? s.lastActivityAt : now);
  return Math.max(0, end - s.startedAt);
}

/** Elapsed span: "40s", "12m", "1h 05m", "2d 3h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "just now", "45s ago", "3m ago", "2h ago", "3d ago". Future timestamps read as "just now". */
export function relativeTime(ts: number, now: number): string {
  const s = Math.floor((now - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Local "HH:MM". */
export function clockHM(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── limits ───────────────────────────────────────────────────────────────────

export type UsageLevel = 'ok' | 'warn' | 'danger';

/** Whole percent of a limit (may exceed 100), or undefined without a positive limit. */
export function percent(used: number, limit: number | null | undefined): number | undefined {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return undefined;
  return Math.max(0, Math.floor((used / limit) * 100));
}

/** ok below 75 %, warn from 75 %, danger from 90 %. */
export function usageLevel(pct: number | undefined): UsageLevel {
  if (pct === undefined) return 'ok';
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warn';
  return 'ok';
}

/** Filled cells (0…cells) for a pixel progress bar; any usage shows at least one cell. */
export function filledCells(pct: number, cells: number): number {
  if (pct <= 0) return 0;
  return Math.min(cells, Math.max(1, Math.round((pct / 100) * cells)));
}

/** What the collapsed rail shows: window % when a limit is set, else the window token total. */
export function railReading(usage: UsageStats | undefined): { text: string; level: UsageLevel } {
  if (!usage) return { text: '–', level: 'ok' };
  const pct = percent(usage.windowTotal, usage.windowLimit);
  if (pct !== undefined) return { text: `${pct}%`, level: usageLevel(pct) };
  return { text: formatTokens(usage.windowTotal), level: 'ok' };
}

// ── sessions ─────────────────────────────────────────────────────────────────

export const DASH_STATUS_LABEL: Record<DashStatus, string> = {
  working: 'working',
  waiting: 'waiting for you',
  idle: 'idle',
  ended: 'ended',
};

export function statusLabel(s: DashStatus): string {
  return DASH_STATUS_LABEL[s] ?? s;
}

/** Theme colour token (CSS var suffix) for a session status. */
export function statusTone(s: DashStatus): 'working' | 'waiting' | 'done' | 'stale' {
  switch (s) {
    case 'working':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'idle':
      return 'done';
    default:
      return 'stale';
  }
}

/** True when any listed session waits for the user. */
export function needsYou(sessions: readonly SessionSummary[] | undefined): boolean {
  return !!sessions?.some((s) => s.status === 'waiting');
}

/** `${sessionId}:${agentId}` → sessionId. Agent ids never contain ':'; session ids may. */
export function sessionIdFromAgentKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const i = key.lastIndexOf(':');
  return i > 0 ? key.slice(0, i) : undefined;
}

/** "claude-opus-4-5-20251101" → "opus-4-5". Unknown shapes pass through. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export const SUBAGENT_STATUS_TONE: Record<AgentStatus, string> = {
  idle: 'stale',
  thinking: 'working',
  working: 'working',
  waiting: 'waiting',
  done: 'done',
  error: 'error',
  stale: 'stale',
};

export interface UsageRow {
  label: string;
  value: number;
}

export function usageRows(u: TokenUsage): UsageRow[] {
  return [
    { label: 'input', value: u.input },
    { label: 'output', value: u.output },
    { label: 'cache write', value: u.cacheCreation },
  ];
}

/** Per-model rows, biggest first. */
export function modelRows(
  byModel: Record<string, TokenUsage> | undefined,
): { model: string; usage: TokenUsage; total: number }[] {
  if (!byModel) return [];
  return Object.entries(byModel)
    .map(([model, usage]) => ({
      model,
      usage,
      total: tokenTotal(usage),
    }))
    .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}

// ── timeline ─────────────────────────────────────────────────────────────────

export const TIMELINE_ICON: Record<TimelineKind, string> = {
  start: '◆',
  prompt: '»',
  tool: '▸',
  subagent: '+',
  subagent_done: '✓',
  wait: '⚑',
  error: '✕',
  compact: '≡',
  turn_end: '■',
  end: '◼',
};

export function timelineIcon(kind: TimelineKind, ok?: boolean): string {
  if (kind === 'tool' && ok === false) return '✕';
  return TIMELINE_ICON[kind] ?? '·';
}

// ── hourly chart ─────────────────────────────────────────────────────────────

export interface ChartSeries {
  id: string;
  name: string;
  /** Colour slot 0…topN-1; "other" uses -1. */
  slot: number;
  total: number;
}

export interface ChartBar {
  start: number;
  total: number;
  /** Values in series order (same length as `series`). */
  values: number[];
}

export interface StackedChart {
  series: ChartSeries[];
  bars: ChartBar[];
  max: number;
}

/**
 * Keep colour slots stable across updates: surviving ids keep their slot, new ids take the
 * lowest free one. Colour follows the project, never its rank.
 */
export function assignSlots(
  prev: Readonly<Record<string, number>>,
  ids: readonly string[],
  slots: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const id of ids) {
    const s = prev[id];
    if (s !== undefined && s < slots && !used.has(s)) {
      out[id] = s;
      used.add(s);
    }
  }
  for (const id of ids) {
    if (out[id] !== undefined) continue;
    let s = 0;
    while (used.has(s)) s++;
    out[id] = s;
    used.add(s);
  }
  return out;
}

/**
 * Stack hourly buckets by project: the top-N projects by 24 h total get their own series
 * (ordered by colour slot), everything else is summed into "other" (last).
 */
export function stackHourly(
  hourly: readonly HourBucket[],
  projectNames: Readonly<Record<string, string>>,
  topN = CHART_TOP_N,
  prevSlots: Readonly<Record<string, number>> = {},
): StackedChart & { slots: Record<string, number> } {
  const totals = new Map<string, number>();
  for (const b of hourly) {
    for (const [id, v] of Object.entries(b.byProject)) {
      if (v > 0) totals.set(id, (totals.get(id) ?? 0) + v);
    }
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, topN).map(([id]) => id);
  const slots = assignSlots(prevSlots, top, topN);
  const ordered = [...top].sort((a, b) => slots[a]! - slots[b]!);
  const series: ChartSeries[] = ordered.map((id) => ({
    id,
    name: projectNames[id] ?? id,
    slot: slots[id]!,
    total: totals.get(id) ?? 0,
  }));
  const topSet = new Set(top);
  const otherTotal = ranked.slice(topN).reduce((s, [, v]) => s + v, 0);
  // Tokens not attributed to any project still show up as "other".
  const unattributed = hourly.reduce(
    (s, b) => s + Math.max(0, b.total - Object.values(b.byProject).reduce((a, v) => a + v, 0)),
    0,
  );
  const hasOther = otherTotal + unattributed > 0;
  if (hasOther)
    series.push({ id: OTHER_ID, name: 'other', slot: -1, total: otherTotal + unattributed });

  let max = 0;
  const bars: ChartBar[] = hourly.map((b) => {
    const values = ordered.map((id) => b.byProject[id] ?? 0);
    if (hasOther) {
      let rest = 0;
      let attributed = 0;
      for (const [id, v] of Object.entries(b.byProject)) {
        attributed += v;
        if (!topSet.has(id)) rest += v;
      }
      values.push(rest + Math.max(0, b.total - attributed));
    }
    const total = Math.max(
      b.total,
      values.reduce((s, v) => s + v, 0),
    );
    if (total > max) max = total;
    return { start: b.start, total, values };
  });
  return { series, bars, max, slots };
}

/**
 * Integer pixel heights for one stacked bar: the whole bar is round(total / max × height), and
 * segments split it by largest remainder so they always add up exactly. Non-zero values get at
 * least 1 px when the bar has room.
 */
export function segmentHeights(values: readonly number[], max: number, height: number): number[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (max <= 0 || total <= 0 || height <= 0) return values.map(() => 0);
  const barPx = Math.max(1, Math.min(height, Math.round((total / max) * height)));
  const exact = values.map((v) => (Math.max(0, v) / total) * barPx);
  const out = exact.map((x) => Math.floor(x));
  let left = barPx - out.reduce((s, v) => s + v, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  // Give tiny non-zero segments a visible pixel, taken from the tallest segment.
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== 0 || (values[i] ?? 0) <= 0) continue;
    let tallest = 0;
    for (let j = 1; j < out.length; j++) if (out[j]! > out[tallest]!) tallest = j;
    if (out[tallest]! > 1) {
      out[tallest]!--;
      out[i] = 1;
    }
  }
  return out;
}

/** Hour label for the chart axis: "14h". */
export function hourLabel(ts: number): string {
  return `${String(new Date(ts).getHours()).padStart(2, '0')}h`;
}
