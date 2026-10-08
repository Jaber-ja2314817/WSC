import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AppInfo, type WscApi } from '@shared/ipc';
import type { StationSnapshot } from '@shared/types';

const api: WscApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot) as Promise<StationSnapshot>,
  onSnapshot: (cb) => {
    const listener = (_e: IpcRendererEvent, snap: StationSnapshot): void => cb(snap);
    ipcRenderer.on(IPC.snapshot, listener);
    return () => ipcRenderer.removeListener(IPC.snapshot, listener);
  },
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
};

contextBridge.exposeInMainWorld('wsc', api);
