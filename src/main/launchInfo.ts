// launch.json: tells the plugin's hook forwarder how to start THIS app again, so a Claude Code
// SessionStart can auto-launch WSC (settings.launchOnSessionStart, read by plugin/hooks/forward.mjs).
// Plain Node (no Electron import) so it is unit-testable. Written next to runtime.json, mode 0600.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { runtimeFilePath } from './runtimeFile';

export interface LaunchInfo {
  version: string;
  /** Executable to spawn. */
  command: string;
  args: string[];
  /** Packaged macOS only: the enclosing `.app` bundle (start it with `open -a`/`open <bundle>`). */
  macBundle?: string;
}

export interface LaunchEnv {
  version: string;
  /** process.execPath */
  execPath: string;
  /** app.getAppPath() */
  appPath: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
}

/** The `.app` folder that contains `execPath`, if any (e.g. /Applications/WSC.app). */
export function enclosingAppBundle(execPath: string, separator: string = sep): string | undefined {
  const marker = `.app${separator}Contents${separator}`;
  const i = execPath.lastIndexOf(marker);
  return i > 0 ? execPath.slice(0, i + 4) : undefined;
}

/** How to start this app again. Pure. */
export function buildLaunchInfo(env: LaunchEnv): LaunchInfo {
  if (!env.isPackaged) {
    // Dev/unpackaged: the electron binary plus the app folder (runs the last `out/` build).
    return { version: env.version, command: env.execPath, args: [env.appPath] };
  }
  const info: LaunchInfo = { version: env.version, command: env.execPath, args: [] };
  if (env.platform === 'darwin') {
    const bundle = enclosingAppBundle(env.execPath, '/');
    if (bundle) info.macBundle = bundle;
  }
  return info;
}

export function launchFilePath(): string {
  return join(dirname(runtimeFilePath()), 'launch.json');
}

/** Atomic write, mode 0600. Never throws. */
export function writeLaunchInfo(info: LaunchInfo): void {
  try {
    const file = launchFilePath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // read-only app-data etc.: auto-launch just won't work
  }
}

// ── startup args from the hook forwarder ─────────────────────────────────────
// `--from-hook`                 started (or poked) by the SessionStart hook: don't steal focus
// `--hook-payload=<base64url>`  the raw hook JSON that triggered the launch (≤ 16 KB decoded)

export const FROM_HOOK_ARG = '--from-hook';
export const HOOK_PAYLOAD_ARG = '--hook-payload=';
export const MAX_HOOK_PAYLOAD_BYTES = 16 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export interface HookArgs {
  fromHook: boolean;
  /** Parsed JSON object, absent when missing, too large or invalid. */
  payload?: Record<string, unknown>;
}

/** Decodes `--hook-payload=`; never throws. */
export function decodeHookPayload(encoded: string): Record<string, unknown> | undefined {
  try {
    if (!encoded || encoded.length > Math.ceil((MAX_HOOK_PAYLOAD_BYTES * 4) / 3) + 4) {
      return undefined;
    }
    if (!BASE64URL.test(encoded)) return undefined;
    const buf = Buffer.from(encoded, 'base64url');
    if (buf.length === 0 || buf.length > MAX_HOOK_PAYLOAD_BYTES) return undefined;
    const parsed: unknown = JSON.parse(buf.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function parseHookArgs(argv: readonly string[]): HookArgs {
  const out: HookArgs = { fromHook: false };
  for (const a of argv) {
    if (a === FROM_HOOK_ARG) out.fromHook = true;
    else if (a.startsWith(HOOK_PAYLOAD_ARG)) {
      const p = decodeHookPayload(a.slice(HOOK_PAYLOAD_ARG.length));
      if (p) out.payload = p;
    }
  }
  return out;
}
