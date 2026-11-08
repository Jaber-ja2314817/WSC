// IPC channel names and the API the preload exposes to the renderer.
import type { DashboardSnapshot, TimelineStep } from './dashboardTypes';
import type { Settings } from './settings';
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
  listUserThemes: 'wsc:list-user-themes',
  getUserTheme: 'wsc:get-user-theme',
  themesChanged: 'wsc:themes-changed',
  getSettings: 'wsc:get-settings',
  setSettings: 'wsc:set-settings',
  settings: 'wsc:settings',
  clearIdleProjects: 'wsc:clear-idle-projects',
  removeProject: 'wsc:remove-project',
  getWindowMode: 'wsc:get-window-mode',
  setWindowMode: 'wsc:set-window-mode',
  windowMode: 'wsc:window-mode',
  getCamera: 'wsc:get-camera',
  saveCamera: 'wsc:save-camera',
  reportThemes: 'wsc:report-themes',
  dashboard: 'wsc:dashboard',
  getDashboard: 'wsc:get-dashboard',
  getTimeline: 'wsc:get-timeline',
  visibility: 'wsc:visibility',
  rendererReady: 'wsc:renderer-ready',
} as const;

export type WindowMode = 'normal' | 'compact';

/** Persisted camera position (world px offset + zoom), per window mode. */
export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

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
  /** Something is wrong with settings.json; shown to the user as a banner. */
  settingsWarning?: string;
}

export interface ConnectionTest {
  ok: boolean;
  port?: number;
  error?: string;
}

/**
 * Commands pushed from main to the renderer (from `/station`, the tray or startup args).
 * Actions: 'theme-unknown' (arg = the theme id nobody knows), 'compact'. Unknown actions must be
 * ignored. Main holds them until the renderer calls `rendererReady()`.
 */
export interface RendererCommand {
  action: string;
  arg?: string;
}

/** A theme found in the user themes folder (not yet validated). */
export interface UserThemeInfo {
  id: string;
  name: string;
}

/** A user theme's raw manifest plus its PNG assets as data: URLs, keyed by manifest path. */
export interface UserThemeData {
  manifest: unknown;
  assets: Record<string, string>;
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
  /** Themes in <appData>/WSC/themes. */
  listUserThemes(): Promise<UserThemeInfo[]>;
  getUserTheme(id: string): Promise<UserThemeData | null>;
  /** The user themes folder changed on disk. */
  onThemesChanged(cb: () => void): () => void;
  getSettings(): Promise<Settings>;
  /** Partial update; invalid fields are ignored. Resolves to the saved settings. */
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  onSettings(cb: (settings: Settings) => void): () => void;
  clearIdleProjects(): Promise<void>;
  /** Remove a project zone; new activity in that folder brings it back. */
  removeProject(projectId: string): Promise<void>;
  getWindowMode(): Promise<WindowMode>;
  setWindowMode(mode: WindowMode | 'toggle'): Promise<void>;
  onWindowMode(cb: (mode: WindowMode) => void): () => void;
  getCamera(mode: WindowMode): Promise<CameraState | null>;
  saveCamera(mode: WindowMode, camera: CameraState): Promise<void>;
  /** Renderer → main: the themes it can load (built-in + user), for the tray menu. */
  reportThemes(themes: { id: string; name: string }[]): void;
  getDashboard(): Promise<DashboardSnapshot | null>;
  /** Pushed at most every 500 ms when something changed, and every 5 s for timers. */
  onDashboard(cb: (dash: DashboardSnapshot) => void): () => void;
  /** Newest first, capped at 300 steps. Empty for unknown sessions. */
  getTimeline(sessionId: string): Promise<TimelineStep[]>;
  /** Renderer → main: the window became visible/hidden. Hidden: main pushes nothing. */
  setVisible(visible: boolean): void;
  /** Renderer → main: `onCommand` is listening, send what was held back. */
  rendererReady(): void;
}

/** Electron's login items exist on macOS and Windows only. Takes `navigator.userAgent`. */
export function supportsLoginItem(userAgent: string): boolean {
  return !/\bLinux\b/.test(userAgent);
}
