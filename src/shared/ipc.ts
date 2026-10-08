// IPC channel names and the API the preload exposes to the renderer.
import type { StationSnapshot } from './types';

export const IPC = {
  snapshot: 'wsc:snapshot',
  getSnapshot: 'wsc:get-snapshot',
  appInfo: 'wsc:app-info',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  demo: boolean;
}

export interface WscApi {
  getSnapshot(): Promise<StationSnapshot>;
  onSnapshot(cb: (snap: StationSnapshot) => void): () => void;
  appInfo(): Promise<AppInfo>;
}
