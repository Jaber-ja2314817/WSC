// App shell: settings persistence and compact mode, each run fully isolated from a real install.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import type { WscApi } from '../../src/shared/ipc';

/** The renderer's globals, typed for page.evaluate callbacks (casts are erased at runtime). */
interface WscWindow {
  wsc: WscApi;
  __wscDebug: () => Debug;
}

interface Debug {
  zones: number;
  theme?: string;
  mode: 'normal' | 'compact';
  loungeSize: number;
}

function isolatedEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'wsc-e2e-shell-'));
  return {
    ...(process.env as Record<string, string>),
    WSC_USER_DATA: join(dir, 'userData'),
    WSC_RUNTIME_FILE: join(dir, 'runtime.json'),
    WSC_STATE_FILE: join(dir, 'state.json'),
    WSC_THEMES_DIR: join(dir, 'themes'),
  };
}

async function ready(win: Page): Promise<Debug> {
  await expect(win.locator('#stage canvas')).toBeVisible({ timeout: 15_000 });
  await win.waitForFunction(() => '__wscDebug' in window);
  return win.evaluate(() => (window as unknown as WscWindow).__wscDebug());
}

async function launch(
  env: Record<string, string>,
): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  const win = await app.firstWindow();
  return { app, win };
}

test('settings persist across relaunch', async () => {
  const env = isolatedEnv();
  let { app, win } = await launch(env);
  expect((await ready(win)).loungeSize).toBe(6);

  const saved = await win.evaluate(() =>
    (window as unknown as WscWindow).wsc.setSettings({
      loungeSize: 9,
      catchphraseBubbles: false,
      reportFrequency: 'chatty',
    }),
  );
  expect(saved.loungeSize).toBe(9);
  // The renderer picks the change up live.
  await expect
    .poll(() => win.evaluate(() => (window as unknown as WscWindow).__wscDebug().loungeSize))
    .toBe(9);
  await app.close();

  ({ app, win } = await launch(env));
  const debug = await ready(win);
  expect(debug.loungeSize).toBe(9);
  const s = await win.evaluate(() => (window as unknown as WscWindow).wsc.getSettings());
  expect(s.catchphraseBubbles).toBe(false);
  expect(s.reportFrequency).toBe('chatty');
  // Invalid patches are ignored field by field.
  const after = await win.evaluate(() =>
    (window as unknown as WscWindow).wsc.setSettings({ loungeSize: 999 }),
  );
  expect(after.loungeSize).toBe(9);
  await app.close();
});

test('compact mode is a small always-on-top window and is remembered', async () => {
  const env = isolatedEnv();
  let { app, win } = await launch(env);
  await ready(win);

  const next = app.waitForEvent('window');
  // Don't await the IPC reply: the calling window is replaced by the compact one.
  await win.evaluate(() => {
    void (window as unknown as WscWindow).wsc.setWindowMode('compact');
  });
  const compact = await next;
  const debug = await ready(compact);
  expect(debug.mode).toBe('compact');
  await expect(compact.locator('#panel')).toBeHidden();
  await expect(compact.locator('#compact')).toBeVisible();

  const info = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed());
    const [width, height] = w ? w.getSize() : [0, 0];
    return {
      count: BrowserWindow.getAllWindows().length,
      onTop: w?.isAlwaysOnTop(),
      width,
      height,
    };
  });
  expect(info.count).toBe(1);
  expect(info.onTop).toBe(true);
  expect(info.width).toBeLessThanOrEqual(480);
  expect(info.height).toBeLessThanOrEqual(320);
  await app.close();

  // Relaunch opens straight into compact mode; toggling returns to the normal window.
  ({ app, win } = await launch(env));
  expect((await ready(win)).mode).toBe('compact');
  const back = app.waitForEvent('window');
  await win.evaluate(() => {
    void (window as unknown as WscWindow).wsc.setWindowMode('toggle');
  });
  const normal = await back;
  expect((await ready(normal)).mode).toBe('normal');
  const onTop = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((b) => !b.isDestroyed())
      ?.isAlwaysOnTop(),
  );
  expect(onTop).toBe(false);
  await app.close();
});
