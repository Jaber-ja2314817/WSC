import { describe, expect, it } from 'vitest';
import { ThemeManager, type ThemeApi } from '../src/renderer/themes/manager';

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
