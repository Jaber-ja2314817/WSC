// Token usage maths: dedupe book, usage window estimate, burn rate, weekly, hourly, cost.
// Pure — no Electron, Node or DOM imports. Windows are an estimate (the common community model
// of Claude's rolling usage window), never an official number.
import {
  ZERO_USAGE,
  rawTokenTotal,
  tokenTotal,
  type DashboardOptions,
  type HourBucket,
  type ModelPrice,
  type TokenUsage,
  type UsageRecord,
  type UsageStats,
} from './dashboardTypes';

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
export const WEEK_MS = 7 * 24 * HOUR_MS;
/** Burn rate looks back this far. */
export const BURN_MS = 10 * MINUTE_MS;
export const HOURLY_BUCKETS = 24;

export const floorHour = (ts: number): number => Math.floor(ts / HOUR_MS) * HOUR_MS;

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheCreation: a.cacheCreation + b.cacheCreation,
  cacheRead: a.cacheRead + b.cacheRead,
});

const subUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: Math.max(0, a.input - b.input),
  output: Math.max(0, a.output - b.output),
  cacheCreation: Math.max(0, a.cacheCreation - b.cacheCreation),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
});

export function sumUsage(records: Iterable<UsageRecord>): TokenUsage {
  let u: TokenUsage = { ...ZERO_USAGE };
  for (const r of records) u = addUsage(u, r.usage);
  return u;
}

/** Per-model usage totals. */
export function usageByModel(records: Iterable<UsageRecord>): Record<string, TokenUsage> {
  const out: Record<string, TokenUsage> = {};
  for (const r of records) out[r.model] = addUsage(out[r.model] ?? ZERO_USAGE, r.usage);
  return out;
}

/** Price whose key is the longest (case-insensitive) substring of the model id. */
export function priceFor(
  model: string,
  prices: Record<string, ModelPrice> | undefined,
): ModelPrice | undefined {
  if (!prices) return undefined;
  const m = model.toLowerCase();
  let best: ModelPrice | undefined;
  let bestLen = -1;
  for (const [key, price] of Object.entries(prices)) {
    if (!key || key.length <= bestLen) continue;
    if (m.includes(key.toLowerCase())) {
      best = price;
      bestLen = key.length;
    }
  }
  return best;
}

/** USD for one usage at one price (prices are per million tokens). */
export const costOf = (u: TokenUsage, p: ModelPrice): number =>
  (u.input * p.input +
    u.output * p.output +
    u.cacheCreation * p.cacheWrite +
    u.cacheRead * p.cacheRead) /
  1_000_000;

/**
 * Cost of per-model usage. Undefined when no prices are configured or any model with usage
 * has no price (a partial sum would understate the cost).
 */
export function costFor(
  byModel: Record<string, TokenUsage>,
  prices: Record<string, ModelPrice> | undefined,
): number | undefined {
  if (!prices || Object.keys(prices).length === 0) return undefined;
  let total = 0;
  for (const [model, u] of Object.entries(byModel)) {
    if (rawTokenTotal(u) === 0) continue;
    const p = priceFor(model, prices);
    if (!p) return undefined;
    total += costOf(u, p);
  }
  return total;
}

interface SessionAgg {
  usage: TokenUsage;
  byModel: Map<string, TokenUsage>;
}

/** Usage records deduped by key, kept sorted by ts, with running per-session totals. */
export class UsageBook {
  private readonly byKey = new Map<string, UsageRecord>();
  private list: UsageRecord[] = [];
  private sorted = true;
  private readonly sessions = new Map<string, SessionAgg>();

  /**
   * Adds new records; returns true if anything changed. A repeat (same key) counts once; it
   * only moves the credit to its session when it ranks lower (see UsageRecord.rank).
   */
  add(records: Iterable<UsageRecord>): boolean {
    let added = false;
    for (const input of records) {
      if (!validRecord(input)) continue;
      const known = this.byKey.get(input.key);
      if (known) {
        if (this.recredit(known, input)) added = true;
        continue;
      }
      const r = { ...input };
      this.byKey.set(r.key, r);
      const last = this.list[this.list.length - 1];
      if (last && last.ts > r.ts) this.sorted = false;
      this.list.push(r);
      this.aggregate(r, 1);
      added = true;
    }
    return added;
  }

  /** Move a repeated response's credit to `repeat`'s session if it outranks the holder. */
  private recredit(known: UsageRecord, repeat: UsageRecord): boolean {
    if (repeat.sessionId === known.sessionId) return false;
    const rank = (x: UsageRecord): number =>
      x.rank !== undefined && Number.isFinite(x.rank) ? x.rank : Infinity;
    if (rank(repeat) >= rank(known)) return false;
    this.aggregate(known, -1);
    known.sessionId = repeat.sessionId;
    known.agentId = repeat.agentId;
    known.projectId = repeat.projectId;
    known.projectName = repeat.projectName;
    if (repeat.rank !== undefined) known.rank = repeat.rank;
    this.aggregate(known, 1);
    return true;
  }

  /** Drop records older than `beforeTs`; returns how many were removed. */
  prune(beforeTs: number): number {
    const all = this.records();
    let i = 0;
    while (i < all.length && (all[i]?.ts ?? 0) < beforeTs) i++;
    if (i === 0) return 0;
    for (const r of all.slice(0, i)) {
      this.byKey.delete(r.key);
      this.aggregate(r, -1);
    }
    this.list = all.slice(i);
    return i;
  }

  get size(): number {
    return this.list.length;
  }

  /** All records, ascending by ts. Do not mutate. */
  records(): readonly UsageRecord[] {
    if (!this.sorted) {
      this.list.sort((a, b) => a.ts - b.ts);
      this.sorted = true;
    }
    return this.list;
  }

  /** Total usage of a session (subagents included). */
  sessionUsage(sessionId: string): TokenUsage {
    return { ...(this.sessions.get(sessionId)?.usage ?? ZERO_USAGE) };
  }

  /** Per-model usage of a session. */
  sessionByModel(sessionId: string): Record<string, TokenUsage> {
    const agg = this.sessions.get(sessionId);
    return agg ? Object.fromEntries([...agg.byModel].map(([m, u]) => [m, { ...u }])) : {};
  }

  private aggregate(r: UsageRecord, sign: 1 | -1): void {
    let agg = this.sessions.get(r.sessionId);
    if (!agg) {
      if (sign < 0) return;
      agg = { usage: { ...ZERO_USAGE }, byModel: new Map() };
      this.sessions.set(r.sessionId, agg);
    }
    const op = sign > 0 ? addUsage : subUsage;
    agg.usage = op(agg.usage, r.usage);
    agg.byModel.set(r.model, op(agg.byModel.get(r.model) ?? ZERO_USAGE, r.usage));
    if (sign < 0) {
      if (rawTokenTotal(agg.byModel.get(r.model) ?? ZERO_USAGE) === 0) agg.byModel.delete(r.model);
      if (agg.byModel.size === 0) this.sessions.delete(r.sessionId);
    }
  }
}

function validRecord(r: UsageRecord): boolean {
  return (
    !!r &&
    typeof r.key === 'string' &&
    r.key !== '' &&
    typeof r.sessionId === 'string' &&
    Number.isFinite(r.ts) &&
    typeof r.model === 'string' &&
    !!r.usage
  );
}

export interface ActiveWindow {
  start: number;
  end: number;
  /** Index (in the ascending records) of the record that opened the window. */
  firstIndex: number;
}

/**
 * The active usage window, if any. Walking records in ascending order, a window opens at the
 * first record at or after the previous window's end, with its start floored to the UTC hour.
 * The last window is active while `now < start + windowMs`.
 */
export function activeWindow(
  records: readonly UsageRecord[],
  now: number,
  windowMs: number,
): ActiveWindow | undefined {
  if (!(windowMs > 0)) return undefined;
  let win: ActiveWindow | undefined;
  for (let i = 0; i < records.length; i++) {
    const ts = records[i]?.ts ?? 0;
    if (ts > now) break;
    if (!win || ts >= win.end) {
      const start = floorHour(ts);
      win = { start, end: start + windowMs, firstIndex: i };
    }
  }
  return win && now < win.end ? win : undefined;
}

/** First index whose ts is > `ts` (records ascending). */
function upperBound(records: readonly UsageRecord[], ts: number): number {
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((records[mid]?.ts ?? 0) > ts) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Records with from < ts <= to. */
export function recordsIn(
  records: readonly UsageRecord[],
  from: number,
  to: number,
): readonly UsageRecord[] {
  return records.slice(upperBound(records, from), upperBound(records, to));
}

/** Tokens per minute over (now - 10 min, now]. */
export function burnPerMin(records: readonly UsageRecord[], now: number): number {
  let total = 0;
  for (const r of recordsIn(records, now - BURN_MS, now)) total += tokenTotal(r.usage);
  return total / (BURN_MS / MINUTE_MS);
}

/** 24 hourly buckets, oldest first, ending with the hour containing `now`, stacked by project. */
export function hourlyBuckets(records: readonly UsageRecord[], now: number): HourBucket[] {
  const last = floorHour(now);
  const first = last - (HOURLY_BUCKETS - 1) * HOUR_MS;
  const buckets: HourBucket[] = [];
  for (let i = 0; i < HOURLY_BUCKETS; i++) {
    buckets.push({ start: first + i * HOUR_MS, total: 0, byProject: {} });
  }
  for (const r of recordsIn(records, first - 1, now)) {
    if (r.ts < first) continue;
    const b = buckets[Math.floor((r.ts - first) / HOUR_MS)];
    if (!b) continue;
    const t = tokenTotal(r.usage);
    b.total += t;
    b.byProject[r.projectId] = (b.byProject[r.projectId] ?? 0) + t;
  }
  return buckets;
}

export function computeUsageStats(book: UsageBook, opts: DashboardOptions): UsageStats {
  const { now, windowMs } = opts;
  const records = book.records();

  const win = activeWindow(records, now, windowMs);
  const winRecords = win ? records.slice(win.firstIndex, upperBound(records, now)) : [];
  const windowUsage = sumUsage(winRecords);
  const windowTotal = tokenTotal(windowUsage);
  const burn = burnPerMin(records, now);
  const projectedTotal = win
    ? windowTotal + burn * Math.max(0, (win.end - now) / MINUTE_MS)
    : windowTotal;

  const weekRecords = recordsIn(records, now - WEEK_MS, now);
  const weeklyUsage = sumUsage(weekRecords);

  const projectNames: Record<string, string> = {};
  for (const r of records) projectNames[r.projectId] = r.projectName;

  const stats: UsageStats = {
    windowHours: windowMs / HOUR_MS,
    windowUsage,
    windowTotal,
    burnPerMin: burn,
    projectedTotal,
    weeklyUsage,
    weeklyTotal: tokenTotal(weeklyUsage),
    hourly: hourlyBuckets(records, now),
    projectNames,
  };
  if (win) {
    stats.windowStart = win.start;
    stats.windowEnd = win.end;
  }
  if (opts.windowLimit !== undefined) stats.windowLimit = opts.windowLimit;
  if (opts.weeklyLimit !== undefined) stats.weeklyLimit = opts.weeklyLimit;
  const windowCost = costFor(usageByModel(winRecords), opts.prices);
  if (windowCost !== undefined) stats.windowCostUsd = windowCost;
  const weeklyCost = costFor(usageByModel(weekRecords), opts.prices);
  if (weeklyCost !== undefined) stats.weeklyCostUsd = weeklyCost;
  return stats;
}
