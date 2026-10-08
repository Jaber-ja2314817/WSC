import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AppInfo,
  type CameraState,
  type ConnectionTest,
  type RendererCommand,
  type StationStatus,
  type UserThemeData,
  type UserThemeInfo,
  type WindowMode,
  type WscApi,
} from '@shared/ipc';
import type { Settings } from '@shared/settings';
import type { StationSnapshot } from '@shared/types';

function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T): void => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: WscApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot) as Promise<StationSnapshot>,
  onSnapshot: (cb) => listen<StationSnapshot>(IPC.snapshot, cb),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  getStatus: () => ipcRenderer.invoke(IPC.getStatus) as Promise<StationStatus>,
  onStatus: (cb) => listen<StationStatus>(IPC.status, cb),
  testConnection: () => ipcRenderer.invoke(IPC.testConnection) as Promise<ConnectionTest>,
  startDemo: () => ipcRenderer.invoke(IPC.startDemo) as Promise<void>,
  onCommand: (cb) => listen<RendererCommand>(IPC.command, cb),
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text) as Promise<void>,
  listUserThemes: () => ipcRenderer.invoke(IPC.listUserThemes) as Promise<UserThemeInfo[]>,
  getUserTheme: (id) => ipcRenderer.invoke(IPC.getUserTheme, id) as Promise<UserThemeData | null>,
  onThemesChanged: (cb) => listen<void>(IPC.themesChanged, () => cb()),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<Settings>,
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch) as Promise<Settings>,
  onSettings: (cb) => listen<Settings>(IPC.settings, cb),
  clearIdleProjects: () => ipcRenderer.invoke(IPC.clearIdleProjects) as Promise<void>,
  getWindowMode: () => ipcRenderer.invoke(IPC.getWindowMode) as Promise<WindowMode>,
  setWindowMode: (mode) => ipcRenderer.invoke(IPC.setWindowMode, mode) as Promise<void>,
  onWindowMode: (cb) => listen<WindowMode>(IPC.windowMode, cb),
  getCamera: (mode) => ipcRenderer.invoke(IPC.getCamera, mode) as Promise<CameraState | null>,
  saveCamera: (mode, camera) => ipcRenderer.invoke(IPC.saveCamera, mode, camera) as Promise<void>,
  reportThemes: (themes) => ipcRenderer.send(IPC.reportThemes, themes),
};

contextBridge.exposeInMainWorld('wsc', api);
