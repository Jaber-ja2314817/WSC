// Theme runtime contract: what the scene asks a loaded theme for.
// The manifest schema (zod) lives in src/shared/themeSchema.ts.
import type { Texture } from 'pixi.js';
import type { Dir, FloorKind } from '@shared/layoutTypes';
import type { ToolCategory } from '@shared/types';
import type { CrewAnim, PhraseMoment } from '../director/types';

/** Props every theme must be able to draw (generated or from a sprite sheet). */
export type CoreProp =
  'command_table' | 'desk' | 'chair' | 'lounge_seat' | 'nameplate' | 'door' | 'plant';

export interface ThemePalette {
  background: string;
  panel: string;
  text: string;
  accent: string;
  working: string;
  waiting: string;
  done: string;
  error: string;
  stale: string;
}

export interface ThemeRuntime {
  id: string;
  name: string;
  /** Source tile size in px (e.g. 16). */
  tileSize: number;
  /** Default integer zoom. */
  pixelScale: number;
  palette: ThemePalette;
  roomNames: { center: string; lounge: string; zone: string };
  /** Number of distinct crew appearance variants available. */
  crewVariants: number;
  /** Frames for an animation (≥1). Variant is taken modulo crewVariants. */
  crewFrames(variant: number, anim: CrewAnim, facing: Dir): Texture[];
  /** Frames per second for an animation. */
  crewFps(anim: CrewAnim): number;
  floor(kind: FloorKind, x: number, y: number): Texture;
  wall(): Texture;
  /** Core props always exist; decor props may return null (skipped). */
  prop(name: CoreProp | (string & {})): Texture | null;
  /** Station gear shown at a desk while working in a category. */
  gear(category: ToolCategory): Texture;
  /** Optional animated backdrop (e.g. starfield). Called once per scene build. */
  backdrop?(width: number, height: number): Texture | null;
  phrases(moment: PhraseMoment): readonly string[];
  /** Bitmap-ish font family for labels/bubbles (CSS family name). */
  fontFamily: string;
  /** Free GPU textures when switching themes. */
  destroy(): void;
}
