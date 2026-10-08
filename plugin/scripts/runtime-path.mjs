// Where the WSC app writes { port, token, pid, version }. Used by the
// /station launcher. Mirrors src/main/runtimeFile.ts and plugin/hooks/forward.mjs (which stays
// self-contained on purpose: an import failure there would print to stderr) — keep in sync.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function appDataDir() {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'WSC');
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'WSC');
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'WSC');
}

export function runtimeFilePath() {
  return process.env.WSC_RUNTIME_FILE || join(appDataDir(), 'runtime.json');
}

/** Parsed runtime info, or null if missing/invalid. Never throws. */
export function readRuntime() {
  try {
    const info = JSON.parse(readFileSync(runtimeFilePath(), 'utf8'));
    if (!Number.isInteger(info.port) || info.port <= 0 || info.port > 65535) return null;
    if (typeof info.token !== 'string' || !info.token) return null;
    return info;
  } catch {
    return null;
  }
}
