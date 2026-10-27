import { cp, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillRecent, backfillTranscript, claudeProjectsDir } from '../src/main/backfill';
import { projectIdFor } from '../src/shared/projects';
import type { StationEvent } from '../src/shared/types';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'transcripts');
// Just after the fixture records (10:00–10:09), like a real recently active session.
const NOW = Date.parse('2026-01-01T10:15:00.000Z');
const MIN = 60 * 1000;
const SA = '11111111-1111-4111-8111-111111111111';
const SB = '22222222-2222-4222-8222-222222222222';
const DIR_A = '-home-user-proj-a';

let root: string;

/** Sets the mtime of every file under `dir` (recursively). */
async function touchAll(dir: string, ms: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await touchAll(p, ms);
    else await utimes(p, ms / 1000, ms / 1000);
  }
}

const touch = (p: string, ms: number): Promise<void> => utimes(p, ms / 1000, ms / 1000);
const subFile = (id: string): string => join(root, DIR_A, SA, 'subagents', `agent-${id}.jsonl`);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wsc-backfill-'));
  await cp(FIXTURES, root, { recursive: true });
  await touchAll(root, NOW - 5 * MIN);
  await touchAll(join(root, '-home-user-proj-old'), NOW - 120 * MIN);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function collect(): Promise<{
  events: StationEvent[];
  result: { sessions: number; agents: number };
}> {
  const events: StationEvent[] = [];
  const result = await backfillRecent({
    projectsDir: root,
    now: NOW,
    onEvents: (e) => events.push(...e),
  });
  return { events, result };
}

describe('backfillRecent', () => {
  it('reconstructs recent sessions across two projects and skips old ones', async () => {
    const { events, result } = await collect();
    expect(result).toEqual({ sessions: 2, agents: 2 });
    const projects = new Set(events.map((e) => e.projectName));
    expect(projects).toEqual(new Set(['proj-a', 'proj-b']));
    expect(events.every((e) => e.source === 'transcript')).toBe(true);
    expect(
      events
        .filter((e) => e.kind === 'session_start')
        .map((e) => e.id)
        .sort(),
    ).toEqual([`${SA}:session:backfill`, `${SB}:session:backfill`].sort());
  });

  it('attributes orchestrator and subagent events with hook-compatible ids', async () => {
    const { events } = await collect();
    const a = events.filter((e) => e.sessionId === SA);
    expect(a.find((e) => e.id === `${SA}:tool:toolu_read_a1:end`)?.tool).toMatchObject({
      name: 'Read',
      ok: true,
    });
    expect(a.find((e) => e.id === `${SA}:tool:toolu_task_a1:start`)).toMatchObject({
      agentId: 'orchestrator',
      label: 'researcher',
      tool: { category: 'delegate' },
    });
    expect(a.find((e) => e.id === `${SA}:agent:aaaa1111:spawn`)).toMatchObject({
      agentId: 'aaaa1111',
      label: 'researcher',
      projectId: projectIdFor('/home/user/proj-a'),
    });
    expect(a.find((e) => e.id === `${SA}:agent:bbbb2222:spawn`)?.label).toBe('Write tests');
    expect(a.find((e) => e.id === `${SA}:tool:toolu_grep_s1:start`)).toMatchObject({
      agentId: 'aaaa1111',
      tool: { category: 'search' },
    });
    expect(a.some((e) => e.kind === 'compacting')).toBe(true);
    const b = events.filter((e) => e.sessionId === SB);
    expect(b.find((e) => e.kind === 'tool_end')?.tool).toMatchObject({ name: 'Bash', ok: false });
  });

  it('emits events sorted by timestamp per session', async () => {
    const { events } = await collect();
    const a = events.filter((e) => e.sessionId === SA).map((e) => e.ts);
    expect(a).toEqual([...a].sort((x, y) => x - y));
  });

  it('marks a quiet subagent whose spawn call was answered as finished', async () => {
    const { events } = await collect();
    const finish = events.find((e) => e.id === `${SA}:agent:aaaa1111:finish`);
    expect(finish).toMatchObject({ kind: 'agent_finish', agentId: 'aaaa1111' });
    expect(finish?.ts).toBe((await stat(subFile('aaaa1111'))).mtimeMs);
  });

  it('does not finish a subagent whose spawn call is unanswered', async () => {
    const { events } = await collect();
    expect(events.some((e) => e.id === `${SA}:agent:bbbb2222:finish`)).toBe(false);
  });

  it('does not finish a subagent that wrote recently', async () => {
    await touch(subFile('aaaa1111'), NOW - 10 * 1000);
    const { events } = await collect();
    expect(events.some((e) => e.kind === 'agent_finish')).toBe(false);
  });

  it('treats a session as recent when only a subagent file changed', async () => {
    await touchAll(join(root, DIR_A), NOW - 120 * MIN);
    await touch(subFile('bbbb2222'), NOW - MIN);
    const { result } = await collect();
    expect(result.sessions).toBe(2);
  });

  it('respects maxAgeMs', async () => {
    const events: StationEvent[] = [];
    const r = await backfillRecent({
      projectsDir: root,
      now: NOW,
      maxAgeMs: 3 * 60 * 60 * 1000,
      onEvents: (e) => events.push(...e),
    });
    expect(r.sessions).toBe(3);
    expect(events.some((e) => e.projectName === 'proj-old')).toBe(true);
  });

  it('returns zeros for a missing directory without throwing', async () => {
    const r = await backfillRecent({
      projectsDir: join(root, 'nope'),
      now: NOW,
      onEvents: () => undefined,
    });
    expect(r).toEqual({ sessions: 0, agents: 0 });
  });
});

describe('backfillTranscript', () => {
  it('backfills one session from its transcript path', async () => {
    const events: StationEvent[] = [];
    const r = await backfillTranscript(join(root, '-home-user-proj-b', `${SB}.jsonl`), {
      now: NOW,
      onEvents: (e) => events.push(...e),
    });
    expect(r).toEqual({ sessions: 1, agents: 0 });
    // The fixture's typed prompt also yields a user_prompt (never its text).
    expect(events.map((e) => e.kind)).toEqual([
      'session_start',
      'user_prompt',
      'tool_start',
      'tool_end',
    ]);
  });

  it('handles a missing transcript', async () => {
    const r = await backfillTranscript(join(root, 'missing.jsonl'), { onEvents: () => undefined });
    expect(r).toEqual({ sessions: 0, agents: 0 });
  });

  it('reads only the tail when maxBytesPerFile is small, dropping the partial first line', async () => {
    const events: StationEvent[] = [];
    await backfillTranscript(join(root, DIR_A, `${SA}.jsonl`), {
      now: NOW,
      maxBytesPerFile: 400,
      onEvents: (e) => events.push(...e),
    });
    // Tail holds only the last records; no throw on the cut line.
    expect(events.every((e) => e.sessionId === SA)).toBe(true);
  });
});

describe('claudeProjectsDir', () => {
  it('honours CLAUDE_CONFIG_DIR', () => {
    const prev = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = '/home/user/.cfg';
    expect(claudeProjectsDir()).toBe(join('/home/user/.cfg', 'projects'));
    delete process.env['CLAUDE_CONFIG_DIR'];
    expect(claudeProjectsDir().endsWith(join('.claude', 'projects'))).toBe(true);
    if (prev !== undefined) process.env['CLAUDE_CONFIG_DIR'] = prev;
  });
});

describe('backfill against real-world quirks', () => {
  it('skips a session whose file was touched recently but whose records are old', async () => {
    const events: StationEvent[] = [];
    // Records in the fixture are from ~11:50; pretend "now" is a day later with fresh mtimes.
    const later = NOW + 24 * 60 * MIN;
    await touchAll(root, later - MIN);
    const result = await backfillRecent({
      projectsDir: root,
      now: later,
      onEvents: (e) => events.push(...e),
    });
    expect(result.sessions).toBe(0);
    expect(events).toEqual([]);
  });

  it('finishes a subagent that has been silent for over 10 minutes', async () => {
    await touch(subFile('bbbb2222'), NOW - 11 * MIN);
    const { events } = await collect();
    expect(events.some((e) => e.id.endsWith(':agent:bbbb2222:finish'))).toBe(true);
  });
});
