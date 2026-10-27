import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function run(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [LAUNCH, ...args], {
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

async function startApp(): Promise<{ commands: StationCommand[]; env: Record<string, string> }> {
  const commands: StationCommand[] = [];
  server = await startIngestServer({
    port: 0,
    token: TOKEN,
    version: '0.1.0',
    onPayload: () => {},
    onCommand: (cmd) => {
      commands.push(cmd);
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
    expect(oneLine(r)).toContain('https://github.com/OWNER/wsc/releases');
    expect(r.ms).toBeLessThan(2_000);
  });

  it('treats a stale runtime file (dead port) as not running', async () => {
    const runtime = join(dir, 'stale.json');
    writeFileSync(runtime, JSON.stringify({ port: 1, token: 'x', pid: 999999, version: '0' }));
    const r = await run(['status'], { WSC_RUNTIME_FILE: runtime });
    expect(oneLine(r)).toBe('WSC: not running. Type /station to start it.');
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
        .toBe('--demo');
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
