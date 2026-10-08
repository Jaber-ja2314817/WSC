// Side panels (projects, crew, activity log, status bar) and the first-run setup screen.
import { render } from 'preact';
import type { StationStatus, WscApi } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import type { StationSnapshot } from '@shared/types';
import { FirstRun } from './FirstRun';
import { Panels } from './Panels';
import { SettingsPanel } from './Settings';
import './panels.css';

export interface MountPanelsOptions {
  /** Defaults to window.wsc. */
  api?: WscApi;
  onFocusProject: (projectId: string) => void;
  onSelectAgent: (agentKey?: string) => void;
}

export interface PanelsHandle {
  update(snap: StationSnapshot): void;
  /** Highlight a crew row (called when an agent is selected in the scene). */
  select(agentKey?: string): void;
  /** Force the first-run screen on/off. Without a call it shows automatically when needed. */
  showFirstRun(show: boolean): void;
  setSettings(settings: Settings): void;
  /** Themes for the picker (built-ins first, then user themes). */
  setThemes(themes: { id: string; name: string; source?: string }[]): void;
  setVersion(version: string): void;
}

type Tab = 'station' | 'settings';

const EMPTY: StationSnapshot = {
  projects: {},
  sessions: {},
  agents: {},
  log: [],
  eventsReceived: 0,
};

export function mountPanels(el: HTMLElement, opts: MountPanelsOptions): PanelsHandle {
  const api = opts.api ?? window.wsc;
  const overlay = document.createElement('div');
  overlay.className = 'wsc-overlay-root';
  document.body.appendChild(overlay);

  let snap = EMPTY;
  let status: StationStatus | null = null;
  let selected: string | undefined;
  let firstRunForced: boolean | undefined;
  let firstRunDismissed = false;
  let tab: Tab = 'station';
  let settings: Settings | null = null;
  let themes: { id: string; name: string; source?: string }[] = [];
  let version = '';

  const firstRunVisible = (): boolean => {
    if (firstRunForced !== undefined) return firstRunForced;
    if (firstRunDismissed || !status) return false;
    return !status.hasReceivedEvents && !status.demo && Object.keys(snap.agents).length === 0;
  };

  const draw = (): void => {
    const tabButton = (id: Tab, label: string) => (
      <button
        type="button"
        role="tab"
        aria-selected={tab === id}
        class={`wsc-tab${tab === id ? ' is-active' : ''}`}
        onClick={() => {
          tab = id;
          draw();
        }}
      >
        {label}
      </button>
    );
    render(
      <div class="wsc-panel-root">
        <div class="wsc-tabs" role="tablist">
          {tabButton('station', 'Station')}
          {tabButton('settings', '⚙ Settings')}
        </div>
        {tab === 'station' ? (
          <Panels
            snap={snap}
            status={status}
            selected={selected}
            onFocusProject={opts.onFocusProject}
            onSelectAgent={(key) => {
              selected = key;
              draw();
              opts.onSelectAgent(key);
            }}
          />
        ) : (
          <SettingsPanel api={api} settings={settings} themes={themes} version={version} />
        )}
      </div>,
      el,
    );
    render(
      firstRunVisible() ? (
        <FirstRun
          api={api}
          onClose={() => {
            firstRunDismissed = true;
            firstRunForced = undefined;
            draw();
          }}
        />
      ) : null,
      overlay,
    );
  };

  const setStatus = (s: StationStatus): void => {
    status = s;
    draw();
  };
  void api.getStatus().then(setStatus, () => {});
  api.onStatus(setStatus);
  draw();

  return {
    update(next) {
      snap = next;
      if (selected && !next.agents[selected]) selected = undefined;
      draw();
    },
    select(key) {
      if (selected === key) return;
      selected = key;
      draw();
      if (key) el.querySelector('.wsc-agent.is-selected')?.scrollIntoView({ block: 'nearest' });
    },
    showFirstRun(show) {
      firstRunForced = show;
      draw();
    },
    setSettings(next) {
      settings = next;
      draw();
    },
    setThemes(list) {
      themes = list;
      draw();
    },
    setVersion(v) {
      version = v;
      draw();
    },
  };
}
