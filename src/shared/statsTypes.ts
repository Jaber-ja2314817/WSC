// Stats contract: usage statistics over a date range, in the spirit of Claude Code's /stats.
// Pure types. Producers: stats.ts (computeStats, pure maths over deduped UsageRecords) and
// main/statsScan.ts (reads every transcript still on disk, usage only). Consumer: the Stats
// view in the dashboard column.
// Privacy: numbers, model ids, project names (the folder's basename) and short session ids
// only. Never prompt text, tool input or output. Nothing here is written to disk.
import type { ModelPrice, TokenUsage } from './dashboardTypes';

/** Last 7 local calendar days (today included), last 30, or everything still on disk. */
export type StatsRange = '7d' | '30d' | 'all';

export const STATS_RANGES: readonly StatsRange[] = ['7d', '30d', 'all'];
export const DEFAULT_STATS_RANGE: StatsRange = '30d';

/** `days` never holds more than this many entries (53 weeks); totals still cover the range. */
export const STATS_MAX_DAYS = 371;
/** A pause longer than this does not count towards a session's active time. */
export const STATS_IDLE_GAP_MS = 30 * 60_000;
export const STATS_TOP_PROJECTS = 5;

export function isStatsRange(v: unknown): v is StatsRange {
  return v === '7d' || v === '30d' || v === 'all';
}

/** One local calendar day. "Tokens" everywhere in this file means tokenTotal(): no cache reads. */
export interface StatsDay {
  /** Local date, `YYYY-MM-DD`. */
  day: string;
  /** Epoch ms of that day's local midnight. */
  start: number;
  tokens: number;
  /** Sessions with at least one response that day. */
  sessions: number;
  /** API responses that day (deduped usage records). */
  messages: number;
  /** Tokens per model id. Only models used that day. */
  byModel: Record<string, number>;
}

export interface StatsModel {
  model: string;
  usage: TokenUsage;
  /** tokenTotal(usage). */
  total: number;
  /** Share of the range's total, 0–1. 0 when the range is empty. */
  share: number;
}

export interface StatsProject {
  projectId: string;
  projectName: string;
  total: number;
  sessions: number;
}

export interface StatsSession {
  /** First 8 characters of the session id. */
  shortId: string;
  projectName: string;
  startedAt: number;
  /**
   * Active time: the sum of gaps between consecutive responses (subagents included), leaving
   * out gaps longer than STATS_IDLE_GAP_MS. Only responses inside the range count.
   */
  durationMs: number;
}

export interface StatsSnapshot {
  range: StatsRange;
  generatedAt: number;
  /** The history scan is still running: every number may still grow. */
  scanning: boolean;
  /**
   * Local midnight of the range's first day. For 'all': the first day with any activity.
   * Absent when 'all' has no data.
   */
  rangeStart?: number;
  /** Oldest response on disk, whatever the range: "history since …". */
  firstActivityAt?: number;
  usage: TokenUsage;
  /** tokenTotal(usage). */
  total: number;
  sessions: number;
  messages: number;
  /** Days in the range with any activity. */
  activeDays: number;
  /** Calendar days in the range, today included (7, 30, or first active day → today). */
  totalDays: number;
  /**
   * Consecutive active days ending today, or ending yesterday when today has no activity yet.
   * Counted over the whole history, not just the range.
   */
  currentStreak: number;
  /** Longest run of consecutive active days in the whole history. */
  longestStreak: number;
  /** The range's busiest day by tokens. Absent when the range is empty. */
  mostActiveDay?: { day: string; tokens: number };
  /** The range's session with the most active time. Absent when the range is empty. */
  longestSession?: StatsSession;
  /** Tokens per local hour of day (index 0–23), summed over the range. Always 24 entries. */
  byHour: number[];
  /** Index of the largest `byHour` entry. Absent when the range is empty. */
  peakHour?: number;
  /** = models[0]?.model. */
  favoriteModel?: string;
  /** Most used first. */
  models: StatsModel[];
  /** Most used first, at most STATS_TOP_PROJECTS. */
  projects: StatsProject[];
  /**
   * One entry per calendar day of the range, oldest first, zero-filled, ending today. Capped
   * at the most recent STATS_MAX_DAYS for 'all'. Empty when 'all' has no data.
   */
  days: StatsDay[];
  /** Only when prices are configured for every model used in the range. */
  costUsd?: number;
}

/**
 * Options of `computeStats(records, opts)` in stats.ts. Days are local calendar days, taken
 * from `new Date(ts)` local getters (so tests build timestamps with `new Date(y, m, d, h)`).
 */
export interface StatsOptions {
  now: number;
  range: StatsRange;
  scanning?: boolean;
  prices?: Record<string, ModelPrice>;
}
