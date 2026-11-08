// Theme manager: lists built-in + user themes, loads one with fallback, and switches live.
// Switching order matters: the scene adopts the new theme first, then the old one's textures
// are destroyed — never the other way round (that would render destroyed textures for a frame).
import type { UserThemeData, UserThemeInfo } from '@shared/ipc';
import {
  BUILT_IN_MANIFESTS,
  DEFAULT_THEME_ID,
  builtInThemeIds,
  loadBuiltInTheme,
  loadThemeFromManifest,
  type LoadedTheme,
} from './loader';
import type { ThemeRuntime } from './types';

export interface ThemeInfo {
  id: string;
  name: string;
  source: 'builtin' | 'user';
}

/** The slice of window.wsc the manager needs (injectable for tests). */
export interface ThemeApi {
  listUserThemes(): Promise<UserThemeInfo[]>;
  getUserTheme(id: string): Promise<UserThemeData | null>;
}

const builtInName = (id: string): string => {
  const raw = BUILT_IN_MANIFESTS[id];
  const name = raw && typeof raw === 'object' ? (raw as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : id;
};

export class ThemeManager {
  private userList: Promise<UserThemeInfo[]> | null = null;
  private current: ThemeRuntime | null = null;
  private switchSeq = 0;

  constructor(private readonly api?: ThemeApi) {}

  /** Id of the theme currently applied via switchTo. */
  get currentId(): string | undefined {
    return this.current?.id;
  }

  /** Forget cached user themes (call when the themes folder changes). */
  invalidate(): void {
    this.userList = null;
  }

  async list(): Promise<ThemeInfo[]> {
    const builtIns: ThemeInfo[] = builtInThemeIds().map((id) => ({
      id,
      name: builtInName(id),
      source: 'builtin',
    }));
    const taken = new Set(builtIns.map((t) => t.id));
    // Built-ins win on id clashes so a stray folder can't hijack "spaceship".
    const users = (await this.userThemes())
      .filter((t) => !taken.has(t.id))
      .map((t): ThemeInfo => ({ id: t.id, name: t.name, source: 'user' }));
    return [...builtIns, ...users];
  }

  /** True for a theme from the user themes folder, as opposed to a bundled one. */
  isUserTheme(id: string): boolean {
    return BUILT_IN_MANIFESTS[id] === undefined;
  }

  /** Load a theme by id without applying it. Never rejects; falls back to Spaceship + warning. */
  async load(id: string): Promise<LoadedTheme> {
    try {
      return await this.loadUnsafe(id);
    } catch (e) {
      const res = await loadBuiltInTheme(DEFAULT_THEME_ID);
      return { ...res, warning: `Theme "${id}" failed to load (${String(e)}). Using Spaceship.` };
    }
  }

  private async loadUnsafe(id: string): Promise<LoadedTheme> {
    if (BUILT_IN_MANIFESTS[id] !== undefined) return loadBuiltInTheme(id);
    const data = this.api ? await this.api.getUserTheme(id).catch(() => null) : null;
    if (!data) {
      const res = await loadBuiltInTheme(DEFAULT_THEME_ID);
      return { ...res, warning: `Theme "${id}" was not found. Using Spaceship.` };
    }
    return loadThemeFromManifest(data.manifest, {
      resolveAsset: (path) => {
        const url = data.assets[path];
        if (!url) throw new Error(`missing or unreadable asset ${path}`);
        return url;
      },
    });
  }

  /**
   * Load `id`, hand it to `apply` (e.g. scene.setTheme), then free the previous theme.
   * If another switch starts meanwhile, the stale result is destroyed without being applied.
   */
  async switchTo(id: string, apply: (theme: ThemeRuntime) => void): Promise<LoadedTheme | null> {
    const seq = ++this.switchSeq;
    const res = await this.load(id);
    if (seq !== this.switchSeq) {
      res.theme.destroy();
      return null;
    }
    const old = this.current;
    apply(res.theme);
    this.current = res.theme;
    if (old && old !== res.theme) old.destroy();
    return res;
  }

  private userThemes(): Promise<UserThemeInfo[]> {
    if (!this.api) return Promise.resolve([]);
    this.userList ??= this.api.listUserThemes().catch(() => []);
    return this.userList;
  }
}
