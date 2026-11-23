import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startIngestServer, type IngestServer, type StationCommand } from '../src/main/server';

const LAUNCH = join(process.cwd(), 'plugin', 'scripts', 'launch.mjs');
const TOKEN = 'launch-test-token';

let dir: string;
let server: IngestServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsc-launch-'));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(
  args: string[],
  env: Record<string, string>,
  nodeArgs: string[] = [],
): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...nodeArgs, LAUNCH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

async function startApp(
  reply?: Record<string, unknown>,
): Promise<{ commands: StationCommand[]; env: Record<string, string> }> {
  const commands: StationCommand[] = [];
  server = await startIngestServer({
    port: 0,
    token: TOKEN,
    version: '0.1.0',
    onPayload: () => {},
    onCommand: (cmd) => {
      commands.push(cmd);
      if (reply) return reply;
      return cmd.action === 'status'
        ? { running: true, version: '0.1.0', port: server?.port, eventsReceived: 3, demo: false }
        : undefined;
    },
  });
  const runtime = join(dir, 'runtime.json');
  writeFileSync(
    runtime,
    JSON.stringify({ port: server.port, token: TOKEN, pid: process.pid, version: '0.1.0' }),
  );
  return { commands, env: { WSC_RUNTIME_FILE: runtime } };
}

const notRunning = (): Record<string, string> => ({
  WSC_RUNTIME_FILE: join(dir, 'missing.json'),
  WSC_APP_PATH: join(dir, 'no-such-app'),
});

const oneLine = (r: RunResult): string => {
  expect(r.code).toBe(0);
  expect(r.stderr).toBe('');
  const lines = r.stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(1);
  return lines[0]!;
};

describe('launch.mjs with the app running', () => {
  it('reports a command the app refused instead of claiming success', async () => {
    const { env } = await startApp({ ok: false, error: 'Unknown theme "typo".' });
    const r = await run(['theme', 'typo'], env);
    expect(oneLine(r)).toBe('WSC: Unknown theme "typo".');
  });

  it.each([
    [[], { action: 'focus' }, 'WSC: station focused.'],
    [['compact'], { action: 'compact' }, 'WSC: switched to compact mode.'],
    [['theme', 'office'], { action: 'theme', arg: 'office' }, 'WSC: switched to the office theme.'],
    [['THEME Home'], { action: 'theme', arg: 'home' }, 'WSC: switched to the home theme.'],
    [['demo'], { action: 'demo' }, 'WSC: playing the demo.'],
  ])('%j posts %j', async (args, expected, line) => {
    const { commands, env } = await startApp();
    const r = await run(args, env);
    expect(oneLine(r)).toBe(line);
    expect(commands).toEqual([expected]);
  });

  it('never sends the token through an env proxy', async () => {
    const viaProxy: string[] = [];
    const proxy = createServer((req, res) => {
      viaProxy.push(String(req.url));
      res.writeHead(502).end();
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = (proxy.address() as { port: number }).port;
    const { commands, env } = await startApp();
    try {
      const r = await run(['compact'], {
        ...env,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        http_proxy: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: '',
        no_proxy: '',
      });
      expect(oneLine(r)).toBe('WSC: switched to compact mode.');
      expect(viaProxy).toEqual([]);
      expect(commands).toEqual([{ action: 'compact' }]);
    } finally {
      proxy.close();
    }
  });

  it('reports status from the app', async () => {
    const { env } = await startApp();
    const line = oneLine(await run(['status'], env));
    expect(line).toMatch(/^WSC: running on 127\.0\.0\.1:\d+ — 3 events received \(v0\.1\.0\)\.$/);
  });
});

describe('launch.mjs with the app not running', () => {
  it('status says not running, fast', async () => {
    const r = await run(['status'], notRunning());
    expect(oneLine(r)).toBe('WSC: not running. Type /station to start it.');
    expect(r.ms).toBeLessThan(2_000);
  });

  it('prints the download link when the app cannot be found', async () => {
    const r = await run([], notRunning());
    expect(oneLine(r)).toContain('https://github.com/Jaber-ja2314817/WSC/releases');
    expect(r.ms).toBeLessThan(2_000);
  });

  it('treats a stale runtime file (dead port) as not running', async () => {
    const runtime = join(dir, 'stale.json');
    writeFileSync(runtime, JSON.stringify({ port: 1, token: 'x', pid: 999999, version: '0' }));
    const r = await run(['status'], { WSC_RUNTIME_FILE: runtime });
    expect(oneLine(r)).toBe('WSC: not running. Type /station to start it.');
  });

  it('sends no token to a port whose recorded process is dead', async () => {
    const tokens: unknown[] = [];
    const foreign = createServer((req, res) => {
      tokens.push(req.headers['x-wsc-token']);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', r));
    const port = (foreign.address() as { port: number }).port;
    const runtime = join(dir, 'stale.json');
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(runtime, JSON.stringify({ port, token: 'x', pid: deadPid, version: '0' }));
    try {
      const r = await run(['status'], { WSC_RUNTIME_FILE: runtime });
      expect(oneLine(r)).toBe('WSC: not running. Type /station to start it.');
      expect(tokens).toEqual([]);
    } finally {
      foreign.close();
    }
  });

  it('rejects unknown subcommands and bad theme names with a usage line', async () => {
    expect(oneLine(await run(['explode'], notRunning()))).toMatch(/^WSC: usage:/);
    expect(oneLine(await run(['theme', '../../etc'], notRunning()))).toMatch(/^WSC: usage:/);
    expect(oneLine(await run(['theme'], notRunning()))).toMatch(/^WSC: usage:/);
  });

  it.skipIf(process.platform === 'win32')(
    'starts the app detached with mode args and returns immediately',
    async () => {
      const marker = join(dir, 'started.txt');
      const fakeApp = join(dir, 'fake-wsc');
      writeFileSync(fakeApp, `#!/bin/sh\necho "$@" > "${marker}"\nsleep 10\n`);
      chmodSync(fakeApp, 0o755);
      const r = await run(['demo'], { ...notRunning(), WSC_APP_PATH: fakeApp });
      expect(oneLine(r)).toBe('WSC: starting the station in demo mode…');
      // Detached: the launcher exited long before the fake app's `sleep 5`.
      expect(r.ms).toBeLessThan(2_000);
      await expect
        .poll(() => (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''), {
          // Generous: spawning is slow when the whole suite runs in parallel.
          timeout: 8_000,
        })
        // Not --demo: that pinned mode ignores real sessions and is only for `npm run demo`.
        .toBe('--play-demo');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'quotes the electron path and repo for a checkout in a folder with spaces on Windows',
    async () => {
      const repo = join(dir, 'First Last', 'wsc');
      mkdirSync(join(repo, 'out', 'main'), { recursive: true });
      mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(repo, 'package.json'), '{"name":"wsc"}');
      writeFileSync(join(repo, 'out', 'main', 'index.js'), '');
      const electron = join(repo, 'node_modules', '.bin', 'electron.cmd');
      writeFileSync(electron, '');
      const preload = join(dir, 'windows.mjs');
      writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: 'win32' });\n`);
      const record = join(dir, 'shell-args.txt');
      const fakeShell = join(dir, 'fake-cmd');
      writeFileSync(fakeShell, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\n`);
      chmodSync(fakeShell, 0o755);
      const r = await run(
        [],
        {
          WSC_RUNTIME_FILE: join(dir, 'missing.json'),
          WSC_APP_PATH: '',
          WSC_REPO: repo,
          LOCALAPPDATA: join(dir, 'local'),
          comspec: fakeShell,
        },
        [`--import=${pathToFileURL(preload).href}`],
      );
      expect(oneLine(r)).toBe('WSC: starting the station…');
      await expect.poll(() => existsSync(record), { timeout: 3_000 }).toBe(true);
      expect(readFileSync(record, 'utf8')).toContain(`"${electron}" "${repo}"`);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'prefers launch.json written by the app over the install locations',
    async () => {
      const marker = join(dir, 'started.txt');
      const fakeApp = join(dir, 'fake-wsc');
      writeFileSync(fakeApp, `#!/bin/sh\necho "$@" > "${marker}"\n`);
      chmodSync(fakeApp, 0o755);
      writeFileSync(
        join(dir, 'launch.json'),
        JSON.stringify({ version: '0.1.0', command: fakeApp, args: ['/home/user/wsc'] }),
      );
      // WSC_RUNTIME_FILE puts the app folder (and so launch.json) in the temp dir.
      const r = await run(['compact'], {
        WSC_RUNTIME_FILE: join(dir, 'runtime.json'),
        WSC_APP_PATH: '',
      });
      expect(oneLine(r)).toBe('WSC: starting the station in compact mode…');
      await expect
        .poll(() => (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''), {
          timeout: 3_000,
        })
        .toBe('/home/user/wsc --compact');
    },
  );
});
