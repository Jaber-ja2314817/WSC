// Speech-bubble rate limiting and stacking. Pure and deterministic.
// Keeps the screen from flooding: per-crew gaps and caps, a global cap and birth rate,
// lowest-priority-first eviction, and a stack index so a crew's bubbles never overlap.

export type BubbleKind = 'status' | 'catchphrase';

/** Higher wins. Waiting/error moments are urgent and bypass the rate limits. */
export const BUBBLE_PRIORITY = { catchphrase: 0, status: 1, urgent: 2 } as const;

export interface BubbleRequest {
  crewId: string;
  kind: BubbleKind;
  text: string;
  /** Defaults to catchphrase → 0, status → 1. */
  priority?: number;
}

export interface Bubble {
  id: string;
  crewId: string;
  kind: BubbleKind;
  text: string;
  priority: number;
  bornAt: number;
  ttlMs: number;
  /** 0 = closest to the head. */
  stack: number;
}

export interface BubbleQueueOptions {
  ttlMs?: number;
  perCrewGapMs?: number;
  maxPerCrew?: number;
  maxVisible?: number;
  maxPerSecond?: number;
}

const DEFAULTS: Required<BubbleQueueOptions> = {
  ttlMs: 2500,
  perCrewGapMs: 1200,
  maxPerCrew: 2,
  maxVisible: 8,
  maxPerSecond: 6,
};

export class BubbleQueue {
  private opts: Required<BubbleQueueOptions>;
  private bubbles: Bubble[] = [];
  private lastPushByCrew = new Map<string, number>();
  private births: number[] = [];
  private seq = 0;

  constructor(opts: BubbleQueueOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  setTtl(ttlMs: number): void {
    this.opts.ttlMs = ttlMs;
  }

  /** Returns true if the bubble is shown. */
  push(req: BubbleRequest, now: number): boolean {
    const text = req.text.trim();
    if (!text || !req.crewId) return false;
    this.expire(now);
    const priority =
      req.priority ??
      (req.kind === 'status' ? BUBBLE_PRIORITY.status : BUBBLE_PRIORITY.catchphrase);
    const urgent = priority >= BUBBLE_PRIORITY.urgent;

    if (!urgent) {
      const last = this.lastPushByCrew.get(req.crewId);
      if (last !== undefined && now - last < this.opts.perCrewGapMs) return false;
      this.births = this.births.filter((t) => now - t < 1000);
      if (this.births.length >= this.opts.maxPerSecond) return false;
    }

    // A crew's newer status replaces its older status bubble instead of stacking.
    if (req.kind === 'status') {
      this.bubbles = this.bubbles.filter((b) => !(b.crewId === req.crewId && b.kind === 'status'));
    }

    const bubble: Bubble = {
      id: `b${++this.seq}`,
      crewId: req.crewId,
      kind: req.kind,
      text,
      priority,
      bornAt: now,
      ttlMs: this.opts.ttlMs,
      stack: 0,
    };

    // Per-crew cap: evict this crew's lowest-priority, oldest bubble.
    const own = this.bubbles.filter((b) => b.crewId === req.crewId);
    if (own.length >= this.opts.maxPerCrew) {
      const victim = lowest(own);
      if (victim.priority > priority) return false;
      this.remove(victim);
    }

    // Global cap: evict the lowest-priority, oldest bubble anywhere.
    if (this.bubbles.length >= this.opts.maxVisible) {
      const victim = lowest(this.bubbles);
      if (victim.priority > priority) return false;
      this.remove(victim);
    }

    this.bubbles.push(bubble);
    this.lastPushByCrew.set(req.crewId, now);
    this.births.push(now);
    return true;
  }

  /** Drop all bubbles of a crew (e.g. sprite removed). */
  clearCrew(crewId: string): void {
    this.bubbles = this.bubbles.filter((b) => b.crewId !== crewId);
    this.lastPushByCrew.delete(crewId);
  }

  visible(now: number): Bubble[] {
    this.expire(now);
    const byCrew = new Map<string, Bubble[]>();
    for (const b of this.bubbles) {
      const list = byCrew.get(b.crewId) ?? [];
      list.push(b);
      byCrew.set(b.crewId, list);
    }
    const out: Bubble[] = [];
    for (const list of byCrew.values()) {
      // Newest sits closest to the head; older ones stack above it.
      list.sort((a, b) => b.bornAt - a.bornAt || cmpId(b.id, a.id));
      list.forEach((b, i) => out.push({ ...b, stack: i }));
    }
    return out.sort((a, b) => a.bornAt - b.bornAt || cmpId(a.id, b.id));
  }

  private expire(now: number): void {
    this.bubbles = this.bubbles.filter((b) => now - b.bornAt < b.ttlMs);
  }

  private remove(b: Bubble): void {
    this.bubbles = this.bubbles.filter((x) => x !== b);
  }
}

function lowest(list: Bubble[]): Bubble {
  return list.reduce((min, b) =>
    b.priority < min.priority || (b.priority === min.priority && b.bornAt < min.bornAt) ? b : min,
  );
}

function cmpId(a: string, b: string): number {
  return Number(a.slice(1)) - Number(b.slice(1));
}
