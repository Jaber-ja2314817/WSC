// Persisted user settings + window state, in the app's userData folder (never event contents).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

type SettingsFile =
  | { state: 'missing' }
  /** Exists but isn't a JSON object, so it can't be used and must not be overwritten either. */
  | { state: 'corrupt' }
  | { state: 'ok'; raw: Record<string, unknown> };

function readSettingsFile(file: string): SettingsFile {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'corrupt' };
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { state: 'ok', raw: raw as Record<string, unknown> };
    }
  } catch {
    // reported below
  }
  return { state: 'corrupt' };
}

/** `prices` entries the parser refused. There is no UI for prices, so these are hand edits. */
function refusedPrices(raw: Record<string, unknown>, parsed: Settings): Record<string, unknown> {
  const prices = raw['prices'];
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return {};
  return Object.fromEntries(
    Object.entries(prices).filter(([key]) => !Object.hasOwn(parsed.prices, key)),
  );
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
  private refused: Record<string, unknown> = {};
  private warningText: string | undefined;

  constructor(private readonly dir: string) {
    const file = readSettingsFile(this.settingsPath);
    this.current = parseSettings(file.state === 'ok' ? file.raw : undefined);
    if (file.state === 'ok') this.noteRefused(file.raw, this.current);
    if (file.state === 'corrupt') {
      this.warningText = 'settings.json could not be read, so WSC is using default settings.';
    }
    this.win = parseWindowState(readJson(this.windowPath));
  }

  /** Something the user should know about settings.json. */
  get warning(): string | undefined {
    return this.warningText;
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

  /**
   * The file wins over what was loaded: settings.json is meant to be edited by hand (prices have
   * no UI) while the app keeps running, so a save must not put old values back.
   */
  update(patch: unknown): Settings {
    const prev = this.current;
    const file = readSettingsFile(this.settingsPath);
    const canWrite = file.state !== 'corrupt' || this.setCorruptFileAside();
    const base = file.state === 'ok' ? parseSettings(file.raw) : prev;
    this.current = mergeSettings(base, patch);
    if (file.state === 'ok') this.noteRefused(file.raw, base);
    const setsPrices = !!patch && typeof patch === 'object' && 'prices' in patch;
    if (setsPrices) this.refused = {};
    if (canWrite) {
      writeJson(this.settingsPath, {
        ...this.current,
        prices: { ...this.refused, ...this.current.prices },
      });
    }
    for (const fn of this.listeners) {
      try {
        fn(this.current, prev);
      } catch {
        // a broken listener must not block saving
      }
    }
    return this.current;
  }

  private noteRefused(raw: Record<string, unknown>, parsed: Settings): void {
    this.refused = refusedPrices(raw, parsed);
    const names = Object.keys(this.refused);
    if (names.length > 0) {
      this.warningText = `Ignoring invalid prices in settings.json: ${names.slice(0, 3).join(', ')}.`;
    } else if (this.warningText?.startsWith('Ignoring')) {
      this.warningText = undefined;
    }
  }

  /** Moves an unreadable settings.json out of the way. False if it is still in the way. */
  private setCorruptFileAside(): boolean {
    const aside = `${this.settingsPath}.corrupt-${Date.now()}`;
    try {
      renameSync(this.settingsPath, aside);
      this.warningText = `settings.json could not be read. It was saved as ${basename(aside)}.`;
      return true;
    } catch {
      return false;
    }
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
