// Pan/zoom camera over the world container. Zoom rests on discrete levels so pixels stay crisp
// (integer ≥ 1; 0.5/0.25 only when the station is bigger than the window).
import type { Container } from 'pixi.js';

export const ZOOM_LEVELS = [0.25, 0.5, 1, 2, 3, 4, 5, 6] as const;

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const nearestLevel = (z: number): number =>
  ZOOM_LEVELS.reduce((best, l) => (Math.abs(l - z) < Math.abs(best - z) ? l : best), 1);

export class Camera {
  private view: View = { x: 0, y: 0, zoom: 2 };
  private target: View | null = null;
  private worldW = 1;
  private worldH = 1;
  private screenW = 1;
  private screenH = 1;
  private drag: { px: number; py: number; vx: number; vy: number; moved: boolean } | null = null;
  private pinch: { dist: number; zoom: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private keys = new Set<string>();
  private detach: (() => void) | null = null;
  /** True right after a drag, so the click handler can ignore it. */
  dragged = false;

  constructor(private readonly world: Container) {}

  /** Easing toward a target, keyboard panning or pinching: the frame pacer keeps drawing. */
  get busy(): boolean {
    return this.target !== null || this.keys.size > 0 || this.pinch !== null;
  }

  get zoom(): number {
    return this.view.zoom;
  }

  setScreenSize(w: number, h: number): void {
    this.screenW = Math.max(1, w);
    this.screenH = Math.max(1, h);
    this.clamp(this.view);
    this.apply();
  }

  setWorldSize(w: number, h: number): void {
    this.worldW = Math.max(1, w);
    this.worldH = Math.max(1, h);
    this.clamp(this.view);
    this.apply();
  }

  /** World px → screen px. */
  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: wx * this.view.zoom + this.view.x, y: wy * this.view.zoom + this.view.y };
  }

  /** Screen px → world px. */
  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.view.x) / this.view.zoom, y: (sy - this.view.y) / this.view.zoom };
  }

  /** Current resting view (for persistence). */
  getView(): View {
    return { ...(this.target ?? this.view) };
  }

  /** Jump to a saved view (clamped to the current world). */
  setView(v: View): void {
    const next = { x: Math.round(v.x), y: Math.round(v.y), zoom: nearestLevel(v.zoom) };
    this.clamp(next);
    this.view = next;
    this.target = null;
    this.apply();
  }

  fitAll(animate = true): void {
    this.focusRect({ x: 0, y: 0, w: this.worldW, h: this.worldH }, animate);
  }

  /** Center a world-px rect at the largest zoom level where it fits. */
  focusRect(r: WorldRect, animate = true): void {
    const fit = Math.min(this.screenW / Math.max(1, r.w), this.screenH / Math.max(1, r.h));
    const zoom = [...ZOOM_LEVELS].reverse().find((l) => l <= fit) ?? ZOOM_LEVELS[0];
    const v: View = {
      zoom,
      x: Math.round(this.screenW / 2 - (r.x + r.w / 2) * zoom),
      y: Math.round(this.screenH / 2 - (r.y + r.h / 2) * zoom),
    };
    this.clamp(v);
    if (animate) this.target = v;
    else {
      this.view = v;
      this.target = null;
      this.apply();
    }
  }

  /** Step zoom one level, keeping the given screen point fixed. */
  zoomStep(dir: 1 | -1, sx = this.screenW / 2, sy = this.screenH / 2): void {
    const base = this.target ?? this.view;
    const i = ZOOM_LEVELS.indexOf(nearestLevel(base.zoom) as (typeof ZOOM_LEVELS)[number]);
    const next = ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i + dir))] ?? 1;
    this.zoomTo(next, sx, sy);
  }

  zoomTo(zoom: number, sx = this.screenW / 2, sy = this.screenH / 2): void {
    const base = this.target ?? this.view;
    const wx = (sx - base.x) / base.zoom;
    const wy = (sy - base.y) / base.zoom;
    const v: View = { zoom, x: Math.round(sx - wx * zoom), y: Math.round(sy - wy * zoom) };
    this.clamp(v);
    this.target = v;
  }

  panBy(dx: number, dy: number): void {
    const base = this.target ?? this.view;
    const v = { ...base, x: base.x + dx, y: base.y + dy };
    this.clamp(v);
    if (this.target) this.target = v;
    else {
      this.view = v;
      this.apply();
    }
  }

  /** Advance animation and keyboard panning. */
  update(dtMs: number): void {
    const panSpeed = 0.6 * dtMs;
    let kx = 0;
    let ky = 0;
    if (this.keys.has('ArrowLeft') || this.keys.has('a')) kx += panSpeed;
    if (this.keys.has('ArrowRight') || this.keys.has('d')) kx -= panSpeed;
    if (this.keys.has('ArrowUp') || this.keys.has('w')) ky += panSpeed;
    if (this.keys.has('ArrowDown') || this.keys.has('s')) ky -= panSpeed;
    if (kx || ky) this.panBy(Math.round(kx), Math.round(ky));

    if (!this.target) return;
    const t = Math.min(1, dtMs / 120);
    const v = this.view;
    const g = this.target;
    v.zoom += (g.zoom - v.zoom) * t;
    v.x += (g.x - v.x) * t;
    v.y += (g.y - v.y) * t;
    if (
      Math.abs(g.zoom - v.zoom) < 0.01 &&
      Math.abs(g.x - v.x) < 0.5 &&
      Math.abs(g.y - v.y) < 0.5
    ) {
      this.view = { ...g };
      this.target = null;
    }
    this.apply();
  }

  /** Wire pointer/wheel/keyboard input. Returns a detach function. */
  attach(el: HTMLElement): () => void {
    const onDown = (e: PointerEvent): void => {
      if (e.button === 2) return; // right-click opens the zone menu, never drags
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.drag = {
          px: e.clientX,
          py: e.clientY,
          vx: this.view.x,
          vy: this.view.y,
          moved: false,
        };
        this.dragged = false;
      } else if (this.pointers.size === 2) {
        this.drag = null;
        this.pinch = { dist: this.pointerDist(), zoom: this.view.zoom };
      }
    };
    const onMove = (e: PointerEvent): void => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size === 2) {
        const ratio = this.pointerDist() / Math.max(1, this.pinch.dist);
        const z = nearestLevel(this.pinch.zoom * ratio);
        if (z !== nearestLevel((this.target ?? this.view).zoom)) {
          const c = this.pointerCenter(el);
          this.zoomTo(z, c.x, c.y);
        }
        return;
      }
      if (!this.drag) return;
      const dx = e.clientX - this.drag.px;
      const dy = e.clientY - this.drag.py;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
      if (!this.drag.moved) return;
      this.target = null;
      const v = { ...this.view, x: this.drag.vx + dx, y: this.drag.vy + dy };
      this.clamp(v);
      this.view = v;
      this.apply();
    };
    const onUp = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.drag?.moved) this.dragged = true;
      if (this.pointers.size === 0) this.drag = null;
    };
    let wheelAcc = 0;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Trackpad two-finger scroll pans; pinch (ctrlKey) and mouse wheels zoom.
      const isMouseWheel = e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0);
      if (!e.ctrlKey && !isMouseWheel) {
        this.panBy(-Math.round(e.deltaX), -Math.round(e.deltaY));
        return;
      }
      wheelAcc += e.deltaY;
      const threshold = e.ctrlKey ? 12 : 1;
      if (Math.abs(wheelAcc) < threshold) return;
      this.zoomStep(wheelAcc < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
      wheelAcc = 0;
    };
    const editable = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement &&
      (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
    const onKeyDown = (e: KeyboardEvent): void => {
      if (editable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') this.zoomStep(1);
      else if (e.key === '-' || e.key === '_') this.zoomStep(-1);
      else if (e.key === '0') this.fitAll();
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key))
        this.keys.add(e.key);
      else if (['w', 'a', 's', 'd'].includes(e.key.toLowerCase()))
        this.keys.add(e.key.toLowerCase());
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      this.keys.delete(e.key);
      this.keys.delete(e.key.toLowerCase());
    };
    const onBlur = (): void => this.keys.clear();

    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.detach = () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
    return this.detach;
  }

  destroy(): void {
    this.detach?.();
  }

  private pointerDist(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 1;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private pointerCenter(el: HTMLElement): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    const ps = [...this.pointers.values()];
    const x = ps.reduce((s, p) => s + p.x, 0) / Math.max(1, ps.length);
    const y = ps.reduce((s, p) => s + p.y, 0) / Math.max(1, ps.length);
    return { x: x - r.left, y: y - r.top };
  }

  /** Keep the world on screen: center it when smaller than the view, else clamp edges. */
  private clamp(v: View): void {
    const ww = this.worldW * v.zoom;
    const wh = this.worldH * v.zoom;
    const margin = 48;
    if (ww <= this.screenW) v.x = Math.round((this.screenW - ww) / 2);
    else v.x = Math.min(margin, Math.max(this.screenW - ww - margin, v.x));
    if (wh <= this.screenH) v.y = Math.round((this.screenH - wh) / 2);
    else v.y = Math.min(margin, Math.max(this.screenH - wh - margin, v.y));
  }

  private apply(): void {
    // Integer translation keeps pixels on the grid; zoom rests on discrete levels.
    this.world.position.set(Math.round(this.view.x), Math.round(this.view.y));
    this.world.scale.set(this.view.zoom);
  }
}
