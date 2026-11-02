// Dashboard contract: token usage, usage windows and per-session summaries. Pure types.
// Producers: normalizer/transcript.ts (UsageRecord, TranscriptExtras), usage.ts (window maths),
// dashboard.ts (SessionLedger → DashboardSnapshot). Consumer: the renderer dashboard panel.
// Privacy: nothing here carries prompt text, tool input or output, except `promptPreview`,
// which is redacted, truncated, opt-in (settings.showPromptPreview) and never written to disk.
import type { AgentStatus } from './types';

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

/**
 * Tokens shown as "used" and compared against the user-set limits: input + output + cache
 * write. Cache reads are left out — every API call re-reads the whole cached context, so they
 * repeat tokens already counted and would dwarf real usage (~98% of a typical week).
 */
export const tokenTotal = (u: TokenUsage): number => u.input + u.output + u.cacheCreation;

/** All four token kinds, cache reads included. For "has any usage" checks, not for display. */
export const rawTokenTotal = (u: TokenUsage): number => tokenTotal(u) + u.cacheRead;

/** One API response's usage, counted once (a message is repeated once per content block). */
export interface UsageRecord {
  /** Dedupe key: `${message.id}:${requestId}`. */
  key: string;
  ts: number;
  sessionId: string;
  /** ORCHESTRATOR_ID or the subagent id; subagent usage still belongs to its parent session. */
  agentId: string;
  projectId: string;
  projectName: string;
  model: string;
  usage: TokenUsage;
  /**
   * Who keeps the credit when one response appears in several sessions' transcripts (a resumed
   * or forked session repeats the history): the lowest rank wins, whatever the read order.
   * The transcript file's creation time. Absent ranks lose to present ones.
   */
  rank?: number;
}

/** Non-event facts from one transcript line. Never carries message text. */
export interface TranscriptExtras {
  sessionId: string;
  agentId: string;
  ts: number;
  projectId?: string;
  projectName?: string;
  gitBranch?: string;
  model?: string;
  usage?: UsageRecord;
  /** Redacted + truncated typed prompt. Only when the caller opts in. */
  promptPreview?: string;
}

/** USD per million tokens, per model-id substring. Never hard-coded: user config only. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export type DashStatus = 'working' | 'waiting' | 'idle' | 'ended';

export type TimelineKind =
  | 'start'
  | 'prompt'
  | 'tool'
  | 'subagent'
  | 'subagent_done'
  | 'wait'
  | 'error'
  | 'compact'
  | 'turn_end'
  | 'end';

export interface TimelineStep {
  /** The StationEvent id it came from (dedupe). */
  id: string;
  ts: number;
  kind: TimelineKind;
  agentId: string;
  /** Subagent label, absent for the orchestrator. */
  agentLabel?: string;
  /** Sanitized text built from logText()/redacted tool summaries only. */
  text: string;
  ok?: boolean;
}

export interface SubagentSummary {
  id: string;
  label: string;
  status: AgentStatus;
  toolCalls: number;
}

export interface SessionSummary {
  id: string;
  shortId: string;
  projectId: string;
  projectName: string;
  gitBranch?: string;
  /** Models seen, most used first. */
  models: string[];
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  status: DashStatus;
  /** e.g. "Editing app.ts", "Running npm test", "Reading 3 files", "Spawned Explore". */
  currentStep: string;
  promptPreview?: string;
  subagents: SubagentSummary[];
  toolCalls: number;
  usage: TokenUsage;
  /** Only filled when more than one model was used. */
  usageByModel?: Record<string, TokenUsage>;
  /** Only when prices are configured for every model used. */
  costUsd?: number;
}

export interface HourBucket {
  /** Epoch ms, start of the hour. */
  start: number;
  total: number;
  byProject: Record<string, number>;
}

export interface UsageStats {
  windowHours: number;
  /** Absent when no window is active (no activity in the last `windowHours`). */
  windowStart?: number;
  /** = reset time. */
  windowEnd?: number;
  windowUsage: TokenUsage;
  windowTotal: number;
  /** Tokens per minute over the last 10 minutes. */
  burnPerMin: number;
  /** windowTotal + burnPerMin × minutes until reset. */
  projectedTotal: number;
  windowLimit?: number;
  weeklyUsage: TokenUsage;
  weeklyTotal: number;
  weeklyLimit?: number;
  /** 24 buckets, oldest first, ending with the current hour. */
  hourly: HourBucket[];
  /** projectId → display name for the chart legend. */
  projectNames: Record<string, string>;
  windowCostUsd?: number;
  weeklyCostUsd?: number;
}

/** One plan usage window as Claude Code reports it (status line `rate_limits`). */
export interface PlanWindow {
  /** Percent of the window used, 0–100, exactly as Claude Code reports it. */
  usedPct: number;
  /** Epoch ms when the window resets. */
  resetsAt: number;
}

/**
 * The real plan usage (what the Claude app and /usage show), forwarded by WSC's status line
 * bridge. Only percentages and reset times — never anything else from the status line input.
 */
export interface PlanLimits {
  /** The rolling 5-hour "current session" window. */
  fiveHour?: PlanWindow;
  /** The 7-day window across all models. */
  sevenDay?: PlanWindow;
  /** Epoch ms of the newest update. */
  updatedAt: number;
}

export interface DashboardSnapshot {
  generatedAt: number;
  /** Real plan usage from Claude Code's status line; absent until the first update arrives. */
  planLimits?: PlanLimits;
  /** True while the startup scan of older transcripts is still running. */
  scanning: boolean;
  usage: UsageStats;
  /** Active first (working, waiting), then idle and ended by last activity. */
  sessions: SessionSummary[];
}

export interface DashboardOptions {
  now: number;
  idleMs: number;
  windowMs: number;
  windowLimit?: number;
  weeklyLimit?: number;
  prices?: Record<string, ModelPrice>;
  /** Sessions shown as cards: active ones plus those with activity within this horizon. */
  sessionHorizonMs?: number;
  maxSessions?: number;
  /** false hides any prompt previews already collected (setting turned off at runtime). */
  showPromptPreview?: boolean;
}
