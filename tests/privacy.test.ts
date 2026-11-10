// Privacy: secrets and private details in tool inputs must never reach the snapshot (panels,
// activity log), the director's frame (speech bubbles, crew tool labels) or the Stats view's
// history snapshot. Synthetic data only.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Station } from '../src/main/station';
import { StatsScanner } from '../src/main/statsScan';
import { Director } from '../src/renderer/director/director';
import { makePathfinder } from '../src/shared/astar';
import { computeLayout, layoutInputFor } from '../src/shared/layout';
import { normalizeHookPayload } from '../src/shared/normalizer/hook';
import { normalizeTranscriptLine } from '../src/shared/normalizer/transcript';
import { computeStats } from '../src/shared/stats';
import { STATS_RANGES } from '../src/shared/statsTypes';
import { StationStore } from '../src/shared/store';
import type { StationEvent, StationSnapshot } from '../src/shared/types';
import { CWD_A, SESSION_A, hookPayload, toolPayload } from './fixtures/hookPayloads';

/** Every value here must never appear in any output. */
const SECRETS = {
  bearer: 'eyJhbGciOiJIUzI1NiJ9fakeBearerToken123',
  password: 'hunter2-very-secret',
  openai: 'sk-proj-FAKEFAKEFAKEFAKEFAKE1234567890',
  github: 'ghp_FAKEfakeFAKEfakeFAKEfake1234567890',
  aws: 'AKIAFAKEFAKEFAKE1234',
  urlPass: 's3cr3tpw',
  base64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
  username: 'alice-private',
  prompt: 'my private prompt about the acquisition of FooCorp',
  query: 'token=abc123querysecret',
} as const;

const SUB = { agentId: 'a1b2c3d4e5f6a7b8c', agentType: 'general-purpose' };

/** Payloads that each carry at least one secret. Tool use ids pair starts with ends. */
function payloads(): Record<string, unknown>[] {
  const tools: [string, Record<string, unknown>][] = [
    ['Bash', { command: `curl -H "Authorization: Bearer ${SECRETS.bearer}" localhost` }],
    ['Bash', { command: `mysql --password=${SECRETS.password} -u root` }],
    ['Bash', { command: `OPENAI_API_KEY=${SECRETS.openai} npm start` }],
    ['Bash', { command: `git clone https://x:${SECRETS.github}@github.com/a/b` }],
    ['Bash', { command: `curl -u admin:${SECRETS.password} localhost:3000` }],
    ['Bash', { command: `psql --password ${SECRETS.urlPass} db` }],
    ['Bash', { command: `aws configure set aws_access_key_id ${SECRETS.aws}` }],
    ['Bash', { command: `echo ${SECRETS.base64} | base64 -d` }],
    ['Read', { file_path: `/Users/${SECRETS.username}/secret-project/.env` }],
    ['Edit', { file_path: `/home/${SECRETS.username}/work/auth.ts`, old_string: SECRETS.password }],
    ['Write', { file_path: `/home/${SECRETS.username}/notes.md`, content: SECRETS.openai }],
    ['WebFetch', { url: `https://bob:${SECRETS.urlPass}@docs.example.com/p?${SECRETS.query}` }],
    ['WebSearch', { query: `api_key=${SECRETS.github} leaked` }],
    ['Grep', { pattern: `password=${SECRETS.password}`, path: `/home/${SECRETS.username}` }],
    ['mcp__vault__read_secret', { name: SECRETS.password }],
  ];
  const out: Record<string, unknown>[] = [
    hookPayload('SessionStart', { source: 'startup' }),
    hookPayload('UserPromptSubmit', { prompt: SECRETS.prompt }),
    hookPayload('SubagentStart', {}, SUB),
  ];
  tools.forEach(([name, input], i) => {
    const id = `toolu_priv_${i}`;
    const opts = i % 2 === 0 ? SUB : {};
    out.push(toolPayload('PreToolUse', name, input, id, opts));
    out.push(
      hookPayload(
        'PostToolUse',
        {
          tool_name: name,
          tool_input: input,
          tool_use_id: id,
          tool_response: { stdout: SECRETS.openai },
        },
        opts,
      ),
    );
  });
  out.push(
    toolPayload('PermissionRequest', 'Bash', { command: `export TOKEN=${SECRETS.github}` }, 'p1'),
    hookPayload('Notification', {
      message: `Claude needs permission for ${SECRETS.password}`,
      notification_type: 'permission_prompt',
    }),
    hookPayload('Stop', { last_assistant_message: SECRETS.prompt }),
    hookPayload('SubagentStop', { last_assistant_message: SECRETS.openai }, SUB),
  );
  return out;
}

function expectNoSecrets(label: string, value: unknown): void {
  const json = JSON.stringify(value);
  for (const [name, secret] of Object.entries(SECRETS)) {
    expect(json.includes(secret), `${label} leaked ${name}`).toBe(false);
  }
}

function runThroughStore(events: StationEvent[]): StationSnapshot {
  const store = new StationStore();
  store.applyMany(events);
  return store.snapshot();
}

/** Drive the director through the run and collect every frame it produces. */
function directorFrames(events: StationEvent[]): unknown[] {
  const store = new StationStore();
  const director = new Director({
    findPath: () => null,
    phrases: () => ['On it!'],
    random: () => 0,
    settings: { reduceMotion: true },
  });
  const frames: unknown[] = [];
  let now = 1_000;
  for (const e of events) {
    store.apply({ ...e, ts: now });
    const snap = store.snapshot();
    const layout = computeLayout({ ...layoutInputFor(snap, 6), orchestratorSeats: 1 });
    director.setLayout(layout, makePathfinder(layout));
    director.setSnapshot(snap, now);
    // Several frames per event: bubbles are rate-limited and appear over time.
    for (let i = 0; i < 4; i++) {
      now += 700;
      frames.push(director.update(now, 700));
    }
  }
  return frames;
}

describe('privacy: hook path', () => {
  const events = payloads().flatMap((p, i) => normalizeHookPayload(p, 1_000 + i));

  it('produces events for the run', () => {
    expect(events.length).toBeGreaterThan(20);
  });

  it('normalized events carry no secrets', () => {
    expectNoSecrets('events', events);
  });

  it('the snapshot (panels + activity log) carries no secrets', () => {
    const snap = runThroughStore(events);
    expect(snap.log.length).toBeGreaterThan(10);
    expectNoSecrets('snapshot', snap);
  });

  it('director frames (bubbles + crew labels) carry no secrets', () => {
    const frames = directorFrames(events);
    const bubbles = frames.flatMap((f) => (f as { bubbles: { text: string }[] }).bubbles);
    expect(bubbles.length).toBeGreaterThan(0);
    expectNoSecrets('director', frames);
  });

  it('file summaries are basenames only', () => {
    const summaries = events
      .filter((e) => ['Read', 'Edit', 'Write'].includes(e.tool?.name ?? ''))
      .map((e) => e.tool?.summary);
    expect(new Set(summaries)).toEqual(new Set(['.env', 'auth.ts', 'notes.md']));
  });

  it('WebFetch summaries are the hostname only', () => {
    const s = events.filter((e) => e.tool?.name === 'WebFetch').map((e) => e.tool?.summary);
    expect(new Set(s)).toEqual(new Set(['docs.example.com']));
  });

  it('never stores the user prompt text', () => {
    const prompt = events.find((e) => e.kind === 'user_prompt');
    expect(prompt).toBeDefined();
    expect(JSON.stringify(prompt)).not.toContain('acquisition');
  });
});

describe('privacy: subagent labels', () => {
  const secret = 'abc123def';
  const description = `Deploy with API_KEY=${secret}`;

  it('hook path', () => {
    const payload = toolPayload('PreToolUse', 'Agent', { description });
    const events = normalizeHookPayload(payload, 1_000);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('transcript path', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: SESSION_A,
      cwd: CWD_A,
      uuid: 'u-label',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        id: 'm-label',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't-label', name: 'Agent', input: { description } }],
      },
    });
    const ctx = { sessionId: SESSION_A, agentId: 'orchestrator', cwd: CWD_A, toolNames: new Map() };
    const events = normalizeTranscriptLine(line, ctx);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

describe('privacy: transcript path', () => {
  const line = (rec: Record<string, unknown>): string =>
    JSON.stringify({
      timestamp: '2026-01-01T10:00:00.000Z',
      sessionId: SESSION_A,
      cwd: CWD_A,
      uuid: `u-${Math.random()}`,
      ...rec,
    });
  const ctx = { sessionId: SESSION_A, agentId: 'orchestrator', cwd: CWD_A, toolNames: new Map() };

  it('tool_use / tool_result lines carry no secrets into events or the snapshot', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: SECRETS.prompt } }),
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: SECRETS.openai },
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: {
                command: `curl -u admin:${SECRETS.password} -H "Authorization: Bearer ${SECRETS.bearer}"`,
              },
            },
            {
              type: 'tool_use',
              id: 't2',
              name: 'Read',
              input: { file_path: `/Users/${SECRETS.username}/keys/${'id_rsa'}` },
            },
            {
              type: 'tool_use',
              id: 't3',
              name: 'WebFetch',
              input: { url: `https://u:${SECRETS.urlPass}@x.example.org/?${SECRETS.query}` },
            },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: SECRETS.github },
            { type: 'tool_result', tool_use_id: 't2', content: SECRETS.aws, is_error: true },
          ],
        },
      }),
    ];
    const events = lines.flatMap((l) => normalizeTranscriptLine(l, ctx));
    expect(events.length).toBeGreaterThanOrEqual(5);
    expectNoSecrets('transcript events', events);
    expectNoSecrets('transcript snapshot', runThroughStore(events));
    expect(events.find((e) => e.tool?.name === 'Read')?.tool?.summary).toBe('id_rsa');
    expect(events.find((e) => e.tool?.name === 'WebFetch')?.tool?.summary).toBe('x.example.org');
  });
});

describe('privacy: stats history scan', () => {
  // The user's name sits in the cwd (and so in the projects folder name) on purpose: only the
  // cwd's basename may reach the snapshot.
  const cwd = `/home/${SECRETS.username}/stats-proj`;
  const sid = '00000000-0000-4000-8000-0000000000c1';
  const agent = 'c0ffee00c0ffee001';
  const at = (minutesAgo: number): string =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const rec = (r: Record<string, unknown>, minutesAgo: number): string =>
    JSON.stringify({
      timestamp: at(minutesAgo),
      sessionId: sid,
      cwd,
      uuid: `u-${minutesAgo}`,
      ...r,
    });
  const usage = (output: number) => ({
    input_tokens: 10,
    output_tokens: output,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 7,
  });

  /** A session (and one subagent) whose prompt, text, tool and result lines are full of secrets. */
  function transcripts(): { main: string[]; sub: string[] } {
    const main = [
      rec({ type: 'user', message: { role: 'user', content: SECRETS.prompt } }, 30),
      rec(
        {
          type: 'assistant',
          requestId: 'req_priv_1',
          message: {
            id: 'msg_priv_1',
            role: 'assistant',
            model: 'fake-model-1',
            usage: usage(20),
            content: [
              { type: 'text', text: `${SECRETS.openai} ${SECRETS.prompt}` },
              {
                type: 'tool_use',
                id: 'tp1',
                name: 'Bash',
                input: {
                  command: `curl -u admin:${SECRETS.password} -H "Authorization: Bearer ${SECRETS.bearer}"`,
                },
              },
              {
                type: 'tool_use',
                id: 'tp2',
                name: 'WebFetch',
                input: { url: `https://u:${SECRETS.urlPass}@x.example.org/?${SECRETS.query}` },
              },
            ],
          },
        },
        29,
      ),
      rec(
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tp1', content: SECRETS.github },
              { type: 'tool_result', tool_use_id: 'tp2', content: SECRETS.aws, is_error: true },
            ],
          },
          toolUseResult: { stdout: SECRETS.base64 },
        },
        28,
      ),
      rec(
        {
          type: 'assistant',
          requestId: 'req_priv_2',
          message: {
            id: 'msg_priv_2',
            role: 'assistant',
            model: 'fake-model-1',
            usage: usage(30),
            content: [
              {
                type: 'tool_use',
                id: 'tp3',
                name: 'Write',
                input: { file_path: `/home/${SECRETS.username}/.env`, content: SECRETS.openai },
              },
            ],
          },
        },
        27,
      ),
    ];
    const sub = [
      rec(
        {
          type: 'user',
          agentId: agent,
          isSidechain: true,
          message: { role: 'user', content: `${SECRETS.prompt} ${SECRETS.password}` },
        },
        26,
      ),
      rec(
        {
          type: 'assistant',
          agentId: agent,
          isSidechain: true,
          requestId: 'req_priv_3',
          message: {
            id: 'msg_priv_3',
            role: 'assistant',
            model: 'fake-model-2',
            usage: usage(40),
            content: [
              { type: 'text', text: SECRETS.github },
              {
                type: 'tool_use',
                id: 'tp4',
                name: 'Grep',
                input: {
                  pattern: `password=${SECRETS.password}`,
                  path: `/home/${SECRETS.username}`,
                },
              },
            ],
          },
        },
        25,
      ),
    ];
    return { main, sub };
  }

  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  async function writeHistory(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'wsc-priv-stats-'));
    const projDir = join(root, cwd.replace(/\//g, '-'));
    const subDir = join(projDir, sid, 'subagents');
    await mkdir(subDir, { recursive: true });
    const { main, sub } = transcripts();
    await writeFile(join(projDir, `${sid}.jsonl`), main.map((l) => `${l}\n`).join(''));
    await writeFile(join(subDir, `agent-${agent}.jsonl`), sub.map((l) => `${l}\n`).join(''));
  }

  it('the scanned records and every range of the snapshot carry no secrets', async () => {
    await writeHistory();
    const scanner = new StatsScanner({ root });
    await scanner.refresh();
    scanner.stop();
    const records = scanner.records();
    // The scan really read both files: 3 responses, two models.
    expect(records.length).toBe(3);
    expectNoSecrets('stats records', records);
    const now = Date.now();
    for (const range of STATS_RANGES) {
      const snap = computeStats(records, { now, range });
      expect(snap.messages).toBe(3);
      expect(snap.projects.map((p) => p.projectName)).toEqual(['stats-proj']);
      expectNoSecrets(`stats snapshot (${range})`, snap);
    }
  });

  it('Station.getStats (the IPC answer) carries no secrets', async () => {
    await writeHistory();
    const station = new Station({
      version: 'test',
      offline: true,
      watchTranscripts: true,
      liveWatch: false,
      projectsDir: root,
      onSnapshot: () => undefined,
    });
    try {
      await station.start();
      station.getStats('all');
      await vi.waitFor(() => expect(station.getStats('all').scanning).toBe(false));
      for (const range of STATS_RANGES) {
        const snap = station.getStats(range);
        expect(snap.messages).toBe(3);
        expectNoSecrets(`station stats (${range})`, snap);
      }
    } finally {
      await station.stop();
    }
  });
});
