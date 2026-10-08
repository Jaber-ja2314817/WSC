import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_CREW_ANIMS, THEME_PHRASE_MOMENTS, validateTheme } from '../src/shared/themeSchema';
import { CREW_ANIMS, PHRASE_MOMENTS } from '../src/renderer/director/types';

const load = (id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`themes/${id}/theme.json`, 'utf8')) as Record<string, unknown>;

const spaceship = (): Record<string, unknown> => structuredClone(load('spaceship'));

describe('theme schema', () => {
  it('stays in sync with the director contract', () => {
    expect([...THEME_PHRASE_MOMENTS]).toEqual([...PHRASE_MOMENTS]);
    expect([...THEME_CREW_ANIMS]).toEqual([...CREW_ANIMS]);
  });

  it.each(readdirSync('themes'))('accepts built-in theme %s', (id) => {
    const res = validateTheme(load(id));
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('has 5+ phrases per moment in the spaceship theme', () => {
    const res = validateTheme(spaceship());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const m of THEME_PHRASE_MOMENTS)
      expect(res.manifest.phrases[m].length).toBeGreaterThanOrEqual(5);
  });

  it('rejects a missing phrase moment with a readable path', () => {
    const t = spaceship();
    delete (t['phrases'] as Record<string, unknown>)['waiting'];
    const res = validateTheme(t);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/^phrases\.waiting: /m);
  });

  it('rejects bad colors, tile sizes and long phrases', () => {
    const t = spaceship();
    (t['palette'] as Record<string, unknown>)['accent'] = 'cyan';
    t['tileSize'] = 64;
    (t['phrases'] as Record<string, string[]>)['done'] = ['x'.repeat(41)];
    const res = validateTheme(t);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const all = res.errors.join('\n');
    expect(all).toContain('palette.accent: must be a #rrggbb color');
    expect(all).toMatch(/^tileSize: /m);
    expect(all).toMatch(/^phrases\.done\.0: catchphrases must be at most 40 characters/m);
  });

  it('rejects asset paths that escape the theme folder', () => {
    const t = spaceship();
    t['art'] = {
      kind: 'sheet',
      image: '../secret.png',
      crew: { frameWidth: 16, frameHeight: 24, variants: 1 },
      floors: { center: [{ x: 0, y: 0, w: 16, h: 16 }] },
      wall: { x: 0, y: 0, w: 16, h: 16 },
      props: {},
    };
    const res = validateTheme(t);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/^art\.image: /m);
  });

  it('accepts a minimal sprite-sheet theme with defaults filled in', () => {
    const t = spaceship();
    t['art'] = {
      kind: 'sheet',
      image: 'sheet.png',
      crew: { frameWidth: 16, frameHeight: 24, variants: 2, anims: { walk: { frames: 4 } } },
      floors: { center: [{ x: 0, y: 0, w: 16, h: 16 }] },
      wall: { x: 16, y: 0, w: 16, h: 16 },
      props: { desk: { x: 0, y: 16, w: 32, h: 24 } },
    };
    const res = validateTheme(t);
    expect(res.ok).toBe(true);
    if (res.ok && res.manifest.art.kind === 'sheet') {
      expect(res.manifest.art.crew.maxFrames).toBe(4);
      expect(res.manifest.art.crew.x).toBe(0);
    }
  });

  it('never throws on garbage', () => {
    for (const raw of [null, undefined, 42, 'theme', [], { id: 'X Y' }]) {
      const res = validateTheme(raw);
      expect(res.ok).toBe(false);
    }
  });
});
