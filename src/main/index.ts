import { join } from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, session, shell } from 'electron';
import { IPC, type AppInfo, type RendererCommand, type StationStatus } from '@shared/ipc';
import { readAppFlags, writeAppFlags } from './appState';
import { installNetGuard } from './netGuard';
import type { StationCommand } from './server';
import { Station } from './station';

let mainWindow: BrowserWindow | null = null;
let station: Station | null = null;
let rendererReady = false;
let pendingCommands: RendererCommand[] = [];
const flags = readAppFlags();

/** Startup args → renderer commands (`--compact`, `--theme=<id>`), shared with second-instance. */
function argCommands(argv: readonly string[]): RendererCommand[] {
  const out: RendererCommand[] = [];
  for (const a of argv) {
    if (a === '--compact') out.push({ action: 'compact' });
    else if (a.startsWith('--theme=') && a.length > 8)
      out.push({ action: 'theme', arg: a.slice(8) });
  }
  return out;
}

function sendToRenderer(cmd: RendererCommand): void {
  if (mainWindow && rendererReady) mainWindow.webContents.send(IPC.command, cmd);
  else pendingCommands.push(cmd);
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
  mainWindow?.webContents.send(IPC.status, status());
}

function createWindow(): void {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: 'WSC',
    backgroundColor: '#0b0e1a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    const queued = pendingCommands;
    pendingCommands = [];
    for (const cmd of queued) mainWindow?.webContents.send(IPC.command, cmd);
    pushStatus();
  });
  // External links open in the user's browser; nothing navigates the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

function focusWindow(): void {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  mainWindow.focus();
}

/** `/station` launcher commands arriving over the local HTTP server. */
function handleCommand(cmd: StationCommand): unknown {
  switch (cmd.action) {
    case 'focus':
      focusWindow();
      return undefined;
    case 'demo':
      station?.startDemo();
      focusWindow();
      return undefined;
    case 'compact':
    case 'theme':
      sendToRenderer({ action: cmd.action, ...(cmd.arg ? { arg: cmd.arg } : {}) });
      focusWindow();
      return undefined;
    case 'status':
      return { running: true, version: app.getVersion(), ...status() };
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--demo')) station?.startDemo();
    for (const cmd of argCommands(argv)) sendToRenderer(cmd);
    focusWindow();
  });

  void app.whenReady().then(() => {
    installNetGuard(session.defaultSession);

    station = new Station({
      version: app.getVersion(),
      mode: process.argv.includes('--demo') ? 'demo-pinned' : 'live',
      onSnapshot: (snap) => mainWindow?.webContents.send(IPC.snapshot, snap),
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

    for (const cmd of argCommands(process.argv)) sendToRenderer(cmd);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  let stopping = false;
  app.on('before-quit', (e) => {
    if (stopping || !station) return;
    stopping = true;
    e.preventDefault();
    void station.stop().finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
