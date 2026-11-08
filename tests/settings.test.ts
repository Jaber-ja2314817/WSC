import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseWindowState, SettingsStore } from '../src/main/settings';
import { trayStatusFor } from '../src/main/tray';
import { boundsVisible, clampBounds } from '../src/main/windows';
import { supportsLoginItem } from '../src/shared/ipc';
import { DEFAULT_SETTINGS, mergeSettings, parseSettings } from '../src/shared/settings';
import { StationStore } from '../src/shared/store';
import { ev } from './fixtures/events';

describe('settings schema', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: 'spaceship',
      port: 47821,
      loungeSize: 6,
      reportFrequency: 'normal',
      staleSeconds: 90,
      lingerSeconds: 10,
      idleProjectMinutes: 30,
      statusBubbles: true,
      catchphraseBubbles: true,
      showFullToolDetails: false,
      notifications: false,
      reduceMotion: 'system',
      sound: false,
      launchAtLogin: false,
      toolCategoryOverrides: {},
      launchOnSessionStart: true,
      focusOnSessionStart: false,
      dashboardOpen: true,
      lookbackDays: 7,
      idleMinutes: 10,
      usageWindowHours: 5,
      windowTokenLimit: null,
      weeklyTokenLimit: null,
      showPromptPreview: false,
      prices: {},
    });
  });

  it.each([null, undefined, 42, 'x', [], {}])('falls back to defaults for %j', (raw) => {
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid fields and replaces only the invalid ones', () => {
    const s = parseSettings({
      theme: 'office',
      port: 80, // below 1024 → default
      loungeSize: 12,
      reportFrequency: 'loud', // invalid → default
      showFullToolDetails: 'yes', // not boolean → default
      notifications: true,
      unknownKey: 1,
    });
    expect(s.theme).toBe('office');
    expect(s.port).toBe(47821);
    expect(s.loungeSize).toBe(12);
    expect(s.reportFrequency).toBe('normal');
    expect(s.showFullToolDetails).toBe(false);
    expect(s.notifications).toBe(true);
    expect('unknownKey' in s).toBe(false);
  });

  it('rejects theme ids that could escape a folder', () => {
    expect(parseSettings({ theme: '../evil' }).theme).toBe('spaceship');
    expect(parseSettings({ theme: 'My Theme' }).theme).toBe('spaceship');
  });

  it('validates tool category overrides entry by entry', () => {
    const s = parseSettings({
      toolCategoryOverrides: {
        mcp__db__query: 'read',
        MyTool: 'execute',
        Bad: 'teleport',
        '': 'read',
      },
    });
    expect(s.toolCategoryOverrides).toEqual({ mcp__db__query: 'read', MyTool: 'execute' });
    expect(parseSettings({ toolCategoryOverrides: 'nope' }).toolCategoryOverrides).toEqual({});
  });

  it('validates prices entry by entry', () => {
    const good = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
    const s = parseSettings({
      prices: {
        'fake-model': good,
        'fake-other': { ...good, extra: 1 },
        negative: { ...good, input: -1 },
        missing: { input: 1, output: 1 },
        text: 'cheap',
        '': good,
      },
    });
    expect(s.prices).toEqual({ 'fake-model': good, 'fake-other': good });
    expect(parseSettings({ prices: [] }).prices).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`m${i}`, good]));
    expect(Object.keys(parseSettings({ prices: many }).prices)).toHaveLength(50);
  });

  it('validates the dashboard fields', () => {
    const s = parseSettings({
      idleMinutes: 0,
      usageWindowHours: 2.5,
      windowTokenLimit: 1_000_000,
      weeklyTokenLimit: -5,
      showPromptPreview: true,
    });
    expect(s.idleMinutes).toBe(10);
    expect(s.usageWindowHours).toBe(2.5);
    expect(s.windowTokenLimit).toBe(1_000_000);
    expect(s.weeklyTokenLimit).toBeNull();
    expect(s.showPromptPreview).toBe(true);
  });

  it('merge keeps the current value when a patch field is invalid', () => {
    const cur = parseSettings({ loungeSize: 10 });
    const next = mergeSettings(cur, { loungeSize: 999, catchphraseBubbles: false });
    expect(next.loungeSize).toBe(10);
    expect(next.catchphraseBubbles).toBe(false);
  });
});

describe('SettingsStore (main)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wsc-settings-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts from defaults when no file exists and never crashes on a corrupt file', async () => {
    expect(new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS);
    await writeFile(join(dir, 'settings.json'), '{ not json');
    expect(new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS);
  });

  const fullPrice = { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 };
  const readSaved = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;

  it('keeps a hand edit made while the app runs when the app saves', async () => {
    const store = new SettingsStore(dir);
    store.update({ loungeSize: 9 });
    const edited = { ...(await readSaved()), prices: { opus: fullPrice } };
    await writeFile(join(dir, 'settings.json'), JSON.stringify(edited));
    const seen: unknown[] = [];
    store.onChange((s) => seen.push(s.prices));
    store.update({ dashboardOpen: false });
    expect(await readSaved()).toMatchObject({
      loungeSize: 9,
      dashboardOpen: false,
      prices: { opus: fullPrice },
    });
    expect(seen).toEqual([{ opus: fullPrice }]);
  });

  it('moves an unreadable settings.json aside before anything overwrites it', async () => {
    await writeFile(join(dir, 'settings.json'), '{ "loungeSize": 9, }');
    const store = new SettingsStore(dir);
    expect(store.warning).toContain('default settings');
    expect((await readdir(dir)).filter((f) => f.includes('corrupt'))).toEqual([]);

    store.update({ theme: 'home' });
    const aside = (await readdir(dir)).filter((f) => f.startsWith('settings.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dir, aside[0]!), 'utf8')).toBe('{ "loungeSize": 9, }');
    expect(await readSaved()).toMatchObject({ theme: 'home' });
    expect(store.warning).toContain(aside[0]);
  });

  it.each(['[]', '5', 'null'])(
    'treats valid JSON that is no object (%s) as unreadable',
    async (t) => {
      await writeFile(join(dir, 'settings.json'), t);
      new SettingsStore(dir).update({ theme: 'home' });
      const aside = (await readdir(dir)).filter((f) => f.startsWith('settings.json.corrupt-'));
      expect(aside).toHaveLength(1);
    },
  );

  it('notices a file that breaks while the app runs', async () => {
    const store = new SettingsStore(dir);
    store.update({ loungeSize: 9 });
    await writeFile(join(dir, 'settings.json'), '{ oops');
    store.update({ theme: 'home' });
    expect(store.get()).toMatchObject({ loungeSize: 9, theme: 'home' });
    expect((await readdir(dir)).some((f) => f.startsWith('settings.json.corrupt-'))).toBe(true);
  });

  it('keeps invalid price entries on disk and warns about them', async () => {
    const prices = { opus: { input: 1 }, sonnet: fullPrice };
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ prices }));
    const store = new SettingsStore(dir);
    expect(store.get().prices).toEqual({ sonnet: fullPrice });
    expect(store.warning).toContain('opus');
    store.update({ theme: 'home' });
    expect((await readSaved())['prices']).toEqual(prices);
    expect(store.get().prices).toEqual({ sonnet: fullPrice });
  });

  it('persists updates with user-only permissions and notifies listeners', async () => {
    const store = new SettingsStore(dir);
    const seen: number[] = [];
    store.onChange((s, prev) => seen.push(prev.loungeSize, s.loungeSize));
    store.update({ loungeSize: 9, theme: 'home' });
    expect(seen).toEqual([6, 9]);
    const onDisk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as {
      loungeSize: number;
    };
    expect(onDisk.loungeSize).toBe(9);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'settings.json'))).mode & 0o777).toBe(0o600);
    }
    expect(new SettingsStore(dir).get().theme).toBe('home');
  });

  it('round-trips window state (mode, bounds, camera) and drops garbage', () => {
    const store = new SettingsStore(dir);
    store.patchWindowState((w) => {
      w.mode = 'compact';
      w.bounds.compact = { x: 10, y: 20, width: 360, height: 240 };
      w.camera.normal = { x: -100, y: 40, zoom: 2 };
    });
    store.flush();
    const again = new SettingsStore(dir).windowState;
    expect(again.mode).toBe('compact');
    expect(again.bounds.compact).toEqual({ x: 10, y: 20, width: 360, height: 240 });
    expect(again.camera.normal).toEqual({ x: -100, y: 40, zoom: 2 });
  });
});

describe('parseWindowState', () => {
  it('rejects tiny, huge or non-numeric bounds and bad cameras', () => {
    const s = parseWindowState({
      mode: 'weird',
      bounds: { normal: { x: 0, y: 0, width: 10, height: 10 }, compact: { x: 'a' } },
      camera: { normal: { x: 0, y: 0, zoom: 0 }, compact: { x: 1, y: 2, zoom: 3 } },
    });
    expect(s.mode).toBe('normal');
    expect(s.bounds).toEqual({});
    expect(s.camera).toEqual({ compact: { x: 1, y: 2, zoom: 3 } });
  });
});

describe('boundsVisible', () => {
  const display = { x: 0, y: 0, width: 1440, height: 900 };
  it('accepts windows on a display and rejects ones left on a disconnected monitor', () => {
    expect(boundsVisible({ x: 100, y: 100, width: 800, height: 600 }, [display])).toBe(true);
    expect(boundsVisible({ x: 2000, y: 100, width: 800, height: 600 }, [display])).toBe(false);
    // Mostly off-screen but a usable corner is still visible.
    expect(boundsVisible({ x: 1300, y: 800, width: 800, height: 600 }, [display])).toBe(true);
    expect(boundsVisible({ x: 1400, y: 880, width: 800, height: 600 }, [display])).toBe(false);
  });
});

describe('boundsVisible title bar', () => {
  const display = { x: 0, y: 0, width: 1440, height: 875 };
  it('rejects a window whose title bar is above the display', () => {
    expect(boundsVisible({ x: 100, y: -700, width: 1280, height: 800 }, [display])).toBe(false);
  });
  it('accepts a title bar on a display stacked above the main one', () => {
    const above = { x: 0, y: -900, width: 1600, height: 900 };
    const b = { x: 100, y: -700, width: 1280, height: 800 };
    expect(boundsVisible(b, [display, above])).toBe(true);
  });
});

describe('clampBounds', () => {
  const display = { x: 0, y: 25, width: 1440, height: 875 };
  it('shrinks a window saved on a bigger monitor and moves it onto the display', () => {
    const b = { x: 200, y: 100, width: 3000, height: 1800 };
    expect(clampBounds(b, [display])).toEqual(display);
  });
  it('leaves a window that fits alone, even if part of it hangs off the edge', () => {
    const b = { x: 1300, y: 800, width: 800, height: 600 };
    expect(clampBounds(b, [display])).toEqual(b);
  });
  it('clamps to the display the window is mostly on', () => {
    const left = { x: -800, y: 0, width: 800, height: 600 };
    const b = { x: 50, y: 100, width: 1000, height: 1200 };
    expect(clampBounds(b, [left, display])).toEqual({ x: 50, y: 25, width: 1000, height: 875 });
  });
});

describe('supportsLoginItem', () => {
  it('is false on Linux only', () => {
    expect(supportsLoginItem('Mozilla/5.0 (X11; Linux x86_64) Electron/44.7.0')).toBe(false);
    expect(supportsLoginItem('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
    expect(supportsLoginItem('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
  });
});

describe('trayStatusFor', () => {
  it('reports idle, working and attention (waiting wins)', () => {
    const store = new StationStore();
    expect(trayStatusFor(store.snapshot())).toBe('idle');
    store.apply(ev({ kind: 'session_start', ts: 1 }));
    store.apply(ev({ kind: 'user_prompt', ts: 2 }));
    expect(trayStatusFor(store.snapshot())).toBe('working');
    store.apply(ev({ kind: 'waiting_for_user', agentId: 'sub1', ts: 3 }));
    expect(trayStatusFor(store.snapshot())).toBe('attention');
  });
});

describe('showFullToolDetails plumbing', () => {
  it('lengthens hook summaries but still redacts secrets', async () => {
    const { normalizeHookPayload } = await import('../src/shared/normalizer/hook');
    const cmd = `curl -H "Authorization: Bearer abcdef123456" https://api.example.com/${'x'.repeat(80)}`;
    const raw = {
      session_id: 's1',
      cwd: '/home/user/proj',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: cmd },
      tool_use_id: 'toolu_1',
    };
    const short = normalizeHookPayload(raw, 1)[0]?.tool?.summary ?? '';
    const full = normalizeHookPayload(raw, 1, { fullToolDetails: true })[0]?.tool?.summary ?? '';
    expect(full.length).toBeGreaterThan(short.length);
    expect(full).not.toContain('abcdef123456');
    expect(short).not.toContain('abcdef123456');
  });

  it('applies custom tool category overrides', async () => {
    const { normalizeHookPayload } = await import('../src/shared/normalizer/hook');
    const raw = {
      session_id: 's1',
      cwd: '/home/user/proj',
      hook_event_name: 'PreToolUse',
      tool_name: 'MyDeployTool',
      tool_input: {},
      tool_use_id: 'toolu_2',
    };
    expect(normalizeHookPayload(raw, 1)[0]?.tool?.category).toBe('other');
    expect(
      normalizeHookPayload(raw, 1, { toolOverrides: { MyDeployTool: 'execute' } })[0]?.tool
        ?.category,
    ).toBe('execute');
  });
});
