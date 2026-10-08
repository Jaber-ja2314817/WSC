// IPC channel names and the API the preload exposes to the renderer.
import type { StationSnapshot } from './types';

export const IPC = {
  snapshot: 'wsc:snapshot',
  getSnapshot: 'wsc:get-snapshot',
  appInfo: 'wsc:app-info',
  getStatus: 'wsc:get-status',
  testConnection: 'wsc:test-connection',
  startDemo: 'wsc:start-demo',
  command: 'wsc:command',
  status: 'wsc:status',
  copyText: 'wsc:copy-text',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  demo: boolean;
}

export interface StationStatus {
  /** Ingest port, absent in demo mode or if the server could not start. */
  port?: number;
  eventsReceived: number;
  /** True once any real hook event has ever reached this install (persisted flag). */
  hasReceivedEvents: boolean;
  demo: boolean;
}

export interface ConnectionTest {
  ok: boolean;
  port?: number;
  error?: string;
}

/**
 * Commands pushed from main to the renderer (from `/station`, the tray or startup args).
 * Actions: 'theme' (arg = theme id), 'compact'. Unknown actions must be ignored.
 */
export interface RendererCommand {
  action: string;
  arg?: string;
}

export interface WscApi {
  getSnapshot(): Promise<StationSnapshot>;
  onSnapshot(cb: (snap: StationSnapshot) => void): () => void;
  appInfo(): Promise<AppInfo>;
  getStatus(): Promise<StationStatus>;
  onStatus(cb: (status: StationStatus) => void): () => void;
  testConnection(): Promise<ConnectionTest>;
  startDemo(): Promise<void>;
  onCommand(cb: (cmd: RendererCommand) => void): () => void;
  /** Clipboard write via main (the sandboxed renderer has no clipboard permission). */
  copyText(text: string): Promise<void>;
}
