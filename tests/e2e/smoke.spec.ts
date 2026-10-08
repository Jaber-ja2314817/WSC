import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

// Isolated runtime file and profile so the test never touches a real install.
const env = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  WSC_RUNTIME_FILE: join(mkdtempSync(join(tmpdir(), 'wsc-e2e-')), 'runtime.json'),
  WSC_USER_DATA: mkdtempSync(join(tmpdir(), 'wsc-e2e-ud-')),
});

async function launch(args: string[]): Promise<{ app: ElectronApplication; errors: string[] }> {
  const app = await electron.launch({ args: ['.', ...args], env: env() });
  const errors: string[] = [];
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return { app, errors };
}

test('app launches and renders the station canvas', async () => {
  const { app, errors } = await launch([]);
  const win = await app.firstWindow();
  await expect(win.locator('#stage canvas')).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#panel')).not.toBeEmpty();
  await expect(win.locator('#fit-all')).toBeVisible();
  await win.screenshot({ path: 'test-results/smoke.png' });
  expect(errors).toEqual([]);
  await app.close();
});

test('demo mode plays a scripted run without errors', async () => {
  const { app, errors } = await launch(['--demo']);
  const win = await app.firstWindow();
  await expect(win.locator('#stage canvas')).toBeVisible({ timeout: 15_000 });
  await win.waitForTimeout(6_000);
  const debug = await win.evaluate(() =>
    (window as unknown as { __wscDebug?: () => { zones: number } }).__wscDebug?.(),
  );
  // Demo runs across at least two projects.
  expect(debug?.zones ?? 0).toBeGreaterThanOrEqual(2);
  await win.screenshot({ path: 'test-results/demo.png' });
  expect(errors).toEqual([]);
  await app.close();
});
