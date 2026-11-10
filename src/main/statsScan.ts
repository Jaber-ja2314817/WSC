// History scanner for the Stats view: the usage lines of every transcript still on disk,
// whatever its age (the watcher stops at its lookback horizon). Same layout as the watcher:
//   <root>/<proj>/<sessionId>.jsonl                                  orchestrator
//   <root>/<proj>/<sessionId>/subagents/agent-<id>.jsonl             subagent
//   <root>/<proj>/<sessionId>/subagents/workflows/<wf>/agent-<id>.jsonl  workflow agent
// Lines are parsed only by transcriptUsageOnly (src/shared/normalizer/transcript.ts) and land
// in a UsageBook, which dedupes repeats, keeps growing usage and credits a resumed session's
// copied history to the original. Incremental: an unchanged file costs one stat, a grown one is
// read from where the last scan stopped. Reads in bounded chunks and yields to the event loop,
// since this runs in Electron's main process. Nothing is read before the first refresh(),
// nothing is written anywhere, and the records live in memory only.
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsageRecord } from '@shared/dashboardTypes';
import {
  firstCwd,
  transcriptUsageOnly,
  type TranscriptContext,
} from '@shared/normalizer/transcript';
import { UsageBook } from '@shared/usage';
import { agentTranscripts, claudeProjectsDir } from './backfill';
import {
  classifyTranscriptPath,
  safeReaddir,
  safeStat,
  yieldToLoop,
  type FileStat,
} from './transcriptWatcher';

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
/** A line longer than this without a newline is skipped (a runaway or binary file). */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** Unchanged files cost only a stat; yield after this many of them in a row. */
const STATS_PER_YIELD = 64;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
/** Only lines containing these can carry usage, or a cwd. */
const USAGE_NEEDLE = Buffer.from('"usage"');
const CWD_NEEDLE = Buffer.from('"cwd"');

export interface StatsScannerOptions {
  /** Defaults to claudeProjectsDir() (respects CLAUDE_CONFIG_DIR). */
  root?: string;
  /** Bytes per read. Default 1 MiB. Tests use tiny chunks. */
  chunkBytes?: number;
  /** Longest line kept, in bytes (default MAX_LINE_BYTES). Tests use a small one. */
  maxLineBytes?: number;
}

interface FileState {
  path: string;
  kind: 'main' | 'sub';
  sessionId: string;
  ino: number;
  /** Size and mtime when last read to the end: equal on the next stat means unchanged. */
  size: number;
  mtimeMs: number;
  /** Byte after the last complete line read. */
  offset: number;
  ctx: TranscriptContext;
}

export class StatsScanner {
  private readonly root: string;
  private readonly chunkBytes: number;
  private readonly maxLineBytes: number;
  private readonly book = new UsageBook();
  private readonly files = new Map<string, FileState>();
  /** Session id → cwd from its main transcript, so a subagent lands in the session's project. */
  private readonly sessionCwd = new Map<string, string>();
  private running: Promise<void> | null = null;
  private stopped = false;
  private scanningNow = false;
  private versionNow = 0;
  private statsSinceYield = 0;

  constructor(opts: StatsScannerOptions = {}) {
    this.root = opts.root ?? claudeProjectsDir();
    this.chunkBytes = Math.max(1, Math.floor(opts.chunkBytes ?? DEFAULT_CHUNK_BYTES));
    this.maxLineBytes = Math.max(1, Math.floor(opts.maxLineBytes ?? MAX_LINE_BYTES));
  }

  /** True from the start of a scan to its end. */
  get scanning(): boolean {
    return this.scanningNow;
  }

  /** Goes up whenever the records changed. */
  get version(): number {
    return this.versionNow;
  }

  /** Deduped usage records, ascending by ts. Do not mutate. */
  records(): readonly UsageRecord[] {
    return this.book.records();
  }

  /**
   * Scan every transcript on disk, reading only what changed since the last scan. Concurrent
   * calls share one scan. Never throws. After stop(), resolves at once without reading.
   */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.resolve();
    this.scanningNow = true;
    this.running = this.scan()
      .catch(() => undefined)
      .finally(() => {
        this.scanningNow = false;
        this.running = null;
      });
    return this.running;
  }

  /** End a running scan early; later refreshes do nothing. */
  stop(): void {
    this.stopped = true;
  }

  // ── discovery ────────────────────────────────────────────────────────────

  private async scan(): Promise<void> {
    const seen = new Set<string>();
    for (const proj of await safeReaddir(this.root)) {
      if (this.stopped) return;
      const projDir = join(this.root, proj);
      const entries = await safeReaddir(projDir);
      // Main transcripts first: they give each session its cwd (project).
      for (const f of entries) {
        if (this.stopped) return;
        if (!f.endsWith('.jsonl')) continue;
        const path = join(projDir, f);
        seen.add(path);
        await this.visit(path);
      }
      for (const sid of entries) {
        if (this.stopped) return;
        if (sid.includes('.')) continue;
        for (const { path } of await agentTranscripts(join(projDir, sid, 'subagents'))) {
          if (this.stopped) return;
          seen.add(path);
          await this.visit(path);
        }
      }
    }
    // A file that went away: forget where we were, so if it comes back it is read again (the
    // book dedupes). Its records stay: they were real usage.
    for (const path of [...this.files.keys()]) if (!seen.has(path)) this.files.delete(path);
  }

  private async visit(path: string): Promise<void> {
    const st = await safeStat(path);
    if (++this.statsSinceYield >= STATS_PER_YIELD) {
      this.statsSinceYield = 0;
      await yieldToLoop();
    }
    if (!st || st.isDir || this.stopped) return;
    let state = this.files.get(path);
    if (state && st.ino === state.ino && st.size === state.size && st.mtimeMs === state.mtimeMs) {
      return;
    }
    if (!state) {
      const where = classifyTranscriptPath(this.root, path);
      if (!where) return;
      state = this.track(path, where.kind, where.sessionId, where.agentId, st);
    } else if (st.ino !== state.ino || st.size < state.size || st.size < state.offset) {
      // Replaced or shrunk: read it again from the start. The book dedupes.
      state.ino = st.ino;
      state.offset = 0;
    }
    try {
      await this.readFrom(state, st.size);
      state.size = st.size;
      state.mtimeMs = st.mtimeMs;
    } catch {
      // Unreadable: size and mtime stay old, so the next scan tries again from the offset.
    }
    this.statsSinceYield = 0;
    await yieldToLoop();
  }

  private track(
    path: string,
    kind: 'main' | 'sub',
    sessionId: string,
    agentId: string,
    st: FileStat,
  ): FileState {
    const cwd = kind === 'sub' ? this.sessionCwd.get(sessionId) : undefined;
    const state: FileState = {
      path,
      kind,
      sessionId,
      ino: st.ino,
      size: -1,
      mtimeMs: -1,
      offset: 0,
      ctx: {
        sessionId,
        agentId,
        ...(cwd ? { cwd } : {}),
        // A resumed session's file repeats the original's history: the older file keeps the
        // credit (UsageRecord.rank). Without a creation time, the mtime is close enough.
        usageRank: st.birthtimeMs || st.mtimeMs,
      },
    };
    this.files.set(path, state);
    return state;
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /** Read complete lines from `state.offset` up to `size`; a partial last line waits. */
  private async readFrom(state: FileState, size: number): Promise<void> {
    if (state.offset >= size) return;
    const fh = await open(state.path, 'r');
    try {
      let pos = state.offset;
      /** Bytes after the last newline seen, starting at state.offset. */
      let carry: Buffer = EMPTY;
      /** Inside an over-long line: skip to its newline. */
      let skipping = false;
      while (pos < size && !this.stopped) {
        const len = Math.min(this.chunkBytes, size - pos);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const data = buf.subarray(0, bytesRead);
        const lastNl = data.lastIndexOf(NEWLINE);
        if (lastNl < 0) {
          if (!skipping) {
            carry = Buffer.concat([carry, data]);
            if (carry.length > this.maxLineBytes) {
              carry = EMPTY;
              skipping = true;
            }
          }
        } else {
          const firstNl = data.indexOf(NEWLINE);
          const records: UsageRecord[] = [];
          // Splitting on the newline byte never cuts a UTF-8 character (0x0a is never part of
          // a multi-byte sequence), and each line is decoded whole.
          if (!skipping)
            this.parseLine(state, Buffer.concat([carry, data.subarray(0, firstNl)]), records);
          skipping = false;
          this.parseLines(state, data.subarray(firstNl + 1, lastNl), records);
          // Copy: `buf` is dropped, and the carry outlives this iteration.
          carry = Buffer.from(data.subarray(lastNl + 1));
          state.offset = pos - carry.length;
          if (records.length > 0 && this.book.add(records)) this.versionNow++;
        }
        await yieldToLoop();
      }
    } finally {
      await fh.close();
    }
  }

  private parseLines(state: FileState, data: Buffer, out: UsageRecord[]): void {
    let start = 0;
    while (start < data.length) {
      let end = data.indexOf(NEWLINE, start);
      if (end < 0) end = data.length;
      if (end > start) this.parseLine(state, data.subarray(start, end), out);
      start = end + 1;
    }
  }

  private parseLine(state: FileState, line: Buffer, out: UsageRecord[]): void {
    if (line.length === 0) return;
    const hasUsage = line.indexOf(USAGE_NEEDLE) >= 0;
    const needCwd = !state.ctx.cwd && line.indexOf(CWD_NEEDLE) >= 0;
    if (!hasUsage && !needCwd) return;
    const text = line.toString('utf8');
    if (needCwd) this.ensureCwd(state, text);
    if (!hasUsage) return;
    const x = transcriptUsageOnly(text, state.ctx);
    if (x?.usage) out.push(x.usage);
  }

  /** The session's project: a main file's first cwd; a subagent takes its session's. */
  private ensureCwd(state: FileState, line: string): void {
    const session = this.sessionCwd.get(state.sessionId);
    const cwd =
      state.kind === 'sub' ? (session ?? firstCwd([line])) : (firstCwd([line]) ?? session);
    if (!cwd) return;
    state.ctx.cwd = cwd;
    if (state.kind === 'main' && !this.sessionCwd.has(state.sessionId)) {
      this.sessionCwd.set(state.sessionId, cwd);
    }
  }
}
