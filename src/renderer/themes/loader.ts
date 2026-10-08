/// <reference types="vite/client" />
// Theme loader: built-in themes are bundled from /themes/*/theme.json; generated art comes from
// the generator registry. A broken or unknown theme never blanks the window — it falls back to
// Spaceship and returns a human-readable `warning` for the UI to show.
import { validateTheme, type ThemeManifest } from '@shared/themeSchema';
import { spaceshipGenerator } from './generators/spaceship';
import type { ArtGenerator } from './generators/types';
import { createGeneratedRuntime, createSheetRuntime, loadImageSource } from './runtime';
import type { ThemeRuntime } from './types';

export const DEFAULT_THEME_ID = 'spaceship';

export interface LoadedTheme {
  theme: ThemeRuntime;
  /** Set when the requested theme could not be used and the default was loaded instead. */
  warning?: string;
}

export interface LoadThemeOptions {
  /** Resolve a theme-relative asset path (sheet images) to a loadable URL. */
  resolveAsset?: (path: string) => string | Promise<string>;
}

const generators = new Map<string, ArtGenerator>();

export function registerGenerator(id: string, generator: ArtGenerator): void {
  generators.set(id, generator);
}

registerGenerator('spaceship', spaceshipGenerator);

// Every folder under /themes with a theme.json is a built-in theme.
const manifestModules = import.meta.glob('../../../themes/*/theme.json', {
  eager: true,
  import: 'default',
});
const assetUrls = import.meta.glob<string>('../../../themes/*/*.png', {
  eager: true,
  import: 'default',
  query: '?url',
});

const themeIdFromPath = (p: string): string => p.split('/').slice(-2, -1)[0] ?? '';

export const BUILT_IN_MANIFESTS: Record<string, unknown> = Object.fromEntries(
  Object.entries(manifestModules).map(([path, mod]) => [themeIdFromPath(path), mod]),
);

export function builtInThemeIds(): string[] {
  const ids = Object.keys(BUILT_IN_MANIFESTS).sort();
  return [DEFAULT_THEME_ID, ...ids.filter((id) => id !== DEFAULT_THEME_ID)];
}

const builtInAsset =
  (id: string) =>
  (path: string): string => {
    const hit = Object.entries(assetUrls).find(([p]) => p.endsWith(`/themes/${id}/${path}`));
    if (!hit) throw new Error(`missing asset ${path}`);
    return hit[1];
  };

async function build(manifest: ThemeManifest, opts: LoadThemeOptions): Promise<ThemeRuntime> {
  const art = manifest.art;
  if (art.kind === 'generated') {
    const gen = generators.get(art.generator);
    if (!gen) throw new Error(`unknown art generator "${art.generator}"`);
    return createGeneratedRuntime(manifest, gen(manifest, art.options ?? {}));
  }
  if (!opts.resolveAsset) throw new Error('sprite sheet themes need an asset resolver');
  const image = await loadImageSource(await opts.resolveAsset(art.image));
  const crewImage = art.crew.image
    ? await loadImageSource(await opts.resolveAsset(art.crew.image))
    : image;
  return createSheetRuntime(manifest, art, image, crewImage);
}

async function fallback(reason: string): Promise<LoadedTheme> {
  const res = validateTheme(BUILT_IN_MANIFESTS[DEFAULT_THEME_ID]);
  if (!res.ok) throw new Error(`default theme is invalid: ${res.errors.join('; ')}`);
  return { theme: await build(res.manifest, {}), warning: reason };
}

/** Load a theme from an already-parsed theme.json (user/community themes). */
export async function loadThemeFromManifest(
  raw: unknown,
  opts: LoadThemeOptions = {},
): Promise<LoadedTheme> {
  const res = validateTheme(raw);
  const label = raw && typeof raw === 'object' && 'name' in raw ? String(raw.name) : 'theme';
  if (!res.ok) {
    const shown = res.errors.slice(0, 3).join('; ');
    const more = res.errors.length > 3 ? ` (+${res.errors.length - 3} more)` : '';
    return fallback(`Theme "${label}" is invalid — ${shown}${more}. Using Spaceship.`);
  }
  try {
    return { theme: await build(res.manifest, opts) };
  } catch (e) {
    return fallback(
      `Theme "${res.manifest.name}" failed to load (${(e as Error).message}). Using Spaceship.`,
    );
  }
}

/** Load a bundled theme by id; unknown ids fall back to Spaceship with a warning. */
export async function loadBuiltInTheme(id: string): Promise<LoadedTheme> {
  const raw = BUILT_IN_MANIFESTS[id];
  if (raw === undefined) return fallback(`Unknown theme "${id}". Using Spaceship.`);
  return loadThemeFromManifest(raw, { resolveAsset: builtInAsset(id) });
}
