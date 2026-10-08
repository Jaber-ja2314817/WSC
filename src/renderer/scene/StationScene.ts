// PixiJS station scene: draws a StationLayout with a theme, and DirectorFrames on top of it.
// World layers are in tile-pixel space (scaled by the camera); text lives in a screen-space
// overlay so labels and bubbles stay crisp at any zoom.
import {
  AnimatedSprite,
  Container,
  Graphics,
  NineSliceSprite,
  Sprite,
  Text,
  TilingSprite,
  type Application,
  type Texture,
} from 'pixi.js';
import type { Rect, StationLayout, ZoneLayout } from '@shared/layoutTypes';
import { DESK_H, DESK_W } from '@shared/layoutTypes';
import type { AgentStatus } from '@shared/types';
import type { BubbleView, CrewView, DirectorFrame, ZoneStatusView } from '../director/types';
import type { ThemeRuntime } from '../themes/types';
import { Camera, type View } from './Camera';
import { formatElapsed, stackBoxes, truncateLabel, zoneSummary, type Box } from './format';

const UNFOLD_MS = 600;
const BUBBLE_FADE_MS = 400;

interface CrewNode {
  sprite: AnimatedSprite;
  ring: Graphics;
  gear: Sprite;
  label: Text;
  elapsed: Text;
  dot: Graphics;
  texKey: string;
  dotColor: string;
  labelText: string;
  elapsedText: string;
  view: CrewView;
}

interface BubbleNode {
  root: Container;
  bg: Graphics;
  text: Text;
  key: string;
}

interface ZoneNode {
  layout: ZoneLayout;
  floor: Container;
  props: Container[];
  plate: Text;
  plateText: string;
  plateColor: string;
  appearedAt: number;
}

export interface SceneCallbacks {
  onSelect?: (agentKey: string | undefined) => void;
  onHover?: (crew: CrewView | null, screenX: number, screenY: number) => void;
  onZoneClick?: (projectId: string) => void;
}

const isCrewWorking = (s: AgentStatus): boolean => s === 'working';

export class StationScene {
  readonly camera: Camera;
  private readonly backdrop = new TilingSprite();
  private readonly world = new Container();
  private readonly baseFloor = new Container();
  private readonly zoneFloors = new Container();
  private readonly pathLayer = new Graphics();
  private readonly actors = new Container();
  private readonly overlay = new Container();
  private readonly roomLabels = new Container();
  private readonly plates = new Container();
  private readonly crewLabels = new Container();
  private readonly bubbleLayer = new Container();

  private theme: ThemeRuntime | null = null;
  private layout: StationLayout | null = null;
  private zones = new Map<string, ZoneNode>();
  private centerProps: Container[] = [];
  private crew = new Map<string, CrewNode>();
  private bubbles = new Map<string, BubbleNode>();
  private selected: string | undefined;
  private hovered: string | undefined;
  private hasFitted = false;
  private pendingView: View | null = null;
  private detachInput: (() => void) | null = null;
  private resolution = Math.max(1, Math.round(window.devicePixelRatio || 1));

  constructor(
    private readonly app: Application,
    private readonly cb: SceneCallbacks = {},
  ) {
    this.actors.sortableChildren = true;
    this.world.addChild(this.baseFloor, this.zoneFloors, this.pathLayer, this.actors);
    this.overlay.addChild(this.roomLabels, this.plates, this.crewLabels, this.bubbleLayer);
    app.stage.addChild(this.backdrop, this.world, this.overlay);
    this.camera = new Camera(this.world);
    this.camera.setScreenSize(app.screen.width, app.screen.height);
    app.renderer.on('resize', (w: number, h: number) => {
      this.camera.setScreenSize(w, h);
      this.backdrop.width = w;
      this.backdrop.height = h;
    });
    this.detachInput = this.attachPointer(app.canvas);
    this.camera.attach(app.canvas);
  }

  get tile(): number {
    return this.theme?.tileSize ?? 16;
  }

  setTheme(theme: ThemeRuntime): void {
    this.theme = theme;
    // Crew textures change completely: drop the pools and rebuild everything.
    for (const id of [...this.crew.keys()]) this.removeCrew(id);
    for (const id of [...this.bubbles.keys()]) this.removeBubble(id);
    const tex = theme.backdrop?.(256, 256) ?? null;
    this.backdrop.texture = tex ?? emptyTexture();
    this.backdrop.visible = !!tex;
    this.backdrop.width = this.app.screen.width;
    this.backdrop.height = this.app.screen.height;
    this.app.renderer.background.color = theme.palette.background;
    if (this.layout) this.build(this.layout, new Set(this.zones.keys()));
  }

  setLayout(layout: StationLayout): void {
    const known = new Set(this.zones.keys());
    const prev = this.layout;
    this.layout = layout;
    this.build(layout, known);
    // computeLayout may translate the whole grid when zones are added or grow; positions relative
    // to the center are stable. Pan by the shift so the view doesn't jump — only the new zone
    // unfolding should be visible.
    if (prev) {
      const dx = layout.center.rect.x - prev.center.rect.x;
      const dy = layout.center.rect.y - prev.center.rect.y;
      if (dx || dy) {
        const k = this.tile * this.camera.zoom;
        this.camera.panBy(-Math.round(dx * k), -Math.round(dy * k));
      }
    }
  }

  setSelected(agentKey: string | undefined): void {
    this.selected = agentKey;
  }

  fitAll(): void {
    this.camera.fitAll();
  }

  /** Saved camera to use instead of the initial "fit all" (call before the first layout). */
  restoreView(view: View | null): void {
    if (!view) return;
    if (this.hasFitted) this.camera.setView(view);
    else this.pendingView = view;
  }

  getView(): View {
    return this.camera.getView();
  }

  /** Animate the camera to show a tile-space rect (e.g. compact mode's "center + active crew"). */
  focusTiles(r: Rect, animate = true): void {
    this.camera.focusRect(this.rectPx(r), animate);
  }

  focusZone(projectId: string): void {
    const z = this.layout?.zones.find((zz) => zz.projectId === projectId);
    if (z) this.camera.focusRect(this.rectPx(z.rect));
  }

  /** Per-frame draw. */
  render(frame: DirectorFrame, now: number, dtMs: number): void {
    this.camera.update(dtMs);
    if (!this.theme || !this.layout) return;

    // Parallax-lite backdrop.
    const wp = this.world.position;
    this.backdrop.tilePosition.set(Math.round(wp.x * 0.3), Math.round(wp.y * 0.3));

    this.renderZones(frame.zones, now);
    this.renderCrew(frame.crew, now);
    this.renderBubbles(frame.bubbles, now);
    this.renderRoomLabels();
    this.renderPath(frame.crew);
  }

  destroy(): void {
    this.detachInput?.();
    this.camera.destroy();
    this.app.stage.removeChildren();
  }

  // ── static layers ──────────────────────────────────────────────────────────

  private build(layout: StationLayout, knownZones: Set<string>): void {
    const theme = this.theme;
    if (!theme) return;
    const T = theme.tileSize;
    const now = performance.now();

    // Clear static content (crew stay; they're re-sorted into actors below).
    destroyChildren(this.baseFloor);
    destroyChildren(this.zoneFloors);
    for (const c of this.centerProps) c.destroy({ children: true });
    this.centerProps = [];
    const oldZones = this.zones;
    this.zones = new Map();
    for (const z of oldZones.values()) {
      for (const p of z.props) p.destroy({ children: true });
      z.plate.destroy();
    }
    destroyChildren(this.roomLabels);

    const zoneOf = (x: number, y: number): ZoneLayout | undefined =>
      layout.zones.find((z) => inRect(z.rect, x, y));

    const zoneFloor = new Map<string, Container>();
    for (const z of layout.zones) {
      const c = new Container();
      zoneFloor.set(z.projectId, c);
      this.zoneFloors.addChild(c);
    }

    const floorAt = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < layout.width && y < layout.height
        ? layout.floor[y * layout.width + x] != null
        : false;

    const wallTex = theme.wall();
    for (let y = 0; y < layout.height; y++) {
      for (let x = 0; x < layout.width; x++) {
        const kind = layout.floor[y * layout.width + x];
        let tex: Texture | null = null;
        if (kind) tex = theme.floor(kind, x, y);
        else if (
          floorAt(x - 1, y) ||
          floorAt(x + 1, y) ||
          floorAt(x, y - 1) ||
          floorAt(x, y + 1) ||
          floorAt(x - 1, y - 1) ||
          floorAt(x + 1, y + 1) ||
          floorAt(x + 1, y - 1) ||
          floorAt(x - 1, y + 1)
        )
          tex = wallTex;
        if (!tex) continue;
        const s = new Sprite(tex);
        s.position.set(x * T, y * T);
        s.roundPixels = true;
        const z = zoneOf(x, y);
        const parent = (z ? zoneFloor.get(z.projectId) : undefined) ?? this.baseFloor;
        parent.addChild(s);
      }
    }
    this.baseFloor.cacheAsTexture({ scaleMode: 'nearest' });

    // Center props.
    const c = layout.center;
    const table = theme.prop('command_table');
    if (table) this.centerProps.push(this.placeTable(table, c.table));
    const seat = theme.prop('lounge_seat');
    if (seat)
      for (const s of c.loungeSpots)
        this.centerProps.push(this.placeProp(seat, s.tile.x, s.tile.y));
    for (const d of c.decor) {
      const t = theme.prop(d.prop);
      if (t) this.centerProps.push(this.placeProp(t, d.tile.x, d.tile.y));
    }

    // Zones.
    for (const z of layout.zones) {
      const floor = zoneFloor.get(z.projectId) ?? new Container();
      floor.cacheAsTexture({ scaleMode: 'nearest' });
      const props: Container[] = [];
      const desk = theme.prop('desk');
      const chair = theme.prop('chair');
      for (const d of z.desks) {
        if (desk)
          props.push(
            this.placeProp(desk, d.desk.x, d.desk.y, {
              x: d.desk.x,
              y: d.desk.y,
              w: DESK_W,
              h: DESK_H,
            }),
          );
        if (chair) props.push(this.placeProp(chair, d.seat.tile.x, d.seat.tile.y, undefined, -0.1));
      }
      for (const dd of z.decor) {
        const t = theme.prop(dd.prop);
        if (t) props.push(this.placeProp(t, dd.tile.x, dd.tile.y));
      }
      const plateTex = theme.prop('nameplate');
      if (plateTex) props.push(this.placeProp(plateTex, z.nameplate.x, z.nameplate.y));
      const plate = new Text({
        text: z.name,
        style: { fontFamily: theme.fontFamily, fontSize: 12, fill: theme.palette.text },
      });
      plate.resolution = this.resolution;
      plate.anchor.set(0.5, 1);
      this.plates.addChild(plate);
      const prev = oldZones.get(z.projectId);
      this.zones.set(z.projectId, {
        layout: z,
        floor,
        props,
        plate,
        plateText: z.name,
        plateColor: theme.palette.text,
        // Zones that existed before keep their state; brand-new ones unfold in.
        appearedAt: knownZones.has(z.projectId) ? (prev?.appearedAt ?? 0) : now,
      });
    }

    // Room labels (center + lounge).
    const mk = (text: string): Text => {
      const t = new Text({
        text,
        style: { fontFamily: theme.fontFamily, fontSize: 11, fill: theme.palette.accent },
      });
      t.resolution = this.resolution;
      t.anchor.set(0.5, 1);
      t.alpha = 0.8;
      this.roomLabels.addChild(t);
      return t;
    };
    mk(theme.roomNames.center).label = 'center';
    mk(theme.roomNames.lounge).label = 'lounge';

    this.camera.setWorldSize(layout.width * T, layout.height * T);
    if (!this.hasFitted) {
      this.hasFitted = true;
      if (this.pendingView) this.camera.setView(this.pendingView);
      else this.camera.fitAll(false);
      this.pendingView = null;
    }
  }

  /** Place a prop sprite, anchored bottom-left at its footprint, y-sorted with crew. */
  private placeProp(tex: Texture, tx: number, ty: number, foot?: Rect, zBias = 0): Container {
    const T = this.tile;
    const s = new Sprite(tex);
    s.roundPixels = true;
    const footH = foot?.h ?? 1;
    // Bottom of the footprint aligns with the sprite bottom; taller art extends upwards.
    s.position.set(tx * T, (ty + footH) * T - tex.height);
    s.zIndex = (ty + footH) * T + zBias;
    this.actors.addChild(s);
    return s;
  }

  /** The command table is a 9-slice (16 px borders) stretched over its whole footprint. */
  private placeTable(tex: Texture, r: Rect): Container {
    const T = this.tile;
    const border = Math.min(16, Math.floor(tex.width / 3), Math.floor(tex.height / 3));
    const s = new NineSliceSprite({
      texture: tex,
      leftWidth: border,
      rightWidth: border,
      topHeight: border,
      bottomHeight: border,
      width: r.w * T,
      height: r.h * T,
    });
    s.roundPixels = true;
    s.position.set(r.x * T, r.y * T);
    s.zIndex = (r.y + r.h) * T;
    this.actors.addChild(s);
    return s;
  }

  private rectPx(r: Rect): Rect {
    const T = this.tile;
    return { x: r.x * T, y: r.y * T, w: r.w * T, h: r.h * T };
  }

  // ── dynamic layers ─────────────────────────────────────────────────────────

  private renderZones(status: Record<string, ZoneStatusView>, now: number): void {
    const theme = this.theme;
    if (!theme) return;
    const T = theme.tileSize;
    const blink = Math.floor(now / 500) % 2 === 0;
    for (const [id, z] of this.zones) {
      const st = status[id];
      const unfold = z.appearedAt ? Math.min(1, (now - z.appearedAt) / UNFOLD_MS) : 1;
      const ease = 1 - (1 - unfold) ** 3;
      const dim = st?.dimmed ? 0.45 : 1;
      const alpha = ease * dim;
      z.floor.alpha = alpha;
      for (const p of z.props) p.alpha = alpha;
      if (unfold < 1) {
        // Unfold: grow vertically from the zone's center line.
        const r = this.rectPx(z.layout.rect);
        const cy = r.y + r.h / 2;
        z.floor.scale.y = ease;
        z.floor.position.y = Math.round(cy * (1 - ease));
      } else if (z.floor.scale.y !== 1) {
        z.floor.scale.y = 1;
        z.floor.position.y = 0;
      }
      const summary = zoneSummary(st);
      const text = summary ? `${z.layout.name}  ${summary}` : z.layout.name;
      if (text !== z.plateText) {
        z.plateText = text;
        z.plate.text = text;
      }
      const color = st?.flashing && blink ? theme.palette.waiting : theme.palette.text;
      if (color !== z.plateColor) {
        z.plateColor = color;
        z.plate.style.fill = color;
      }
      const p = this.camera.toScreen((z.layout.nameplate.x + 0.5) * T, z.layout.nameplate.y * T);
      z.plate.position.set(Math.round(p.x), Math.round(p.y - 2));
      z.plate.alpha = alpha;
    }
  }

  private renderCrew(views: CrewView[], now: number): void {
    const theme = this.theme;
    if (!theme) return;
    const T = theme.tileSize;
    const seen = new Set<string>();
    const zoom = this.camera.zoom;
    for (const v of views) {
      seen.add(v.id);
      let n = this.crew.get(v.id);
      if (!n) n = this.createCrew(v);
      n.view = v;

      const key = `${v.variant}|${v.anim}|${v.facing}`;
      if (key !== n.texKey) {
        n.texKey = key;
        const frames = theme.crewFrames(v.variant, v.anim, v.facing);
        if (frames.length) {
          n.sprite.textures = frames;
          n.sprite.animationSpeed = theme.crewFps(v.anim) / 60;
          if (frames.length > 1) n.sprite.play();
          else n.sprite.gotoAndStop(0);
        }
      }
      const px = Math.round((v.x + 0.5) * T);
      const py = Math.round((v.y + 1) * T);
      n.sprite.position.set(px, py);
      n.sprite.zIndex = py + 0.5;
      n.sprite.alpha = v.alpha;

      // Highlight ring under the feet while waiting for the user.
      n.ring.visible = v.highlight || v.agentKey === this.selected;
      if (n.ring.visible) {
        const pulse = v.highlight ? 0.5 + 0.5 * Math.sin(now / 180) : 0.9;
        n.ring.clear();
        n.ring.ellipse(px, py - 1, T * 0.55, T * 0.22).stroke({
          width: 1,
          color: v.highlight ? theme.palette.waiting : theme.palette.accent,
          alpha: pulse,
        });
        n.ring.zIndex = py;
      }

      // Station gear for the current tool.
      const working = isCrewWorking(v.status) && v.tool;
      n.gear.visible = !!working;
      if (working && v.tool) {
        const g = theme.gear(v.tool.category);
        if (n.gear.texture !== g) n.gear.texture = g;
        n.gear.position.set(px + Math.round(T * 0.35), py - Math.round(T * 1.9));
        n.gear.zIndex = py + 0.6;
        n.gear.alpha = v.alpha;
      }

      // Screen-space label, status dot, elapsed time.
      // Free lounge crew stay unlabeled (they're stand-ins) unless hovered.
      const bound = v.agentKey !== undefined || v.isOrchestrator;
      const showLabels =
        v.id === this.hovered ||
        v.highlight ||
        (v.agentKey !== undefined && v.agentKey === this.selected) ||
        (bound && zoom >= 1);
      const sp = this.camera.toScreen(px, py);
      const head = this.camera.toScreen(px, py - T * 1.25);
      const labelText = truncateLabel(v.label);
      if (labelText !== n.labelText) {
        n.labelText = labelText;
        n.label.text = labelText;
      }
      n.label.visible = showLabels && v.alpha > 0.05;
      n.label.position.set(Math.round(sp.x), Math.round(sp.y + 2));
      n.label.alpha = v.alpha;

      const busy = v.agentKey !== undefined && v.status !== 'idle' && v.status !== 'done';
      const el = busy ? formatElapsed(now - v.stepStartedAt) : '';
      if (el !== n.elapsedText) {
        n.elapsedText = el;
        n.elapsed.text = el;
      }
      n.elapsed.visible = showLabels && !!el;
      n.elapsed.position.set(Math.round(sp.x), Math.round(sp.y + 15));

      const dotColor = statusColor(theme, v.status, v.agentKey !== undefined);
      if (dotColor !== n.dotColor) {
        n.dotColor = dotColor;
        n.dot.clear().rect(-2, -2, 4, 4).fill(dotColor);
      }
      n.dot.visible = showLabels && v.alpha > 0.05;
      n.dot.position.set(Math.round(head.x + 7), Math.round(head.y));
    }
    for (const id of [...this.crew.keys()]) if (!seen.has(id)) this.removeCrew(id);
    this.declutterLabels();
  }

  /** Hide name labels that would collide; selected, waiting and orchestrators win. */
  private declutterLabels(): void {
    const prio = (n: CrewNode): number =>
      (n.view.agentKey !== undefined && n.view.agentKey === this.selected ? 8 : 0) +
      (n.view.id === this.hovered ? 8 : 0) +
      (n.view.highlight ? 4 : 0) +
      (n.view.isOrchestrator ? 2 : 0);
    const nodes = [...this.crew.values()]
      .filter((n) => n.label.visible)
      .sort((a, b) => prio(b) - prio(a));
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    for (const n of nodes) {
      const w = n.label.width;
      const box = {
        l: n.label.x - w / 2,
        r: n.label.x + w / 2,
        t: n.label.y,
        b: n.label.y + (n.elapsed.visible ? 24 : n.label.height),
      };
      const hit = placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t);
      if (hit && prio(n) < 4) {
        n.label.visible = false;
        n.elapsed.visible = false;
        continue;
      }
      placed.push(box);
    }
  }

  private createCrew(v: CrewView): CrewNode {
    const theme = this.theme as ThemeRuntime;
    const frames = theme.crewFrames(v.variant, v.anim, v.facing);
    const sprite = new AnimatedSprite({ textures: frames.length ? frames : [emptyTexture()] });
    sprite.anchor.set(0.5, 1);
    sprite.roundPixels = true;
    sprite.autoUpdate = true;
    const ring = new Graphics();
    const gear = new Sprite(theme.gear('other'));
    gear.roundPixels = true;
    gear.anchor.set(0.5, 1);
    this.actors.addChild(ring, sprite, gear);

    const label = new Text({
      text: '',
      style: {
        fontFamily: theme.fontFamily,
        fontSize: 10,
        fill: theme.palette.text,
        stroke: { color: theme.palette.background, width: 3 },
      },
    });
    label.resolution = this.resolution;
    label.anchor.set(0.5, 0);
    const elapsed = new Text({
      text: '',
      style: {
        fontFamily: theme.fontFamily,
        fontSize: 9,
        fill: theme.palette.stale,
        stroke: { color: theme.palette.background, width: 3 },
      },
    });
    elapsed.resolution = this.resolution;
    elapsed.anchor.set(0.5, 0);
    const dot = new Graphics();
    this.crewLabels.addChild(label, elapsed, dot);
    const n: CrewNode = {
      sprite,
      ring,
      gear,
      label,
      elapsed,
      dot,
      texKey: '',
      dotColor: '',
      labelText: '',
      elapsedText: '',
      view: v,
    };
    this.crew.set(v.id, n);
    return n;
  }

  private removeCrew(id: string): void {
    const n = this.crew.get(id);
    if (!n) return;
    n.sprite.destroy();
    n.ring.destroy();
    n.gear.destroy();
    n.label.destroy();
    n.elapsed.destroy();
    n.dot.destroy();
    this.crew.delete(id);
  }

  private renderBubbles(views: BubbleView[], now: number): void {
    const theme = this.theme;
    if (!theme) return;
    const T = theme.tileSize;
    const seen = new Set<string>();
    const live: { n: BubbleNode; box: Box; alpha: number }[] = [];
    for (const b of views) {
      const crew = this.crew.get(b.crewId);
      if (!crew) continue;
      seen.add(b.id);
      let n = this.bubbles.get(b.id);
      const key = `${b.kind}|${b.text}`;
      if (!n) {
        n = this.createBubble(b);
        this.bubbles.set(b.id, n);
      }
      if (n.key !== key) this.drawBubble(n, b);
      const left = b.bornAt + b.ttlMs - now;
      n.root.visible = left > 0;
      if (left <= 0) continue;
      const v = crew.view;
      const head = this.camera.toScreen((v.x + 0.5) * T, (v.y + 1) * T - T * 1.4);
      const h = n.bg.height;
      live.push({
        n,
        box: { x: head.x, bottom: head.y - 2 - b.stack * (h + 3), w: n.bg.width, h },
        alpha: Math.max(0, Math.min(1, left / BUBBLE_FADE_MS)) * v.alpha,
      });
    }
    // Bubbles from neighbouring crew must never overlap illegibly: lift colliding ones.
    const bottoms = stackBoxes(live.map((l) => l.box));
    live.forEach((l, i) => {
      l.n.root.position.set(Math.round(l.box.x), Math.round(bottoms[i] ?? l.box.bottom));
      l.n.root.alpha = l.alpha;
    });
    for (const id of [...this.bubbles.keys()]) if (!seen.has(id)) this.removeBubble(id);
  }

  private createBubble(b: BubbleView): BubbleNode {
    const theme = this.theme as ThemeRuntime;
    const root = new Container();
    const bg = new Graphics();
    const text = new Text({
      text: '',
      style: { fontFamily: theme.fontFamily, fontSize: 10, fill: theme.palette.text },
    });
    text.resolution = this.resolution;
    root.addChild(bg, text);
    this.bubbleLayer.addChild(root);
    const n: BubbleNode = { root, bg, text, key: '' };
    this.drawBubble(n, b);
    return n;
  }

  /** Pixel-style bubble: square body with notched corners and a stepped tail. */
  private drawBubble(n: BubbleNode, b: BubbleView): void {
    const theme = this.theme as ThemeRuntime;
    n.key = `${b.kind}|${b.text}`;
    n.text.text = b.text;
    const catchy = b.kind === 'catchphrase';
    n.text.style.fill = catchy ? theme.palette.text : theme.palette.stale;
    const padX = 5;
    const padY = 3;
    const w = Math.ceil(n.text.width) + padX * 2;
    const h = Math.ceil(n.text.height) + padY * 2;
    const x = -Math.round(w / 2);
    const y = -h - 4;
    const border = catchy ? theme.palette.accent : theme.palette.stale;
    const fill = theme.palette.panel;
    const g = n.bg.clear();
    // Border body with notched (pixel-rounded) corners.
    g.rect(x + 1, y - 1, w - 2, h + 2).fill(border);
    g.rect(x - 1, y + 1, w + 2, h - 2).fill(border);
    g.rect(x, y, w, h).fill(border);
    g.rect(x + 1, y, w - 2, h).fill(fill);
    g.rect(x, y + 1, w, h - 2).fill(fill);
    // Stepped tail.
    g.rect(-3, y + h, 6, 2).fill(border);
    g.rect(-2, y + h, 4, 1).fill(fill);
    g.rect(-1, y + h + 2, 2, 2).fill(border);
    n.text.position.set(x + padX, y + padY);
  }

  private removeBubble(id: string): void {
    this.bubbles.get(id)?.root.destroy({ children: true });
    this.bubbles.delete(id);
  }

  private renderRoomLabels(): void {
    const layout = this.layout;
    if (!layout) return;
    const T = this.tile;
    for (const child of this.roomLabels.children) {
      // Center name on the room's top wall, lounge name on the lounge's bottom edge.
      const isCenter = child.label === 'center';
      const r = isCenter ? layout.center.rect : layout.center.lounge;
      const y = isCenter ? r.y + 0.1 : r.y + r.h + 0.9;
      const p = this.camera.toScreen((r.x + r.w / 2) * T, y * T);
      child.position.set(Math.round(p.x), Math.round(p.y));
      child.visible = this.camera.zoom >= 1;
    }
  }

  private renderPath(views: CrewView[]): void {
    const g = this.pathLayer.clear();
    if (!this.selected || !this.theme) return;
    const v = views.find((c) => c.agentKey === this.selected);
    if (!v?.path?.length) return;
    const T = this.tile;
    // Dotted route: one 2×2 dot per tile step.
    for (const p of v.path) {
      g.rect(Math.round((p.x + 0.5) * T) - 1, Math.round((p.y + 0.5) * T) - 1, 2, 2).fill({
        color: this.theme.palette.accent,
        alpha: 0.8,
      });
    }
  }

  // ── input ──────────────────────────────────────────────────────────────────

  private hit(sx: number, sy: number): CrewView | null {
    const T = this.tile;
    const w = this.camera.toWorld(sx, sy);
    let best: CrewView | null = null;
    let bestY = -Infinity;
    for (const n of this.crew.values()) {
      const v = n.view;
      if (v.alpha < 0.2) continue;
      const cx = (v.x + 0.5) * T;
      const by = (v.y + 1) * T;
      const h = n.sprite.height || T;
      if (w.x >= cx - T / 2 && w.x <= cx + T / 2 && w.y >= by - h && w.y <= by && by > bestY) {
        best = v;
        bestY = by;
      }
    }
    return best;
  }

  private attachPointer(canvas: HTMLCanvasElement): () => void {
    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent): void => {
      const p = local(e);
      const v = this.hit(p.x, p.y);
      canvas.style.cursor = v ? 'pointer' : 'grab';
      this.hovered = v?.id;
      this.cb.onHover?.(v, p.x, p.y);
    };
    const onLeave = (): void => {
      this.hovered = undefined;
      this.cb.onHover?.(null, 0, 0);
    };
    const onUp = (e: PointerEvent): void => {
      // Defer one tick so Camera's pointerup (window listener) has set `dragged`.
      setTimeout(() => {
        if (this.camera.dragged) return;
        const p = local(e);
        const v = this.hit(p.x, p.y);
        if (v) {
          this.cb.onSelect?.(v.agentKey);
          return;
        }
        const w = this.camera.toWorld(p.x, p.y);
        const T = this.tile;
        const z = this.layout?.zones.find((zz) => inRect(zz.rect, w.x / T, w.y / T));
        if (z) this.cb.onZoneClick?.(z.projectId);
        else this.cb.onSelect?.(undefined);
      }, 0);
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerup', onUp);
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerup', onUp);
    };
  }
}

function statusColor(theme: ThemeRuntime, s: AgentStatus, bound: boolean): string {
  if (!bound) return theme.palette.stale;
  switch (s) {
    case 'working':
    case 'thinking':
      return theme.palette.working;
    case 'waiting':
      return theme.palette.waiting;
    case 'done':
    case 'idle':
      return theme.palette.done;
    case 'error':
      return theme.palette.error;
    case 'stale':
      return theme.palette.stale;
  }
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

function destroyChildren(c: Container): void {
  if (c.isCachedAsTexture) c.cacheAsTexture(false);
  for (const ch of c.removeChildren()) ch.destroy({ children: true });
}

let empty: Texture | null = null;
function emptyTexture(): Texture {
  // Lazily created 1×1 transparent texture for sprites without frames.
  if (!empty) {
    const cv = document.createElement('canvas');
    cv.width = 1;
    cv.height = 1;
    empty = Sprite.from(cv).texture;
  }
  return empty;
}
