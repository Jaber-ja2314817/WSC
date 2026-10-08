// Runtime file: tells the hook forwarder and launcher where the app listens.
// Plain Node (no Electron import) so it is unit-testable. Path rules are
// duplicated in plugin/hooks/forward.mjs and plugin/scripts/launch.mjs — keep in sync.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
}

export function appDataDir(): string {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'WSC');
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] || join(home, 'AppData', 'Roaming'), 'WSC');
  }
  return join(process.env['XDG_CONFIG_HOME'] || join(home, '.config'), 'WSC');
}

export function runtimeFilePath(): string {
  return process.env['WSC_RUNTIME_FILE'] || join(appDataDir(), 'runtime.json');
}

export function writeRuntimeFile(info: RuntimeInfo): void {
  const file = runtimeFilePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  renameSync(tmp, file);
}

export function readRuntimeFile(): RuntimeInfo | null {
  try {
    const raw = JSON.parse(readFileSync(runtimeFilePath(), 'utf8')) as Partial<RuntimeInfo>;
    if (
      typeof raw.port !== 'number' ||
      !Number.isInteger(raw.port) ||
      typeof raw.token !== 'string' ||
      typeof raw.pid !== 'number'
    ) {
      return null;
    }
    return {
      port: raw.port,
      token: raw.token,
      pid: raw.pid,
      version: typeof raw.version === 'string' ? raw.version : '',
    };
  } catch {
    return null;
  }
}

/** Removes the runtime file only if it belongs to this process (or to `pid`). */
export function removeRuntimeFile(pid: number = process.pid): void {
  const info = readRuntimeFile();
  if (info && info.pid !== pid) return;
  try {
    rmSync(runtimeFilePath(), { force: true });
  } catch {
    // ignore
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: exists but owned by someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
