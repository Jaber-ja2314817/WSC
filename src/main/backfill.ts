// Transcript backfill: reconstruct sessions/agents that were running before the app opened.
// Reads ~/.claude/projects/**; parsing itself lives in src/shared/normalizer/transcript.ts.
// Every entry point is total: missing dirs, permission errors and bad files are skipped.
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  firstCwd,
  metaToolUseId,
  normalizeSubagentMeta,
  normalizeTranscriptLine,
  stripAgentPrefix,
  type TranscriptContext,
  HANDBACK_TOOL,
  WORKFLOW_RESULT_TOOL,
} from '@shared/normalizer/transcript';
import { projectIdFor, projectNameFor } from '@shared/projects';
import { ORCHESTRATOR_ID, type StationEvent, type ToolCategory } from '@shared/types';

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** A subagent quiet for this long (with its spawn call answered) counts as finished. */
const DEFAULT_FINISH_GRACE_MS = 60 * 1000;
/** The session's cwd comes from the file's head, even when only its tail is read. */
const HEAD_BYTES = 64 * 1024;
/**
 * Workflow agents never hand back: most end on a StructuredOutput call and the rest on plain
 * text, and nothing else marks the end. A workflow can run dozens of them, so they get a shorter
 * quiet limit than subagents. If one was only in a long model call, its next tool call revives it.
 */
export const WORKFLOW_QUIET_MS = 3 * 60_000;

/** True for the tool call that ends a subagent (or, in a workflow, a workflow agent). */
export function isTerminalTool(name: string | undefined, workflow: boolean): boolean {
  return name === HANDBACK_TOOL || (workflow && name === WORKFLOW_RESULT_TOOL);
}

export interface BackfillOptions {
  now?: number;
  /** Only the last N bytes of each file are read. */
  maxBytesPerFile?: number;
  finishGraceMs?: number;
  toolOverrides?: Record<string, ToolCategory>;
  fullToolDetails?: boolean;
  onEvents: (evs: StationEvent[]) => void;
}

export interface BackfillRecentOptions extends BackfillOptions {
  projectsDir?: string;
  maxAgeMs?: number;
}

export interface BackfillResult {
  sessions: number;
  agents: number;
}

export function claudeProjectsDir(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  return configDir ? join(configDir, 'projects') : join(homedir(), '.claude', 'projects');
}

/** Reads the last `maxBytes` of a file as lines, dropping a partial first line. */
async function readTailLines(path: string, maxBytes: number): Promise<string[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim().length > 0);
  } finally {
    await fh.close();
  }
}

/** Reads the first `maxBytes` of a file as lines; a cut-off last line fails to parse and is skipped. */
async function readHeadLines(path: string, maxBytes: number): Promise<string[]> {
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      return buf.toString('utf8', 0, bytesRead).split('\n');
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

const isAgentFile = (f: string): boolean => f.startsWith('agent-') && f.endsWith('.jsonl');

/**
 * A session's agent transcripts, given its `subagents` folder: direct subagents, plus workflow
 * agents in workflows/<wf>/ (their meta.json sits beside them; journal.jsonl is not a transcript).
 */
export async function agentTranscripts(
  subDir: string,
): Promise<{ path: string; workflow: boolean }[]> {
  const entries = await safeReaddir(subDir);
  const out = entries.filter(isAgentFile).map((f) => ({ path: join(subDir, f), workflow: false }));
  if (!entries.includes('workflows')) return out;
  const root = join(subDir, 'workflows');
  for (const wf of await safeReaddir(root)) {
    for (const f of await safeReaddir(join(root, wf))) {
      if (isAgentFile(f)) out.push({ path: join(root, wf, f), workflow: true });
    }
  }
  return out;
}

async function safeMtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const byTs = (a: StationEvent, b: StationEvent): number => a.ts - b.ts;

/** Backfill one session from its orchestrator transcript path (as given in hook input). */
export async function backfillTranscript(
  transcriptPath: string,
  opts: BackfillOptions,
  cutoff?: number,
): Promise<BackfillResult> {
  try {
    return await backfillSession(transcriptPath, opts, cutoff);
  } catch {
    return { sessions: 0, agents: 0 };
  }
}

/** A subagent silent this long is over, even if its last call never got an answer. */
const LONG_QUIET_MS = 10 * 60_000;

async function backfillSession(
  transcriptPath: string,
  opts: BackfillOptions,
  /** Skip the session if its newest record is older than this (file mtimes can lie). */
  cutoff?: number,
): Promise<BackfillResult> {
  const now = opts.now ?? Date.now();
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
  const grace = opts.finishGraceMs ?? DEFAULT_FINISH_GRACE_MS;
  const sessionId = basename(transcriptPath, '.jsonl');

  const mainMtime = await safeMtime(transcriptPath);
  if (mainMtime === undefined) return { sessions: 0, agents: 0 };
  let lines: string[];
  try {
    lines = await readTailLines(transcriptPath, maxBytes);
  } catch {
    return { sessions: 0, agents: 0 };
  }
  // The head, not the tail: a session stays in the zone it started in, even after a `cd`.
  const cwd = firstCwd(await readHeadLines(transcriptPath, HEAD_BYTES)) ?? firstCwd(lines);
  if (!cwd) return { sessions: 0, agents: 0 };

  const events: StationEvent[] = [];
  const ctx: TranscriptContext = {
    sessionId,
    agentId: ORCHESTRATOR_ID,
    cwd,
    toolNames: new Map(),
    ...(opts.toolOverrides ? { toolOverrides: opts.toolOverrides } : {}),
    ...(opts.fullToolDetails ? { fullToolDetails: true } : {}),
  };
  for (const line of lines) {
    for (const ev of normalizeTranscriptLine(line, ctx)) {
      // Lines from another agent (shouldn't happen in the main file) are attributed as-is.
      events.push(ev);
    }
  }
  const answeredInParent = new Set(
    events.filter((e) => e.kind === 'tool_end' && e.tool?.useId).map((e) => e.tool?.useId),
  );

  const firstTs = events.length > 0 ? Math.min(...events.map((e) => e.ts)) : mainMtime;
  // Unshift so a stable sort keeps session_start ahead of same-timestamp events.
  events.unshift({
    id: `${sessionId}:session:backfill`,
    ts: firstTs,
    source: 'transcript',
    projectId: projectIdFor(cwd),
    projectName: projectNameFor(cwd),
    sessionId,
    agentId: ORCHESTRATOR_ID,
    kind: 'session_start',
  });

  // Subagents: <dir>/<sessionId>/subagents/agent-<id>.jsonl (+ agent-<id>.meta.json), and
  // workflow agents in subagents/workflows/<wf>/.
  const subDir = join(dirname(transcriptPath), sessionId, 'subagents');
  let agents = 0;
  for (const { path, workflow } of await agentTranscripts(subDir)) {
    const agentId = stripAgentPrefix(basename(path, '.jsonl'));
    const mtime = await safeMtime(path);
    if (mtime === undefined) continue;
    let subLines: string[];
    try {
      subLines = await readTailLines(path, maxBytes);
    } catch {
      continue;
    }
    const meta = await readJson(join(dirname(path), `agent-${agentId}.meta.json`));
    const subCtx: TranscriptContext = {
      sessionId,
      agentId,
      // The session's project, even when the subagent ran in a worktree.
      cwd,
      toolNames: new Map(),
      ...(opts.toolOverrides ? { toolOverrides: opts.toolOverrides } : {}),
      ...(opts.fullToolDetails ? { fullToolDetails: true } : {}),
    };
    const subEvents = subLines.flatMap((l) => normalizeTranscriptLine(l, subCtx));
    const spawnTs = subEvents.length > 0 ? Math.min(...subEvents.map((e) => e.ts)) : mtime;
    events.push(
      ...normalizeSubagentMeta(meta, { sessionId, agentId, cwd: cwd, ts: spawnTs }),
      ...subEvents,
    );
    agents++;

    if (isFinished(subEvents, meta, answeredInParent, mtime, now, grace, workflow)) {
      events.push({
        id: `${sessionId}:agent:${agentId}:finish`,
        ts: mtime,
        source: 'transcript',
        projectId: projectIdFor(cwd),
        projectName: projectNameFor(cwd),
        sessionId,
        agentId,
        parentAgentId: ORCHESTRATOR_ID,
        kind: 'agent_finish',
      });
    }
  }

  // Only record-derived events count: session_start/agent_spawn/agent_finish may carry mtimes.
  const SYNTHETIC = new Set(['session_start', 'agent_spawn', 'agent_finish']);
  if (cutoff !== undefined && !events.some((e) => e.ts >= cutoff && !SYNTHETIC.has(e.kind))) {
    return { sessions: 0, agents: 0 };
  }
  opts.onEvents(events.sort(byTs));
  return { sessions: 1, agents };
}

/**
 * Conservative: finished only if the parent answered the spawning tool call, the subagent's
 * last tool call has a result, and the file has been quiet for `grace` ms. Unsure → not finished
 * (the store will mark the agent stale instead).
 */
function isFinished(
  subEvents: StationEvent[],
  meta: unknown,
  answeredInParent: Set<string | undefined>,
  mtime: number,
  now: number,
  grace: number,
  workflow: boolean,
): boolean {
  const starts = subEvents.filter((e) => e.kind === 'tool_start');
  const last = starts[starts.length - 1];
  // Subagents end by calling the hand-back tool (verified live, Claude Code 2.1.294). Only the
  // last call counts: a subagent continued after handing back is working again.
  if (isTerminalTool(last?.tool?.name, workflow)) return true;
  if (now - mtime >= LONG_QUIET_MS) return true;
  const answered =
    !last || subEvents.some((e) => e.kind === 'tool_end' && e.tool?.useId === last.tool?.useId);
  if (workflow && answered && now - mtime >= WORKFLOW_QUIET_MS) return true;
  const spawnUseId = metaToolUseId(meta);
  if (!spawnUseId || !answeredInParent.has(spawnUseId)) return false;
  if (now - mtime < grace) return false;
  return answered;
}

/** Backfill every session touched within `maxAgeMs` across all project folders. */
export async function backfillRecent(opts: BackfillRecentOptions): Promise<BackfillResult> {
  const total: BackfillResult = { sessions: 0, agents: 0 };
  try {
    const root = opts.projectsDir ?? claudeProjectsDir();
    const now = opts.now ?? Date.now();
    const cutoff = now - (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    for (const projectDir of await safeReaddir(root)) {
      const dir = join(root, projectDir);
      for (const file of await safeReaddir(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(dir, file);
        if (!(await isRecent(path, cutoff))) continue;
        const r = await backfillTranscript(path, { ...opts, now }, cutoff);
        total.sessions += r.sessions;
        total.agents += r.agents;
      }
    }
  } catch {
    // never throw
  }
  return total;
}

/** A session is recent if its transcript or any subagent transcript changed after `cutoff`. */
async function isRecent(transcriptPath: string, cutoff: number): Promise<boolean> {
  const mtime = await safeMtime(transcriptPath);
  if (mtime !== undefined && mtime >= cutoff) return true;
  const subDir = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
  for (const { path } of await agentTranscripts(subDir)) {
    const m = await safeMtime(path);
    if (m !== undefined && m >= cutoff) return true;
  }
  return false;
}
