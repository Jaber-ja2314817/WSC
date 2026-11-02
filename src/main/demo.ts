// Plays the scripted demo (src/shared/demoScript.ts) in real time, looping with fresh ids.
import type { PlanLimits, TokenUsage, TranscriptExtras } from '@shared/dashboardTypes';
import { buildDemoScript, DEMO_DURATION_MS } from '@shared/demoScript';
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
