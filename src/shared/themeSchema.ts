// theme.json manifest schema (zod v4). Pure — shared by the renderer loader, main and tests.
// Full authoring guide: docs/themes.md.
import { z } from 'zod';

/** Catchphrase moments. Must stay in sync with PhraseMoment in src/renderer/director/types.ts. */
export const THEME_PHRASE_MOMENTS = [
  'assigned',
  'heading_out',
  'done',
  'error',
  'waiting',
  'lounge',
  'delegating',
  'arrive',
] as const;

/** Crew animations. Must stay in sync with CREW_ANIMS in src/renderer/director/types.ts. */
export const THEME_CREW_ANIMS = [
  'idle',
  'walk',
  'sit',
  'type',
  'read',
  'scan',
  'terminal',
  'comms',
  'report',
  'celebrate',
  'error',
  'wait',
  'think',
] as const;

/** Facing order used by sprite sheets (rows within an animation). */
export const THEME_FACINGS = ['down', 'left', 'right', 'up'] as const;

export const THEME_TOOL_CATEGORIES = [
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

export const THEME_FLOOR_KINDS = ['center', 'lounge', 'zone', 'corridor'] as const;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb color');
const phrase = z.string().min(1).max(40, 'catchphrases must be at most 40 characters');
const phraseList = z.array(phrase).min(1, 'needs at least one phrase').max(20);
const assetPath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*\.\.)[\w./ -]+$/, 'must be a relative path inside the theme folder');

const rect = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});

const generatedArt = z.object({
  kind: z.literal('generated'),
  /** Registered generator id, e.g. 'spaceship'. */
  generator: z.string().min(1),
  /** Generator-specific options (palette tweaks etc.). */
  options: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Hand-made sprite sheet. Crew layout: each variant is a block of columns
 * (`maxFrames` × frameWidth wide), placed left to right starting at (x, y).
 * Inside a block, row = animIndex * 4 + facingIndex (THEME_CREW_ANIMS × THEME_FACINGS order),
 * column = frame. Props, floors, wall, gear and backdrop are pixel rects in the image.
 */
const sheetArt = z.object({
  kind: z.literal('sheet'),
  image: assetPath,
  crew: z.object({
    image: assetPath.optional(),
    frameWidth: z.number().int().min(8).max(64),
    frameHeight: z.number().int().min(8).max(64),
    variants: z.number().int().min(1).max(32),
    maxFrames: z.number().int().min(1).max(8).default(4),
    x: z.number().int().min(0).default(0),
    y: z.number().int().min(0).default(0),
    /** Frames per animation (default 1) and optional fps override. */
    anims: z
      .partialRecord(
        z.enum(THEME_CREW_ANIMS),
        z.object({
          frames: z.number().int().min(1).max(8),
          fps: z.number().min(0.5).max(30).optional(),
        }),
      )
      .optional(),
  }),
  floors: z.partialRecord(z.enum(THEME_FLOOR_KINDS), z.array(rect).min(1)),
  wall: rect,
  props: z.record(z.string(), rect),
  gear: z.partialRecord(z.enum(THEME_TOOL_CATEGORIES), rect).optional(),
  backdrop: rect.optional(),
});

const phrasesShape = Object.fromEntries(THEME_PHRASE_MOMENTS.map((m) => [m, phraseList])) as {
  [K in (typeof THEME_PHRASE_MOMENTS)[number]]: typeof phraseList;
};

export const ThemeManifestSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'must be a lowercase slug (a-z, 0-9, -), max 40 chars'),
  name: z.string().min(1).max(40),
  author: z.string().min(1).max(80),
  license: z.string().min(1).max(40),
  version: z.string().regex(/^\d+\.\d+\.\d+([-+].*)?$/, 'must be a semver version like 1.0.0'),
  description: z.string().max(280).optional(),
  palette: z.object({
    background: color,
    panel: color,
    text: color,
    accent: color,
    working: color,
    waiting: color,
    done: color,
    error: color,
    stale: color,
  }),
  tileSize: z.number().int().min(8).max(32),
  pixelScale: z.number().int().min(1).max(8),
  roomNames: z.object({
    center: z.string().min(1).max(24),
    lounge: z.string().min(1).max(24),
    zone: z.string().min(1).max(24),
  }),
  fontFamily: z.string().min(1).max(120).optional(),
  art: z.discriminatedUnion('kind', [generatedArt, sheetArt]),
  /** Decoration hints per area: prop names the scene may scatter (unknown names are skipped). */
  decor: z
    .object({
      center: z.array(z.string()).max(32).optional(),
      lounge: z.array(z.string()).max(32).optional(),
      zone: z.array(z.string()).max(32).optional(),
    })
    .optional(),
  /** Override which prop is shown as station gear for a tool category. */
  gear: z.partialRecord(z.enum(THEME_TOOL_CATEGORIES), z.string()).optional(),
  ambient: z
    .object({
      starfield: z.boolean().optional(),
      twinkle: z.boolean().optional(),
      scanlines: z.boolean().optional(),
      dust: z.boolean().optional(),
    })
    .optional(),
  phrases: z.object(phrasesShape),
  /** Optional sound files per moment (played only when sound is enabled). */
  sounds: z.partialRecord(z.enum(THEME_PHRASE_MOMENTS), assetPath).optional(),
});

export type ThemeManifest = z.infer<typeof ThemeManifestSchema>;
export type SheetArt = z.infer<typeof sheetArt>;
export type GeneratedArtSpec = z.infer<typeof generatedArt>;

export type ThemeValidation =
  { ok: true; manifest: ThemeManifest } | { ok: false; errors: string[] };

/** Validate a parsed theme.json. Never throws; errors read like `palette.accent: must be a #rrggbb color`. */
export function validateTheme(raw: unknown): ThemeValidation {
  const res = ThemeManifestSchema.safeParse(raw);
  if (res.success) return { ok: true, manifest: res.data };
  const errors = res.error.issues.map((i) => {
    const path = i.path.map(String).join('.');
    return `${path || '(root)'}: ${i.message}`;
  });
  return { ok: false, errors };
}
