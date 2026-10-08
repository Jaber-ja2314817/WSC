// Plays the scripted demo (src/shared/demoScript.ts) in real time, looping with fresh ids.
import { buildDemoScript, DEMO_DURATION_MS } from '@shared/demoScript';
import type { StationEvent } from '@shared/types';

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
