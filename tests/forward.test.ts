import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const FORWARD = resolve('plugin/hooks/forward.mjs');
const BODY = JSON.stringify({
  hook_event_name: 'PreToolUse',
  session_id: 'sess-1',
  cwd: '/home/user/demo',
  tool_name: 'Read',
});

let dir: string;
let runtimeFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsc-fwd-'));
  runtimeFile = join(dir, 'runtime.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(input: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((done) => {
    const started = Date.now();
    const env: Record<string, string | undefined> = {
      ...process.env,
      WSC_RUNTIME_FILE: runtimeFile,
      // Never let the launcher fallback find a real install or this checkout.
      WSC_APP_PATH: join(dir, 'no-such-app'),
      WSC_AUTOLAUNCH: '0',
      ...extraEnv,
    };
    const child = spawn(process.execPath, [FORWARD], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
    child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
    child.on('close', (code) => done({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)),
  );
}

// Node startup itself takes time; the budget is for our own waiting on top of it.
const STARTUP_SLACK_MS = 400;

describe('forward.mjs', () => {
  it('exits 0 silently when no runtime file exists', async () => {
    const r = await run(BODY);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeLessThan(300 + STARTUP_SLACK_MS);
  });

  it('exits 0 silently with an invalid runtime file', async () => {
    writeFileSync(runtimeFile, 'not json');
    const r = await run(BODY);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('exits 0 silently when the app is not listening', async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: 1, version: '0' }));
    const r = await run(BODY);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeLessThan(300 + STARTUP_SLACK_MS);
  });

  it('forwards the exact body with the token', async () => {
    const got: { body: string; token: unknown; path?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += String(d)));
      req.on('end', () => {
        got.push({ body, token: req.headers['x-wsc-token'], path: req.url });
        res.writeHead(204).end();
      });
    });
    const port = await listen(server);
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 'secret', pid: 1, version: '0' }));
    try {
      const r = await run(BODY);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(got).toEqual([{ body: BODY, token: 'secret', path: '/v1/events' }]);
    } finally {
      server.close();
    }
  });

  it('gives up on a server that never responds', async () => {
    const server = createServer(() => {
      /* never respond */
    });
    const port = await listen(server);
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: 1, version: '0' }));
    try {
      const r = await run(BODY);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(r.ms).toBeLessThan(300 + STARTUP_SLACK_MS);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

// ── auto-launch on SessionStart ──────────────────────────────────────────────────────────────
const SESSION_START = JSON.stringify({
  hook_event_name: 'SessionStart',
  session_id: 'sess-launch-1',
  cwd: '/home/user/demo',
  source: 'startup',
});

describe('forward.mjs auto-launch', () => {
  let record: string;
  const launchEnv = { WSC_AUTOLAUNCH: '' };

  beforeEach(() => {
    record = join(dir, 'launched.json');
    // A tiny fake app: records its argv and exits.
    const fakeApp = join(dir, 'fake-app.mjs');
    writeFileSync(
      fakeApp,
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n`,
    );
    writeFileSync(
      join(dir, 'launch.json'),
      JSON.stringify({ version: '0.0.0-test', command: process.execPath, args: [fakeApp, record] }),
    );
  });

  const launchedArgs = async (): Promise<string[]> => {
    await expect.poll(() => existsSync(record), { timeout: 3_000 }).toBe(true);
    return JSON.parse(readFileSync(record, 'utf8')) as string[];
  };
  /** Negative check: give a (wrongly) spawned fake app time to write its record. */
  const notLaunched = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(record)).toBe(false);
  };
  const silent = (r: RunResult): void => {
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeLessThan(1_000);
  };

  it('launches on SessionStart when no runtime file exists, with the payload', async () => {
    const r = await run(SESSION_START, launchEnv);
    silent(r);
    const args = await launchedArgs();
    expect(args[0]).toBe('--from-hook');
    const payload = args.find((a) => a.startsWith('--hook-payload='));
    expect(payload).toBeDefined();
    const decoded = Buffer.from(payload!.slice('--hook-payload='.length), 'base64url').toString();
    expect(decoded).toBe(SESSION_START);
    const marker = JSON.parse(readFileSync(join(dir, 'launching.json'), 'utf8')) as {
      ts: number;
      pid: number;
    };
    expect(Date.now() - marker.ts).toBeLessThan(5_000);
    expect(Number.isInteger(marker.pid)).toBe(true);
  });

  it('omits the payload when it is larger than 16 KB', async () => {
    const big = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'sess-big',
      cwd: '/home/user/demo',
      pad: 'x'.repeat(17 * 1024),
    });
    silent(await run(big, launchEnv));
    expect(await launchedArgs()).toEqual(['--from-hook']);
  });

  it.each(['PreToolUse', 'UserPromptSubmit', 'SessionEnd', 'Stop'])(
    'does not launch for %s',
    async (event) => {
      silent(await run(JSON.stringify({ hook_event_name: event, session_id: 's' }), launchEnv));
      await notLaunched();
    },
  );

  it('does not launch for malformed input', async () => {
    silent(await run('{"hook_event_name": "SessionStart"', launchEnv));
    await notLaunched();
  });

  it('does not launch when WSC_AUTOLAUNCH=0', async () => {
    silent(await run(SESSION_START, { WSC_AUTOLAUNCH: '0' }));
    await notLaunched();
  });

  it('does not launch when launchOnSessionStart is false', async () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ launchOnSessionStart: false }));
    silent(await run(SESSION_START, launchEnv));
    await notLaunched();
  });

  it('launches when settings.json lacks the field or is broken', async () => {
    writeFileSync(join(dir, 'settings.json'), '{ broken');
    silent(await run(SESSION_START, launchEnv));
    expect((await launchedArgs())[0]).toBe('--from-hook');
  });

  it('respects a fresh launch marker', async () => {
    writeFileSync(join(dir, 'launching.json'), JSON.stringify({ ts: Date.now(), pid: 1 }));
    silent(await run(SESSION_START, launchEnv));
    await notLaunched();
  });

  it('ignores a stale launch marker and replaces it', async () => {
    const old = Date.now() - 60_000;
    writeFileSync(join(dir, 'launching.json'), JSON.stringify({ ts: old, pid: 1 }));
    silent(await run(SESSION_START, launchEnv));
    expect((await launchedArgs())[0]).toBe('--from-hook');
    const marker = JSON.parse(readFileSync(join(dir, 'launching.json'), 'utf8')) as { ts: number };
    expect(marker.ts).toBeGreaterThan(old);
  });

  it('launches when runtime.json points at a dead port', async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: 999999, version: '0' }));
    silent(await run(SESSION_START, launchEnv));
    expect((await launchedArgs())[0]).toBe('--from-hook');
  });

  it('does not launch when the app is running', async () => {
    const server = createServer((_req, res) => res.writeHead(204).end());
    const port = await listen(server);
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: 1, version: '0' }));
    try {
      silent(await run(SESSION_START, launchEnv));
      await notLaunched();
    } finally {
      server.close();
    }
  });

  it('logs a short line without payload content when the app cannot be found', async () => {
    rmSync(join(dir, 'launch.json'));
    silent(await run(SESSION_START, launchEnv));
    const log = readFileSync(join(dir, 'hook-errors.log'), 'utf8');
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2}T[^ ]+ autolaunch: app not found/);
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).not.toContain('sess-launch-1');
    expect(log).not.toContain('/home/user/demo');
  });

  it('caps hook-errors.log at 64 KB', async () => {
    rmSync(join(dir, 'launch.json'));
    const logFile = join(dir, 'hook-errors.log');
    writeFileSync(logFile, 'old line\n'.repeat(8_000)); // ~72 KB
    silent(await run(SESSION_START, launchEnv));
    expect(statSync(logFile).size).toBeLessThanOrEqual(64 * 1024);
    expect(readFileSync(logFile, 'utf8')).toMatch(/autolaunch: app not found[^\n]*\n$/);
  });

  it('ignores a launch.json whose command does not exist', async () => {
    writeFileSync(
      join(dir, 'launch.json'),
      JSON.stringify({ version: '0', command: join(dir, 'gone'), args: [] }),
    );
    silent(await run(SESSION_START, launchEnv));
    expect(readFileSync(join(dir, 'hook-errors.log'), 'utf8')).toContain('app not found');
  });
});
