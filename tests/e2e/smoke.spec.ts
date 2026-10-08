import { _electron as electron, expect, test } from '@playwright/test';

test('app launches and renders the station canvas', async () => {
  const app = await electron.launch({ args: ['.'] });
  const errors: string[] = [];
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  await expect(win.locator('#stage canvas')).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#panel')).toContainText('WSC v0.1.0');
  await win.screenshot({ path: 'test-results/smoke.png' });
  expect(errors).toEqual([]);
  await app.close();
});
