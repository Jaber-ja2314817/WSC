// Live, incremental transcript watching for the dashboard (token usage, timelines) and for
// subagents whose work only shows up in their transcript.
//   <root>/<proj>/<sessionId>.jsonl                                  orchestrator
//   <root>/<proj>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json) subagent
// Parsing lives in src/shared/normalizer/transcript.ts; this module only finds files, reads
// appended bytes and splits them into lines. Every entry point is total: missing dirs,
// permission errors and bad files are skipped. Nothing read here is written anywhere.
import { watch, type FSWatcher } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { TranscriptExtras } from '@shared/dashboardTypes';
import {
  firstCwd,
  normalizeSubagentMeta,
  normalizeTranscriptLineFull,
  stripAgentPrefix,
  transcriptUsageOnly,
  type TranscriptContext,
} from '@shared/normalizer/transcript';
import { projectIdFor, projectNameFor } from '@shared/projects';
import { ORCHESTRATOR_ID, type StationEvent, type ToolCategory } from '@shared/types';
import { claudeProjectsDir } from './backfill';

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_RESCAN_MS = 10_000;
/** Lines longer than this without a newline are dropped (a runaway or binary file). */
const MAX_REMAINDER_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;
/** Old files take the usage-only path; only lines containing this can carry usage. */
const USAGE_NEEDLE = Buffer.from('"usage"');
const HANDBACK_TOOL = 'SubagentHandback';
/**
 * A subagent quiet this long without a hand-back is over (interrupted, or its hand-back went
 * unrecorded) — the backfill's rule. With a tool call still running, it gets much longer.
 */
const QUIET_FINISH_MS = 10 * 60_000;
const QUIET_FINISH_OPEN_TOOL_MS = 60 * 60_000;

export interface WatcherBatch {
  events: StationEvent[];
  extras: TranscriptExtras[];
  /** True while it comes from the startup scan of existing files. */
  initial: boolean;
}

export interface WatcherParseOptions {
  toolOverrides?: Record<string, ToolCategory>;
  fullToolDetails?: boolean;
  promptPreview?: boolean;
}

export interface TranscriptWatcherOptions {
  /** Defaults to claudeProjectsDir() (respects CLAUDE_CONFIG_DIR). */
  root?: string;
  /** Startup scan reads files modified within this many days. Default 7. */
  lookbackDays?: number;
  /** Files older than this at startup only contribute usage. Default 24 h. */
  fullParseMs?: number;
  chunkBytes?: number;
  /** false: no fs.watch / rescan timer (tests call poll()). Default true. */
  live?: boolean;
  debounceMs?: number;
  rescanMs?: number;
  now?: () => number;
  /** Read on every parse, so settings changes apply to new lines. */
  parseOptions?: () => WatcherParseOptions;
  onBatch(batch: WatcherBatch): void;
  onScanning?(scanning: boolean): void;
}

type FileKind = 'main' | 'sub';

interface FileState {
  path: string;
  kind: FileKind;
  sessionId: string;
  agentId: string;
  offset: number;
  remainder: Buffer;
  ino: number;
  size: number;
  mtimeMs: number;
  ctx: TranscriptContext;
  /** Subagent: agent_spawn emitted. */
  spawned: boolean;
  /** Subagent: agent_finish emitted (hand-back seen, or quiet for long). */
  finished: boolean;
  /** Subagent: tool calls started without a result yet. */
  openUses: Set<string>;
  /** Subagent: parsed agent-<id>.meta.json (loaded before the first spawn). */
  meta?: unknown;
  busy: boolean;
  again: boolean;
}

/** Parsed file location, or null if the path is not a transcript. */
export function classifyTranscriptPath(
  root: string,
  path: string,
): { kind: FileKind; sessionId: string; agentId: string } | null {
  if (!path.endsWith('.jsonl')) return null;
  const rel = path.startsWith(root + sep) ? path.slice(root.length + 1) : null;
  if (!rel) return null;
  const parts = rel.split(sep);
  if (parts.length === 2) {
    const sessionId = basename(parts[1]!, '.jsonl');
    return sessionId ? { kind: 'main', sessionId, agentId: ORCHESTRATOR_ID } : null;
  }
  if (parts.length === 4 && parts[2] === 'subagents' && parts[3]!.startsWith('agent-')) {
    const agentId = stripAgentPrefix(basename(parts[3]!, '.jsonl'));
    return agentId && parts[1] ? { kind: 'sub', sessionId: parts[1], agentId } : null;
  }
  return null;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

interface FileStat {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Creation time; 0 where the file system doesn't record one. */
  birthtimeMs: number;
  isDir: boolean;
}

async function safeStat(path: string): Promise<FileStat | null> {
  try {
    const s = await stat(path);
    return {
      ino: s.ino,
      size: s.size,
      mtimeMs: s.mtimeMs,
      birthtimeMs: s.birthtimeMs > 0 ? s.birthtimeMs : 0,
      isDir: s.isDirectory(),
    };
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

export class TranscriptWatcher {
  private readonly root: string;
  private readonly files = new Map<string, FileState>();
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private scanningNow = false;
  /** Files the startup scan will read (it reads them as history). */
  private readonly scanQueue = new Set<string>();
  /** Changed during the startup scan before the scan got to them: read once it has. */
  private readonly pendingLive = new Set<string>();
  private polling: Promise<void> | null = null;
  /** Session id → cwd, so a subagent file without a cwd line can still be attributed. */
  private readonly sessionCwd = new Map<string, string>();

  constructor(private readonly opts: TranscriptWatcherOptions) {
    this.root = opts.root ?? claudeProjectsDir();
  }

  get scanning(): boolean {
    return this.scanningNow;
  }

  /** Startup scan, then live watching. Resolves when the startup scan is done. */
  async start(): Promise<void> {
    // Watch from the start: appends to files the scan already read show up live at once.
    if (this.opts.live !== false) this.startWatch();
    this.setScanning(true);
    try {
      await this.initialScan();
    } catch {
      // never throw
    }
    this.scanQueue.clear();
    this.setScanning(false);
    await this.flushPending();
    if (this.closed || this.opts.live === false) return;
    this.rescanTimer = setInterval(() => void this.poll(), this.opts.rescanMs ?? DEFAULT_RESCAN_MS);
    this.rescanTimer.unref?.();
  }

  close(): void {
    this.closed = true;
    try {
      this.watcher?.close();
    } catch {
      // ignore
    }
    this.watcher = null;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
  }

  /**
   * Safety rescan: discover new files and read appended bytes of recently modified ones.
   * Also the deterministic entry point for tests.
   */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.rescan()
      .catch(() => undefined)
      .finally(() => (this.polling = null));
    return this.polling;
  }

  /** Read whatever was appended to one file (fs.watch path; also usable from tests). */
  async flush(path: string): Promise<void> {
    if (this.closed) return;
    const known = this.files.get(path);
    // The startup scan hasn't reached this file, or is reading it: read the rest after it.
    if (this.scanningNow && (known ? known.busy : this.scanQueue.has(path))) {
      this.pendingLive.add(path);
      return;
    }
    if (known) {
      await this.readFile(known, 'full', false);
      return;
    }
    const where = classifyTranscriptPath(this.root, path);
    if (!where) return;
    const st = await safeStat(path);
    if (!st || st.isDir) return;
    const state = this.track(path, where, st);
    await this.readFile(state, 'full', false);
  }

  // ── discovery ────────────────────────────────────────────────────────────

  private async listFiles(
    recentSubdirsOnly: number | null,
  ): Promise<{ path: string; mtimeMs: number }[]> {
    const out: { path: string; mtimeMs: number }[] = [];
    for (const proj of await safeReaddir(this.root)) {
      const projDir = join(this.root, proj);
      const entries = await safeReaddir(projDir);
      const jsonl = new Set(entries.filter((e) => e.endsWith('.jsonl')));
      for (const f of jsonl) {
        const p = join(projDir, f);
        const st = await safeStat(p);
        if (st && !st.isDir) out.push({ path: p, mtimeMs: st.mtimeMs });
      }
      for (const sid of entries) {
        if (sid.includes('.')) continue;
        if (recentSubdirsOnly !== null) {
          // Rescans: only look inside sessions whose main transcript changed recently.
          const main = out.find((o) => o.path === join(projDir, `${sid}.jsonl`));
          if (!main || main.mtimeMs < recentSubdirsOnly) continue;
        }
        const subDir = join(projDir, sid, 'subagents');
        for (const f of await safeReaddir(subDir)) {
          if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
          const p = join(subDir, f);
          const st = await safeStat(p);
          if (st && !st.isDir) out.push({ path: p, mtimeMs: st.mtimeMs });
        }
      }
    }
    return out;
  }

  private track(
    path: string,
    where: { kind: FileKind; sessionId: string; agentId: string },
    st: FileStat,
  ): FileState {
    const state: FileState = {
      path,
      kind: where.kind,
      sessionId: where.sessionId,
      agentId: where.agentId,
      offset: 0,
      remainder: Buffer.alloc(0),
      ino: st.ino,
      size: 0,
      mtimeMs: st.mtimeMs,
      ctx: {
        sessionId: where.sessionId,
        agentId: where.agentId,
        toolNames: new Map(),
        // A resumed session's file repeats the original's history: the older file keeps its
        // usage (UsageRecord.rank). No creation time on this file system: the mtime is close.
        usageRank: st.birthtimeMs || st.mtimeMs,
      },
      spawned: false,
      finished: false,
      openUses: new Set(),
      busy: false,
      again: false,
    };
    this.files.set(path, state);
    return state;
  }

  private async initialScan(): Promise<void> {
    const now = this.now();
    const cutoff = now - (this.opts.lookbackDays ?? 7) * DAY_MS;
    const fullCutoff = now - (this.opts.fullParseMs ?? DAY_MS);
    const found = (await this.listFiles(null)).filter((f) => f.mtimeMs >= cutoff);
    // Main transcripts first (they establish each session's cwd), newest first so active
    // sessions show up at once. Read order doesn't decide usage credit (UsageRecord.rank).
    found.sort((a, b) => {
      const ka = classifyTranscriptPath(this.root, a.path)?.kind === 'main' ? 0 : 1;
      const kb = classifyTranscriptPath(this.root, b.path)?.kind === 'main' ? 0 : 1;
      return ka - kb || b.mtimeMs - a.mtimeMs;
    });
    for (const f of found) this.scanQueue.add(f.path);
    for (const f of found) {
      if (this.closed) return;
      const where = classifyTranscriptPath(this.root, f.path);
      if (where) {
        const st = await safeStat(f.path);
        if (st && !st.isDir) {
          const state = this.track(f.path, where, st);
          await this.readFile(state, st.mtimeMs >= fullCutoff ? 'full' : 'usage', true);
        }
      }
      this.scanQueue.delete(f.path);
      await this.flushPending();
    }
    this.finishQuietSubagents(true);
  }

  /** Read files that changed while the startup scan had them queued or open. */
  private async flushPending(): Promise<void> {
    for (const path of [...this.pendingLive]) {
      const known = this.files.get(path);
      if (this.scanningNow && (known ? known.busy : this.scanQueue.has(path))) continue;
      this.pendingLive.delete(path);
      await this.flush(path);
    }
  }

  /** agent_finish for subagents that went quiet without a hand-back. */
  private finishQuietSubagents(initial: boolean): void {
    const now = this.now();
    const events: StationEvent[] = [];
    for (const state of this.files.values()) {
      if (state.kind !== 'sub' || !state.spawned || state.finished || state.busy) continue;
      const quietFor = state.openUses.size > 0 ? QUIET_FINISH_OPEN_TOOL_MS : QUIET_FINISH_MS;
      if (now - state.mtimeMs < quietFor) continue;
      const cwd = state.ctx.cwd ?? this.sessionCwd.get(state.sessionId);
      if (!cwd) continue;
      state.finished = true;
      events.push(this.finishEvent(state, cwd, state.mtimeMs));
    }
    if (events.length === 0) return;
    try {
      this.opts.onBatch({ events, extras: [], initial });
    } catch {
      // never throw
    }
  }

  private finishEvent(state: FileState, cwd: string, ts: number): StationEvent {
    return {
      id: `${state.sessionId}:agent:${state.agentId}:finish`,
      ts,
      source: 'transcript',
      projectId: projectIdFor(cwd),
      projectName: projectNameFor(cwd),
      sessionId: state.sessionId,
      agentId: state.agentId,
      parentAgentId: ORCHESTRATOR_ID,
      kind: 'agent_finish',
    };
  }

  private async rescan(): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    const cutoff = now - (this.opts.lookbackDays ?? 7) * DAY_MS;
    const recent = now - DAY_MS;
    if (!this.watcher && this.opts.live !== false && this.rescanTimer) this.startWatch();
    for (const f of await this.listFiles(recent)) {
      if (this.closed) return;
      const known = this.files.get(f.path);
      if (known) {
        if (f.mtimeMs < recent && f.mtimeMs === known.mtimeMs) continue;
        await this.readFile(known, 'full', false);
      } else {
        if (f.mtimeMs < cutoff) continue;
        await this.flush(f.path);
      }
    }
    this.finishQuietSubagents(false);
  }

  // ── fs.watch ─────────────────────────────────────────────────────────────

  private startWatch(): void {
    try {
      const w = watch(this.root, { recursive: true, persistent: false }, (_type, name) => {
        if (!name) return;
        const rel = name.toString();
        if (!rel.endsWith('.jsonl')) return;
        this.schedule(join(this.root, rel));
      });
      w.on('error', () => {
        try {
          w.close();
        } catch {
          // ignore
        }
        if (this.watcher === w) this.watcher = null; // the rescan re-arms it
      });
      this.watcher = w;
    } catch {
      this.watcher = null; // root missing or recursive watch unsupported: rescans cover it
    }
  }

  private schedule(path: string): void {
    if (this.closed) return;
    const prev = this.debounce.get(path);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.debounce.delete(path);
      void this.flush(path).catch(() => undefined);
    }, this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.debounce.set(path, t);
  }

  // ── reading ──────────────────────────────────────────────────────────────

  private async readFile(
    state: FileState,
    mode: 'full' | 'usage',
    initial: boolean,
  ): Promise<void> {
    if (state.busy) {
      state.again = true;
      return;
    }
    state.busy = true;
    try {
      do {
        state.again = false;
        await this.readAppended(state, mode, initial);
      } while (state.again && !this.closed);
    } catch {
      // unreadable file: try again on the next change
    } finally {
      state.busy = false;
    }
  }

  private async readAppended(
    state: FileState,
    mode: 'full' | 'usage',
    initial: boolean,
  ): Promise<void> {
    const st = await safeStat(state.path);
    if (!st || st.isDir) return;
    state.mtimeMs = st.mtimeMs;
    if (st.ino !== state.ino || st.size < state.offset) {
      // Replaced or truncated: start over. Downstream dedupe makes re-reads harmless.
      state.ino = st.ino;
      state.offset = 0;
      state.remainder = Buffer.alloc(0);
      state.ctx.toolNames = new Map();
    }
    state.size = st.size;
    if (st.size === state.offset) return;
    if (state.kind === 'sub' && !state.spawned && state.meta === undefined) {
      state.meta = await readJson(join(dirname(state.path), `agent-${state.agentId}.meta.json`));
    }

    const chunkBytes = Math.max(1, this.opts.chunkBytes ?? DEFAULT_CHUNK_BYTES);
    const fh = await open(state.path, 'r');
    try {
      while (state.offset < st.size && !this.closed) {
        const len = Math.min(chunkBytes, st.size - state.offset);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, state.offset);
        if (bytesRead <= 0) break;
        state.offset += bytesRead;
        const data =
          state.remainder.length > 0
            ? Buffer.concat([state.remainder, buf.subarray(0, bytesRead)])
            : buf.subarray(0, bytesRead);
        const lastNl = data.lastIndexOf(NEWLINE);
        if (lastNl < 0) {
          state.remainder = data.length > MAX_REMAINDER_BYTES ? Buffer.alloc(0) : Buffer.from(data);
        } else {
          // Copy: `buf` is reused memory and the remainder outlives this iteration.
          state.remainder = Buffer.from(data.subarray(lastNl + 1));
          this.parseLines(state, data.subarray(0, lastNl), mode, initial);
        }
        // Let the main process breathe between chunks (the startup scan reads hundreds of MB).
        if (initial) await yieldToLoop();
      }
    } finally {
      await fh.close();
    }
  }

  private parseLines(
    state: FileState,
    data: Buffer,
    mode: 'full' | 'usage',
    initial: boolean,
  ): void {
    const ctx = state.ctx;
    const po = this.opts.parseOptions?.() ?? {};
    if (po.toolOverrides) ctx.toolOverrides = po.toolOverrides;
    else delete ctx.toolOverrides;
    if (po.fullToolDetails) ctx.fullToolDetails = true;
    else delete ctx.fullToolDetails;
    if (po.promptPreview) ctx.promptPreview = true;
    else delete ctx.promptPreview;

    const events: StationEvent[] = [];
    const extras: TranscriptExtras[] = [];
    let start = 0;
    while (start <= data.length) {
      let end = data.indexOf(NEWLINE, start);
      if (end < 0) end = data.length;
      if (end > start) {
        const lineBuf = data.subarray(start, end);
        if (mode === 'usage') {
          if (lineBuf.indexOf(USAGE_NEEDLE) >= 0) {
            const line = lineBuf.toString('utf8');
            this.ensureCwd(state, line);
            const x = transcriptUsageOnly(line, ctx);
            if (x) extras.push(x);
          }
        } else {
          const line = lineBuf.toString('utf8');
          this.ensureCwd(state, line);
          const r = normalizeTranscriptLineFull(line, ctx);
          if (r.events.length > 0) events.push(...r.events);
          if (r.extras) extras.push(r.extras);
        }
      }
      start = end + 1;
    }
    if (state.kind === 'sub' && events.length > 0) this.addSubagentLifecycle(state, events);
    if (events.length === 0 && extras.length === 0) return;
    events.sort((a, b) => a.ts - b.ts);
    try {
      this.opts.onBatch({ events, extras, initial });
    } catch {
      // a consumer bug must not stop the watcher
    }
  }

  /** Remember the session's cwd from the first line that has one. */
  private ensureCwd(state: FileState, line: string): void {
    if (state.ctx.cwd) return;
    const cwd = firstCwd([line]) ?? this.sessionCwd.get(state.sessionId);
    if (!cwd) return;
    state.ctx.cwd = cwd;
    if (state.kind === 'main' && !this.sessionCwd.has(state.sessionId)) {
      this.sessionCwd.set(state.sessionId, cwd);
    }
  }

  /** agent_spawn on first sight (from meta.json), agent_finish on the hand-back tool call. */
  private addSubagentLifecycle(state: FileState, events: StationEvent[]): void {
    for (const e of events) {
      const useId = e.tool?.useId;
      if (useId === undefined) continue;
      if (e.kind === 'tool_start') state.openUses.add(useId);
      else if (e.kind === 'tool_end') state.openUses.delete(useId);
    }
    const cwd = state.ctx.cwd ?? this.sessionCwd.get(state.sessionId);
    if (!cwd) return;
    if (!state.spawned) {
      state.spawned = true;
      const ts = Math.min(...events.map((e) => e.ts));
      events.unshift(
        ...normalizeSubagentMeta(state.meta, {
          sessionId: state.sessionId,
          agentId: state.agentId,
          cwd,
          ts,
        }),
      );
    }
    if (!state.finished) {
      const handback = events.find(
        (e) => e.kind === 'tool_start' && e.tool?.name === HANDBACK_TOOL,
      );
      if (handback) {
        state.finished = true;
        events.push(this.finishEvent(state, cwd, handback.ts));
      }
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private setScanning(v: boolean): void {
    if (this.scanningNow === v) return;
    this.scanningNow = v;
    try {
      this.opts.onScanning?.(v);
    } catch {
      // ignore
    }
  }

  /** Test/diagnostic helper: number of tracked files. */
  get trackedFiles(): number {
    return this.files.size;
  }
}
