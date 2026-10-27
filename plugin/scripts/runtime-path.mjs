// Where the WSC app writes { port, token, pid, version } (runtime.json) and how to start it again
// (launch.json). Used by the /station launcher. Mirrors src/main/runtimeFile.ts and plugin/hooks/forward.mjs (which stays
// self-contained on purpose: an import failure there would print to stderr) — keep in sync.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

/** The folder holding runtime.json, launch.json and settings.json (honours WSC_RUNTIME_FILE). */
export function appDir() {
  return dirname(runtimeFilePath());
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

/**
 * How the app last said it can be started again: { version, command, args, macBundle? } from
 * <appDir>/launch.json, or null when missing/invalid or the command no longer exists. macBundle is
 * kept only on macOS when the bundle exists. Never throws.
 */
export function readLaunchInfo() {
  try {
    const info = JSON.parse(readFileSync(join(appDir(), 'launch.json'), 'utf8'));
    if (!info || typeof info !== 'object') return null;
    if (typeof info.command !== 'string' || !info.command || !existsSync(info.command)) return null;
    if (!Array.isArray(info.args) || !info.args.every((a) => typeof a === 'string')) return null;
    const result = {
      version: typeof info.version === 'string' ? info.version : '',
      command: info.command,
      args: info.args,
    };
    if (
      process.platform === 'darwin' &&
      typeof info.macBundle === 'string' &&
      info.macBundle &&
      existsSync(info.macBundle)
    ) {
      result.macBundle = info.macBundle;
    }
    return result;
  } catch {
    return null;
  }
}
