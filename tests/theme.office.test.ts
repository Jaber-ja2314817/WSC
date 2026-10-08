import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CREW_ANIMS, PHRASE_MOMENTS } from '../src/renderer/director/types';
import {
  CREW_H,
  CREW_W,
  crewFrameCount,
  crewVariants,
  generateCrewSet,
} from '../src/renderer/themes/crew';
import { OFFICE_CREW, officeGenerator, wallpaper } from '../src/renderer/themes/generators/office';
import { spaceshipGenerator } from '../src/renderer/themes/generators/spaceship';
import { validateTheme, type ThemeManifest } from '../src/shared/themeSchema';

const load = (id: string): ThemeManifest => {
  const res = validateTheme(JSON.parse(readFileSync(`themes/${id}/theme.json`, 'utf8')));
  if (!res.ok) throw new Error(res.errors.join('\n'));
  return res.manifest;
};

const CORE_PROPS = ['command_table', 'desk', 'chair', 'lounge_seat', 'nameplate', 'door', 'plant'];
const DECOR_PROPS = ['sofa', 'coffee_machine', 'console', 'rug', 'lamp', 'bookshelf', 'crate'];
const CATEGORIES = [
  'read',
  'search',
  'write',
  'execute',
  'web',
  'delegate',
  'plan',
  'mcp',
  'other',
] as const;

describe('office theme manifest', () => {
  const manifest = load('office');

  it('validates with office identity and generator', () => {
    expect(manifest.id).toBe('office');
    expect(manifest.name).toBe('Office');
    expect(manifest.art).toEqual({ kind: 'generated', generator: 'office' });
    expect(manifest.roomNames).toEqual({
      center: 'Meeting Room',
      lounge: 'Break Room',
      zone: 'Team',
    });
  });

  it('has 5+ short, original catchphrases for every moment', () => {
    for (const m of PHRASE_MOMENTS) {
      const list = manifest.phrases[m];
      expect(list.length).toBeGreaterThanOrEqual(5);
      for (const p of list) expect(p.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('office generator', () => {
  const art = officeGenerator(load('office'), {});

  it('provides floors for every FloorKind at tile size', () => {
    for (const k of ['center', 'lounge', 'zone', 'corridor'] as const) {
      expect(art.floors[k].length).toBeGreaterThan(0);
      for (const f of art.floors[k]) {
        expect([f.width, f.height]).toEqual([16, 16]);
        expect(f.solidCount()).toBe(256);
      }
    }
    expect([art.wall.width, art.wall.height]).toEqual([16, 16]);
  });

  it('provides every core and decor prop with the shared size conventions', () => {
    for (const p of [...CORE_PROPS, ...DECOR_PROPS]) {
      expect(art.props[p]?.solidCount() ?? 0, p).toBeGreaterThan(0);
    }
    const table = art.props['command_table']!;
    expect([table.width, table.height]).toEqual([48, 48]);
    const desk = art.props['desk']!;
    expect([desk.width, desk.height]).toEqual([32, 24]);
  });

  it('provides gear for every tool category', () => {
    for (const c of CATEGORIES) expect(art.gear[c].solidCount(), c).toBeGreaterThan(10);
  });

  it('has a tileable wallpaper backdrop instead of a starfield', () => {
    expect(art.backdrop?.width).toBe(64);
    expect(art.backdrop?.solidCount()).toBe(64 * 64);
    expect(Buffer.from(wallpaper().data).equals(Buffer.from(wallpaper().data))).toBe(true);
  });

  it('looks different from the spaceship theme', () => {
    const ship = spaceshipGenerator(load('spaceship'), {});
    for (const p of ['command_table', 'desk', 'plant']) {
      expect(Buffer.from(art.props[p]!.data).equals(Buffer.from(ship.props[p]!.data))).toBe(false);
    }
    expect(Buffer.from(art.wall.data).equals(Buffer.from(ship.wall.data))).toBe(false);
  });
});

describe('office crew', () => {
  it('uses business-casual outfits with 8 distinct variants', () => {
    expect(OFFICE_CREW.uniform).toBe('casual');
    const vs = crewVariants(OFFICE_CREW, 8);
    const keys = new Set(vs.map((v) => `${v.skin}-${v.hair}-${v.hairStyle}-${v.outfit}`));
    expect(keys.size).toBe(8);
  });

  it('draws every anim × facing × variant', () => {
    const set = generateCrewSet(OFFICE_CREW, CREW_ANIMS, 8);
    expect(set.frames.size).toBe(8 * CREW_ANIMS.length * 4);
    for (const [key, frames] of set.frames) {
      const anim = key.split(':')[1] as (typeof CREW_ANIMS)[number];
      expect(frames.length).toBe(crewFrameCount(anim));
      for (const f of frames) {
        expect([f.width, f.height]).toEqual([CREW_W, CREW_H]);
        expect(f.solidCount()).toBeGreaterThan(60);
      }
    }
  });
});
