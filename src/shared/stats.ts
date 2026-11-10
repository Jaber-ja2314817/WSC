// Stats maths: usage statistics over a date range (Claude Code's /stats, for WSC).
// Pure — no Electron, Node or DOM imports. One pass over deduped UsageRecords in any order;
// see statsTypes.ts for the meaning of every field.
import { ZERO_USAGE, tokenTotal, type TokenUsage, type UsageRecord } from './dashboardTypes';
import {
  STATS_IDLE_GAP_MS,
  STATS_MAX_DAYS,
  STATS_TOP_PROJECTS,
  type StatsDay,
  type StatsModel,
  type StatsOptions,
  type StatsProject,
  type StatsRange,
  type StatsSession,
  type StatsSnapshot,
} from './statsTypes';
import { costFor } from './usage';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const QUARTER_MS = 900_000;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

function dayKeyOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${pad2(m + 1)}-${pad2(d)}`;
}

/** Calendar day number of a local date: consecutive dates differ by exactly 1 (no DST drift). */
const dayIndexOf = (y: number, m: number, d: number): number => Date.UTC(y, m, d) / DAY_MS;

/** Local date of `ts`, `YYYY-MM-DD`. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return dayKeyOf(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Epoch ms of the local midnight that starts the day containing `ts`. */
export function localDayStart(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local midnight of the range's first day: 6 or 29 days before today. Undefined for 'all'. */
export function rangeStartFor(range: StatsRange, now: number): number | undefined {
  if (range === 'all') return undefined;
  const back = range === '7d' ? 6 : 29;
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
}

interface LocalHour {
  /** Local hour of day, 0–23. */
  hour: number;
  /** The local hour's bounds, clamped to its local day. */
  start: number;
  end: number;
  day: LocalDay;
}

/** A local calendar day with any activity (whole history), and its range totals if in range. */
interface LocalDay {
  index: number;
  start: number;
  end: number;
  agg?: DayAgg;
}

function localHourOf(ts: number, dayCache: Map<number, LocalDay>): LocalHour {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth();
  const dd = d.getDate();
  const index = dayIndexOf(y, m, dd);
  let day = dayCache.get(index);
  if (!day) {
    day = { index, start: new Date(y, m, dd).getTime(), end: new Date(y, m, dd + 1).getTime() };
    dayCache.set(index, day);
  }
  const hour = d.getHours();
  const top = ts - (d.getMinutes() * 60_000 + d.getSeconds() * 1000 + d.getMilliseconds());
  let start = Math.max(top, day.start);
  let end = Math.min(top + HOUR_MS, day.end);
  // A clock change that is not on the hour (Lord Howe, Chatham) leaves a local hour shorter
  // than 60 minutes, and `top` or `top + 1h` then lies in the next or previous hour. Shrink
  // the span by quarter hours until both ends are inside this hour, so the quarter-hour cache
  // never maps another hour's records here. Both ends stay on UTC quarter hours.
  while (start + QUARTER_MS <= ts && new Date(start).getHours() !== hour) start += QUARTER_MS;
  while (end - QUARTER_MS > ts && new Date(end - 1).getHours() !== hour) end -= QUARTER_MS;
  return { hour, start, end, day };
}

interface DayAgg {
  index: number;
  tokens: number;
  messages: number;
  sessions: Set<string>;
  lastSession: string;
  byModel: Record<string, number>;
}

interface SessionAgg {
  id: string;
  times: number[];
  sorted: boolean;
  startedAt: number;
  projectName: string;
}

interface ProjectAgg {
  projectId: string;
  projectName: string;
  /** ts of the record the name came from: the newest record names the project. */
  nameTs: number;
  total: number;
  sessions: Set<string>;
  lastSession: string;
}

function addInto(target: TokenUsage, u: TokenUsage): void {
  target.input += u.input;
  target.output += u.output;
  target.cacheCreation += u.cacheCreation;
  target.cacheRead += u.cacheRead;
}

/** Active time of a session: gaps between consecutive responses, idle gaps left out. */
function activeTime(s: SessionAgg): number {
  const t = s.sorted ? s.times : Float64Array.from(s.times).sort();
  let total = 0;
  for (let i = 1; i < t.length; i++) {
    const gap = (t[i] ?? 0) - (t[i - 1] ?? 0);
    if (gap <= STATS_IDLE_GAP_MS) total += gap;
  }
  return total;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Usage statistics for `opts.range`, ending with today (the local day containing `opts.now`).
 * Records after today are clock skew and are left out; streaks and firstActivityAt cover the
 * whole history. Ties are broken by fixed keys, so equal input gives an equal snapshot.
 */
export function computeStats(records: readonly UsageRecord[], opts: StatsOptions): StatsSnapshot {
  const { now, range } = opts;
  const nowDate = new Date(now);
  const ty = nowDate.getFullYear();
  const tm = nowDate.getMonth();
  const td = nowDate.getDate();
  const todayIndex = dayIndexOf(ty, tm, td);
  const todayEnd = new Date(ty, tm, td + 1).getTime();
  const fixedStart = rangeStartFor(range, now);
  const from = fixedStart ?? -Infinity;

  const usage: TokenUsage = { ...ZERO_USAGE };
  let messages = 0;
  let firstActivityAt = Infinity;
  // Every day with activity, whole history: streaks.
  const activeAll = new Map<number, LocalDay>();
  // Days of the range with activity.
  const days: DayAgg[] = [];
  const sessions = new Map<string, SessionAgg>();
  const models = new Map<string, TokenUsage>();
  const projects = new Map<string, ProjectAgg>();
  const byHour: number[] = new Array<number>(24).fill(0);

  // Caches: the local hour and day of the previous record, reused while records stay inside.
  const quarters = new Map<number, LocalHour>();
  let hourStart = 1;
  let hourEnd = 0;
  let hour = 0;
  let localDay: LocalDay | undefined;
  let lastSession: SessionAgg | undefined;
  let lastModelId = '';
  let lastModel: TokenUsage | undefined;
  let lastProject: ProjectAgg | undefined;

  for (const r of records) {
    const ts = r?.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts >= todayEnd || !r.usage) continue;

    if (ts < hourStart || ts >= hourEnd) {
      // Every UTC offset is a whole number of quarter hours, so a UTC quarter hour lies inside
      // one local hour: out-of-order records find their hour without building a Date.
      const q = Math.floor(ts / QUARTER_MS);
      let info = quarters.get(q);
      // The bounds check only fails for offsets that are not whole quarter hours (historical).
      if (!info || ts < info.start || ts >= info.end) {
        info = localHourOf(ts, activeAll);
        for (let k = Math.floor(info.start / QUARTER_MS); k * QUARTER_MS < info.end; k++) {
          quarters.set(k, info);
        }
      }
      hour = info.hour;
      hourStart = info.start;
      hourEnd = info.end;
      localDay = info.day;
    }
    if (!localDay) continue; // unreachable: set by the first record

    if (ts < firstActivityAt) firstActivityAt = ts;
    if (ts < from) continue;

    const u = r.usage;
    const tokens = tokenTotal(u);
    addInto(usage, u);
    messages++;
    byHour[hour] = (byHour[hour] ?? 0) + tokens;

    let day = localDay.agg;
    if (!day) {
      day = {
        index: localDay.index,
        tokens: 0,
        messages: 0,
        sessions: new Set(),
        lastSession: '',
        byModel: {},
      };
      localDay.agg = day;
      days.push(day);
    }
    day.tokens += tokens;
    day.messages++;
    if (day.lastSession !== r.sessionId) {
      day.sessions.add(r.sessionId);
      day.lastSession = r.sessionId;
    }
    day.byModel[r.model] = (day.byModel[r.model] ?? 0) + tokens;

    if (lastModel === undefined || lastModelId !== r.model) {
      lastModelId = r.model;
      lastModel = models.get(r.model);
      if (!lastModel) {
        lastModel = { ...ZERO_USAGE };
        models.set(r.model, lastModel);
      }
    }
    addInto(lastModel, u);

    let s = lastSession;
    if (!s || s.id !== r.sessionId) {
      s = sessions.get(r.sessionId);
      if (!s) {
        s = { id: r.sessionId, times: [], sorted: true, startedAt: ts, projectName: r.projectName };
        sessions.set(r.sessionId, s);
      }
      lastSession = s;
    }
    const prev = s.times[s.times.length - 1];
    if (prev !== undefined && prev > ts) s.sorted = false;
    s.times.push(ts);
    if (ts < s.startedAt || (ts === s.startedAt && cmpStr(r.projectName, s.projectName) < 0)) {
      s.startedAt = ts;
      s.projectName = r.projectName;
    }

    let p = lastProject;
    if (!p || p.projectId !== r.projectId) {
      p = projects.get(r.projectId);
      if (!p) {
        p = {
          projectId: r.projectId,
          projectName: r.projectName,
          nameTs: ts,
          total: 0,
          sessions: new Set(),
          lastSession: '',
        };
        projects.set(r.projectId, p);
      }
      lastProject = p;
    }
    p.total += tokens;
    if (p.lastSession !== r.sessionId) {
      p.sessions.add(r.sessionId);
      p.lastSession = r.sessionId;
    }
    if (ts > p.nameTs || (ts === p.nameTs && cmpStr(r.projectName, p.projectName) < 0)) {
      p.nameTs = ts;
      p.projectName = r.projectName;
    }
  }

  const hasHistory = activeAll.size > 0;
  const total = tokenTotal(usage);

  // Streaks over the whole history.
  const sortedDays = [...activeAll.keys()].sort((a, b) => a - b);
  let longestStreak = 0;
  let run = 0;
  for (let i = 0; i < sortedDays.length; i++) {
    run = i > 0 && (sortedDays[i] ?? 0) - (sortedDays[i - 1] ?? 0) === 1 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
  }
  let currentStreak = 0;
  let cursor = activeAll.has(todayIndex) ? todayIndex : todayIndex - 1;
  while (activeAll.has(cursor)) {
    currentStreak++;
    cursor--;
  }

  // The range's calendar days.
  let rangeStart = fixedStart;
  let totalDays = range === '7d' ? 7 : range === '30d' ? 30 : 0;
  if (range === 'all' && hasHistory) {
    rangeStart = localDayStart(firstActivityAt);
    totalDays = todayIndex - (sortedDays[0] ?? todayIndex) + 1;
  }
  const shown = Math.min(totalDays, STATS_MAX_DAYS);
  const dayList: StatsDay[] = [];
  for (let i = shown - 1; i >= 0; i--) {
    const d = new Date(ty, tm, td - i);
    const y = d.getFullYear();
    const m = d.getMonth();
    const dd = d.getDate();
    const agg = activeAll.get(dayIndexOf(y, m, dd))?.agg;
    dayList.push({
      day: dayKeyOf(y, m, dd),
      start: d.getTime(),
      tokens: agg?.tokens ?? 0,
      sessions: agg?.sessions.size ?? 0,
      messages: agg?.messages ?? 0,
      byModel: agg ? { ...agg.byModel } : {},
    });
  }

  let busiest: DayAgg | undefined;
  for (const agg of days) {
    if (
      !busiest ||
      agg.tokens > busiest.tokens ||
      (agg.tokens === busiest.tokens && agg.index < busiest.index)
    ) {
      busiest = agg;
    }
  }

  let longest: StatsSession | undefined;
  let longestId = '';
  for (const s of sessions.values()) {
    const durationMs = activeTime(s);
    if (
      !longest ||
      durationMs > longest.durationMs ||
      (durationMs === longest.durationMs &&
        (s.startedAt < longest.startedAt ||
          (s.startedAt === longest.startedAt && cmpStr(s.id, longestId) < 0)))
    ) {
      longestId = s.id;
      longest = {
        shortId: s.id.slice(0, 8),
        projectName: s.projectName,
        startedAt: s.startedAt,
        durationMs,
      };
    }
  }

  const modelList: StatsModel[] = [...models]
    .map(([model, mu]) => {
      const t = tokenTotal(mu);
      return { model, usage: { ...mu }, total: t, share: total > 0 ? t / total : 0 };
    })
    .sort((a, b) => b.total - a.total || cmpStr(a.model, b.model));

  const projectList: StatsProject[] = [...projects.values()]
    .sort(
      (a, b) =>
        b.total - a.total ||
        cmpStr(a.projectName, b.projectName) ||
        cmpStr(a.projectId, b.projectId),
    )
    .slice(0, STATS_TOP_PROJECTS)
    .map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      total: p.total,
      sessions: p.sessions.size,
    }));

  const snap: StatsSnapshot = {
    range,
    generatedAt: now,
    scanning: opts.scanning ?? false,
    usage,
    total,
    sessions: sessions.size,
    messages,
    activeDays: days.length,
    totalDays,
    currentStreak,
    longestStreak,
    byHour,
    models: modelList,
    projects: projectList,
    days: dayList,
  };
  if (rangeStart !== undefined) snap.rangeStart = rangeStart;
  if (hasHistory) snap.firstActivityAt = firstActivityAt;
  if (busiest)
    snap.mostActiveDay = { day: dayKeyOf(...ymdOfIndex(busiest.index)), tokens: busiest.tokens };
  if (longest) snap.longestSession = longest;
  if (messages > 0) {
    let peak = 0;
    for (let h = 1; h < 24; h++) if ((byHour[h] ?? 0) > (byHour[peak] ?? 0)) peak = h;
    snap.peakHour = peak;
  }
  const fav = modelList[0];
  if (fav) snap.favoriteModel = fav.model;
  const byModel: Record<string, TokenUsage> = {};
  for (const m of modelList) byModel[m.model] = m.usage;
  const cost = costFor(byModel, opts.prices);
  if (cost !== undefined) snap.costUsd = cost;
  return snap;
}

/** Local year, month and date of a calendar day number (the inverse of dayIndexOf). */
function ymdOfIndex(index: number): [number, number, number] {
  const d = new Date(index * DAY_MS);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}
