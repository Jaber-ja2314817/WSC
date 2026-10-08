// Pure output of an art generator. The loader wraps these buffers into Pixi textures.
//
// Prop convention (all props except `command_table`): the scene places a prop with Pixi anchor
// (0, 1) at the bottom-left corner of its footprint's bottom row, i.e. (x * ts, (y + 1) * ts) for
// a prop on tile (x, y). Width may span several tiles (desk = 2 tiles); height may exceed one tile
// (the extra pixels extend upward, giving a 3/4 view).
//
// `command_table` is a 48×48 nine-slice texture with 16 px borders: draw it with a Pixi
// NineSliceSprite (leftWidth/topHeight/rightWidth/bottomHeight = 16) sized to the layout's
// `center.table` rect in pixels.
import type { FloorKind } from '@shared/layoutTypes';
import type { ThemeManifest } from '@shared/themeSchema';
import type { ToolCategory } from '@shared/types';
import type { CrewStyle } from '../crew';
import type { PixelBuffer } from '../pixelBuffer';

export interface GeneratedArt {
  tileSize: number;
  crewStyle: CrewStyle;
  /** Number of crew variants to generate (default 8). */
  crewVariants?: number;
  /** Several variants per kind; the runtime picks one per tile by coordinate hash. */
  floors: Record<FloorKind, PixelBuffer[]>;
  wall: PixelBuffer;
  props: Record<string, PixelBuffer>;
  gear: Record<ToolCategory, PixelBuffer>;
  /** Seamlessly tileable backdrop; draw with a TilingSprite behind the station. */
  backdrop?: PixelBuffer;
}

export type ArtGenerator = (
  manifest: ThemeManifest,
  options: Record<string, unknown>,
) => GeneratedArt;

export const NINE_SLICE_BORDER = 16;
