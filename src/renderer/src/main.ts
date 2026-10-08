// Keeps the strict CSP (no 'unsafe-eval'): Pixi uses precompiled shaders/uniform syncs.
import 'pixi.js/unsafe-eval';
import { Application, TextureStyle } from 'pixi.js';
import { makePathfinder } from '@shared/astar';
import type { CameraState, WindowMode } from '@shared/ipc';
import { computeLayout } from '@shared/layout';
import type { LayoutInput, Rect, StationLayout, TilePos } from '@shared/layoutTypes';
import type { Settings } from '@shared/settings';
import type { StationSnapshot } from '@shared/types';
import { Director, type CrewView, type DirectorFrame, type DirectorSettings } from '../director';
import { mountPanels, type PanelsHandle } from '../panels';
import { mountCompact } from '../panels/Compact';
import { StationScene } from '../scene/StationScene';
import { formatElapsed } from '../scene/format';
import { ThemeManager } from '../themes/manager';
import type { ThemeRuntime } from '../themes/types';

// Crisp pixels: must be set before any texture is created.
TextureStyle.defaultOptions.scaleMode = 'nearest';

const MODE: WindowMode =
  new URLSearchParams(window.location.search).get('mode') === 'compact' ? 'compact' : 'normal';
const CAMERA_SAVE_MS = 2000;
/** Compact mode re-frames the camera on the active crew unless the user moved it recently. */
const COMPACT_REFIT_MS = 3000;
const COMPACT_HANDS_OFF_MS = 8000;

/** Only the facts that change the layout; anything else must not trigger a rebuild. */
function layoutInput(snap: StationSnapshot, loungeSize: number): LayoutInput {
  const agentCount = new Map<string, number>();
  for (const a of Object.values(snap.agents)) {
    if (a.isOrchestrator) continue;
    agentCount.set(a.projectId, (agentCount.get(a.projectId) ?? 0) + 1);
  }
  const projects = Object.values(snap.projects)
    .sort((a, b) => a.order - b.order)
    .map((p) => ({
      id: p.id,
      name: p.name,
      order: p.order,
      agentCount: agentCount.get(p.id) ?? 0,
    }));
  const active = Object.values(snap.sessions).filter((s) => s.endedAt === undefined).length;
  return { projects, orchestratorSeats: Math.max(1, active), loungeSize };
}

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
  if (!stage || !panel || !tooltip || !compactEl) return;
  document.body.classList.toggle('compact', MODE === 'compact');
  compactEl.hidden = MODE !== 'compact';

  const app = new Application();
  await app.init({
    resizeTo: stage,
    antialias: false,
    roundPixels: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    background: '#0b0e1a',
  });
  stage.prepend(app.canvas);

  let settings: Settings = await window.wsc.getSettings();
  let snapshot: StationSnapshot = await window.wsc.getSnapshot();
  let selected: string | undefined;
  let layout: StationLayout | null = null;
  let layoutKey = '';
  let pathfinder: (a: TilePos, b: TilePos) => TilePos[] | null = () => null;
  let theme: ThemeRuntime | null = null;
  let lastFrame: DirectorFrame | null = null;
  let lastInteraction = 0;

  const director = new Director({
    findPath: (a, b) => pathfinder(a, b),
    phrases: (m) => theme?.phrases(m) ?? [],
    settings: directorSettings(settings),
  });

  const select = (key: string | undefined): void => {
    selected = key;
    director.select(key);
    scene.setSelected(key);
    panels.select(key);
  };

  const scene = new StationScene(app, {
    onSelect: (key) => select(key),
    onZoneClick: (projectId) => scene.focusZone(projectId),
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
  panels.setSettings(settings);
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
    document.documentElement.style.setProperty('--accent', res.theme.palette.accent);
  };
  const refreshThemeList = async (): Promise<void> => {
    const list = await themes.list();
    panels.setThemes(list);
    window.wsc.reportThemes(list.map(({ id, name }) => ({ id, name })));
  };
  await applyTheme(settings.theme);
  void refreshThemeList();
  window.wsc.onThemesChanged(() => {
    themes.invalidate();
    void refreshThemeList();
    // Dev hot-reload: re-apply the current theme if it's a user theme being edited.
    if (themes.currentId && themes.currentId === settings.theme) void applyTheme(settings.theme);
  });

  // ── state ─────────────────────────────────────────────────────────────────
  const onSnapshot = (snap: StationSnapshot): void => {
    snapshot = snap;
    const input = layoutInput(snap, settings.loungeSize);
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
  };
  onSnapshot(snapshot);
  window.wsc.onSnapshot(onSnapshot);

  window.wsc.onSettings((next) => {
    const prev = settings;
    settings = next;
    director.setSettings(directorSettings(next));
    panels.setSettings(next);
    if (next.theme !== prev.theme) void applyTheme(next.theme);
    if (next.loungeSize !== prev.loungeSize) onSnapshot(snapshot);
  });
  reducedMotionQuery.addEventListener('change', () => {
    director.setSettings(directorSettings(settings));
  });

  window.wsc.onCommand((cmd) => {
    // Unknown theme ids land here (main only persists known ones): show the fallback warning.
    if (cmd.action === 'theme' && cmd.arg) void applyTheme(cmd.arg);
    else if (cmd.action === 'compact') void window.wsc.setWindowMode('compact');
  });

  // ── input ─────────────────────────────────────────────────────────────────
  document.getElementById('fit-all')?.addEventListener('click', () => scene.fitAll());
  const touch = (): void => {
    lastInteraction = Date.now();
  };
  stage.addEventListener('pointerdown', touch);
  stage.addEventListener('wheel', touch, { passive: true });
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

  let last = performance.now();
  app.ticker.add(() => {
    const t = performance.now();
    const dt = Math.min(100, t - last);
    last = t;
    const now = Date.now();
    const frame = director.update(now, dt);
    lastFrame = frame;
    scene.render(frame, now, dt);
  });

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
