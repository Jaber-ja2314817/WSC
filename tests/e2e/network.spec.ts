// Local only, end to end: the running app cannot reach the internet from either process.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const env = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  WSC_RUNTIME_FILE: join(mkdtempSync(join(tmpdir(), 'wsc-e2e-')), 'runtime.json'),
  // Isolated profile: never touch the real install's settings or single-instance lock.
  WSC_USER_DATA: mkdtempSync(join(tmpdir(), 'wsc-e2e-ud-')),
  WSC_STATE_FILE: join(mkdtempSync(join(tmpdir(), 'wsc-e2e-')), 'state.json'),
});

test('outbound requests are blocked in the renderer and the main session', async () => {
  const app = await electron.launch({ args: ['.', '--demo'], env: env() });
  const win = await app.firstWindow();
  await expect(win.locator('#stage canvas')).toBeVisible({ timeout: 15_000 });

  // Renderer: fetch and <img> to a remote host both fail.
  const renderer = await win.evaluate(async () => {
    let fetchBlocked = false;
    try {
      await fetch('https://example.com/');
    } catch {
      fetchBlocked = true;
    }
    const imgLoaded = await new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = 'https://example.com/pixel.png';
      setTimeout(() => resolve(false), 5_000);
    });
    return { fetchBlocked, imgLoaded };
  });
  expect(renderer).toEqual({ fetchBlocked: true, imgLoaded: false });

  // Main process: requests through the default session hit the webRequest guard, which cancels
  // them (independently of the renderer's CSP).
  const main = await app.evaluate(async ({ net }) => {
    try {
      await net.fetch('https://example.com/');
      return 'reached';
    } catch (e) {
      return String(e);
    }
  });
  expect(main).toMatch(/ERR_BLOCKED_BY_CLIENT|blocked/i);

  // Local traffic still works: the app's own server answers on 127.0.0.1.
  const local = await app.evaluate(async ({ net }) => {
    try {
      const r = await net.fetch('http://127.0.0.1:1/');
      return `status ${r.status}`;
    } catch (e) {
      return String(e);
    }
  });
  expect(local).not.toMatch(/ERR_BLOCKED_BY_CLIENT/);

  await app.close();
});
