import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CREW_ANIMS } from '../src/renderer/director/types';
import {
  CREW_H,
  CREW_W,
  crewFrameCount,
  crewVariants,
  drawCrewFrame,
} from '../src/renderer/themes/crew';
import { terminalGenerator, TERMINAL_CREW } from '../src/renderer/themes/generators/terminal';
import type { Dir, FloorKind } from '../src/shared/layoutTypes';
import { validateTheme, type ThemeManifest } from '../src/shared/themeSchema';
import type { ToolCategory } from '../src/shared/types';

const raw = JSON.parse(readFileSync('themes/terminal/theme.json', 'utf8')) as unknown;
const res = validateTheme(raw);
const manifest = (res.ok ? res.manifest : undefined) as ThemeManifest;

/** WCAG relative luminance / contrast ratio. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('terminal theme manifest', () => {
  it('validates', () => {
    expect(res.ok ? [] : res.errors).toEqual([]);
    expect(manifest.id).toBe('terminal');
    expect(manifest.art).toMatchObject({ kind: 'generated', generator: 'terminal' });
    expect(manifest.roomNames).toEqual({ center: 'core', lounge: 'idle_pool', zone: 'proc' });
  });

  it('has 5+ terse phrases for every moment', () => {
    for (const list of Object.values(manifest.phrases)) {
      expect(list.length).toBeGreaterThanOrEqual(5);
      for (const p of list) expect(p.length).toBeLessThanOrEqual(40);
    }
  });

  it('keeps text and accent at ≥ 7:1 contrast on the background', () => {
    const { background, text, accent, panel } = manifest.palette;
    expect(contrast(text, background)).toBeGreaterThanOrEqual(7);
    expect(contrast(accent, background)).toBeGreaterThanOrEqual(7);
    expect(contrast(text, panel)).toBeGreaterThanOrEqual(7);
  });

  it('separates status colors by brightness, not only hue (color-blind safe)', () => {
    const { waiting, working, done, error, stale, background } = manifest.palette;
    const order = [waiting, working, done, error, stale];
    for (let i = 0; i < order.length - 1; i++) {
      expect(contrast(order[i]!, order[i + 1]!)).toBeGreaterThanOrEqual(1.25);
    }
    // Everything but the intentionally dim 'stale' stays readable as a UI color (≥ 3:1).
    for (const c of [waiting, working, done, error]) {
      expect(contrast(c, background)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('terminal generator', () => {
  const art = terminalGenerator(manifest, {});

  it('draws every floor kind with variants', () => {
    for (const k of ['center', 'lounge', 'zone', 'corridor'] as FloorKind[]) {
      expect(art.floors[k].length).toBeGreaterThanOrEqual(1);
      for (const f of art.floors[k]) expect([f.width, f.height]).toEqual([16, 16]);
    }
  });

  it('draws all core and decor props with sensible sizes', () => {
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
      const b = art.props[p];
      expect(b, p).toBeDefined();
      expect(b!.solidCount(), p).toBeGreaterThan(0);
    }
    expect([art.props.command_table!.width, art.props.command_table!.height]).toEqual([48, 48]);
    expect(art.props.desk!.width).toBe(32);
  });

  it('draws a visible glyph for every tool category', () => {
    const cats: ToolCategory[] = [
      'read',
      'search',
      'write',
      'execute',
      'web',
      'delegate',
      'plan',
      'mcp',
      'other',
    ];
    const seen = new Set<string>();
    for (const c of cats) {
      const g = art.gear[c];
      expect([g.width, g.height]).toEqual([16, 16]);
      seen.add(Array.from({ length: 256 }, (_, i) => g.get(i % 16, i >> 4)).join(','));
    }
    expect(seen.size).toBe(cats.length); // every category has a distinct glyph
  });

  it('has no backdrop', () => {
    expect(art.backdrop).toBeUndefined();
  });

  it('produces crew frames for every animation, facing and variant', () => {
    expect(art.crewStyle).toBe(TERMINAL_CREW);
    const variants = crewVariants(TERMINAL_CREW, art.crewVariants ?? 8);
    expect(variants).toHaveLength(8);
    for (const v of variants) {
      for (const anim of CREW_ANIMS) {
        for (const facing of ['down', 'left', 'right', 'up'] as Dir[]) {
          for (let f = 0; f < crewFrameCount(anim); f++) {
            const b = drawCrewFrame(v, TERMINAL_CREW, anim, facing, f);
            expect([b.width, b.height]).toEqual([CREW_W, CREW_H]);
            expect(b.solidCount()).toBeGreaterThan(20);
          }
        }
      }
    }
  });
});
