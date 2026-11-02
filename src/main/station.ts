// Main-process wiring: ingest server + backfill + transcript watcher → normalizer → store →
// renderer snapshots, plus the dashboard ledger (token usage, timelines) → dashboard snapshots.
import { randomBytes } from 'node:crypto';
import { SessionLedger } from '@shared/dashboard';
import type {
  DashboardOptions,
  DashboardSnapshot,
  ModelPrice,
  PlanLimits,
  TimelineStep,
} from '@shared/dashboardTypes';
import { hookSessionInfo, normalizeHookPayload, normalizeRateLimits } from '@shared/normalizer';
import { mergePlanLimits, samePlanLimits } from '@shared/usage';
import { StationStore } from '@shared/store';
import type { StationEvent, StationSnapshot, ToolCategory } from '@shared/types';
import { backfillRecent, backfillTranscript } from './backfill';
import { DemoPlayer, demoPlanLimits, demoUsageExtras } from './demo';
import { readRuntimeFile, removeRuntimeFile, writeRuntimeFile } from './runtimeFile';
import { startIngestServer, type IngestServer, type StationCommand } from './server';
import { TranscriptWatcher, type WatcherBatch } from './transcriptWatcher';

export const DEFAULT_PORT = 47821;
const PUSH_INTERVAL_MS = 100;
const TICK_INTERVAL_MS = 5_000;
/** Dashboard pushes: at most this often when something changed… */
const DASH_PUSH_MS = 500;
/** …and at least this often, for timers (idle status, window reset countdown). */
const DASH_TIMER_MS = 5_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Live transcript events older than this only reach the dashboard, never the station floor. */
const LIVE_STORE_HORIZON_MS = 30 * 60_000;
const TIMELINE_LIMIT = 300;

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
  /** Dashboard snapshots (≤ 2/s when changed, every 5 s for timers, never when unchanged). */
  onDashboard?: (dash: DashboardSnapshot) => void;
  /** Last known plan usage (persisted by the caller), shown until a fresh update arrives. */
  planLimits?: PlanLimits;
  /** Plan usage numbers changed (for persisting; not called when only updatedAt moves). */
  onPlanLimits?: (limits: PlanLimits) => void;
  /** A live SessionStart hook arrived over HTTP. */
  onSessionStart?: () => void;
  /** Initial tunables (settings); change later with `configure`. */
  tuning?: StationTuning;
  /** Watch transcripts (default: when not offline and not a pinned demo). */
  watchTranscripts?: boolean;
  /** Transcript root override (tests). Defaults to claudeProjectsDir(). */
  projectsDir?: string;
  /** false: no fs.watch / rescan timer; call pollTranscripts() (tests). */
  liveWatch?: boolean;
}

/** Settings-driven knobs that can change while running. */
export interface StationTuning {
  toolOverrides?: Record<string, ToolCategory>;
  fullToolDetails?: boolean;
  staleMs?: number;
  sessionLingerMs?: number;
  /** Redacted prompt previews on the dashboard (settings.showPromptPreview). */
  promptPreview?: boolean;
  /** Startup transcript scan horizon and ledger retention. */
  lookbackDays?: number;
  idleMs?: number;
  usageWindowMs?: number;
  windowTokenLimit?: number | null;
  weeklyTokenLimit?: number | null;
  prices?: Record<string, ModelPrice>;
}

export class Station {
  private store = new StationStore();
  private unsubscribe: () => void;
  private server: IngestServer | null = null;
  private token = '';
  private seenSessions = new Set<string>();
  private dirty = false;
  private pushTimer: NodeJS.Timeout | null = null;
  private storeRevision = 0;
  private hidden = false;
  private timers: NodeJS.Timeout[] = [];
  private demo: DemoPlayer | null = null;
  private sawHookEvent = false;
  private currentMode: StationMode;
  /** Real sessions: hooks, backfill and transcripts. Kept across demo runs. */
  private ledger = new SessionLedger();
  /** Demo sessions; reset with the store. */
  private demoLedger = new SessionLedger();
  private watcher: TranscriptWatcher | null = null;
  private dashDirty = true;
  private lastDashAt = 0;
  private lastDashJson = '';
  private scanDone: Promise<void> = Promise.resolve();
  /** Real plan usage from the status line bridge. */
  private planLimits: PlanLimits | undefined;
  private demoStartedAt = Date.now();

  private tuning: StationTuning = {};
  /** While paused, events are still ingested but no snapshots are pushed. */
  paused = false;

  constructor(private readonly opts: StationOptions) {
    this.currentMode = opts.mode ?? 'live';
    this.planLimits = opts.planLimits;
    if (opts.tuning) this.configure(opts.tuning);
    this.unsubscribe = this.store.subscribe(() => this.markDirty());
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
    this.timers.push(
      setInterval(() => this.store.tick(Date.now()), TICK_INTERVAL_MS),
      setInterval(() => this.pushDashboard(), DASH_PUSH_MS),
      setInterval(() => this.pruneLedger(), PRUNE_INTERVAL_MS),
    );
    if (this.currentMode !== 'live') this.playDemo();
    const watch =
      this.opts.watchTranscripts ?? (!this.opts.offline && this.currentMode !== 'demo-pinned');
    if (watch) this.startWatcher();
    if (this.opts.offline) return;

    this.token = randomBytes(24).toString('hex');
    this.server = await startIngestServer({
      port: this.opts.port ?? DEFAULT_PORT,
      token: this.token,
      version: this.opts.version,
      onPayload: (raw, receivedAt) => this.ingestHook(raw, receivedAt, true),
      onLimits: (raw, receivedAt) => this.ingestLimits(raw, receivedAt),
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
    this.dashDirty = true;
  }

  clearIdleProjects(idleMs: number): void {
    this.store.clearIdleProjects(Date.now(), idleMs);
  }

  removeProject(projectId: string): void {
    this.store.removeProject(projectId, Date.now());
  }

  /** Resume pushing after a pause: send the current state once. */
  resume(): void {
    this.paused = false;
    this.markDirty();
    this.dashDirty = true;
  }

  /** Bumped on every store change (cheap change check for pollers). */
  get revision(): number {
    return this.storeRevision;
  }

  /**
   * The window is hidden or minimized: build and push nothing (events are still ingested).
   * Showing it again pushes the current state once.
   */
  setViewHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) return;
    this.markDirty();
    this.dashDirty = true;
    this.pushDashboard();
  }

  /** Coalesce bursts: at most one snapshot per PUSH_INTERVAL_MS, and none while idle. */
  private markDirty(): void {
    this.storeRevision++;
    this.dirty = true;
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      if (!this.dirty || this.paused || this.hidden) return;
      this.dirty = false;
      this.opts.onSnapshot(this.store.snapshot());
    }, PUSH_INTERVAL_MS);
  }

  /** Real events: store + dashboard ledger. */
  ingest(evs: StationEvent[]): void {
    this.store.applyMany(evs);
    if (this.ledger.applyEvents(evs)) this.dashDirty = true;
  }

  /** A raw hook payload passed on the command line (`--hook-payload=`) at launch. */
  ingestHookPayload(raw: unknown): void {
    this.ingestHook(raw, Date.now(), false);
  }

  /** A status line `rate_limits` update (real plan usage). */
  ingestLimits(raw: unknown, receivedAt: number): void {
    const next = normalizeRateLimits(raw, receivedAt);
    if (!next) return;
    const merged = mergePlanLimits(this.planLimits, next, receivedAt);
    const changed = !samePlanLimits(this.planLimits, merged);
    this.planLimits = merged;
    if (!changed) return;
    this.dashDirty = true;
    this.opts.onPlanLimits?.(merged);
    this.pushDashboard();
  }

  /** The dashboard as of now. */
  getDashboard(): DashboardSnapshot {
    const now = Date.now();
    const opts = this.dashboardOptions();
    const snap = this.activeLedger().snapshot(this.store.snapshot(), opts);
    snap.scanning = this.currentMode === 'live' && (this.watcher?.scanning ?? false);
    const limits =
      this.currentMode === 'live' ? this.planLimits : demoPlanLimits(now, this.demoStartedAt);
    if (limits) snap.planLimits = limits;
    return snap;
  }

  /** Newest first, at most 300 steps. */
  getTimeline(sessionId: string): TimelineStep[] {
    return this.activeLedger().timeline(sessionId, TIMELINE_LIMIT);
  }

  /** Read appended transcript bytes now (tests; the live watcher does this on its own). */
  async pollTranscripts(): Promise<void> {
    await this.watcher?.poll();
  }

  /** Resolves when the startup transcript scan finished (immediately without a watcher). */
  get transcriptScan(): Promise<void> {
    return this.scanDone;
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
    if (!this.watcher && this.opts.watchTranscripts !== false && !this.opts.offline) {
      this.startWatcher();
    }
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
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.demo?.stop();
    this.demo = null;
    this.watcher?.close();
    this.watcher = null;
    removeRuntimeFile();
    await this.server?.close();
    this.server = null;
  }

  private playDemo(): void {
    this.demo?.stop();
    this.demoStartedAt = Date.now();
    this.demo = new DemoPlayer((evs) => this.ingestDemo(evs));
    this.demo.start();
  }

  private ingestDemo(evs: StationEvent[]): void {
    this.store.applyMany(evs);
    const a = this.demoLedger.applyEvents(evs);
    const b = this.demoLedger.applyExtras(demoUsageExtras(evs));
    if (a || b) this.dashDirty = true;
  }

  private activeLedger(): SessionLedger {
    return this.currentMode === 'live' ? this.ledger : this.demoLedger;
  }

  private startWatcher(): void {
    if (this.watcher) return;
    this.watcher = new TranscriptWatcher({
      ...(this.opts.projectsDir !== undefined ? { root: this.opts.projectsDir } : {}),
      ...(this.opts.liveWatch === false ? { live: false } : {}),
      lookbackDays: this.tuning.lookbackDays ?? 7,
      parseOptions: () => ({
        ...this.normalizeOpts(),
        ...(this.tuning.promptPreview ? { promptPreview: true } : {}),
      }),
      onBatch: (b) => this.onWatcherBatch(b),
      onScanning: () => (this.dashDirty = true),
    });
    this.scanDone = this.watcher.start();
  }

  private onWatcherBatch(b: WatcherBatch): void {
    let changed = false;
    if (b.events.length > 0 && this.ledger.applyEvents(b.events)) changed = true;
    if (b.extras.length > 0 && this.ledger.applyExtras(b.extras)) {
      changed = true;
    }
    if (changed) this.dashDirty = true;
    // The startup scan only feeds the dashboard; backfill seeds the station floor. Live lines
    // also reach the floor (sessions without hooks still show up), but never old history.
    if (b.initial || this.currentMode !== 'live' || b.events.length === 0) return;
    const horizon = Date.now() - LIVE_STORE_HORIZON_MS;
    const recent = b.events.filter((e) => e.ts >= horizon);
    if (recent.length > 0) this.store.applyMany(recent);
  }

  private dashboardOptions(): DashboardOptions {
    const t = this.tuning;
    return {
      now: Date.now(),
      idleMs: t.idleMs ?? 10 * 60_000,
      windowMs: t.usageWindowMs ?? 5 * 60 * 60_000,
      ...(t.windowTokenLimit != null ? { windowLimit: t.windowTokenLimit } : {}),
      ...(t.weeklyTokenLimit != null ? { weeklyLimit: t.weeklyTokenLimit } : {}),
      ...(t.prices && Object.keys(t.prices).length > 0 ? { prices: t.prices } : {}),
      showPromptPreview: t.promptPreview === true,
    };
  }

  private pushDashboard(): void {
    if (this.paused || this.hidden || !this.opts.onDashboard) return;
    const now = Date.now();
    if (!this.dashDirty && now - this.lastDashAt < DASH_TIMER_MS) return;
    this.dashDirty = false;
    this.lastDashAt = now;
    let dash: DashboardSnapshot;
    try {
      dash = this.getDashboard();
    } catch {
      return;
    }
    // generatedAt always changes: compare everything else.
    const json = JSON.stringify({ ...dash, generatedAt: 0 });
    if (json === this.lastDashJson) return;
    this.lastDashJson = json;
    this.opts.onDashboard(dash);
  }

  private pruneLedger(): void {
    const days = this.tuning.lookbackDays ?? 7;
    this.ledger.prune(Date.now(), days * DAY_MS);
    this.demoLedger.prune(Date.now(), days * DAY_MS);
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
    this.unsubscribe = this.store.subscribe(() => this.markDirty());
    this.seenSessions.clear();
    this.markDirty();
    this.demoLedger = new SessionLedger();
    this.dashDirty = true;
  }

  private ingestHook(raw: unknown, receivedAt: number, live = true): void {
    if (this.currentMode === 'demo-pinned') return;
    const events = normalizeHookPayload(raw, receivedAt, this.normalizeOpts());
    if (events.length === 0) return;
    if (live && events.some((e) => e.kind === 'session_start')) {
      try {
        this.opts.onSessionStart?.();
      } catch {
        // ignore
      }
    }
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
