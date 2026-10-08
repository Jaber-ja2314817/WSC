import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseWindowState, SettingsStore } from '../src/main/settings';
import { trayStatusFor } from '../src/main/tray';
import { boundsVisible } from '../src/main/windows';
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
