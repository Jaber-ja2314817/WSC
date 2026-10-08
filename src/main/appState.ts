// Tiny persisted app flags (never event contents). Lives next to the runtime file in app data.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appDataDir } from './runtimeFile';

export interface AppFlags {
  /** A real hook event has reached this install at least once (hides the first-run screen). */
  hasReceivedEvents: boolean;
}

const DEFAULT_FLAGS: AppFlags = { hasReceivedEvents: false };

export function appFlagsPath(): string {
  return process.env['WSC_STATE_FILE'] || join(appDataDir(), 'state.json');
}

export function readAppFlags(): AppFlags {
  try {
    const raw = JSON.parse(readFileSync(appFlagsPath(), 'utf8')) as Partial<AppFlags>;
    return { hasReceivedEvents: raw.hasReceivedEvents === true };
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

export function writeAppFlags(flags: AppFlags): void {
  try {
    const file = appFlagsPath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(flags), { mode: 0o600 });
  } catch {
    // Non-critical: worst case the first-run screen shows again.
  }
}
