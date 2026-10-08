import { app, BrowserWindow, clipboard, ipcMain, Notification, session } from 'electron';
import {
  IPC,
  type AppInfo,
  type CameraState,
  type RendererCommand,
  type StationStatus,
} from '@shared/ipc';
import type { Settings } from '@shared/settings';
import type { StationSnapshot } from '@shared/types';
import { readAppFlags, writeAppFlags } from './appState';
import { installNetGuard } from './netGuard';
import type { StationCommand } from './server';
import { SettingsStore } from './settings';
import { Station, type StationTuning } from './station';
import { StationTray, trayStatusFor } from './tray';
import { registerUserThemeIpc } from './userThemes';
import { WindowManager } from './windows';

// Tests (and power users) can isolate all app state: must run before anything reads userData.
const userDataOverride = process.env['WSC_USER_DATA'];
if (userDataOverride) app.setPath('userData', userDataOverride);

const STATUS_POLL_MS = 1000;
const THEME_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

let station: Station | null = null;
let windows: WindowManager | null = null;
let tray: StationTray | null = null; // module scope: keeps the tray from being garbage-collected
let pendingCommands: RendererCommand[] = [];
let knownThemes: { id: string; name: string }[] = [{ id: 'spaceship', name: 'Spaceship' }];
const flags = readAppFlags();
const settings = new SettingsStore(app.getPath('userData'));

const tuningFrom = (s: Settings): StationTuning => ({
  toolOverrides: s.toolCategoryOverrides,
  fullToolDetails: s.showFullToolDetails,
  staleMs: s.staleSeconds * 1000,
  sessionLingerMs: s.lingerSeconds * 1000,
});

/** Startup args → actions (`--compact`, `--theme=<id>`), shared with second-instance. */
function applyArgs(argv: readonly string[], startup: boolean): void {
  for (const a of argv) {
    if (a === '--compact') {
      if (startup) settings.patchWindowState((w) => (w.mode = 'compact'));
      else windows?.setMode('compact');
    } else if (a.startsWith('--theme=')) setTheme(a.slice(8));
  }
}

function sendToRenderer(cmd: RendererCommand): void {
  const win = windows?.window;
  if (win && windows?.ready) win.webContents.send(IPC.command, cmd);
  else pendingCommands.push(cmd);
}

function setTheme(id: string): void {
  if (!THEME_ID.test(id)) return;
  // Unknown ids still go to the renderer (it falls back to Spaceship with a visible warning),
  // but only themes the renderer reported as loadable are persisted.
  if (knownThemes.some((t) => t.id === id)) settings.update({ theme: id });
  else sendToRenderer({ action: 'theme', arg: id });
}

function status(): StationStatus {
  return {
    ...(station?.port !== undefined ? { port: station.port } : {}),
    eventsReceived: station?.eventsReceived ?? 0,
    hasReceivedEvents: flags.hasReceivedEvents,
    demo: station !== null && station.mode !== 'live',
  };
}

function pushStatus(): void {
  windows?.window?.webContents.send(IPC.status, status());
}

/** `/station` launcher commands arriving over the local HTTP server. */
function handleCommand(cmd: StationCommand): unknown {
  switch (cmd.action) {
    case 'focus':
      windows?.focus();
      return undefined;
    case 'demo':
      station?.startDemo();
      windows?.focus();
      return undefined;
    case 'compact':
      windows?.setMode('compact');
      windows?.focus();
      return undefined;
    case 'theme':
      if (cmd.arg) setTheme(cmd.arg);
      windows?.focus();
      return undefined;
    case 'status':
      return { running: true, version: app.getVersion(), ...status() };
  }
}

// ── attention: tray dot + optional native notifications ──────────────────────
const notified = new Set<string>();

function checkAttention(snap: StationSnapshot): void {
  tray?.setStatus(trayStatusFor(snap));
  const waiting = new Set<string>();
  for (const [key, a] of Object.entries(snap.agents)) {
    if (a.status !== 'waiting') continue;
    waiting.add(key);
    if (notified.has(key)) continue;
    notified.add(key);
    if (!settings.get().notifications || !Notification.isSupported()) continue;
    const project = snap.projects[a.projectId]?.name ?? 'a project';
    const who = a.isOrchestrator ? 'The orchestrator' : a.label;
    // Only the agent label and project name — never tool input.
    const n = new Notification({ title: 'WSC', body: `${who} in ${project} needs your input` });
    n.on('click', () => windows?.focus());
    n.show();
  }
  // Re-arm once an agent stops waiting, so a later wait notifies again.
  for (const key of [...notified]) if (!waiting.has(key)) notified.delete(key);
}

function applySettings(next: Settings, prev?: Settings): void {
  station?.configure(tuningFrom(next));
  if (!prev || prev.launchAtLogin !== next.launchAtLogin) {
    try {
      // Only touch the OS login item when the user changed it (or it's on at startup).
      if (prev || next.launchAtLogin) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    } catch {
      // unsupported platform/packaging: ignore
    }
  }
  if (prev && prev.theme !== next.theme) tray?.rebuildMenu();
  windows?.window?.webContents.send(IPC.settings, next);
}

const isMode = (m: unknown): m is 'normal' | 'compact' => m === 'normal' || m === 'compact';

function registerIpc(): void {
  ipcMain.handle(IPC.getSnapshot, () => station?.snapshot());
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    name: 'WSC',
    version: app.getVersion(),
    demo: station !== null && station.mode !== 'live',
  }));
  ipcMain.handle(IPC.getStatus, () => status());
  ipcMain.handle(IPC.testConnection, async () =>
    station ? station.testConnection() : { ok: false, error: 'Starting up…' },
  );
  ipcMain.handle(IPC.startDemo, () => station?.startDemo());
  ipcMain.handle(IPC.copyText, async (_e, text: unknown) => {
    if (typeof text === 'string' && text.length <= 64 * 1024) await clipboard.writeText(text);
  });
  ipcMain.handle(IPC.getSettings, () => settings.get());
  ipcMain.handle(IPC.setSettings, (_e, patch: unknown) => settings.update(patch));
  ipcMain.handle(IPC.clearIdleProjects, () =>
    station?.clearIdleProjects(settings.get().idleProjectMinutes * 60_000),
  );
  ipcMain.handle(IPC.getWindowMode, () => windows?.mode ?? 'normal');
  ipcMain.handle(IPC.setWindowMode, (_e, mode: unknown) => {
    if (isMode(mode) || mode === 'toggle') windows?.setMode(mode);
  });
  ipcMain.handle(IPC.getCamera, (_e, mode: unknown) =>
    isMode(mode) ? (settings.windowState.camera[mode] ?? null) : null,
  );
  ipcMain.handle(IPC.saveCamera, (_e, mode: unknown, cam: unknown) => {
    if (!isMode(mode) || !cam || typeof cam !== 'object') return;
    const { x, y, zoom } = cam as Partial<CameraState>;
    if (![x, y, zoom].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
    settings.patchWindowState((w) => {
      w.camera[mode] = { x: x!, y: y!, zoom: zoom! };
    });
  });
  ipcMain.on(IPC.reportThemes, (_e, list: unknown) => {
    if (!Array.isArray(list)) return;
    const clean: { id: string; name: string }[] = [];
    for (const t of list.slice(0, 100) as unknown[]) {
      if (!t || typeof t !== 'object') continue;
      const { id, name } = t as { id?: unknown; name?: unknown };
      if (typeof id !== 'string' || !THEME_ID.test(id) || typeof name !== 'string') continue;
      clean.push({ id, name: name.slice(0, 60) });
    }
    if (clean.length > 0) knownThemes = clean;
    tray?.rebuildMenu();
  });
  registerUserThemeIpc(ipcMain, () => windows?.window ?? null, !app.isPackaged);
}

function createTray(): void {
  try {
    tray = new StationTray({
      show: () => {
        windows?.setMode('normal');
        windows?.focus();
      },
      toggleCompact: () => windows?.setMode('toggle'),
      isCompact: () => windows?.mode === 'compact',
      themes: () => knownThemes,
      currentTheme: () => settings.get().theme,
      setTheme: (id) => setTheme(id),
      isPaused: () => station?.paused ?? false,
      setPaused: (paused) => {
        if (!station) return;
        if (paused) station.paused = true;
        else station.resume();
        tray?.rebuildMenu();
      },
      quit: () => app.quit(),
    });
  } catch {
    // Some Linux desktops have no tray: the window still works.
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--demo')) station?.startDemo();
    applyArgs(argv, false);
    windows?.focus();
  });

  applyArgs(process.argv, true);

  void app.whenReady().then(() => {
    installNetGuard(session.defaultSession);

    const initial = settings.get();
    station = new Station({
      version: app.getVersion(),
      port: initial.port,
      mode: process.argv.includes('--demo') ? 'demo-pinned' : 'live',
      tuning: tuningFrom(initial),
      onSnapshot: (snap) => windows?.window?.webContents.send(IPC.snapshot, snap),
      onStatusChange: pushStatus,
      onFirstHookEvent: () => {
        if (flags.hasReceivedEvents) return;
        flags.hasReceivedEvents = true;
        writeAppFlags(flags);
        pushStatus();
      },
      onCommand: handleCommand,
    });
    station.start().catch(() => {
      // Ingest unavailable (e.g. no free port): the app still opens; status shows no port.
    });

    settings.onChange((next, prev) => applySettings(next, prev));
    applySettings(initial);
    registerIpc();

    windows = new WindowManager({
      settings,
      onReady: (win) => {
        const queued = pendingCommands;
        pendingCommands = [];
        for (const cmd of queued) win.webContents.send(IPC.command, cmd);
        pushStatus();
      },
      onModeChange: () => tray?.rebuildMenu(),
    });
    windows.create();
    createTray();

    setInterval(() => {
      if (station) checkAttention(station.snapshot());
    }, STATUS_POLL_MS).unref();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) windows?.create();
      else windows?.focus();
    });
  });

  let stopping = false;
  app.on('before-quit', (e) => {
    settings.flush();
    if (stopping || !station) return;
    stopping = true;
    e.preventDefault();
    tray?.destroy();
    void station.stop().finally(() => app.quit());
  });

  // macOS keeps running in the menu bar when the window closes; elsewhere closing quits.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
