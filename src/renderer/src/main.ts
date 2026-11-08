// Keeps the strict CSP (no 'unsafe-eval'): Pixi uses precompiled shaders/uniform syncs.
import 'pixi.js/unsafe-eval';
import { Application, TextureStyle, Ticker } from 'pixi.js';
import { makePathfinder } from '@shared/astar';
import type { CameraState, StationStatus, WindowMode } from '@shared/ipc';
import { computeLayout, layoutInputFor, SlotBook } from '@shared/layout';
import type { Rect, StationLayout, TilePos } from '@shared/layoutTypes';
import type { Settings } from '@shared/settings';
import { ORCHESTRATOR_ID, type StationSnapshot } from '@shared/types';
import { Director, type CrewView, type DirectorFrame, type DirectorSettings } from '../director';
import { mountPanels, type PanelsHandle } from '../panels';
import { mountCompact } from '../panels/Compact';
import { mountDashboard, type DashboardHandle } from '../panels/Dashboard';
import { sessionIdFromAgentKey } from '../panels/dashboardModel';
import { StationScene } from '../scene/StationScene';
import { frameHasMotion, stillFps, targetFps } from '../scene/pacing';
import { formatElapsed } from '../scene/format';
import { DEFAULT_THEME_ID } from '../themes/loader';
import { ThemeManager } from '../themes/manager';
import type { ThemeRuntime } from '../themes/types';

// Crisp pixels: must be set before any texture is created.
TextureStyle.defaultOptions.scaleMode = 'nearest';

const MODE: WindowMode =
  new URLSearchParams(window.location.search).get('mode') === 'compact' ? 'compact' : 'normal';
const CAMERA_SAVE_MS = 2000;
/** Sprite loop rate assumed before a theme is loaded. */
const IDLE_FPS_FALLBACK = 10;
/** Compact mode re-frames the camera on the active crew unless the user moved it recently. */
const COMPACT_REFIT_MS = 3000;
const COMPACT_HANDS_OFF_MS = 8000;

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

function directorSettings(s: Settings): Partial<DirectorSettings> {
  return {
    loungeSize: s.loungeSize,
    reportFrequency: s.reportFrequency,
    statusBubbles: s.statusBubbles,
    catchphraseBubbles: s.catchphraseBubbles,
    reduceMotion:
      s.reduceMotion === 'system' ? reducedMotionQuery.matches : s.reduceMotion === 'on',
    idleProjectMs: s.idleProjectMinutes * 60_000,
  };
}

/** Theme palette → CSS vars used by the panels and the dashboard (fallbacks live in the CSS). */
function applyPalette(p: ThemeRuntime['palette']): void {
  const root = document.documentElement.style;
  const vars: [string, string][] = [
    ['--bg', p.background],
    ['--panel', p.panel],
    ['--text', p.text],
    ['--accent', p.accent],
    ['--working', p.working],
    ['--waiting', p.waiting],
    ['--done', p.done],
    ['--error', p.error],
    ['--stale', p.stale],
  ];
  for (const [name, value] of vars) {
    if (value) root.setProperty(name, value);
  }
}

function showBanner(text: string): void {
  const el = document.getElementById('banner');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 8000);
}

/** Tile rect covering the center plus every crew member bound to a real agent. */
function activeBounds(layout: StationLayout, frame: DirectorFrame | null): Rect {
  const c = layout.center.rect;
  let x0 = c.x;
  let y0 = c.y;
  let x1 = c.x + c.w;
  let y1 = c.y + c.h;
  for (const crew of frame?.crew ?? []) {
    if (!crew.agentKey || crew.isOrchestrator) continue;
    x0 = Math.min(x0, Math.floor(crew.x) - 1);
    y0 = Math.min(y0, Math.floor(crew.y) - 2);
    x1 = Math.max(x1, Math.ceil(crew.x) + 2);
    y1 = Math.max(y1, Math.ceil(crew.y) + 1);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

async function boot(): Promise<void> {
  const stage = document.getElementById('stage');
  const panel = document.getElementById('panel');
  const tooltip = document.getElementById('tooltip');
  const compactEl = document.getElementById('compact');
  const zoneMenu = document.getElementById('zone-menu');
  const dashboardEl = document.getElementById('dashboard');
  if (!stage || !panel || !tooltip || !compactEl || !zoneMenu || !dashboardEl) return;
  document.body.classList.toggle('compact', MODE === 'compact');
  compactEl.hidden = MODE !== 'compact';

  // One paced loop (below) drives every Pixi ticker: left alone, each would run its own
  // requestAnimationFrame loop at the display rate (60–120 Hz) even when nothing moves.
  for (const t of [Ticker.shared, Ticker.system]) {
    t.autoStart = false;
    t.stop();
  }
  const app = new Application();
  await app.init({
    sharedTicker: true,
    autoStart: false,
    powerPreference: 'low-power',
    resizeTo: stage,
    antialias: false,
    roundPixels: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    background: '#0b0e1a',
  });
  stage.prepend(app.canvas);
  // The stage also changes size when the dashboard column collapses/expands.
  new ResizeObserver(() => app.queueResize()).observe(stage);

  let settings: Settings = await window.wsc.getSettings();
  let snapshot: StationSnapshot = await window.wsc.getSnapshot();
  let selected: string | undefined;
  let layout: StationLayout | null = null;
  let layoutKey = '';
  const slots = new SlotBook();
  let pathfinder: (a: TilePos, b: TilePos) => TilePos[] | null = () => null;
  let theme: ThemeRuntime | null = null;
  let lastFrame: DirectorFrame | null = null;
  let lastInteraction = 0;
  // Frame loop state (the loop itself is at the end of boot()).
  let last = performance.now();
  let lastDrawAt = 0;
  let inputAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerDue = 0;
  let rafPending = false;

  const director = new Director({
    findPath: (a, b) => pathfinder(a, b),
    phrases: (m) => theme?.phrases(m) ?? [],
    settings: directorSettings(settings),
  });

  /** `fromDashboard`: the dashboard already shows the selection, don't echo it back. */
  const select = (key: string | undefined, fromDashboard = false): void => {
    selected = key;
    director.select(key);
    scene.setSelected(key);
    panels.select(key);
    if (!fromDashboard) dashboard.select(sessionIdFromAgentKey(key));
  };

  // Dashboard card → station: select the session's orchestrator and frame its project.
  const selectSession = (sessionId: string | undefined): void => {
    const key = sessionId ? `${sessionId}:${ORCHESTRATOR_ID}` : undefined;
    const agent = key ? snapshot.agents[key] : undefined;
    if (agent && key) {
      select(key, true);
      scene.focusZone(agent.projectId);
    } else if (selected) {
      select(undefined, true);
    }
  };

  const scene = new StationScene(app, {
    onSelect: (key) => select(key),
    onZoneClick: (projectId) => scene.focusZone(projectId),
    onZoneContextMenu: (projectId, x, y) => openZoneMenu(projectId, x, y),
    onHover: (crew, x, y) => renderTooltip(crew, x, y),
  });
  scene.restoreView(await window.wsc.getCamera(MODE).catch(() => null));

  // Compact mode has no side panel: a stub keeps the call sites simple.
  const panels: PanelsHandle =
    MODE === 'normal'
      ? mountPanels(panel, {
          api: window.wsc,
          onFocusProject: (projectId) => scene.focusZone(projectId),
          onSelectAgent: (key) => select(key),
        })
      : {
          update: () => {},
          select: () => {},
          showFirstRun: () => {},
          setSettings: () => {},
          setThemes: () => {},
          setVersion: () => {},
        };
  const compact = MODE === 'compact' ? mountCompact(compactEl, window.wsc) : null;
  // Compact mode hides the dashboard column (CSS); a stub keeps the call sites simple.
  const dashboard: DashboardHandle =
    MODE === 'normal'
      ? mountDashboard(dashboardEl, {
          api: window.wsc,
          onSelectSession: selectSession,
        })
      : { select: () => {}, setSettings: () => {} };
  panels.setSettings(settings);
  dashboard.setSettings(settings);
  void window.wsc.appInfo().then((info) => panels.setVersion(info.version));

  // ── themes ────────────────────────────────────────────────────────────────
  const themes = new ThemeManager(window.wsc);
  const applyTheme = async (id: string): Promise<void> => {
    const res = await themes.switchTo(id, (t) => {
      theme = t;
      scene.setTheme(t);
    });
    if (!res) return; // superseded by a newer switch
    if (res.warning) showBanner(res.warning);
    applyPalette(res.theme.palette);
  };
  const refreshThemeList = async (): Promise<void> => {
    const list = await themes.list();
    panels.setThemes(list);
    window.wsc.reportThemes(list.map(({ id, name }) => ({ id, name })));
  };
  // A theme that throws must not stop boot: that would leave no snapshots and no frame loop.
  await applyTheme(settings.theme).catch(() => applyTheme(DEFAULT_THEME_ID));
  void refreshThemeList();
  window.wsc.onThemesChanged(() => {
    themes.invalidate();
    void refreshThemeList();
    // Re-apply the current theme if it's a user theme being edited.
    if (themes.currentId === settings.theme && themes.isUserTheme(settings.theme)) {
      void applyTheme(settings.theme);
    }
  });

  // ── state ─────────────────────────────────────────────────────────────────
  const onSnapshot = (snap: StationSnapshot): void => {
    snapshot = snap;
    const input = slots.assign(layoutInputFor(snap, settings.loungeSize));
    const key = JSON.stringify(input);
    if (key !== layoutKey || !layout) {
      layoutKey = key;
      layout = computeLayout(input);
      pathfinder = makePathfinder(layout);
      director.setLayout(layout);
      scene.setLayout(layout);
    }
    director.setSnapshot(snap, Date.now());
    panels.update(snap);
    compact?.update(snap);
    wake();
  };
  onSnapshot(snapshot);
  window.wsc.onSnapshot(onSnapshot);

  window.wsc.onSettings((next) => {
    const prev = settings;
    settings = next;
    director.setSettings(directorSettings(next));
    panels.setSettings(next);
    dashboard.setSettings(next);
    if (next.theme !== prev.theme) void applyTheme(next.theme);
    if (next.loungeSize !== prev.loungeSize) onSnapshot(snapshot);
  });
  reducedMotionQuery.addEventListener('change', () => {
    director.setSettings(directorSettings(settings));
  });

  window.wsc.onCommand((cmd) => {
    if (cmd.action === 'theme-unknown' && cmd.arg) {
      showBanner(`Theme "${cmd.arg}" was not found. Keeping the current theme.`);
    } else if (cmd.action === 'compact') void window.wsc.setWindowMode('compact');
  });
  window.wsc.rendererReady();

  let settingsWarning: string | undefined;
  const warnSettings = (s: StationStatus): void => {
    if (s.settingsWarning === settingsWarning) return;
    settingsWarning = s.settingsWarning;
    if (settingsWarning) showBanner(settingsWarning);
  };
  void window.wsc.getStatus().then(warnSettings);
  window.wsc.onStatus(warnSettings);

  // ── input ─────────────────────────────────────────────────────────────────
  document.getElementById('fit-all')?.addEventListener('click', () => scene.fitAll());
  const touch = (): void => {
    lastInteraction = Date.now();
    wake();
  };
  stage.addEventListener('pointerdown', touch);
  stage.addEventListener('wheel', touch, { passive: true });
  // Hover labels and tooltips: draw smoothly while the pointer moves, without counting as a
  // camera interaction (compact mode's auto-framing keys off lastInteraction).
  stage.addEventListener('pointermove', () => {
    inputAt = Date.now();
    wake();
  });
  window.addEventListener('keydown', (e) => {
    // ⌘/Ctrl+Shift+M toggles compact mode.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      void window.wsc.setWindowMode('toggle');
    } else touch();
  });

  // ── camera persistence + compact auto-framing ─────────────────────────────
  let savedCamera = JSON.stringify(scene.getView());
  setInterval(() => {
    const view: CameraState = scene.getView();
    const json = JSON.stringify(view);
    if (json === savedCamera) return;
    savedCamera = json;
    void window.wsc.saveCamera(MODE, view);
  }, CAMERA_SAVE_MS);
  if (MODE === 'compact') {
    setInterval(() => {
      if (!layout || Date.now() - lastInteraction < COMPACT_HANDS_OFF_MS) return;
      scene.focusTiles(activeBounds(layout, lastFrame));
    }, COMPACT_REFIT_MS);
  }

  // ── zone right-click menu ─────────────────────────────────────────────────
  let menuProject: string | undefined;
  const closeZoneMenu = (): void => {
    menuProject = undefined;
    zoneMenu.hidden = true;
  };
  const openZoneMenu = (projectId: string, x: number, y: number): void => {
    const project = snapshot.projects[projectId];
    if (!project) return;
    menuProject = projectId;
    const title = zoneMenu.querySelector('.zone-menu-title');
    if (title) title.textContent = project.name;
    renderTooltip(null, 0, 0);
    zoneMenu.hidden = false;
    // Keep the menu inside the stage.
    const maxX = Math.max(0, (stage?.clientWidth ?? 0) - zoneMenu.offsetWidth - 4);
    const maxY = Math.max(0, (stage?.clientHeight ?? 0) - zoneMenu.offsetHeight - 4);
    zoneMenu.style.left = `${Math.min(x, maxX)}px`;
    zoneMenu.style.top = `${Math.min(y, maxY)}px`;
    zoneMenu.querySelector('button')?.focus();
  };
  zoneMenu.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest('button')?.dataset['action'];
    const projectId = menuProject;
    closeZoneMenu();
    if (action === 'remove' && projectId) {
      if (selected && snapshot.agents[selected]?.projectId === projectId) select(undefined);
      void window.wsc.removeProject(projectId);
    }
  });
  zoneMenu.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('pointerdown', (e) => {
    if (!zoneMenu.hidden && !zoneMenu.contains(e.target as Node)) closeZoneMenu();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeZoneMenu();
  });
  stage.addEventListener('wheel', closeZoneMenu, { passive: true });

  function renderTooltip(crew: CrewView | null, x: number, y: number): void {
    if (!tooltip) return;
    if (!crew) {
      tooltip.hidden = true;
      return;
    }
    const agent = crew.agentKey ? snapshot.agents[crew.agentKey] : undefined;
    const project = crew.projectId ? snapshot.projects[crew.projectId]?.name : undefined;
    const lines = [
      crew.label,
      project ? `project: ${project}` : agent ? '' : 'free crew — waiting in the lounge',
      agent ? `status: ${agent.status}` : '',
      agent?.currentTool
        ? `tool: ${agent.currentTool.name}${agent.currentTool.summary ? ` · ${agent.currentTool.summary}` : ''}`
        : '',
      agent
        ? `step: ${formatElapsed(Date.now() - agent.stepStartedAt)} · ${agent.toolCalls} tool calls`
        : '',
    ].filter(Boolean);
    tooltip.textContent = lines.join('\n');
    tooltip.hidden = false;
    const max = stage?.clientWidth ?? 0;
    tooltip.style.left = `${Math.min(x + 14, Math.max(0, max - 240))}px`;
    tooltip.style.top = `${y + 14}px`;
  }

  // ── frame loop ────────────────────────────────────────────────────────────
  // 30 fps while anything moves, 4–10 fps when still, nothing while hidden (scene/pacing.ts).
  // Pixi caps a frame's time step at 1/minFPS: allow the slow idle steps so sprite loops keep
  // their real speed.
  app.ticker.minFPS = 2;
  app.ticker.add(() => {
    const t = performance.now();
    const dt = Math.min(100, t - last);
    last = t;
    const now = Date.now();
    const frame = director.update(now, dt);
    lastFrame = frame;
    scene.render(frame, now, dt);
  });
  function fpsNow(): number {
    const now = Date.now();
    return targetFps({
      hidden: document.hidden,
      motion: frameHasMotion(lastFrame, now),
      still: stillFps(lastFrame, (anim) => theme?.crewFps(anim) ?? IDLE_FPS_FALLBACK),
      sceneBusy: scene.isBusy(now),
      sinceInputMs: Math.min(now - inputAt, now - lastInteraction),
    });
  }
  function draw(t: number): void {
    rafPending = false;
    lastDrawAt = t;
    Ticker.system.update(t); // Pixi housekeeping (texture GC)
    app.ticker.update(t); // sprite animations, director + scene, then the render
    pump();
  }
  /** Schedule the next frame: wait out the frame interval, then draw on a vsync. */
  function pump(): void {
    if (timer !== undefined || rafPending) return;
    const fps = fpsNow();
    if (fps === 0) return; // hidden: visibilitychange restarts the loop
    const wait = Math.max(0, lastDrawAt + 1000 / fps - performance.now() - 4);
    timerDue = performance.now() + wait;
    timer = setTimeout(() => {
      timer = undefined;
      rafPending = true;
      requestAnimationFrame(draw);
    }, wait);
  }
  /** Something changed (input, new state): don't wait out a slow idle interval. */
  function wake(): void {
    if (timer !== undefined) {
      const fps = fpsNow();
      if (fps > 0 && timerDue > lastDrawAt + 1000 / fps) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
    pump();
  }
  const reportVisibility = (): void => {
    window.wsc.setVisible(!document.hidden);
    wake();
  };
  document.addEventListener('visibilitychange', reportVisibility);
  reportVisibility();

  // Exposed for the e2e tests (read-only diagnostics, no state access beyond counts).
  (window as unknown as { __wscDebug: () => unknown }).__wscDebug = () => ({
    zones: layout?.zones.length ?? 0,
    selected,
    theme: theme?.id,
    mode: MODE,
    loungeSize: settings.loungeSize,
  });
}

void boot();
