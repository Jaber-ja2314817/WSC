import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_GENERATORS } from '../src/renderer/themes/generators';
import { BUILT_IN_MANIFESTS } from '../src/renderer/themes/loader';
import { ThemeManager, type ThemeApi } from '../src/renderer/themes/manager';
import { createGeneratedRuntime } from '../src/renderer/themes/runtime';
import { validateTheme } from '../src/shared/themeSchema';

const api = (users: { id: string; name: string }[]): ThemeApi => ({
  listUserThemes: () => Promise.resolve([...users]),
  getUserTheme: () => Promise.resolve(null),
});

describe('ThemeManager.list', () => {
  it('lists built-ins first (spaceship leading), then user themes', async () => {
    const list = await new ThemeManager(api([{ id: 'neon', name: 'Neon' }])).list();
    expect(list[0]).toEqual({ id: 'spaceship', name: 'Spaceship', source: 'builtin' });
    expect(list.at(-1)).toEqual({ id: 'neon', name: 'Neon', source: 'user' });
  });

  it('lets built-ins win id clashes and survives a failing API', async () => {
    const clash = await new ThemeManager(api([{ id: 'spaceship', name: 'Fake' }])).list();
    expect(clash.filter((t) => t.id === 'spaceship')).toHaveLength(1);
    const broken: ThemeApi = {
      listUserThemes: () => Promise.reject(new Error('ipc down')),
      getUserTheme: () => Promise.resolve(null),
    };
    const list = await new ThemeManager(broken).list();
    expect(list.every((t) => t.source === 'builtin')).toBe(true);
  });

  it('re-reads user themes after invalidate()', async () => {
    const users = [{ id: 'a', name: 'A' }];
    const m = new ThemeManager(api(users));
    expect((await m.list()).some((t) => t.id === 'b')).toBe(false);
    users.push({ id: 'b', name: 'B' });
    expect((await m.list()).some((t) => t.id === 'b')).toBe(false);
    m.invalidate();
    expect((await m.list()).some((t) => t.id === 'b')).toBe(true);
  });
});

describe('hostile themes', () => {
  const minimal = BUILT_IN_MANIFESTS['spaceship'] as Record<string, unknown>;
  const serving = (manifest: unknown): ThemeApi => ({
    listUserThemes: () => Promise.resolve([]),
    getUserTheme: () => Promise.resolve({ manifest, assets: {} }),
  });
  afterEach(() => vi.unstubAllGlobals());

  it('load() falls back when a theme name cannot be turned into a string', async () => {
    const res = await new ThemeManager(serving({ ...minimal, name: { toString: 0 } })).load('evil');
    expect(res.theme.id).toBe('spaceship');
    expect(res.warning).toContain('invalid');
  });

  it('load() falls back instead of rejecting when loading throws', async () => {
    const api: ThemeApi = {
      listUserThemes: () => Promise.resolve([]),
      getUserTheme: () =>
        Promise.resolve({
          get manifest(): unknown {
            throw new Error('boom');
          },
          assets: {},
        }),
    };
    const res = await new ThemeManager(api).load('evil');
    expect(res.theme.id).toBe('spaceship');
    expect(res.warning).toContain('boom');
  });

  it('a gear override naming an Object.prototype key gets the default gear', () => {
    const v = validateTheme({ ...minimal, gear: { other: 'constructor' } });
    if (!v.ok) throw new Error(v.errors.join('; '));
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: () => ({ putImageData: () => {} }) }),
    });
    vi.stubGlobal('ImageData', class {});
    const art = BUILT_IN_GENERATORS['spaceship']!(v.manifest, {});
    const runtime = createGeneratedRuntime(v.manifest, art);
    expect(runtime.prop('constructor')).toBeNull();
    expect(() => runtime.gear('other')).not.toThrow();
  });
});

describe('isUserTheme', () => {
  it('tells bundled themes from the rest', () => {
    const m = new ThemeManager();
    expect(m.isUserTheme('spaceship')).toBe(false);
    expect(m.isUserTheme('my-theme')).toBe(true);
  });
});
