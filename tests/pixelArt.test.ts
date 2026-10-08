import { describe, expect, it } from 'vitest';
import { CREW_ANIMS } from '../src/renderer/director/types';
import {
  CREW_H,
  CREW_W,
  crewFrameCount,
  crewVariants,
  drawCrewFrame,
  generateCrewSet,
  type CrewStyle,
} from '../src/renderer/themes/crew';
import {
  SPACESHIP_CREW,
  spaceshipGenerator,
  starfield,
} from '../src/renderer/themes/generators/spaceship';
import { PixelBuffer, hex, mix, shade } from '../src/renderer/themes/pixelBuffer';
import { validateTheme } from '../src/shared/themeSchema';
import { readFileSync } from 'node:fs';

const RED = hex('#ff0000');
const BLUE = hex('#0000ff');

describe('PixelBuffer', () => {
  it('packs colors and ignores out-of-bounds writes', () => {
    const b = new PixelBuffer(4, 4);
    expect(hex('#ff0000')).toBe(0xff0000ff);
    expect(hex('nope')).toBe(0);
    b.set(1, 2, RED).set(-1, 0, RED).set(9, 9, RED);
    expect(b.get(1, 2)).toBe(RED);
    expect(b.solidCount()).toBe(1);
  });

  it('fills, strokes and draws lines inclusively', () => {
    const b = new PixelBuffer(8, 8).fillRect(0, 0, 2, 2, RED);
    expect(b.solidCount()).toBe(4);
    const l = new PixelBuffer(8, 8).line(0, 0, 7, 7, BLUE);
    expect(l.solidCount()).toBe(8);
    expect(l.get(7, 7)).toBe(BLUE);
    const s = new PixelBuffer(5, 5).strokeRect(0, 0, 5, 5, RED);
    expect(s.solidCount()).toBe(16);
  });

  it('outlines shapes exactly once around the 4-neighbourhood', () => {
    const b = new PixelBuffer(5, 5).set(2, 2, RED).outline(BLUE);
    expect(b.solidCount()).toBe(5);
    expect(b.get(2, 1)).toBe(BLUE);
    expect(b.get(1, 1)).toBe(0);
  });

  it('mirrors horizontally and blits over transparency only', () => {
    const b = new PixelBuffer(4, 1).set(0, 0, RED);
    expect(b.mirrorX().get(3, 0)).toBe(RED);
    const dst = new PixelBuffer(4, 1).set(1, 0, BLUE);
    dst.blit(new PixelBuffer(2, 1).set(0, 0, RED), 2, 0);
    expect([dst.get(1, 0), dst.get(2, 0), dst.get(3, 0)]).toEqual([BLUE, RED, 0]);
  });

  it('shades and mixes colors', () => {
    expect(shade(hex('#808080'), 0.5)).toBe(hex('#404040'));
    expect(shade(hex('#000000'), 2)).toBe(hex('#ffffff'));
    expect(mix(hex('#000000'), hex('#ffffff'), 0.5)).toBe(hex('#808080'));
  });
});

describe('crew generator', () => {
  it('produces ≥8 distinct variants', () => {
    const vs = crewVariants(SPACESHIP_CREW, 8);
    expect(vs).toHaveLength(8);
    const keys = new Set(
      vs.map((v) => `${v.skin}-${v.hair}-${v.hairStyle}-${v.outfit}-${v.accessory}`),
    );
    expect(keys.size).toBe(8);
  });

  it('draws every anim × facing × variant with consistent size and real pixels', () => {
    const set = generateCrewSet(SPACESHIP_CREW, CREW_ANIMS, 8);
    expect(set.frames.size).toBe(8 * CREW_ANIMS.length * 4);
    for (const [key, frames] of set.frames) {
      const anim = key.split(':')[1] as (typeof CREW_ANIMS)[number];
      expect(frames.length).toBe(crewFrameCount(anim));
      expect(frames.length).toBeGreaterThanOrEqual(2);
      for (const f of frames) {
        expect([f.width, f.height]).toEqual([CREW_W, CREW_H]);
        expect(f.solidCount()).toBeGreaterThan(60);
      }
    }
  });

  it('stands on the feet anchor (bottom row) and animates', () => {
    const v = crewVariants(SPACESHIP_CREW, 1)[0]!;
    const idle = drawCrewFrame(v, SPACESHIP_CREW, 'idle', 'down', 0);
    let bottomSolid = 0;
    for (let x = 0; x < CREW_W; x++) if (idle.isSolid(x, CREW_H - 1)) bottomSolid++;
    expect(bottomSolid).toBeGreaterThan(0);
    const w0 = drawCrewFrame(v, SPACESHIP_CREW, 'walk', 'left', 0);
    const w1 = drawCrewFrame(v, SPACESHIP_CREW, 'walk', 'left', 1);
    expect(Buffer.from(w0.data).equals(Buffer.from(w1.data))).toBe(false);
  });

  it('right facing mirrors left (without icons)', () => {
    const v = crewVariants(SPACESHIP_CREW, 1)[0]!;
    const l = drawCrewFrame(v, SPACESHIP_CREW, 'walk', 'left', 2);
    const r = drawCrewFrame(v, SPACESHIP_CREW, 'walk', 'right', 2);
    expect(Buffer.from(l.mirrorX().data).equals(Buffer.from(r.data))).toBe(true);
  });

  it('supports mono and casual uniforms', () => {
    const mono: CrewStyle = {
      uniform: 'mono',
      outfits: [],
      mono: ['#003300', '#00aa00', '#66ff66'],
    };
    const casual: CrewStyle = {
      uniform: 'casual',
      outfits: [['#aa5533', '#ffffff']],
      pants: '#223344',
    };
    for (const style of [mono, casual]) {
      const v = crewVariants(style, 2)[1]!;
      expect(drawCrewFrame(v, style, 'type', 'up', 1).solidCount()).toBeGreaterThan(60);
    }
  });
});

describe('spaceship generator', () => {
  const res = validateTheme(JSON.parse(readFileSync('themes/spaceship/theme.json', 'utf8')));
  if (!res.ok) throw new Error(res.errors.join('\n'));
  const art = spaceshipGenerator(res.manifest, {});

  it('provides floors, wall, core props, gear and a backdrop', () => {
    for (const k of ['center', 'lounge', 'zone', 'corridor'] as const) {
      expect(art.floors[k].length).toBeGreaterThan(0);
      for (const f of art.floors[k]) expect([f.width, f.height]).toEqual([16, 16]);
    }
    for (const p of [
      'command_table',
      'desk',
      'chair',
      'lounge_seat',
      'nameplate',
      'door',
      'plant',
    ]) {
      expect(art.props[p]?.solidCount() ?? 0).toBeGreaterThan(0);
    }
    expect([art.props['command_table']!.width, art.props['command_table']!.height]).toEqual([
      48, 48,
    ]);
    expect(art.props['desk']!.width).toBe(32);
    for (const g of Object.values(art.gear)) expect(g.solidCount()).toBeGreaterThan(10);
    expect(art.backdrop?.width).toBe(256);
  });

  it('draws a tileable starfield deterministically', () => {
    const a = starfield(64, 3);
    const b = starfield(64, 3);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(a.solidCount()).toBe(64 * 64);
  });
});
