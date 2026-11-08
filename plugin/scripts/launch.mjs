// /station launcher. Dependency-free and cross-platform.
// If WSC is running → send it a command; otherwise start it detached and return immediately.
// Prints exactly one short line for Claude Code to relay, and always exits 0.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLaunchInfo, readRuntime } from './runtime-path.mjs';

const RELEASES_URL = 'https://github.com/OWNER/wsc/releases';
const THEME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

function say(line) {
  process.stdout.write(`${line}\n`);
}

/** argv → { action, arg } or { error } */
export function parseArgs(argv) {
  const words = argv
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const [first, second] = words;
  if (!first || first === 'open' || first === 'focus') return { action: 'focus' };
  if (first === 'compact' || first === 'demo' || first === 'status') return { action: first };
  if (first === 'theme') {
    if (!second || !THEME_RE.test(second)) {
      return { error: 'WSC: usage: /station theme <spaceship|office|home|terminal|name>' };
    }
    return { action: 'theme', arg: second };
  }
  return { error: 'WSC: usage: /station [compact | theme <name> | demo | status]' };
}

/** node:http with `agent: false`, never fetch: fetch can follow NODE_USE_ENV_PROXY. */
function request(runtime, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: runtime.port,
        path,
        method,
        agent: false,
        headers: {
          'x-wsc-token': runtime.token,
          'content-type': 'application/json',
          ...(data ? { 'content-length': data.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) return reject(new Error(`HTTP ${status}`));
          if (status === 204) return resolve({});
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(data);
  });
}

function successLine(cmd, result) {
  switch (cmd.action) {
    case 'compact':
      return 'WSC: switched to compact mode.';
    case 'theme':
      return `WSC: switched to the ${cmd.arg} theme.`;
    case 'demo':
      return 'WSC: playing the demo.';
    case 'status': {
      const events = Number(result.eventsReceived ?? 0);
      const port = result.port ? ` on 127.0.0.1:${result.port}` : '';
      const mode = result.demo ? ', demo mode' : '';
      return `WSC: running${port} — ${events} event${events === 1 ? '' : 's'} received${mode} (v${result.version ?? '?'}).`;
    }
    default:
      return 'WSC: station focused.';
  }
}

function startArgs(cmd) {
  // Not --demo: that mode is pinned for `npm run demo` and ignores real sessions.
  if (cmd.action === 'demo') return ['--play-demo'];
  if (cmd.action === 'compact') return ['--compact'];
  if (cmd.action === 'theme') return [`--theme=${cmd.arg}`];
  return [];
}

function isWscRepo(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return pkg.name === 'wsc' && existsSync(join(dir, 'out', 'main', 'index.js'));
  } catch {
    return false;
  }
}

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/**
 * cmd.exe gets a shell spawn's arguments unquoted, so anything with spaces is quoted here. It is
 * one string because Node 24+ prints a deprecation warning to stderr for shell plus an args array.
 */
const cmdQuote = (s) => (/^[\w.:=\\/-]+$/.test(s) ? s : `"${s}"`);

const viaCmd = (command, args) => ({
  command: [command, ...args].map(cmdQuote).join(' '),
  args: [],
  shell: true,
});

/**
 * How to start the app: { command, args, shell? } or null when it can't be found.
 * Order: WSC_APP_PATH, then <appDir>/launch.json (written by the app), then the usual install
 * locations, then a source checkout (WSC_REPO or the repo this plugin lives in).
 */
export function locateApp(extraArgs) {
  const explicit = process.env.WSC_APP_PATH;
  if (explicit) {
    if (!existsSync(explicit)) return null;
    if (process.platform === 'darwin' && explicit.endsWith('.app')) {
      return { command: 'open', args: ['-a', explicit, '--args', ...extraArgs] };
    }
    return { command: explicit, args: extraArgs };
  }

  // What the app itself recorded the last time it ran (works from the plugin cache too).
  const info = readLaunchInfo();
  if (info?.macBundle) {
    return { command: 'open', args: ['-a', info.macBundle, '--args', ...extraArgs] };
  }
  if (info) {
    const args = [...info.args, ...extraArgs];
    return process.platform === 'win32' && /\.(cmd|bat)$/i.test(info.command)
      ? viaCmd(info.command, args)
      : { command: info.command, args };
  }

  const home = homedir();
  if (process.platform === 'darwin') {
    for (const app of ['/Applications/WSC.app', join(home, 'Applications', 'WSC.app')]) {
      if (existsSync(app)) return { command: 'open', args: ['-a', app, '--args', ...extraArgs] };
    }
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const exe = join(local, 'Programs', 'WSC', 'WSC.exe');
    if (existsSync(exe)) return { command: exe, args: extraArgs };
  } else {
    const appsDir = join(home, 'Applications');
    try {
      const image = readdirSync(appsDir).find((f) => /^WSC.*\.AppImage$/i.test(f));
      if (image) return { command: join(appsDir, image), args: extraArgs };
    } catch {
      // no ~/Applications
    }
    const bin = onPath('wsc');
    if (bin) return { command: bin, args: extraArgs };
  }

  // Running from a source checkout: WSC_REPO, or the repo this plugin lives in.
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = process.env.WSC_REPO || resolve(here, '..', '..');
  if (isWscRepo(repo)) {
    const electronBin = join(
      repo,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'electron.cmd' : 'electron',
    );
    if (existsSync(electronBin)) {
      const args = [repo, ...extraArgs];
      return process.platform === 'win32'
        ? viaCmd(electronBin, args)
        : { command: electronBin, args };
    }
  }
  return null;
}

async function main() {
  const cmd = parseArgs(process.argv.slice(2));
  if (cmd.error) return say(cmd.error);

  const runtime = readRuntime();
  if (runtime) {
    try {
      await request(runtime, 'GET', '/v1/health', null, 800);
      const result = await request(runtime, 'POST', '/v1/command', cmd, 2_000);
      if (result?.ok === false && result.error) return say(`WSC: ${result.error}`);
      return say(successLine(cmd, result));
    } catch {
      // Stale runtime file or app shutting down: fall through to starting it.
    }
  }

  if (cmd.action === 'status') return say('WSC: not running. Type /station to start it.');

  const target = locateApp(startArgs(cmd));
  if (!target) {
    return say(`WSC: app not found. Download it from ${RELEASES_URL} (or set WSC_APP_PATH).`);
  }
  try {
    const child = spawn(target.command, target.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      ...(target.shell ? { shell: true } : {}),
    });
    child.on('error', () => {});
    child.unref();
    const mode =
      cmd.action === 'demo' ? ' in demo mode' : cmd.action === 'compact' ? ' in compact mode' : '';
    say(`WSC: starting the station${mode}…`);
  } catch {
    say(`WSC: could not start the app. Download it from ${RELEASES_URL}.`);
  }
}

// Only run when executed directly (tests import parseArgs/locateApp).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch(() => say('WSC: something went wrong starting the station.'))
    .finally(() => process.exit(0));
}
