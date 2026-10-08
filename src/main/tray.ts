// Tray / menu-bar icon with a status dot (idle / working / needs input) and a small menu.
import { join } from 'node:path';
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { StationSnapshot } from '@shared/types';

export type TrayStatus = 'idle' | 'working' | 'attention';

export interface TrayActions {
  show(): void;
  toggleCompact(): void;
  isCompact(): boolean;
  themes(): { id: string; name: string }[];
  currentTheme(): string;
  setTheme(id: string): void;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  quit(): void;
}

/** Any waiting agent → attention; any working/thinking agent → working; else idle. */
export function trayStatusFor(snap: StationSnapshot): TrayStatus {
  let working = false;
  for (const a of Object.values(snap.agents)) {
    if (a.status === 'waiting') return 'attention';
    if (a.status === 'working' || a.status === 'thinking') working = true;
  }
  return working ? 'working' : 'idle';
}

const LABEL: Record<TrayStatus, string> = {
  idle: 'idle',
  working: 'working',
  attention: 'needs your input',
};

export class StationTray {
  // Kept on the instance (held at module scope by the caller) so it is never garbage-collected.
  private tray: Tray;
  private status: TrayStatus = 'idle';
  private readonly icons = new Map<TrayStatus, Electron.NativeImage>();

  constructor(private readonly actions: TrayActions) {
    for (const s of ['idle', 'working', 'attention'] as const) this.icons.set(s, this.loadIcon(s));
    this.tray = new Tray(this.icons.get('idle')!);
    this.tray.setToolTip('WSC — idle');
    // Windows/Linux: a click shows the window. macOS opens the menu on click by default.
    this.tray.on('click', () => {
      if (process.platform !== 'darwin') this.actions.show();
    });
    this.rebuildMenu();
  }

  setStatus(status: TrayStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.tray.setImage(this.icons.get(status)!);
    this.tray.setToolTip(`WSC — ${LABEL[status]}`);
    this.rebuildMenu();
  }

  rebuildMenu(): void {
    const current = this.actions.currentTheme();
    const themeItems: MenuItemConstructorOptions[] = this.actions.themes().map((t) => ({
      label: t.name,
      type: 'radio',
      checked: t.id === current,
      click: () => this.actions.setTheme(t.id),
    }));
    const menu = Menu.buildFromTemplate([
      { label: `Status: ${LABEL[this.status]}`, enabled: false },
      { type: 'separator' },
      { label: 'Show', click: () => this.actions.show() },
      {
        label: 'Compact mode',
        type: 'checkbox',
        checked: this.actions.isCompact(),
        click: () => this.actions.toggleCompact(),
      },
      { label: 'Theme', submenu: themeItems },
      {
        label: 'Pause updates',
        type: 'checkbox',
        checked: this.actions.isPaused(),
        click: (item) => this.actions.setPaused(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit WSC', click: () => this.actions.quit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray.destroy();
  }

  private loadIcon(status: TrayStatus): Electron.NativeImage {
    const dir = join(app.getAppPath(), 'resources', 'tray');
    // macOS: template images (the OS tints them for light/dark menu bars; @2x picked up by name).
    const file =
      process.platform === 'darwin'
        ? `${status}Template.png`
        : `${status}${process.platform === 'win32' ? '' : '@2x'}.png`;
    const img = nativeImage.createFromPath(join(dir, file));
    if (process.platform === 'darwin') img.setTemplateImage(true);
    return img;
  }
}
