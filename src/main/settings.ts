// Persisted user settings + window state, in the app's userData folder (never event contents).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CameraState, WindowMode } from '@shared/ipc';
import { mergeSettings, parseSettings, type Settings } from '@shared/settings';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  mode: WindowMode;
  bounds: Partial<Record<WindowMode, Bounds>>;
  camera: Partial<Record<WindowMode, CameraState>>;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Atomic write, user-only permissions. Errors are swallowed: settings are never critical. */
function writeJson(file: string, value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // ignore
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseBounds(v: unknown): Bounds | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const b = v as Record<string, unknown>;
  if (!isNum(b['x']) || !isNum(b['y']) || !isNum(b['width']) || !isNum(b['height'])) {
    return undefined;
  }
  if (b['width'] < 200 || b['height'] < 120 || b['width'] > 20000 || b['height'] > 20000) {
    return undefined;
  }
  return { x: b['x'], y: b['y'], width: b['width'], height: b['height'] };
}

function parseCamera(v: unknown): CameraState | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const c = v as Record<string, unknown>;
  if (!isNum(c['x']) || !isNum(c['y']) || !isNum(c['zoom'])) return undefined;
  if (c['zoom'] <= 0 || c['zoom'] > 16) return undefined;
  return { x: c['x'], y: c['y'], zoom: c['zoom'] };
}

export function parseWindowState(raw: unknown): WindowState {
  const out: WindowState = { mode: 'normal', bounds: {}, camera: {} };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r['mode'] === 'compact') out.mode = 'compact';
  for (const mode of ['normal', 'compact'] as const) {
    const b = parseBounds((r['bounds'] as Record<string, unknown> | undefined)?.[mode]);
    if (b) out.bounds[mode] = b;
    const c = parseCamera((r['camera'] as Record<string, unknown> | undefined)?.[mode]);
    if (c) out.camera[mode] = c;
  }
  return out;
}

export class SettingsStore {
  private current: Settings;
  private win: WindowState;
  private listeners = new Set<(s: Settings, prev: Settings) => void>();
  private winSaveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dir: string) {
    this.current = parseSettings(readJson(this.settingsPath));
    this.win = parseWindowState(readJson(this.windowPath));
  }

  get settingsPath(): string {
    return join(this.dir, 'settings.json');
  }

  get windowPath(): string {
    return join(this.dir, 'window-state.json');
  }

  get(): Settings {
    return this.current;
  }

  update(patch: unknown): Settings {
    const prev = this.current;
    this.current = mergeSettings(prev, patch);
    writeJson(this.settingsPath, this.current);
    for (const fn of this.listeners) {
      try {
        fn(this.current, prev);
      } catch {
        // a broken listener must not block saving
      }
    }
    return this.current;
  }

  onChange(fn: (s: Settings, prev: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get windowState(): WindowState {
    return this.win;
  }

  /** Window bounds/camera change often (drag, resize): debounce writes. */
  patchWindowState(patch: (w: WindowState) => void): void {
    patch(this.win);
    if (this.winSaveTimer) clearTimeout(this.winSaveTimer);
    this.winSaveTimer = setTimeout(() => this.flush(), 400);
  }

  flush(): void {
    if (this.winSaveTimer) clearTimeout(this.winSaveTimer);
    this.winSaveTimer = null;
    writeJson(this.windowPath, this.win);
  }
}
