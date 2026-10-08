// Main-process wiring: ingest server + backfill → normalizer → store → renderer snapshots.
import { randomBytes } from 'node:crypto';
import { hookSessionInfo, normalizeHookPayload } from '@shared/normalizer';
import { StationStore } from '@shared/store';
import type { StationEvent, StationSnapshot } from '@shared/types';
import { backfillRecent, backfillTranscript } from './backfill';
import { removeRuntimeFile, writeRuntimeFile } from './runtimeFile';
import { startIngestServer, type IngestServer } from './server';

export const DEFAULT_PORT = 47821;
const PUSH_INTERVAL_MS = 100;
const TICK_INTERVAL_MS = 5_000;

export interface StationOptions {
  version: string;
  port?: number;
  /** Skip the HTTP server + backfill (demo mode feeds events directly). */
  offline?: boolean;
  onSnapshot: (snap: StationSnapshot) => void;
}

export class Station {
  readonly store = new StationStore();
  private server: IngestServer | null = null;
  private seenSessions = new Set<string>();
  private dirty = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly opts: StationOptions) {
    this.store.subscribe(() => (this.dirty = true));
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  async start(): Promise<void> {
    // Coalesce bursts: at most one snapshot per PUSH_INTERVAL_MS.
    this.timers.push(
      setInterval(() => {
        if (!this.dirty) return;
        this.dirty = false;
        this.opts.onSnapshot(this.store.snapshot());
      }, PUSH_INTERVAL_MS),
      setInterval(() => this.store.tick(Date.now()), TICK_INTERVAL_MS),
    );
    if (this.opts.offline) return;

    const token = randomBytes(24).toString('hex');
    this.server = await startIngestServer({
      port: this.opts.port ?? DEFAULT_PORT,
      token,
      version: this.opts.version,
      onPayload: (raw, receivedAt) => this.ingestHook(raw, receivedAt),
    });
    writeRuntimeFile({
      port: this.server.port,
      token,
      pid: process.pid,
      version: this.opts.version,
    });
    void backfillRecent({ onEvents: (evs) => this.ingest(evs) });
  }

  ingest(evs: StationEvent[]): void {
    this.store.applyMany(evs);
  }

  snapshot(): StationSnapshot {
    return this.store.snapshot();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    removeRuntimeFile();
    await this.server?.close();
    this.server = null;
  }

  private ingestHook(raw: unknown, receivedAt: number): void {
    const info = hookSessionInfo(raw);
    // First sight of a session that started before the app: reconstruct it from its transcript.
    if (info && !this.seenSessions.has(info.sessionId)) {
      this.seenSessions.add(info.sessionId);
      if (info.transcriptPath) {
        void backfillTranscript(info.transcriptPath, { onEvents: (evs) => this.ingest(evs) });
      }
    }
    this.ingest(normalizeHookPayload(raw, receivedAt));
  }
}
