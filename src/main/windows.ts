// Main window in two modes: normal, and compact (small frameless always-on-top floating panel).
// `frame` can't change on a live window, so switching modes recreates the window; the renderer
// rebuilds from the current snapshot, so nothing is lost.
import { join } from 'node:path';
import { app, BrowserWindow, screen, shell } from 'electron';
import type { WindowMode } from '@shared/ipc';
import type { Bounds, SettingsStore } from './settings';

const SIZES: Record<
  WindowMode,
  { width: number; height: number; minWidth: number; minHeight: number }
> = {
  normal: { width: 1280, height: 800, minWidth: 640, minHeight: 400 },
  compact: { width: 360, height: 240, minWidth: 240, minHeight: 160 },
};

export interface WindowManagerOptions {
  settings: SettingsStore;
  /** Fired after each (re)created window finished loading. */
  onReady(win: BrowserWindow): void;
  /** Fired when the window mode changed. */
  onModeChange?(mode: WindowMode): void;
}

/** Height of the strip along the top of a window that has to stay reachable. */
const TITLE_STRIP = 32;

/** True if the window's title bar can be reached: its top strip is at least 64 px on a display. */
export function boundsVisible(b: Bounds, displays: Bounds[]): boolean {
  return displays.some((d) => {
    const w = Math.min(b.x + b.width, d.x + d.width) - Math.max(b.x, d.x);
    const h = Math.min(b.y + TITLE_STRIP, d.y + d.height) - Math.max(b.y, d.y);
    return w >= 64 && h >= TITLE_STRIP;
  });
}

/** Shrinks a window that no longer fits its display (saved on a bigger monitor) and moves it in. */
export function clampBounds(b: Bounds, displays: Bounds[]): Bounds {
  const overlap = (d: Bounds): number =>
    Math.max(0, Math.min(b.x + b.width, d.x + d.width) - Math.max(b.x, d.x)) *
    Math.max(0, Math.min(b.y + b.height, d.y + d.height) - Math.max(b.y, d.y));
  const d = displays.reduce<Bounds | undefined>(
    (best, c) => (!best || overlap(c) > overlap(best) ? c : best),
    undefined,
  );
  if (!d || (b.width <= d.width && b.height <= d.height)) return b;
  const width = Math.min(b.width, d.width);
  const height = Math.min(b.height, d.height);
  return {
    x: Math.max(d.x, Math.min(b.x, d.x + d.width - width)),
    y: Math.max(d.y, Math.min(b.y, d.y + d.height - height)),
    width,
    height,
  };
}

export class WindowManager {
  private win: BrowserWindow | null = null;
  private currentMode: WindowMode;

  constructor(private readonly opts: WindowManagerOptions) {
    this.currentMode = opts.settings.windowState.mode;
  }

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  get mode(): WindowMode {
    return this.currentMode;
  }

  /**
   * `inactive`: show without taking focus (launched by a Claude Code SessionStart hook while
   * settings.focusOnSessionStart is off).
   */
  create(opts: { inactive?: boolean } = {}): BrowserWindow {
    const mode = this.currentMode;
    const size = SIZES[mode];
    const saved = this.opts.settings.windowState.bounds[mode];
    const displays = screen.getAllDisplays().map((d) => d.workArea);
    const bounds =
      saved && boundsVisible(saved, displays) ? clampBounds(saved, displays) : undefined;
    const compact = mode === 'compact';

    const win = new BrowserWindow({
      ...size,
      ...(bounds ?? {}),
      show: false,
      title: 'WSC',
      backgroundColor: '#0b0e1a',
      autoHideMenuBar: true,
      frame: !compact,
      alwaysOnTop: compact,
      skipTaskbar: false,
      fullscreenable: !compact,
      icon: join(app.getAppPath(), 'resources', 'icon.png'),
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    if (compact) win.setAlwaysOnTop(true, 'floating');
    this.win = win;

    win.on('ready-to-show', () => (opts.inactive ? win.showInactive() : win.show()));
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    const saveBounds = (): void => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      const b = win.getNormalBounds();
      this.opts.settings.patchWindowState((s) => {
        s.bounds[mode] = b;
      });
    };
    win.on('resize', saveBounds);
    win.on('move', saveBounds);
    win.webContents.on('did-finish-load', () => this.opts.onReady(win));
    // External links open in the user's browser; nothing navigates the app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      // User-clicked https:// links (docs, releases) open in the user's own browser — not an app
      // network request. Every other scheme is ignored.
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (!app.isPackaged && devUrl) {
      const u = new URL(devUrl);
      u.searchParams.set('mode', mode);
      void win.loadURL(u.toString());
    } else {
      void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { query: { mode } });
    }
    return win;
  }

  focus(): void {
    const win = this.window ?? this.create();
    if (win.isMinimized()) win.restore();
    win.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.focus();
  }

  setMode(mode: WindowMode | 'toggle'): void {
    const next: WindowMode =
      mode === 'toggle' ? (this.currentMode === 'compact' ? 'normal' : 'compact') : mode;
    if (next === this.currentMode && this.window) {
      this.focus();
      return;
    }
    this.currentMode = next;
    this.opts.settings.patchWindowState((s) => {
      s.mode = next;
    });
    const old = this.window;
    this.create();
    // Next tick: lets an in-flight IPC reply (e.g. the setWindowMode call itself) reach the old
    // window before it goes away.
    setImmediate(() => old?.destroy());
    this.opts.onModeChange?.(next);
  }
}
