// WSC hook forwarder. Claude Code runs this on each hook event (async).
// Contract: dependency-free, never writes to stdout/stderr, always exits 0,
// gives up after 300 ms. It must never slow down or influence Claude Code.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 300;
const MAX_BYTES = 1024 * 1024;

const done = () => process.exit(0);

// Hard deadline no matter what is pending.
setTimeout(done, TIMEOUT_MS).unref();

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
  try {
    const info = JSON.parse(readFileSync(runtimeFilePath(), 'utf8'));
    if (!Number.isInteger(info.port) || info.port <= 0 || info.port > 65535) return null;
    if (typeof info.token !== 'string' || !info.token) return null;
    return info;
  } catch {
    return null;
  }
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

async function main() {
  const runtime = readRuntime();
  if (!runtime) return;
  const body = await readStdin();
  if (!body || body.length === 0) return;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS - 20);
  t.unref();
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wsc-token': runtime.token },
      body,
      signal: ctrl.signal,
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    // App closed or slow: ignore.
  }
}

process.on('uncaughtException', done);
process.on('unhandledRejection', done);
main().then(done, done);
