// Stats view: the dashboard column's "Stats" tab in demo mode (synthetic history, no transcript
// is read), and its switch from live history to the demo. Fully isolated from a real install:
// the live test reads a SYNTHETIC transcript from its own CLAUDE_CONFIG_DIR.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

function isolatedEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'wsc-e2e-stats-'));
  return {
    ...(process.env as Record<string, string>),
    WSC_USER_DATA: join(dir, 'userData'),
    WSC_RUNTIME_FILE: join(dir, 'runtime.json'),
    WSC_STATE_FILE: join(dir, 'state.json'),
    WSC_THEMES_DIR: join(dir, 'themes'),
    // Never the real ~/.claude: an empty config folder unless a test writes into it.
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
  };
}

/** One SYNTHETIC session with two responses, yesterday, in project "e2e-history". */
function writeSyntheticHistory(configDir: string): void {
  const sid = 'eeeeeeee-0000-4000-8000-000000000001';
  const proj = join(configDir, 'projects', '-home-user-e2e-history');
  mkdirSync(proj, { recursive: true });
  const at = Date.now() - 24 * 3_600_000;
  const line = (i: number): string =>
    JSON.stringify({
      type: 'assistant',
      uuid: `u-fake-${i}`,
      timestamp: new Date(at + i * 60_000).toISOString(),
      sessionId: sid,
      cwd: '/home/user/e2e-history',
      requestId: `req_fake_${i}`,
      message: {
        id: `msg_fake_${i}`,
        role: 'assistant',
        model: 'fake-model-e2e',
        usage: { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'fake output' }],
      },
    });
  writeFileSync(join(proj, `${sid}.jsonl`), `${line(0)}\n${line(1)}\n`);
}

/** Where the Stats screenshots go. Default: Playwright's own output folder. */
const SHOTS = process.env['WSC_E2E_SHOTS'] ?? 'test-results';

test('demo: the Stats tab shows tiles and a heatmap, switches ranges and back to Live', async () => {
  const app = await electron.launch({ args: ['.', '--demo'], env: isolatedEnv() });
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await expect(win.locator('#stage canvas')).toBeVisible({ timeout: 15_000 });
  // The column starts collapsed in a narrow window: open it.
  const expand = win.locator('#dashboard button[aria-label="Show dashboard"]');
  if (await expand.isVisible()) await expand.click();

  const statsTab = win.locator('#dashboard [role="tab"][data-tab="stats"]');
  const liveTab = win.locator('#dashboard [role="tab"][data-tab="live"]');
  await expect(liveTab).toHaveAttribute('aria-selected', 'true');
  await statsTab.click();
  await expect(statsTab).toHaveAttribute('aria-selected', 'true');

  const stats = win.locator('[data-testid="dash-stats"]');
  await expect(stats).toBeVisible();
  // Default range: 30 days.
  await expect(stats.locator('[data-range="30d"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(stats.locator('[data-testid="stats-tiles"]')).toBeVisible({ timeout: 10_000 });
  await expect(stats.locator('[data-testid="stats-heatmap"]')).toBeVisible();
  await expect(stats.locator('[data-testid="stats-heatmap"] [role="gridcell"]')).toHaveCount(30);
  await expect(stats.locator('[data-testid="stats-hours"]')).toBeVisible();
  // The column never scrolls sideways.
  const overflow = await win.evaluate(() => {
    const el = document.querySelector('#dashboard');
    return el ? el.scrollWidth - el.clientWidth : -1;
  });
  expect(overflow).toBe(0);
  // Let the station draw its first frames, so the full-window shot shows the whole app.
  await win.waitForTimeout(1_000);
  await win.screenshot({ path: join(SHOTS, 'stats-30d.png') });
  // The lower half of the view: hours, projects and the small print.
  await stats.locator('.wsc-stats-foot').scrollIntoViewIfNeeded();
  await expect(stats.locator('.wsc-stats-project').first()).toBeVisible();
  await win.screenshot({ path: join(SHOTS, 'stats-30d-bottom.png') });
  await stats.locator('[data-range="30d"]').scrollIntoViewIfNeeded();

  // All: the demo has seven weeks of history.
  await stats.locator('[data-range="all"]').click();
  await expect(stats.locator('[data-range="all"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(stats.locator('.wsc-stats-title')).toContainText('Since');
  await expect(stats.locator('[data-testid="stats-heatmap"]')).toBeVisible();
  await expect(stats.locator('[data-testid="stats-scanning"]')).toHaveCount(0);
  await win.screenshot({ path: join(SHOTS, 'stats-all.png') });

  // 7 days: a bar chart instead of the heatmap.
  await stats.locator('[data-range="7d"]').click();
  await expect(stats.locator('[data-testid="stats-days"]')).toBeVisible();
  await expect(stats.locator('[data-testid="stats-heatmap"]')).toHaveCount(0);

  // Back to 30 days, then back to Live.
  await stats.locator('[data-range="30d"]').click();
  await expect(stats.locator('[data-testid="stats-heatmap"] [role="gridcell"]')).toHaveCount(30);
  await liveTab.click();
  await expect(liveTab).toHaveAttribute('aria-selected', 'true');
  await expect(stats).toHaveCount(0);
  await expect(win.locator('#wsc-dash-panel-live')).toBeVisible();

  // The range survives a round trip through Live.
  await statsTab.click();
  await expect(win.locator('[data-testid="dash-stats"] [data-range="30d"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await liveTab.click();

  expect(errors).toEqual([]);
  await app.close();
});

test('live: the Stats tab shows real history, and follows a switch to the demo at once', async () => {
  const env = isolatedEnv();
  writeSyntheticHistory(env['CLAUDE_CONFIG_DIR']!);
  const app = await electron.launch({ args: ['.'], env });
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await expect(win.locator('#stage canvas')).toBeVisible({ timeout: 15_000 });
  // A fresh live install opens the setup dialog first: close it.
  const closeSetup = win.locator('button[aria-label="Close setup"]');
  await closeSetup.click({ timeout: 5_000 }).catch(() => undefined);
  await expect(win.locator('.wsc-firstrun-backdrop')).toHaveCount(0);
  const expand = win.locator('#dashboard button[aria-label="Show dashboard"]');
  if (await expand.isVisible()) await expand.click();
  await win.locator('#dashboard [role="tab"][data-tab="stats"]').click();

  const stats = win.locator('[data-testid="dash-stats"]');
  const projects = stats.locator('.wsc-stats-project');
  // The synthetic history: one project, 6k tokens (cache reads are not counted anyway).
  await expect(projects).toHaveCount(1, { timeout: 10_000 });
  await expect(projects.first()).toContainText('e2e-history');
  await expect(stats.locator('[data-testid="stats-tile-total"]')).toContainText('6k');
  await expect(stats.locator('[data-testid="stats-scanning"]')).toHaveCount(0);

  // Start the demo with the view open: its made-up history replaces the real one right away,
  // not at the next once-a-minute poll.
  await win.evaluate(() =>
    (window as unknown as { wsc: { startDemo(): Promise<void> } }).wsc.startDemo(),
  );
  await expect(projects.first()).toContainText(/moonbase-planner|rocket-app|asteroid-tools/, {
    timeout: 5_000,
  });
  await expect(stats).not.toContainText('e2e-history');

  expect(errors).toEqual([]);
  await app.close();
});
