import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Container } from 'pixi.js';
import { Camera, ZOOM_LEVELS } from '../src/renderer/scene/Camera';

type Handler = (e: Record<string, unknown>) => void;

interface Rig {
  cam: Camera;
  scale: () => number;
  down: (x: number, y: number) => void;
  move: (x: number, y: number) => void;
  up: () => void;
}

function rig(world = { w: 960, h: 540 }): Rig {
  let scale = 1;
  const stub = {
    position: { set: () => undefined },
    scale: { set: (v: number) => (scale = v) },
  };
  const cam = new Camera(stub as unknown as Container);
  const on: Record<string, Handler> = {};
  const target = (prefix: string): object => ({
    addEventListener: (t: string, f: Handler) => (on[prefix + t] = f),
    removeEventListener: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  });
  vi.stubGlobal('window', target('window:'));
  vi.stubGlobal('HTMLElement', class {});
  cam.attach(target('el:') as unknown as HTMLElement);
  cam.setScreenSize(1200, 800);
  cam.setWorldSize(world.w, world.h);
  const pointer = (x: number, y: number): Record<string, unknown> => ({
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
  });
  return {
    cam,
    scale: () => scale,
    down: (x, y) => on['el:pointerdown']?.(pointer(x, y)),
    move: (x, y) => on['window:pointermove']?.(pointer(x, y)),
    up: () => on['window:pointerup']?.(pointer(0, 0)),
  };
}

describe('Camera', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('never rests on a fractional zoom after a drag interrupts an ease', () => {
    const r = rig();
    r.cam.setView({ x: 0, y: 0, zoom: 1 });
    r.cam.zoomStep(1, 600, 400);
    r.cam.update(33);
    r.cam.update(33);
    expect(ZOOM_LEVELS).not.toContain(r.cam.zoom);
    r.down(100, 100);
    r.move(130, 100);
    r.up();
    for (let i = 0; i < 100; i++) r.cam.update(33);
    expect(r.cam.zoom).toBe(2);
    expect(r.scale()).toBe(2);
    expect(r.cam.busy).toBe(false);
  });

  it('keeps zoom whole when a refit starts during a long drag', () => {
    const r = rig({ w: 4000, h: 3000 });
    r.cam.setView({ x: -500, y: -500, zoom: 1 });
    r.down(100, 100);
    r.move(120, 100);
    r.cam.zoomTo(2);
    r.cam.update(33);
    r.move(140, 100);
    expect(r.cam.zoom).toBe(2);
  });

  it('does not jump when a drag starts just after an ease finished', () => {
    const r = rig({ w: 4000, h: 3000 });
    r.cam.setView({ x: -500, y: -500, zoom: 1 });
    r.cam.zoomTo(1, 600, 400);
    r.cam.panBy(-300, 0);
    r.down(100, 100);
    for (let i = 0; i < 100; i++) r.cam.update(33);
    const settled = r.cam.getView().x;
    r.move(110, 100);
    expect(r.cam.getView().x).toBe(settled);
  });

  it('follows the pointer once a drag has started', () => {
    const r = rig({ w: 4000, h: 3000 });
    r.cam.setView({ x: -500, y: -500, zoom: 1 });
    r.down(100, 100);
    r.move(110, 100);
    r.move(150, 120);
    expect(r.cam.getView()).toMatchObject({ x: -460, y: -480 });
  });

  it('lands inside the world when the world shrinks during an ease', () => {
    const r = rig({ w: 4000, h: 3000 });
    r.cam.setView({ x: -2000, y: -1500, zoom: 1 });
    r.cam.zoomTo(1, 0, 0);
    r.cam.setWorldSize(960, 540);
    for (let i = 0; i < 100; i++) r.cam.update(33);
    expect(r.cam.getView()).toMatchObject({ x: 120, y: 130, zoom: 1 });
  });

  it('keeps a layout shift when the drag goes on', () => {
    const r = rig({ w: 4000, h: 3000 });
    r.cam.setView({ x: -500, y: -500, zoom: 1 });
    r.down(100, 100);
    r.move(110, 100);
    r.cam.panBy(-320, 0);
    expect(r.cam.getView().x).toBe(-820);
    r.move(111, 100);
    expect(r.cam.getView().x).toBe(-819);
  });
});
