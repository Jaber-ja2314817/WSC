import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AppInfo,
  type ConnectionTest,
  type RendererCommand,
  type StationStatus,
  type WscApi,
} from '@shared/ipc';
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
};

contextBridge.exposeInMainWorld('wsc', api);
