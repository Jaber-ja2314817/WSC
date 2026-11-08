import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const STATUSLINE = resolve('plugin/statusline/statusline.mjs');
const RATE_LIMITS = {
  five_hour: { used_percentage: 23.5, resets_at: 1_900_000_000 },
  seven_day: { used_percentage: 41.2, resets_at: 1_900_400_000 },
};
/** Synthetic status line input, with fields that must never leave this machine's status line. */
const INPUT = JSON.stringify({
  hook_event_name: 'Status',
  session_id: 'sess-1',
  transcript_path: '/home/user/.claude/projects/demo/sess-1.jsonl',
  cwd: '/home/user/demo',
  model: { id: 'model-x', display_name: 'Model X' },
  workspace: { current_dir: '/home/user/demo', project_dir: '/home/user/demo' },
  cost: { total_cost_usd: 0.01 },
  rate_limits: RATE_LIMITS,
});

let dir: string;
let runtimeFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsc-sl-'));
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
  args: string[] = [],
  extraEnv: Record<string, string> = {},
  nodeArgs: string[] = [],
): Promise<RunResult> {
  return new Promise((done) => {
    const started = Date.now();
    const env = { ...process.env, WSC_RUNTIME_FILE: runtimeFile, ...extraEnv };
    const child = spawn(process.execPath, [...nodeArgs, STATUSLINE, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
    child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
    child.on('close', (code) => done({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
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

interface Got {
  body: string;
  token: unknown;
  path?: string;
  method?: string;
  type?: string;
}

/** A local WSC stand-in that records what it receives. */
async function recorder(): Promise<{ server: Server; got: Got[] }> {
  const got: Got[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += String(d)));
    req.on('end', () => {
      got.push({
        body,
        token: req.headers['x-wsc-token'],
        path: req.url,
        method: req.method,
        type: req.headers['content-type'],
      });
      res.writeHead(204).end();
    });
  });
  const port = await listen(server);
  writeFileSync(runtimeFile, JSON.stringify({ port, token: 'secret', pid: 1, version: '0' }));
  return { server, got };
}

/** `--then` argument for a command that runs a tiny node script echoing what it gets. */
function thenEcho(script: string): string[] {
  const file = join(dir, 'echo.mjs');
  writeFileSync(file, script);
  const cmd = `"${process.execPath}" "${file}"`;
  return ['--then', Buffer.from(cmd, 'utf8').toString('base64url')];
}

const ECHO_STDIN = `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);process.stdout.write('[' + j.model.display_name + '] ' + s.length);process.stderr.write('noise');});`;

// Node startup itself takes time; the budget is for our own waiting on top of it.
const STARTUP_SLACK_MS = 400;

describe('statusline.mjs', () => {
  it('posts only session_id and rate_limits, with the token, and prints nothing', async () => {
    const { server, got } = await recorder();
    try {
      const r = await run(INPUT);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({
        path: '/v1/limits',
        method: 'POST',
        token: 'secret',
        type: 'application/json',
      });
      expect(JSON.parse(got[0]!.body)).toEqual({ session_id: 'sess-1', rate_limits: RATE_LIMITS });
      expect(got[0]!.body).not.toContain('/home/user');
    } finally {
      server.close();
    }
  });

  it('omits a missing session_id and passes partial windows through', async () => {
    const { server, got } = await recorder();
    try {
      const limits = { five_hour: { used_percentage: 5, resets_at: 1_900_000_000 } };
      const r = await run(JSON.stringify({ rate_limits: limits, cwd: '/home/user/demo' }));
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(JSON.parse(got[0]!.body)).toEqual({ rate_limits: limits });
    } finally {
      server.close();
    }
  });

  it.each([
    ['no rate_limits', JSON.stringify({ session_id: 'sess-1', cwd: '/home/user/demo' })],
    ['rate_limits not an object', JSON.stringify({ session_id: 'sess-1', rate_limits: 'x' })],
    ['garbage', 'not json {'],
    ['empty input', ''],
  ])('does not post with %s', async (_label, input) => {
    const { server, got } = await recorder();
    try {
      const r = await run(input);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(got).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('exits 0 silently when no runtime file exists', async () => {
    const r = await run(INPUT);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeLessThan(300 + STARTUP_SLACK_MS);
  });

  it('exits 0 silently when the app is not listening', async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: 1, version: '0' }));
    const r = await run(INPUT);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeLessThan(300 + STARTUP_SLACK_MS);
  });

  it('gives up on a server that never responds', async () => {
    const server = createServer(() => {
      /* never respond */
    });
    const port = await listen(server);
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: 1, version: '0' }));
    try {
      const r = await run(INPUT);
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
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: 1, version: '0' }));
    const exitFile = join(dir, 'exit-uptime.txt');
    try {
      const r = await run(INPUT, [], {}, [slowBootPreload(exitFile)]);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      // Timing from the old start-of-script deadline would land at about 0.5 s.
      expect(Number(readFileSync(exitFile, 'utf8'))).toBeLessThan(0.42);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('never sends the token or limits through an env proxy', async () => {
    const viaProxy: string[] = [];
    const proxy = createServer((req, res) => {
      viaProxy.push(String(req.url));
      res.writeHead(204).end();
    });
    const proxyPort = await listen(proxy);
    const { server, got } = await recorder();
    try {
      const r = await run(INPUT, [], proxyEnv(proxyPort));
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(viaProxy).toEqual([]);
      expect(got).toHaveLength(1);
    } finally {
      server.close();
      proxy.close();
    }
  });

  it('sends nothing when the runtime file belongs to a dead process', async () => {
    const { server, got } = await recorder();
    const { port } = JSON.parse(readFileSync(runtimeFile, 'utf8')) as { port: number };
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port, token: 'secret', pid: deadPid(), version: '0' }),
    );
    try {
      expect(await run(INPUT)).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(got).toEqual([]);
    } finally {
      server.close();
    }
  });

  it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    'exits 0 on %s while stdin is still open',
    async (signal) => {
      const child = spawn(process.execPath, [STATUSLINE], {
        env: { ...process.env, WSC_RUNTIME_FILE: runtimeFile },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      // Signal handlers are installed at the top of the script; let it get there.
      await new Promise((r) => setTimeout(r, 120));
      const exit = new Promise<[number | null, string | null]>((r) =>
        child.on('close', (code, sig) => r([code, sig])),
      );
      child.kill(signal);
      expect(await exit).toEqual([0, null]);
    },
  );

  describe('--then', () => {
    it('runs the original command with the same stdin and prints only its stdout', async () => {
      const { server, got } = await recorder();
      try {
        const r = await run(INPUT, thenEcho(ECHO_STDIN));
        expect(r).toMatchObject({ code: 0, stderr: '' });
        expect(r.stdout).toBe(`[Model X] ${INPUT.length}`);
        expect(JSON.parse(got[0]!.body)).toEqual({
          session_id: 'sess-1',
          rate_limits: RATE_LIMITS,
        });
      } finally {
        server.close();
      }
    });

    it('still prints the status line while WSC hangs', async () => {
      const server = createServer(() => {
        /* never respond */
      });
      const port = await listen(server);
      writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: 1, version: '0' }));
      try {
        const r = await run(INPUT, thenEcho(ECHO_STDIN));
        expect(r).toMatchObject({ code: 0, stderr: '', stdout: `[Model X] ${INPUT.length}` });
        expect(r.ms).toBeLessThan(300 + STARTUP_SLACK_MS * 2);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });

    it('works without WSC running and with input that has no rate_limits', async () => {
      const input = JSON.stringify({ model: { display_name: 'Model X' } });
      const r = await run(input, thenEcho(ECHO_STDIN));
      expect(r).toMatchObject({ code: 0, stderr: '', stdout: `[Model X] ${input.length}` });
    });

    it('prints nothing when the original command fails to start or is not valid base64url', async () => {
      const missing = Buffer.from(`"${join(dir, 'no-such-binary')}"`).toString('base64url');
      for (const args of [['--then', missing], ['--then', '***'], ['--then']]) {
        const r = await run(INPUT, args);
        expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      }
    });

    it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
      'stops the original command when the bridge gets %s',
      async (signal) => {
        const pidFile = join(dir, 'child.pid');
        const [, then] = thenEcho(
          `import { writeFileSync } from 'node:fs';` +
            `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
            `setInterval(() => {}, 1000);`,
        );
        const child = spawn(process.execPath, [STATUSLINE, '--then', then!], {
          env: { ...process.env, WSC_RUNTIME_FILE: runtimeFile },
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        const exit = new Promise<[number | null, string | null]>((r) =>
          child.on('close', (code, sig) => r([code, sig])),
        );
        child.stdin.end(INPUT);
        await expect.poll(() => existsSync(pidFile), { timeout: 2_500 }).toBe(true);
        await expect.poll(() => readFileSync(pidFile, 'utf8'), { timeout: 500 }).not.toBe('');
        const pid = Number(readFileSync(pidFile, 'utf8'));
        const alive = (): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        child.kill(signal);
        try {
          expect(await exit).toEqual([0, null]);
          await expect.poll(alive, { timeout: 2_000 }).toBe(false);
        } finally {
          if (alive()) process.kill(pid, 'SIGKILL');
        }
      },
      10_000,
    );

    it.skipIf(process.platform === 'win32')(
      'runs the original command in Git Bash on Windows, not cmd.exe',
      async () => {
        const fakeBash = join(dir, 'fake-bash');
        writeFileSync(fakeBash, `#!/bin/sh\nprintf 'via-bash:'\nexec /bin/sh "$@"\n`);
        chmodSync(fakeBash, 0o755);
        const then = Buffer.from('echo hi', 'utf8').toString('base64url');
        const r = await run(
          INPUT,
          ['--then', then],
          { CLAUDE_CODE_GIT_BASH_PATH: fakeBash, comspec: join(dir, 'no-such-cmd') },
          [windowsPreload()],
        );
        expect(r).toMatchObject({ code: 0, stdout: 'via-bash:hi\n', stderr: '' });
      },
    );

    it('stops a command that runs past the 3 s cap and prints nothing', async () => {
      const r = await run(
        INPUT,
        thenEcho(`process.stdout.write('late');setTimeout(()=>{},10000);`),
      );
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(r.ms).toBeLessThan(3200 + STARTUP_SLACK_MS * 2);
    }, 10_000);
  });
});
