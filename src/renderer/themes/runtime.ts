// Builds a ThemeRuntime (contract in ./types.ts) from a validated manifest plus either generated
// art (pixel buffers) or a hand-made sprite sheet. Textures are created lazily and cached.
import { ImageSource, Rectangle, Texture, type TextureSource } from 'pixi.js';
import type { Dir, FloorKind } from '@shared/layoutTypes';
import {
  THEME_CREW_ANIMS,
  THEME_FACINGS,
  type SheetArt,
  type ThemeManifest,
} from '@shared/themeSchema';
import type { ToolCategory } from '@shared/types';
import type { CrewAnim, PhraseMoment } from '../director/types';
import { crewAnimFps, crewFrameCount, crewKey, crewVariants, drawCrewFrame } from './crew';
import type { GeneratedArt } from './generators/types';
import { bufferToTexture, hash2 } from './pixel';
import type { ThemePalette, ThemeRuntime } from './types';

export const DEFAULT_FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

type Common = Pick<
  ThemeRuntime,
  'id' | 'name' | 'tileSize' | 'pixelScale' | 'palette' | 'roomNames' | 'fontFamily' | 'phrases'
>;

function common(m: ThemeManifest): Common {
  return {
    id: m.id,
    name: m.name,
    tileSize: m.tileSize,
    pixelScale: m.pixelScale,
    palette: { ...m.palette } satisfies ThemePalette,
    roomNames: { ...m.roomNames },
    fontFamily: m.fontFamily ?? DEFAULT_FONT,
    phrases: (moment: PhraseMoment) => m.phrases[moment] ?? [],
  };
}

/** Runtime over generated art. */
export function createGeneratedRuntime(m: ThemeManifest, art: GeneratedArt): ThemeRuntime {
  const owned: Texture[] = [];
  const make = (b: Parameters<typeof bufferToTexture>[0]): Texture => {
    const t = bufferToTexture(b);
    owned.push(t);
    return t;
  };
  const variantCount = art.crewVariants ?? 8;
  const variants = crewVariants(art.crewStyle, variantCount);
  const crewCache = new Map<string, Texture[]>();
  const floorCache = new Map<FloorKind, Texture[]>();
  const propCache = new Map<string, Texture | null>();
  const gearCache = new Map<ToolCategory, Texture>();
  let wallTex: Texture | null = null;
  let backdropTex: Texture | null = null;

  const prop = (name: string): Texture | null => {
    if (propCache.has(name)) return propCache.get(name) ?? null;
    const b = art.props[name];
    const t = b ? make(b) : null;
    propCache.set(name, t);
    return t;
  };

  return {
    ...common(m),
    crewVariants: variantCount,
    crewFrames(variant: number, anim: CrewAnim, facing: Dir): Texture[] {
      const v = ((variant % variantCount) + variantCount) % variantCount;
      const key = crewKey(v, anim, facing);
      let list = crewCache.get(key);
      if (!list) {
        const spec = variants[v]!;
        list = [];
        for (let f = 0; f < crewFrameCount(anim); f++) {
          list.push(make(drawCrewFrame(spec, art.crewStyle, anim, facing, f)));
        }
        crewCache.set(key, list);
      }
      return list;
    },
    crewFps: (anim) => crewAnimFps(anim),
    floor(kind, x, y) {
      let list = floorCache.get(kind);
      if (!list) {
        const bufs = art.floors[kind]?.length ? art.floors[kind] : art.floors.center;
        list = bufs.map(make);
        floorCache.set(kind, list);
      }
      return list[Math.floor(hash2(x, y, 11) * list.length)] ?? list[0]!;
    },
    wall() {
      wallTex ??= make(art.wall);
      return wallTex;
    },
    prop,
    gear(category) {
      let t = gearCache.get(category);
      if (!t) {
        const override = m.gear?.[category];
        t = (override ? prop(override) : null) ?? make(art.gear[category] ?? art.gear.other);
        gearCache.set(category, t);
      }
      return t;
    },
    backdrop: art.backdrop
      ? () => {
          backdropTex ??= make(art.backdrop!);
          return backdropTex;
        }
      : undefined,
    destroy() {
      for (const t of owned) t.destroy(true);
      owned.length = 0;
      crewCache.clear();
      floorCache.clear();
      propCache.clear();
      gearCache.clear();
      wallTex = null;
      backdropTex = null;
    },
  };
}

export async function loadImageSource(url: string): Promise<TextureSource> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return new ImageSource({ resource: img, scaleMode: 'nearest', autoGenerateMipmaps: false });
}

/** Runtime over a hand-made sprite sheet (format documented in themeSchema.ts / docs/themes.md). */
export function createSheetRuntime(
  m: ThemeManifest,
  sheet: SheetArt,
  image: TextureSource,
  crewImage: TextureSource = image,
): ThemeRuntime {
  const owned: Texture[] = [];
  const sub = (src: TextureSource, r: { x: number; y: number; w: number; h: number }): Texture => {
    if (r.x + r.w > src.width || r.y + r.h > src.height) return Texture.EMPTY;
    const t = new Texture({ source: src, frame: new Rectangle(r.x, r.y, r.w, r.h) });
    owned.push(t);
    return t;
  };
  const crew = sheet.crew;
  const crewCache = new Map<string, Texture[]>();
  const cache = new Map<string, Texture | null>();
  const once = (key: string, fn: () => Texture | null): Texture | null => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key) ?? null;
  };
  const prop = (name: string): Texture | null =>
    once(`prop:${name}`, () => (sheet.props[name] ? sub(image, sheet.props[name]) : null));

  return {
    ...common(m),
    crewVariants: crew.variants,
    crewFrames(variant, anim, facing) {
      const v = ((variant % crew.variants) + crew.variants) % crew.variants;
      const key = crewKey(v, anim, facing);
      let list = crewCache.get(key);
      if (!list) {
        const ai = THEME_CREW_ANIMS.indexOf(anim);
        const fi = THEME_FACINGS.indexOf(facing);
        const n = Math.min(crew.anims?.[anim]?.frames ?? 1, crew.maxFrames);
        list = [];
        for (let k = 0; k < n; k++) {
          list.push(
            sub(crewImage, {
              x: crew.x + (v * crew.maxFrames + k) * crew.frameWidth,
              y: crew.y + (Math.max(0, ai) * 4 + Math.max(0, fi)) * crew.frameHeight,
              w: crew.frameWidth,
              h: crew.frameHeight,
            }),
          );
        }
        crewCache.set(key, list);
      }
      return list;
    },
    crewFps: (anim) => crew.anims?.[anim]?.fps ?? crewAnimFps(anim),
    floor(kind, x, y) {
      const rects = sheet.floors[kind] ?? sheet.floors.center ?? Object.values(sheet.floors)[0];
      if (!rects?.length) return Texture.EMPTY;
      const r = rects[Math.floor(hash2(x, y, 11) * rects.length)] ?? rects[0]!;
      return once(`floor:${kind}:${r.x},${r.y}`, () => sub(image, r)) ?? Texture.EMPTY;
    },
    wall: () => once('wall', () => sub(image, sheet.wall)) ?? Texture.EMPTY,
    prop,
    gear(category) {
      const override = m.gear?.[category];
      const rect = sheet.gear?.[category] ?? sheet.gear?.other;
      return (
        (override ? prop(override) : null) ??
        once(`gear:${category}`, () => (rect ? sub(image, rect) : null)) ??
        Texture.EMPTY
      );
    },
    backdrop: sheet.backdrop
      ? () => once('backdrop', () => sub(image, sheet.backdrop!))
      : undefined,
    destroy() {
      for (const t of owned) t.destroy(false);
      owned.length = 0;
      crewCache.clear();
      cache.clear();
      image.destroy();
      if (crewImage !== image) crewImage.destroy();
    },
  };
}
