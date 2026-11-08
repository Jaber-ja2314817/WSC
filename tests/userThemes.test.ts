import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getUserTheme,
  listUserThemes,
  readThemeAsset,
  registerUserThemeIpc,
} from '../src/main/userThemes';
import { validateTheme } from '../src/shared/themeSchema';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let root: string;
let outside: string;

async function theme(id: string, manifest: unknown): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  await writeFile(join(dir, 'theme.json'), body);
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wsc-themes-'));
  outside = await mkdtemp(join(tmpdir(), 'wsc-outside-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('listUserThemes', () => {
  it('lists valid folders sorted, with names', async () => {
    await theme('neon', { name: 'Neon Nights' });
    await theme('alpha', { name: 'Alpha' });
    const list = await listUserThemes(root);
    expect(list.map((t) => [t.id, t.name])).toEqual([
      ['alpha', 'Alpha'],
      ['neon', 'Neon Nights'],
    ]);
    expect(list[0]?.dir).toBe(join(root, 'alpha'));
  });

  it('skips malformed, non-object, oversized and badly named themes', async () => {
    await theme('broken', '{ not json');
    await theme('array', '[1,2,3]');
    await theme('Bad_Name', { name: 'x' });
    await theme('huge', JSON.stringify({ name: 'x', pad: 'a'.repeat(300 * 1024) }));
    await mkdir(join(root, 'empty'));
    await theme('ok', { name: 'Fine' });
    expect((await listUserThemes(root)).map((t) => t.id)).toEqual(['ok']);
  });

  it('falls back to the folder id when the name is missing', async () => {
    await theme('noname', { id: 'noname' });
    expect((await listUserThemes(root))[0]?.name).toBe('noname');
  });

  it('returns [] for a missing root without throwing', async () => {
    expect(await listUserThemes(join(root, 'nope'))).toEqual([]);
  });
});

describe('readThemeAsset', () => {
  beforeEach(async () => {
    const dir = await theme('sheet', { name: 'Sheet' });
    await mkdir(join(dir, 'art'));
    await writeFile(join(dir, 'art', 'crew.png'), PNG);
    await writeFile(join(dir, 'fake.png'), 'not really a png');
    await writeFile(join(dir, 'notes.txt'), 'hello');
    await writeFile(join(outside, 'secret.png'), PNG);
  });

  it('reads a PNG inside the theme folder', async () => {
    const bytes = await readThemeAsset('sheet', 'art/crew.png', root);
    expect(bytes && Buffer.from(bytes).equals(PNG)).toBe(true);
  });

  it.each([
    '../sheet/art/crew.png',
    'art/../../sheet/art/crew.png',
    '/etc/passwd.png',
    'notes.txt',
    'fake.png',
    'missing.png',
    '',
  ])('rejects %j', async (p) => {
    expect(await readThemeAsset('sheet', p, root)).toBeNull();
  });

  it('rejects an absolute path to a PNG outside the theme', async () => {
    expect(await readThemeAsset('sheet', join(outside, 'secret.png'), root)).toBeNull();
  });

  it('rejects bad theme ids', async () => {
    expect(await readThemeAsset('../sheet', 'art/crew.png', root)).toBeNull();
  });

  it('rejects symlinks that escape the theme folder', async () => {
    await symlink(join(outside, 'secret.png'), join(root, 'sheet', 'link.png'));
    expect(await readThemeAsset('sheet', 'link.png', root)).toBeNull();
  });

  it('rejects files over the 4 MB cap', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    await writeFile(join(root, 'sheet', 'big.png'), big);
    expect(await readThemeAsset('sheet', 'big.png', root)).toBeNull();
  });
});

describe('getUserTheme', () => {
  it('returns the manifest with referenced PNGs as data URLs', async () => {
    const dir = await theme('sheety', {
      name: 'Sheety',
      art: { kind: 'sheet', image: 'sheet.png', crew: { image: 'crew.png' } },
    });
    await writeFile(join(dir, 'sheet.png'), PNG);
    await writeFile(join(dir, 'crew.png'), PNG);
    const data = await getUserTheme('sheety', root);
    expect(Object.keys(data?.assets ?? {}).sort()).toEqual(['crew.png', 'sheet.png']);
    expect(data?.assets['sheet.png']).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('returns null for unknown or invalid ids', async () => {
    expect(await getUserTheme('nope', root)).toBeNull();
    expect(await getUserTheme('../etc', root)).toBeNull();
  });
});

describe('docs/examples/minimal-theme', () => {
  it('is a valid, installable theme manifest', async () => {
    const raw = JSON.parse(
      await readFile(join('docs', 'examples', 'minimal-theme', 'theme.json'), 'utf8'),
    ) as unknown;
    const res = validateTheme(raw);
    expect(res.ok ? [] : res.errors).toEqual([]);
    if (res.ok) {
      expect(res.manifest.id).toBe('minimal-theme');
      expect(res.manifest.art).toEqual({ kind: 'generated', generator: 'spaceship' });
    }
  });
});

describe('registerUserThemeIpc', () => {
  it('reports a theme copied into a themes folder that did not exist at startup', async () => {
    const folder = join(root, 'not-created-yet');
    process.env['WSC_THEMES_DIR'] = folder;
    const send = vi.fn();
    const ipc = { handle: vi.fn(), removeHandler: vi.fn() } as unknown as IpcMain;
    const win = { webContents: { send } } as unknown as BrowserWindow;
    const stop = registerUserThemeIpc(ipc, () => win);
    try {
      await mkdir(join(folder, 'neon'), { recursive: true });
      await writeFile(join(folder, 'neon', 'theme.json'), '{}');
      await vi.waitFor(() => expect(send).toHaveBeenCalled(), { timeout: 3000 });
    } finally {
      stop();
      delete process.env['WSC_THEMES_DIR'];
    }
  });
});
