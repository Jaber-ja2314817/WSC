// Main-process wiring: ingest server + backfill → normalizer → store → renderer snapshots.
import { randomBytes } from 'node:crypto';
import { hookSessionInfo, normalizeHookPayload } from '@shared/normalizer';
import { StationStore } from '@shared/store';
import type { StationEvent, StationSnapshot, ToolCategory } from '@shared/types';
import { backfillRecent, backfillTranscript } from './backfill';
import { DemoPlayer } from './demo';
import { readRuntimeFile, removeRuntimeFile, writeRuntimeFile } from './runtimeFile';
import { startIngestServer, type IngestServer, type StationCommand } from './server';

export const DEFAULT_PORT = 47821;
const PUSH_INTERVAL_MS = 100;
const TICK_INTERVAL_MS = 5_000;

/**
 * - `live`: real hook events + transcript backfill.
 * - `demo`: scripted run; the first real hook event switches back to live (first-run button,
 *   `/station demo`).
 * - `demo-pinned`: scripted run that ignores hooks (`--demo`, for development and recordings).
 */
export type StationMode = 'live' | 'demo' | 'demo-pinned';

export interface StationOptions {
  version: string;
  port?: number;
  mode?: StationMode;
  /** Skip the HTTP server + backfill entirely (tests). */
  offline?: boolean;
  onSnapshot: (snap: StationSnapshot) => void;
  /** Fired once for the first real hook event this process sees. */
  onFirstHookEvent?: () => void;
  /** Mode or port changed. */
  onStatusChange?: () => void;
  onCommand?: (cmd: StationCommand) => unknown;
  /** Initial tunables (settings); change later with `configure`. */
  tuning?: StationTuning;
}

/** Settings-driven knobs that can change while running. */
export interface StationTuning {
  toolOverrides?: Record<string, ToolCategory>;
  fullToolDetails?: boolean;
  staleMs?: number;
  sessionLingerMs?: number;
}

export class Station {
  private store = new StationStore();
  private unsubscribe: () => void;
  private server: IngestServer | null = null;
  private token = '';
  private seenSessions = new Set<string>();
  private dirty = false;
  private timers: NodeJS.Timeout[] = [];
  private demo: DemoPlayer | null = null;
  private sawHookEvent = false;
  private currentMode: StationMode;

  private tuning: StationTuning = {};
  /** While paused, events are still ingested but no snapshots are pushed. */
  paused = false;

  constructor(private readonly opts: StationOptions) {
    this.currentMode = opts.mode ?? 'live';
    if (opts.tuning) this.configure(opts.tuning);
    this.unsubscribe = this.store.subscribe(() => (this.dirty = true));
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  get mode(): StationMode {
    return this.currentMode;
  }

  get eventsReceived(): number {
    return this.store.snapshot().eventsReceived;
  }

  async start(): Promise<void> {
    // Coalesce bursts: at most one snapshot per PUSH_INTERVAL_MS.
    this.timers.push(
      setInterval(() => {
        if (!this.dirty || this.paused) return;
        this.dirty = false;
        this.opts.onSnapshot(this.store.snapshot());
      }, PUSH_INTERVAL_MS),
      setInterval(() => this.store.tick(Date.now()), TICK_INTERVAL_MS),
    );
    if (this.currentMode !== 'live') this.playDemo();
    if (this.opts.offline) return;

    this.token = randomBytes(24).toString('hex');
    this.server = await startIngestServer({
      port: this.opts.port ?? DEFAULT_PORT,
      token: this.token,
      version: this.opts.version,
      onPayload: (raw, receivedAt) => this.ingestHook(raw, receivedAt),
      ...(this.opts.onCommand ? { onCommand: this.opts.onCommand } : {}),
    });
    writeRuntimeFile({
      port: this.server.port,
      token: this.token,
      pid: process.pid,
      version: this.opts.version,
    });
    this.opts.onStatusChange?.();
    if (this.currentMode === 'live') this.backfill();
  }

  /** Apply settings changes. Tool mapping/summary changes affect events from now on. */
  configure(t: StationTuning): void {
    this.tuning = { ...this.tuning, ...t };
    this.store.setTimings({
      ...(this.tuning.staleMs !== undefined ? { staleMs: this.tuning.staleMs } : {}),
      ...(this.tuning.sessionLingerMs !== undefined
        ? { sessionLingerMs: this.tuning.sessionLingerMs }
        : {}),
    });
  }

  clearIdleProjects(idleMs: number): void {
    this.store.clearIdleProjects(Date.now(), idleMs);
  }

  /** Resume pushing after a pause: send the current state once. */
  resume(): void {
    this.paused = false;
    this.dirty = true;
  }

  ingest(evs: StationEvent[]): void {
    this.store.applyMany(evs);
  }

  snapshot(): StationSnapshot {
    return this.store.snapshot();
  }

  /** Switch to a scripted demo in place (clears the board). */
  startDemo(pinned = false): void {
    this.currentMode = pinned ? 'demo-pinned' : 'demo';
    this.resetStore();
    this.playDemo();
    this.opts.onStatusChange?.();
  }

  /** Leave demo mode: clear the board and rebuild live state from recent transcripts. */
  stopDemo(): void {
    if (this.currentMode === 'live') return;
    this.demo?.stop();
    this.demo = null;
    this.currentMode = 'live';
    this.resetStore();
    if (this.server) this.backfill();
    this.opts.onStatusChange?.();
  }

  /** Self-check used by the first-run "Test connection" button. */
  async testConnection(): Promise<{ ok: boolean; port?: number; error?: string }> {
    if (!this.server) return { ok: false, error: 'The event server is not running.' };
    const port = this.server.port;
    const onDisk = readRuntimeFile();
    if (!onDisk || onDisk.port !== port || onDisk.token !== this.token) {
      return { ok: false, port, error: 'The runtime file does not point at this app.' };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { 'x-wsc-token': this.token },
        signal: AbortSignal.timeout(1_000),
      });
      if (!res.ok) return { ok: false, port, error: `Health check returned ${res.status}.` };
      return { ok: true, port };
    } catch {
      return { ok: false, port, error: 'Could not reach the event server.' };
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.demo?.stop();
    this.demo = null;
    removeRuntimeFile();
    await this.server?.close();
    this.server = null;
  }

  private playDemo(): void {
    this.demo?.stop();
    this.demo = new DemoPlayer((evs) => this.ingest(evs));
    this.demo.start();
  }

  private backfill(): void {
    // Tick right away so long-silent backfilled agents show as stale/done immediately.
    void backfillRecent({ ...this.normalizeOpts(), onEvents: (evs) => this.ingest(evs) }).then(() =>
      this.store.tick(Date.now()),
    );
  }

  private resetStore(): void {
    this.unsubscribe();
    this.store = new StationStore();
    this.configure({});
    this.unsubscribe = this.store.subscribe(() => (this.dirty = true));
    this.seenSessions.clear();
    this.dirty = true;
  }

  private ingestHook(raw: unknown, receivedAt: number): void {
    if (this.currentMode === 'demo-pinned') return;
    const events = normalizeHookPayload(raw, receivedAt, this.normalizeOpts());
    if (events.length === 0) return;
    if (!this.sawHookEvent) {
      this.sawHookEvent = true;
      this.opts.onFirstHookEvent?.();
    }
    // Real work started while the demo was playing: show reality instead.
    if (this.currentMode === 'demo') this.stopDemo();

    const info = hookSessionInfo(raw);
    // First sight of a session that started before the app: reconstruct it from its transcript.
    if (info && !this.seenSessions.has(info.sessionId)) {
      this.seenSessions.add(info.sessionId);
      if (info.transcriptPath) {
        void backfillTranscript(info.transcriptPath, {
          ...this.normalizeOpts(),
          onEvents: (evs) => this.ingest(evs),
        });
      }
    }
    this.ingest(events);
  }

  private normalizeOpts(): {
    toolOverrides?: Record<string, ToolCategory>;
    fullToolDetails?: boolean;
  } {
    return {
      ...(this.tuning.toolOverrides ? { toolOverrides: this.tuning.toolOverrides } : {}),
      ...(this.tuning.fullToolDetails ? { fullToolDetails: true } : {}),
    };
  }
}
