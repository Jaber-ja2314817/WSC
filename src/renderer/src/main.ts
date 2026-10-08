// Keeps the strict CSP (no 'unsafe-eval'): Pixi uses precompiled shaders/uniform syncs.
import 'pixi.js/unsafe-eval';
import { Application, TextureStyle } from 'pixi.js';
import { makePathfinder } from '@shared/astar';
import { computeLayout } from '@shared/layout';
import type { LayoutInput, StationLayout, TilePos } from '@shared/layoutTypes';
import type { StationSnapshot } from '@shared/types';
import { Director, type CrewView } from '../director';
import { mountPanels } from '../panels';
import { StationScene } from '../scene/StationScene';
import { formatElapsed } from '../scene/format';
import { DEFAULT_THEME_ID, loadBuiltInTheme } from '../themes/loader';
import type { ThemeRuntime } from '../themes/types';

// Crisp pixels: must be set before any texture is created.
TextureStyle.defaultOptions.scaleMode = 'nearest';

const LOUNGE_SIZE = 6;

/** Only the facts that change the layout; anything else must not trigger a rebuild. */
function layoutInput(snap: StationSnapshot): LayoutInput {
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
  return { projects, orchestratorSeats: Math.max(1, active), loungeSize: LOUNGE_SIZE };
}

function showBanner(text: string): void {
  const el = document.getElementById('banner');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 8000);
}

async function boot(): Promise<void> {
  const stage = document.getElementById('stage');
  const panel = document.getElementById('panel');
  const tooltip = document.getElementById('tooltip');
  if (!stage || !panel || !tooltip) return;

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

  let snapshot: StationSnapshot = await window.wsc.getSnapshot();
  let selected: string | undefined;
  let layout: StationLayout | null = null;
  let layoutKey = '';
  let pathfinder: (a: TilePos, b: TilePos) => TilePos[] | null = () => null;
  let theme: ThemeRuntime | null = null;

  const director = new Director({
    findPath: (a, b) => pathfinder(a, b),
    phrases: (m) => theme?.phrases(m) ?? [],
    settings: {
      loungeSize: LOUNGE_SIZE,
      reduceMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    },
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

  const panels = mountPanels(panel, {
    api: window.wsc,
    onFocusProject: (projectId) => scene.focusZone(projectId),
    onSelectAgent: (key) => select(key),
  });

  const applyTheme = async (id: string): Promise<void> => {
    const res = await loadBuiltInTheme(id);
    if (res.warning) showBanner(res.warning);
    const old = theme;
    theme = res.theme;
    scene.setTheme(res.theme);
    old?.destroy();
    document.documentElement.style.setProperty('--accent', res.theme.palette.accent);
  };
  await applyTheme(DEFAULT_THEME_ID);

  const onSnapshot = (snap: StationSnapshot): void => {
    snapshot = snap;
    const input = layoutInput(snap);
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
  };
  onSnapshot(snapshot);
  window.wsc.onSnapshot(onSnapshot);

  window.wsc.onCommand((cmd) => {
    if (cmd.action === 'theme' && cmd.arg) void applyTheme(cmd.arg);
  });

  document.getElementById('fit-all')?.addEventListener('click', () => scene.fitAll());

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
    scene.render(frame, now, dt);
  });

  // Exposed for the e2e smoke test (read-only diagnostics, no state access beyond counts).
  (window as unknown as { __wscDebug: () => unknown }).__wscDebug = () => ({
    zones: layout?.zones.length ?? 0,
    selected,
    theme: theme?.id,
  });
}

void boot();
