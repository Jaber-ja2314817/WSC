// WSC hook forwarder. Claude Code runs this on each hook event (async).
// Contract: dependency-free, never writes to stdout/stderr, always exits 0,
// gives up after 300 ms. It must never slow down or influence Claude Code.
//
// On SessionStart, when WSC isn't running (no runtime file, or a stale one whose port refuses
// connections), it starts the app detached with `--from-hook --hook-payload=<b64url>` so the new
// session shows up immediately. Only a session the user just started or resumed launches it: a
// `/clear` or compaction inside an open session must not bring back an app they quit. Opt out with
// WSC_AUTOLAUNCH=0 or the `launchOnSessionStart` setting. Only node: builtins are imported
// statically; the launch.mjs fallback is a guarded dynamic import so a broken or missing file can
// never print anything.
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const TIMEOUT_MS = 300;
/** process.uptime() misses the exec before Node's clock starts and the teardown after exit. */
const EXIT_MARGIN_MS = 40;
/** Kept even when Node boots slowly: a local POST needs a moment, and an event beats silence. */
const MIN_BUDGET_MS = 100;
const MAX_BYTES = 1024 * 1024;
/** Larger SessionStart payloads are not passed on the command line (the app backfills instead). */
const MAX_PAYLOAD_ARG = 16 * 1024;
/** A launch marker younger than this means another hook is already starting the app. */
const LAUNCH_MARKER_TTL_MS = 15_000;
const ERROR_LOG_MAX = 64 * 1024;

const done = () => process.exit(0);

// Hard deadline no matter what is pending. Node's boot time counts against it.
setTimeout(
  done,
  Math.max(MIN_BUDGET_MS, TIMEOUT_MS - EXIT_MARGIN_MS - process.uptime() * 1000),
).unref();

// Mirrors plugin/scripts/runtime-path.mjs and src/main/runtimeFile.ts — keep in sync.
function runtimeFilePath() {
  if (process.env.WSC_RUNTIME_FILE) return process.env.WSC_RUNTIME_FILE;
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'WSC', 'runtime.json');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'WSC', 'runtime.json');
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'WSC', 'runtime.json');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readRuntime() {
  const info = readJson(runtimeFilePath());
  if (!info || typeof info !== 'object') return null;
  if (!Number.isInteger(info.port) || info.port <= 0 || info.port > 65535) return null;
  if (typeof info.token !== 'string' || !info.token) return null;
  return info;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const finish = () => resolve(Buffer.concat(chunks));
    try {
      process.stdin.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          chunks.length = 0;
          process.stdin.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      process.stdin.on('end', finish);
      process.stdin.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/** True when a user just started or resumed a session; absent means an older Claude Code. */
function startsSession(body) {
  try {
    const payload = JSON.parse(body.toString('utf8'));
    if (payload?.hook_event_name !== 'SessionStart') return false;
    const source = payload.source;
    return typeof source !== 'string' || source === 'startup' || source === 'resume';
  } catch {
    return false;
  }
}

/** True only when the process that wrote the runtime file is certainly gone. */
function processGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH'; // EPERM means it's alive under another user.
  }
}

/**
 * 'ok' | 'unreachable' (not WSC: nothing listens, or something else took the port) | 'failed'.
 * node:http with `agent: false`, never fetch: fetch can follow NODE_USE_ENV_PROXY and would hand
 * the token and payload to a proxy. The hard deadline covers a server that never answers.
 */
function post(runtime, body) {
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: runtime.port,
          path: '/v1/events',
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            'x-wsc-token': runtime.token,
          },
        },
        (res) => {
          res.resume();
          const status = res.statusCode;
          resolve(status === 401 || status === 403 || status === 404 ? 'unreachable' : 'ok');
        },
      );
      req.on('error', (err) => {
        const refused = err?.code === 'ECONNREFUSED' || err?.code === 'EADDRNOTAVAIL';
        resolve(refused ? 'unreachable' : 'failed');
      });
      req.end(body);
    } catch {
      resolve('failed');
    }
  });
}

/** One short line, never payload content. Capped: when over the cap, keep the newest half. */
function logError(appDir, message) {
  try {
    mkdirSync(appDir, { recursive: true }); // The app may never have run.
    const file = join(appDir, 'hook-errors.log');
    const line = `${new Date().toISOString()} ${String(message).slice(0, 200).replace(/\s+/g, ' ')}\n`;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // no log yet
    }
    if (size + line.length > ERROR_LOG_MAX) {
      let keep = '';
      try {
        const text = readFileSync(file, 'utf8');
        keep = text.slice(-Math.floor(ERROR_LOG_MAX / 2));
        keep = keep.slice(keep.indexOf('\n') + 1);
      } catch {
        // unreadable: start over
      }
      writeFileSync(file, keep + line, { mode: 0o600 });
    } else {
      appendFileSync(file, line, { mode: 0o600 });
    }
  } catch {
    // Logging is best effort.
  }
}

function autoLaunchDisabled(settings) {
  const env = (process.env.WSC_AUTOLAUNCH || '').trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'off' || env === 'no') return true;
  return settings?.launchOnSessionStart === false;
}

/** <appDir>/launch.json written by the app: { version, command, args, macBundle? }. */
function readLaunchInfo(appDir) {
  const info = readJson(join(appDir, 'launch.json'));
  if (!info || typeof info !== 'object') return null;
  if (typeof info.command !== 'string' || !info.command || !existsSync(info.command)) return null;
  if (!Array.isArray(info.args) || !info.args.every((a) => typeof a === 'string')) return null;
  const macBundle =
    process.platform === 'darwin' &&
    typeof info.macBundle === 'string' &&
    info.macBundle &&
    existsSync(info.macBundle)
      ? info.macBundle
      : undefined;
  return { command: info.command, args: info.args, macBundle };
}

/** Fallback when the app never wrote launch.json: the /station launcher's search. */
async function locateViaLauncher(extraArgs) {
  const mod = await import(new URL('../scripts/launch.mjs', import.meta.url).href).catch(
    () => null,
  );
  if (!mod || typeof mod.locateApp !== 'function') return null;
  try {
    const target = mod.locateApp(extraArgs);
    if (!target || typeof target.command !== 'string' || !Array.isArray(target.args)) return null;
    return target;
  } catch {
    return null;
  }
}

/**
 * Claims the launch for this hook. A marker younger than the TTL means someone else is starting
 * the app; an older one is stale (crashed launch) and gets replaced.
 */
function claimLaunch(appDir) {
  const marker = join(appDir, 'launching.json');
  const data = JSON.stringify({ ts: Date.now(), pid: process.pid });
  try {
    writeFileSync(marker, data, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  const prev = readJson(marker);
  const age = Date.now() - Number(prev?.ts);
  if (Number.isFinite(age) && age >= 0 && age < LAUNCH_MARKER_TTL_MS) return false;
  const tmp = `${marker}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, marker);
  return true;
}

/**
 * cmd.exe gets a shell spawn's arguments unquoted, so anything with spaces is quoted here. It is
 * one string because Node 24+ prints a deprecation warning to stderr for shell plus an args array.
 */
const cmdQuote = (s) => (/^[\w.:=\\/-]+$/.test(s) ? s : `"${s}"`);

async function autoLaunch(body) {
  const appDir = dirname(runtimeFilePath());
  try {
    const settings = readJson(join(appDir, 'settings.json'));
    if (autoLaunchDisabled(settings)) return;
    const focus = settings?.focusOnSessionStart === true;

    const extraArgs = ['--from-hook'];
    if (body.length <= MAX_PAYLOAD_ARG) {
      extraArgs.push(`--hook-payload=${body.toString('base64url')}`);
    }

    let target;
    const info = readLaunchInfo(appDir);
    if (info?.macBundle) {
      target = {
        command: 'open',
        args: [...(focus ? [] : ['-g']), '-a', info.macBundle, '--args', ...extraArgs],
      };
    } else if (info) {
      const args = [...info.args, ...extraArgs];
      target =
        process.platform === 'win32' && /\.(cmd|bat)$/i.test(info.command)
          ? { command: [info.command, ...args].map(cmdQuote).join(' '), args: [], shell: true }
          : { command: info.command, args };
    } else {
      target = await locateViaLauncher(extraArgs);
      if (target && !focus && target.command === 'open' && target.args[0] === '-a') {
        target = { ...target, args: ['-g', ...target.args] };
      }
    }
    if (!target) {
      logError(appDir, 'autolaunch: app not found (start WSC once so it writes launch.json)');
      return;
    }

    mkdirSync(appDir, { recursive: true });
    if (!claimLaunch(appDir)) return;

    const child = spawn(target.command, target.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      ...(target.shell ? { shell: true } : {}),
    });
    child.on('error', (err) => logError(appDir, `autolaunch: spawn failed ${err?.code ?? ''}`));
    child.unref();
    // A missing binary is reported on the next tick; give it one so it reaches the log.
    await new Promise((r) => setImmediate(r));
  } catch (err) {
    logError(appDir, `autolaunch: ${err?.code ?? err?.name ?? 'error'}`);
  }
}

async function main() {
  const runtime = readRuntime();
  const body = await readStdin();
  if (!body || body.length === 0) return;
  if (runtime && !processGone(runtime.pid)) {
    const result = await post(runtime, body);
    if (result !== 'unreachable') return;
  }
  if (startsSession(body)) await autoLaunch(body);
}

process.on('uncaughtException', done);
process.on('unhandledRejection', done);
main().then(done, done);
