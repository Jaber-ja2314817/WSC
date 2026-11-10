// Plays the scripted demo (src/shared/demoScript.ts) in real time, looping with fresh ids.
import type { PlanLimits, TokenUsage, TranscriptExtras, UsageRecord } from '@shared/dashboardTypes';
import { buildDemoScript, DEMO_DURATION_MS } from '@shared/demoScript';
import { projectIdFor, projectNameFor } from '@shared/projects';
import { computeStats } from '@shared/stats';
import type { StatsRange, StatsSnapshot } from '@shared/statsTypes';
import { ORCHESTRATOR_ID, type StationEvent } from '@shared/types';

/** Granularity of the playback clock; events due in the same tick are applied together. */
const TICK_MS = 50;

export class DemoPlayer {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sink: (evs: StationEvent[]) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stop();
    let t0 = this.now();
    let steps = buildDemoScript(t0);
    let next = 0;
    this.timer = setInterval(() => {
      const elapsed = this.now() - t0;
      const due: StationEvent[] = [];
      while (next < steps.length && steps[next]!.at <= elapsed) due.push(steps[next++]!.event);
      if (due.length > 0) this.sink(due);
      if (elapsed >= DEMO_DURATION_MS) {
        t0 = this.now();
        steps = buildDemoScript(t0);
        next = 0;
      }
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const DEMO_MODELS = ['demo-model-large', 'demo-model-small'] as const;

/** Small deterministic number in [0, n) from a string (FNV-1a). */
function hashTo(s: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % n;
}

/**
 * SYNTHETIC token usage for demo tool calls, so the dashboard shows numbers in `npm run demo`.
 * One fake API response per tool_start; subagents use the small model.
 */
export function demoUsageExtras(evs: StationEvent[]): TranscriptExtras[] {
  const out: TranscriptExtras[] = [];
  for (const ev of evs) {
    if (ev.kind !== 'tool_start') continue;
    const model = ev.agentId === ORCHESTRATOR_ID ? DEMO_MODELS[0] : DEMO_MODELS[1];
    const usage: TokenUsage = {
      input: 20 + hashTo(`${ev.id}:i`, 400),
      output: 80 + hashTo(`${ev.id}:o`, 1_400),
      cacheCreation: hashTo(`${ev.id}:w`, 4) === 0 ? 500 + hashTo(`${ev.id}:c`, 3_000) : 0,
      cacheRead: 4_000 + hashTo(`${ev.id}:r`, 36_000),
    };
    out.push({
      sessionId: ev.sessionId,
      agentId: ev.agentId,
      ts: ev.ts,
      projectId: ev.projectId,
      projectName: ev.projectName,
      model,
      usage: {
        key: `${ev.id}:demo-usage`,
        ts: ev.ts,
        sessionId: ev.sessionId,
        agentId: ev.agentId,
        projectId: ev.projectId,
        projectName: ev.projectName,
        model,
        usage,
      },
    });
  }
  return out;
}

/**
 * Made-up plan usage for demo mode: the 5-hour bar climbs from 38 % into the warning band over
 * a few minutes so the colours can be checked; the weekly bar sits at 61 %.
 */
export function demoPlanLimits(now: number, startedAt: number): PlanLimits {
  const elapsedS = Math.max(0, (now - startedAt) / 1000);
  return {
    updatedAt: now,
    fiveHour: {
      usedPct: Math.min(97, Math.round(38 + elapsedS / 4)),
      resetsAt: startedAt + (2 * 60 + 14) * 60_000,
    },
    sevenDay: { usedPct: 61, resetsAt: startedAt + 3 * 24 * 3_600_000 + 5 * 3_600_000 },
  };
}

/** Days of made-up history behind the demo's Stats view (about seven weeks). */
export const DEMO_STATS_DAYS = 49;
/** Days ago with no activity at all: a few gaps, and a current streak of eight days. */
const DEMO_GAP_DAYS = new Set([8, 15, 16, 27, 34, 35, 36, 44]);
const DEMO_STATS_PROJECTS = ['moonbase-planner', 'rocket-app', 'asteroid-tools'] as const;
const DEMO_STATS_MODELS = ['demo-model-large', 'demo-model-medium', 'demo-model-small'] as const;

/** Small seeded PRNG (mulberry32): the same seed gives the same sequence. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * SYNTHETIC usage history for demo mode: about seven weeks ending at `now`, with a few idle
 * days, lighter weekends, three models and the demo's own projects. Deterministic: each day's
 * records come from a generator seeded with that local date, so the picture is stable.
 */
export function demoStatsRecords(now: number): UsageRecord[] {
  const out: UsageRecord[] = [];
  const today = new Date(now);
  for (let ago = DEMO_STATS_DAYS - 1; ago >= 0; ago--) {
    if (DEMO_GAP_DAYS.has(ago)) continue;
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ago);
    const dayKey = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
    const rand = seeded(hashTo(dayKey, 4_294_967_295));
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const sessions = weekend ? 1 : 1 + Math.floor(rand() * 4);
    for (let s = 0; s < sessions; s++) {
      const project = pick(DEMO_STATS_PROJECTS);
      const cwd = `/home/demo/${project}`;
      // Fake, but shaped like a session id, so short ids (its first 8 characters) differ.
      const hex = hashTo(`${dayKey}:${s}`, 0xffffffff).toString(16).padStart(8, '0');
      const sessionId = `${hex}-0000-4000-8000-demo${dayKey.replace(/-/g, '')}${s}`;
      // Mostly working hours, with the odd late evening.
      const startHour = rand() < 0.15 ? 19 + Math.floor(rand() * 3) : 8 + Math.floor(rand() * 9);
      let ts = day.getTime() + startHour * 3_600_000 + Math.floor(rand() * 60) * 60_000;
      const responses = 12 + Math.floor(rand() * (weekend ? 20 : 60));
      const main = rand() < 0.6 ? DEMO_STATS_MODELS[0] : DEMO_STATS_MODELS[1];
      for (let i = 0; i < responses; i++) {
        // Now and then a long pause (a coffee, a meeting) that does not count as active time.
        ts += rand() < 0.05 ? (35 + Math.floor(rand() * 60)) * 60_000 : (20 + rand() * 300) * 1000;
        if (ts > now || ts >= dayEnd) break; // keeps the idle days idle
        const sub = rand() < 0.25;
        const model = sub ? DEMO_STATS_MODELS[2] : main;
        const usage: TokenUsage = {
          input: 40 + Math.floor(rand() * 2_400),
          output: 150 + Math.floor(rand() * (sub ? 1_800 : 4_200)),
          cacheCreation: rand() < 0.3 ? 1_000 + Math.floor(rand() * 9_000) : 0,
          cacheRead: 8_000 + Math.floor(rand() * 60_000),
        };
        out.push({
          key: `${sessionId}:${i}`,
          ts: Math.round(ts),
          sessionId,
          agentId: sub ? `demo-agent-${s}` : ORCHESTRATOR_ID,
          projectId: projectIdFor(cwd),
          projectName: projectNameFor(cwd),
          model,
          usage,
          rank: day.getTime(),
        });
      }
    }
  }
  return out;
}

/** The demo's Stats view: synthetic records through the real maths. Never reads transcripts. */
export function demoStats(now: number, range: StatsRange): StatsSnapshot {
  return computeStats(demoStatsRecords(now), { now, range, scanning: false });
}
