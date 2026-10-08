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
import { HOME_CREW, garden, homeGenerator } from '../src/renderer/themes/generators/home';
import { validateTheme } from '../src/shared/themeSchema';

const res = validateTheme(JSON.parse(readFileSync('themes/home/theme.json', 'utf8')));

describe('home theme manifest', () => {
  it('validates', () => {
    if (!res.ok) throw new Error(res.errors.join('\n'));
    expect(res.manifest.id).toBe('home');
    expect(res.manifest.roomNames).toEqual({
      center: 'Kitchen',
      lounge: 'Living Room',
      zone: 'Room',
    });
  });

  it('has 5–6 short phrases for every moment', () => {
    if (!res.ok) throw new Error('invalid');
    for (const m of PHRASE_MOMENTS) {
      const list = res.manifest.phrases[m];
      expect(list.length).toBeGreaterThanOrEqual(5);
      for (const p of list) expect(p.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('home generator', () => {
  if (!res.ok) throw new Error('invalid');
  const art = homeGenerator(res.manifest, {});

  it('provides floors for every FloorKind', () => {
    for (const k of ['center', 'lounge', 'zone', 'corridor'] as const) {
      expect(art.floors[k].length).toBeGreaterThan(0);
      for (const f of art.floors[k]) {
        expect([f.width, f.height]).toEqual([16, 16]);
        expect(f.solidCount()).toBe(256);
      }
    }
    expect([art.wall.width, art.wall.height]).toEqual([16, 16]);
  });

  it('draws every core and decor prop with the shared sizes', () => {
    for (const p of [
      'command_table',
      'desk',
      'chair',
      'lounge_seat',
      'nameplate',
      'door',
      'plant',
      'sofa',
      'coffee_machine',
      'console',
      'rug',
      'lamp',
      'bookshelf',
      'crate',
    ]) {
      expect(art.props[p]?.solidCount() ?? 0, p).toBeGreaterThan(0);
    }
    const table = art.props['command_table']!;
    expect([table.width, table.height]).toEqual([48, 48]);
    expect([art.props['desk']!.width, art.props['desk']!.height]).toEqual([32, 24]);
  });

  it('has gear for every tool category', () => {
    const cats = ['read', 'search', 'write', 'execute', 'web', 'delegate', 'plan', 'mcp', 'other'];
    expect(Object.keys(art.gear).sort()).toEqual([...cats].sort());
    for (const g of Object.values(art.gear)) {
      expect([g.width, g.height]).toEqual([16, 16]);
      expect(g.solidCount()).toBeGreaterThan(10);
    }
  });

  it('has a deterministic, fully opaque garden backdrop', () => {
    expect(art.backdrop?.width).toBe(256);
    const a = garden(64, 3);
    const b = garden(64, 3);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(a.solidCount()).toBe(64 * 64);
  });

  it('dresses 8 distinct casual crew with every anim × facing', () => {
    expect(art.crewStyle.uniform).toBe('casual');
    const keys = new Set(
      crewVariants(HOME_CREW, 8).map((v) => `${v.skin}-${v.hair}-${v.hairStyle}-${v.outfit}`),
    );
    expect(keys.size).toBe(8);
    const set = generateCrewSet(HOME_CREW, CREW_ANIMS, 8);
    expect(set.frames.size).toBe(8 * CREW_ANIMS.length * 4);
    for (const [key, frames] of set.frames) {
      const anim = key.split(':')[1] as (typeof CREW_ANIMS)[number];
      expect(frames.length).toBe(crewFrameCount(anim));
      for (const f of frames) expect([f.width, f.height]).toEqual([CREW_W, CREW_H]);
    }
  });
});
