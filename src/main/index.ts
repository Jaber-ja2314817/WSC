import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { IPC, type AppInfo } from '@shared/ipc';
import { installNetGuard } from './netGuard';
import { Station } from './station';

const isDemo = process.argv.includes('--demo');
let mainWindow: BrowserWindow | null = null;
let station: Station | null = null;

function createWindow(): void {
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
  mainWindow.focus();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusWindow());

  void app.whenReady().then(() => {
    installNetGuard(session.defaultSession);

    station = new Station({
      version: app.getVersion(),
      offline: isDemo,
      onSnapshot: (snap) => mainWindow?.webContents.send(IPC.snapshot, snap),
    });
    station.start().catch(() => {
      // Ingest unavailable (e.g. no free port): the app still opens; status shows 0 events.
    });

    ipcMain.handle(IPC.getSnapshot, () => station?.snapshot());
    ipcMain.handle(IPC.appInfo, (): AppInfo => ({
      name: 'WSC',
      version: app.getVersion(),
      demo: isDemo,
    }));

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
