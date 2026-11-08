// User/community themes: <appData>/WSC/themes/<id>/theme.json (+ PNG assets).
// Everything read from this folder is untrusted: sizes are capped, paths are confined to the
// theme's own folder, and only PNG assets are served (as data: URLs, which the CSP allows).
import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { IPC, type UserThemeData, type UserThemeInfo } from '@shared/ipc';
import { appDataDir } from './runtimeFile';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_THEMES = 64;
const MAX_ASSETS_PER_THEME = 32;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface UserTheme {
  id: string;
  name: string;
  manifest: unknown;
  dir: string;
}

/** Root folder for user themes (env `WSC_THEMES_DIR` overrides, used by tests). */
export function userThemesDir(): string {
  return process.env['WSC_THEMES_DIR'] || join(appDataDir(), 'themes');
}

async function readCapped(path: string, max: number): Promise<Buffer | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > max) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/** Every readable `<id>/theme.json`. Folder name is the id; malformed folders are skipped. */
export async function listUserThemes(root = userThemesDir()): Promise<UserTheme[]> {
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && ID_RE.test(d.name))
      .map((d) => d.name)
      .sort()
      .slice(0, MAX_THEMES);
  } catch {
    return [];
  }
  const out: UserTheme[] = [];
  for (const id of entries) {
    const dir = join(root, id);
    const buf = await readCapped(join(dir, 'theme.json'), MAX_MANIFEST_BYTES);
    if (!buf) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(buf.toString('utf8'));
    } catch {
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    const rawName = (manifest as Record<string, unknown>)['name'];
    const name = typeof rawName === 'string' && rawName ? rawName.slice(0, 40) : id;
    out.push({ id, name, manifest, dir });
  }
  return out;
}

/**
 * Read a PNG asset of theme `id`. Returns null for traversal, absolute paths, non-PNG files,
 * symlinks escaping the theme folder, or files over the size cap.
 */
export async function readThemeAsset(
  id: string,
  relPath: string,
  root = userThemesDir(),
): Promise<Uint8Array | null> {
  if (!ID_RE.test(id) || typeof relPath !== 'string' || !relPath) return null;
  if (isAbsolute(relPath) || relPath.includes('\0')) return null;
  const clean = normalize(relPath);
  if (clean.startsWith('..') || clean.split(/[\\/]/).includes('..')) return null;
  if (!clean.toLowerCase().endsWith('.png')) return null;
  const dir = join(root, id);
  try {
    const [realDir, realFile] = await Promise.all([realpath(dir), realpath(join(dir, clean))]);
    const rel = relative(realDir, realFile);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
      return null;
    }
    const buf = await readCapped(realFile, MAX_ASSET_BYTES);
    if (!buf || buf.length < 8 || PNG_MAGIC.some((b, i) => buf[i] !== b)) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Asset paths a manifest references (sheet image, crew image). */
function referencedAssets(manifest: unknown): string[] {
  const art = (
    manifest as { art?: { kind?: unknown; image?: unknown; crew?: { image?: unknown } } }
  ).art;
  if (!art || art.kind !== 'sheet') return [];
  return [art.image, art.crew?.image]
    .filter((p): p is string => typeof p === 'string')
    .slice(0, MAX_ASSETS_PER_THEME);
}

/** Manifest + its PNG assets as data: URLs, or null if the theme doesn't exist. */
export async function getUserTheme(
  id: string,
  root = userThemesDir(),
): Promise<UserThemeData | null> {
  if (!ID_RE.test(id)) return null;
  const theme = (await listUserThemes(root)).find((t) => t.id === id);
  if (!theme) return null;
  const assets: Record<string, string> = {};
  for (const p of referencedAssets(theme.manifest)) {
    const bytes = await readThemeAsset(id, p, root);
    if (bytes) assets[p] = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  }
  return { manifest: theme.manifest, assets };
}

/**
 * IPC for user themes. Call once from main after app ready:
 * `registerUserThemeIpc(ipcMain, () => mainWindow)`.
 * Edits under the themes folder emit IPC.themesChanged (debounced), so a theme copied in while the
 * app runs shows up right away. Tests can turn that off with `watchForChanges`.
 */
export function registerUserThemeIpc(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
  watchForChanges = true,
): () => void {
  ipcMain.handle(IPC.listUserThemes, async (): Promise<UserThemeInfo[]> =>
    (await listUserThemes()).map(({ id, name }) => ({ id, name })),
  );
  ipcMain.handle(IPC.getUserTheme, (_e, id: unknown) =>
    typeof id === 'string' ? getUserTheme(id) : null,
  );

  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  if (watchForChanges) {
    try {
      // A first theme usually lands in a folder that doesn't exist yet.
      mkdirSync(userThemesDir(), { recursive: true, mode: 0o700 });
      watcher = watch(userThemesDir(), { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => getWindow()?.webContents.send(IPC.themesChanged), 300);
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      // Read-only app data or no recursive watch: themes are picked up on the next launch.
    }
  }
  return () => {
    watcher?.close();
    if (timer) clearTimeout(timer);
    ipcMain.removeHandler(IPC.listUserThemes);
    ipcMain.removeHandler(IPC.getUserTheme);
  };
}
