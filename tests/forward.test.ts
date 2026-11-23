import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

function run(
  input: string,
  extraEnv: Record<string, string> = {},
  nodeArgs: string[] = [],
): Promise<RunResult> {
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
    const child = spawn(process.execPath, [...nodeArgs, FORWARD], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
    child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
    child.on('close', (code) => done({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

/** Preload: makes the script think Node took 200 ms to boot, and records when it exits. */
function slowBootPreload(exitFile: string): string {
  const file = join(dir, 'slow-boot.mjs');
  writeFileSync(
    file,
    `import { writeFileSync } from 'node:fs';\n` +
      `while (process.uptime() < 0.2);\n` +
      `process.on('exit', () => writeFileSync(${JSON.stringify(exitFile)}, String(process.uptime())));\n`,
  );
  return `--import=${pathToFileURL(file).href}`;
}

/** Preload: makes the script take its Windows branches on any OS. */
function windowsPreload(): string {
  const file = join(dir, 'windows.mjs');
  writeFileSync(file, `Object.defineProperty(process, 'platform', { value: 'win32' });\n`);
  return `--import=${pathToFileURL(file).href}`;
}

/** A pid that belonged to a process that has already exited. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid;

/** Env that sends every proxied request to `port`, the way a corporate shell profile might. */
const proxyEnv = (port: number): Record<string, string> => ({
  NODE_USE_ENV_PROXY: '1',
  HTTP_PROXY: `http://127.0.0.1:${port}`,
  http_proxy: `http://127.0.0.1:${port}`,
  NO_PROXY: '',
  no_proxy: '',
});

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
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port, token: 't', pid: process.pid, version: '0' }),
    );
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
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port, token: 'secret', pid: process.pid, version: '0' }),
    );
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
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port, token: 't', pid: process.pid, version: '0' }),
    );
    try {
      const r = await run(BODY);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(r.ms).toBeLessThan(300 + STARTUP_SLACK_MS);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('counts Node boot time against the 300 ms budget', async () => {
    const server = createServer(() => {
      /* never respond */
    });
    const port = await listen(server);
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port, token: 't', pid: process.pid, version: '0' }),
    );
    const exitFile = join(dir, 'exit-uptime.txt');
    try {
      const r = await run(BODY, {}, [slowBootPreload(exitFile)]);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      // Timing from the old start-of-script deadline would land at about 0.5 s.
      expect(Number(readFileSync(exitFile, 'utf8'))).toBeLessThan(0.42);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('never sends the token or payload through an env proxy', async () => {
    const viaProxy: string[] = [];
    const proxy = createServer((req, res) => {
      viaProxy.push(`${req.url} ${String(req.headers['x-wsc-token'])}`);
      res.writeHead(204).end();
    });
    const proxyPort = await listen(proxy);
    const got: string[] = [];
    const server = createServer((req, res) => {
      got.push(String(req.url));
      req.resume();
      req.on('end', () => res.writeHead(204).end());
    });
    const port = await listen(server);
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port, token: 'secret', pid: process.pid, version: '0' }),
    );
    try {
      const r = await run(BODY, proxyEnv(proxyPort));
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(viaProxy).toEqual([]);
      expect(got).toEqual(['/v1/events']);
    } finally {
      server.close();
      proxy.close();
    }
  });

  it('reaches the app on a port fetch refuses to use', async () => {
    const got: string[] = [];
    const server = createServer((req, res) => {
      got.push(String(req.url));
      req.resume();
      req.on('end', () => res.writeHead(204).end());
    });
    // 6667 is on the fetch spec's blocked port list. Skip quietly if something already has it.
    const bound = await new Promise<boolean>((r) => {
      server.once('error', () => r(false));
      server.listen(6667, '127.0.0.1', () => r(true));
    });
    if (!bound) return;
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port: 6667, token: 't', pid: process.pid, version: '0' }),
    );
    try {
      expect(await run(BODY)).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(got).toEqual(['/v1/events']);
    } finally {
      server.close();
    }
  });

  it('sends nothing when the runtime file belongs to a dead process', async () => {
    const got: string[] = [];
    const server = createServer((req, res) => {
      got.push(String(req.headers['x-wsc-token']));
      req.resume();
      req.on('end', () => res.writeHead(204).end());
    });
    const port = await listen(server);
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port, token: 'secret', pid: deadPid(), version: '0' }),
    );
    try {
      expect(await run(BODY)).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(got).toEqual([]);
    } finally {
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
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port, token: 't', pid: process.pid, version: '0' }),
    );
    try {
      silent(await run(SESSION_START, launchEnv));
      await notLaunched();
    } finally {
      server.close();
    }
  });

  it.each(['startup', 'resume', undefined])('launches for source %s', async (source) => {
    const body = JSON.stringify({ ...(JSON.parse(SESSION_START) as object), source });
    silent(await run(body, launchEnv));
    expect((await launchedArgs())[0]).toBe('--from-hook');
  });

  it.each(['compact', 'clear'])('does not launch for source %s', async (source) => {
    const body = JSON.stringify({ ...(JSON.parse(SESSION_START) as object), source });
    silent(await run(body, launchEnv));
    await notLaunched();
  });

  it.each([401, 403, 404])('launches when a foreign server on the port says %i', async (status) => {
    const server = createServer((_req, res) => res.writeHead(status).end());
    const port = await listen(server);
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port, token: 't', pid: process.pid, version: '0' }),
    );
    try {
      silent(await run(SESSION_START, launchEnv));
      expect((await launchedArgs())[0]).toBe('--from-hook');
    } finally {
      server.close();
    }
  });

  it('launches when the recorded process is dead, even if its port now answers', async () => {
    const server = createServer((_req, res) => res.writeHead(204).end());
    const port = await listen(server);
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: deadPid(), version: '0' }));
    try {
      silent(await run(SESSION_START, launchEnv));
      expect((await launchedArgs())[0]).toBe('--from-hook');
    } finally {
      server.close();
    }
  });

  it('does not launch when the app answers with a server error', async () => {
    const server = createServer((_req, res) => res.writeHead(500).end());
    const port = await listen(server);
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port, token: 't', pid: process.pid, version: '0' }),
    );
    try {
      silent(await run(SESSION_START, launchEnv));
      await notLaunched();
    } finally {
      server.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'quotes a .cmd launch command in a folder with spaces on Windows',
    async () => {
      const spaced = join(dir, 'First Last');
      mkdirSync(spaced);
      const electron = join(spaced, 'electron.cmd');
      writeFileSync(electron, '');
      writeFileSync(
        join(dir, 'launch.json'),
        JSON.stringify({ version: '0', command: electron, args: [join(spaced, 'repo')] }),
      );
      const fakeShell = join(dir, 'fake-cmd');
      writeFileSync(fakeShell, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\n`);
      chmodSync(fakeShell, 0o755);
      silent(await run(SESSION_START, { ...launchEnv, comspec: fakeShell }, [windowsPreload()]));
      await expect.poll(() => existsSync(record), { timeout: 3_000 }).toBe(true);
      expect(readFileSync(record, 'utf8')).toContain(`"${electron}" "${join(spaced, 'repo')}" `);
    },
  );

  it('logs the failure even when the app folder does not exist yet', async () => {
    const fresh = join(dir, 'never-started', 'runtime.json');
    silent(await run(SESSION_START, { ...launchEnv, WSC_RUNTIME_FILE: fresh }));
    const log = readFileSync(join(dir, 'never-started', 'hook-errors.log'), 'utf8');
    expect(log).toContain('autolaunch: app not found');
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
