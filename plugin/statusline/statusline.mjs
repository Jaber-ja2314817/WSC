// WSC status line bridge. Claude Code runs this as the user's `statusLine` command and pipes a
// JSON object to it on every status line refresh. That object carries `rate_limits`, the real
// plan usage (5-hour and 7-day windows), which is nowhere else on disk. Installed into user
// settings by scripts/install-statusline.mjs (plugins can't define a status line).
//
// Contract: dependency-free (node: builtins only), never writes to stderr, always exits 0, never
// launches the app. It sends only `session_id` and `rate_limits` to WSC, nothing else from the
// payload.
//
//   node statusline.mjs                      → prints nothing (an empty status line)
//   node statusline.mjs --then <base64url>   → also runs the user's original status line command
//                                              (decoded) with the same stdin and prints its
//                                              stdout: that is the status line Claude Code shows
//
// The POST and the original command run concurrently. Deadline: 300 ms without --then; with
// --then, the command gets 3 s and the whole run ends shortly after.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 300;
const POST_TIMEOUT_MS = 250;
const CHILD_TIMEOUT_MS = 3000;
const CHILD_MARGIN_MS = 200;
const MAX_BYTES = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;

const done = () => process.exit(0);

function thenCommand(argv) {
  const i = argv.indexOf('--then');
  const encoded = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--then='))?.slice(7);
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const cmd = Buffer.from(encoded, 'base64url').toString('utf8');
    return cmd.trim() ? cmd : null;
  } catch {
    return null;
  }
}

const chained = thenCommand(process.argv.slice(2));

// Hard deadline no matter what is pending.
setTimeout(done, chained ? CHILD_TIMEOUT_MS + CHILD_MARGIN_MS : TIMEOUT_MS).unref();

// Mirrors plugin/hooks/forward.mjs, plugin/scripts/runtime-path.mjs and src/main/runtimeFile.ts
// — keep in sync.
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

function readRuntime() {
  let info;
  try {
    info = JSON.parse(readFileSync(runtimeFilePath(), 'utf8'));
  } catch {
    return null;
  }
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

/** The only thing sent to WSC: the session id and the rate_limits object, or null. */
function limitsBody(input) {
  let payload;
  try {
    payload = JSON.parse(input.toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const limits = payload.rate_limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return null;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
  return JSON.stringify({ session_id: sessionId, rate_limits: limits });
}

async function post(runtime, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  t.unref();
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/limits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wsc-token': runtime.token },
      body,
      signal: ctrl.signal,
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    // WSC not running, refused or slow: the status line must not care.
  } finally {
    clearTimeout(t);
  }
}

/** Runs the original status line command; resolves with its stdout, or null on any failure. */
function runChained(cmd, input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, {
        shell: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        // Its own process group on POSIX, so a timeout also stops whatever the shell started.
        detached: process.platform !== 'win32',
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(null);
    }, CHILD_TIMEOUT_MS);
    timer.unref();
    child.on('error', () => finish(null));
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT) chunks.push(chunk);
    });
    child.stdout.on('error', () => finish(null));
    child.on('close', () => finish(Buffer.concat(chunks)));
    child.stdin.on('error', () => {
      // The command may not read stdin at all (EPIPE).
    });
    child.stdin.end(input);
  });
}

function writeOut(buf) {
  return new Promise((resolve) => {
    if (!buf || buf.length === 0) {
      resolve();
      return;
    }
    try {
      process.stdout.on('error', () => resolve());
      process.stdout.write(buf, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function main() {
  const input = await readStdin();
  const body = input && input.length > 0 ? limitsBody(input) : null;
  const runtime = body ? readRuntime() : null;
  const posting = runtime ? post(runtime, body) : Promise.resolve();
  const output = chained && input ? runChained(chained, input).then(writeOut) : Promise.resolve();
  await Promise.all([posting, output]);
}

process.on('uncaughtException', done);
process.on('unhandledRejection', done);
main().then(done, done);
