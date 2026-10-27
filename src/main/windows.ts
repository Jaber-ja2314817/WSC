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

/** True if at least a 64×64 px part of the bounds is on some display. */
export function boundsVisible(b: Bounds, displays: Bounds[]): boolean {
  return displays.some((d) => {
    const w = Math.min(b.x + b.width, d.x + d.width) - Math.max(b.x, d.x);
    const h = Math.min(b.y + b.height, d.y + d.height) - Math.max(b.y, d.y);
    return w >= 64 && h >= 64;
  });
}

export class WindowManager {
  private win: BrowserWindow | null = null;
  private currentMode: WindowMode;
  ready = false;

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
    const bounds = saved && boundsVisible(saved, displays) ? saved : undefined;
    const compact = mode === 'compact';

    this.ready = false;
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
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
      this.opts.onReady(win);
    });
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
