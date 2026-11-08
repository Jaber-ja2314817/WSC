import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isWscHandler, mergeHooks, removeHooks } from '../scripts/hooks-settings.mjs';

const CLI = resolve('scripts/install-hooks.mjs');
const HOOKS_JSON = JSON.parse(readFileSync('plugin/hooks/hooks.json', 'utf8')) as {
  hooks: Record<string, unknown[]>;
};
const EVENTS = Object.keys(HOOKS_JSON.hooks);
const FORWARD = '/home/user/wsc/plugin/hooks/forward.mjs';

interface Handler {
  type: string;
  command: string;
  args?: string[];
  async?: boolean;
  timeout?: number;
}
interface Group {
  matcher?: string;
  hooks: Handler[];
}
type Settings = Record<string, unknown> & { hooks?: Record<string, Group[]> };

/** Synthetic user settings with unrelated keys and the user's own hooks. */
const userSettings = (): Settings => ({
  model: 'opus',
  permissions: { allow: ['Bash(npm test:*)'], deny: [] },
  env: { FOO: 'bar' },
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: '/home/user/bin/guard.sh', timeout: 10 }],
      },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    Notification: [
      { hooks: [{ type: 'command', command: 'node', args: ['/home/user/x/hooks/forward.mjs'] }] },
    ],
  },
});

const wscHandlers = (s: Settings, event: string): Handler[] =>
  (s.hooks?.[event] ?? []).flatMap((g) => g.hooks.filter((h) => isWscHandler(h)));

describe('isWscHandler', () => {
  it.each([
    [{ type: 'command', command: 'node', args: [FORWARD] }, true],
    [
      {
        type: 'command',
        command: 'node',
        args: ['C:\\Users\\user\\wsc\\plugin\\hooks\\forward.mjs'],
      },
      true,
    ],
    [{ type: 'command', command: 'node "/home/user/wsc/plugin/hooks/forward.mjs"' }, true],
    [{ type: 'command', command: 'node', args: ['<path-to-wsc>/plugin/hooks/forward.mjs'] }, true],
    [{ type: 'command', command: 'node', args: ['/home/user/x/hooks/forward.mjs'] }, false],
    [{ type: 'command', command: 'node', args: ['/home/user/myplugin/hooks/forward.mjs'] }, false],
    [{ type: 'command', command: '/home/user/bin/guard.sh' }, false],
    [null, false],
    ['plugin/hooks/forward.mjs', false],
  ])('%j → %s', (handler, expected) => {
    expect(isWscHandler(handler)).toBe(expected);
  });
});

describe('mergeHooks', () => {
  it('adds one forwarder per event with the absolute path, mirroring hooks.json', () => {
    const { settings, added, updated } = mergeHooks({}, HOOKS_JSON, FORWARD);
    expect(added).toBe(EVENTS.length);
    expect(updated).toBe(0);
    const s = settings as Settings;
    expect(Object.keys(s.hooks!).sort()).toEqual([...EVENTS].sort());
    for (const event of EVENTS) {
      const handlers = wscHandlers(s, event);
      expect(handlers).toHaveLength(1);
      expect(handlers[0]!.args).toEqual([FORWARD]);
      expect(JSON.stringify(handlers[0])).not.toContain('CLAUDE_PLUGIN_ROOT');
    }
    expect(wscHandlers(s, 'Stop')[0]!.async).toBeUndefined();
    expect(wscHandlers(s, 'PreToolUse')[0]!.async).toBe(true);
  });

  it('preserves unrelated settings and existing hooks, and does not mutate its input', () => {
    const input = userSettings();
    const before = JSON.stringify(input);
    const s = mergeHooks(input, HOOKS_JSON, FORWARD).settings as Settings;
    expect(JSON.stringify(input)).toBe(before);
    expect(s.model).toBe('opus');
    expect(s.permissions).toEqual(input.permissions);
    expect(s.env).toEqual({ FOO: 'bar' });
    expect(s.hooks!.PreToolUse![0]).toEqual(input.hooks!.PreToolUse![0]);
    expect(s.hooks!.Stop![0]).toEqual(input.hooks!.Stop![0]);
    expect(s.hooks!.Notification![0]).toEqual(input.hooks!.Notification![0]);
    expect(s.hooks!.PreToolUse).toHaveLength(2);
  });

  it('is idempotent', () => {
    const once = mergeHooks(userSettings(), HOOKS_JSON, FORWARD).settings;
    const twice = mergeHooks(once, HOOKS_JSON, FORWARD);
    expect(twice.added + twice.updated).toBe(0);
    expect(twice.settings).toEqual(once);
  });

  it('replaces outdated WSC entries (moved checkout) instead of duplicating them', () => {
    const old = mergeHooks(userSettings(), HOOKS_JSON, '/home/user/old/plugin/hooks/forward.mjs');
    const moved = mergeHooks(old.settings, HOOKS_JSON, FORWARD);
    expect(moved.added).toBe(0);
    expect(moved.updated).toBe(EVENTS.length);
    const s = moved.settings as Settings;
    for (const event of EVENTS)
      expect(wscHandlers(s, event).map((h) => h.args)).toEqual([[FORWARD]]);
    expect(s.hooks!.PreToolUse![0]!.matcher).toBe('Bash');
  });

  it('rejects settings that are not objects', () => {
    expect(() => mergeHooks([] as never, HOOKS_JSON, FORWARD)).toThrow();
    expect(() => mergeHooks({ hooks: [] }, HOOKS_JSON, FORWARD)).toThrow();
  });
});

describe('removeHooks', () => {
  it('removes only WSC entries and restores the original settings', () => {
    const original = userSettings();
    const installed = mergeHooks(original, HOOKS_JSON, FORWARD).settings;
    const { settings, removed } = removeHooks(installed);
    expect(removed).toBe(EVENTS.length);
    expect(settings).toEqual(original);
  });

  it('drops groups and events that only held WSC entries, and the hooks key when empty', () => {
    const installed = mergeHooks({ model: 'opus' }, HOOKS_JSON, FORWARD).settings;
    expect(removeHooks(installed).settings).toEqual({ model: 'opus' });
  });

  it('keeps other handlers that share a group with a WSC handler', () => {
    const mixed: Settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'node', args: [FORWARD] },
              { type: 'command', command: 'say done' },
            ],
          },
        ],
      },
    };
    const { settings, removed } = removeHooks(mixed);
    expect(removed).toBe(1);
    expect(settings).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    });
  });

  it('is a no-op without WSC entries', () => {
    const s = userSettings();
    expect(removeHooks(s)).toEqual({ settings: s, removed: 0 });
  });
});

// ── CLI (temp files only) ────────────────────────────────────────────────────────────────────
describe('install-hooks.mjs', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wsc-hooks-'));
    file = join(dir, 'settings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--settings', file], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'unused') },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const backups = () => readdirSync(dir).filter((f) => f.startsWith('settings.json.wsc-backup-'));
  const read = () => JSON.parse(readFileSync(file, 'utf8')) as Settings;

  it('installs into an existing file with a timestamped backup and 2-space JSON', () => {
    const original = `${JSON.stringify(userSettings(), null, 2)}\n`;
    writeFileSync(file, original);
    const r = cli('install');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Installed WSC hooks');
    const b = backups();
    expect(b).toHaveLength(1);
    expect(b[0]).toMatch(/^settings\.json\.wsc-backup-\d{8}-\d{6}$/);
    expect(readFileSync(join(dir, b[0]!), 'utf8')).toBe(original);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^\{\n {2}"model": "opus",/);
    const s = read();
    expect(s.permissions).toEqual(userSettings().permissions);
    expect(wscHandlers(s, 'SessionStart')[0]!.args).toEqual([resolve('plugin/hooks/forward.mjs')]);
    expect(readdirSync(dir).filter((f) => f.includes('wsc-tmp'))).toEqual([]);
  });

  it('is idempotent: a second install changes nothing and makes no backup', () => {
    writeFileSync(file, JSON.stringify(userSettings()));
    expect(cli('install').code).toBe(0);
    const after = readFileSync(file, 'utf8');
    const r = cli('install');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already installed');
    expect(readFileSync(file, 'utf8')).toBe(after);
    expect(backups()).toHaveLength(1);
  });

  it('creates the file when it does not exist', () => {
    expect(cli('install').code).toBe(0);
    expect(Object.keys(read().hooks!).sort()).toEqual([...EVENTS].sort());
    expect(backups()).toEqual([]);
  });

  it('uninstall removes only WSC entries', () => {
    writeFileSync(file, JSON.stringify(userSettings()));
    cli('install');
    const r = cli('uninstall');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Removed ${EVENTS.length} WSC hook entries`);
    expect(read()).toEqual(userSettings());
    expect(backups().length).toBeGreaterThanOrEqual(1);
  });

  it('refuses to install while the wsc@wsc plugin is enabled, unless --force', () => {
    const content = JSON.stringify({ enabledPlugins: { 'wsc@wsc': true } });
    writeFileSync(file, content);
    const r = cli('install');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('wsc@wsc');
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(backups()).toEqual([]);
    expect(cli('install', '--force').code).toBe(0);
    expect(wscHandlers(read(), 'Stop')).toHaveLength(1);
  });

  it.each(['{ "model": ', '[1, 2]', '{"hooks": []}'])(
    'refuses to touch a malformed file: %s',
    (content) => {
      writeFileSync(file, content);
      for (const action of ['install', 'uninstall']) {
        const r = cli(action);
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/Nothing changed/);
      }
      expect(readFileSync(file, 'utf8')).toBe(content);
      expect(backups()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')('keeps a symlinked settings file a symlink', () => {
    const target = join(dir, 'dotfiles', 'claude-settings.json');
    mkdirSync(join(dir, 'dotfiles'));
    writeFileSync(target, `${JSON.stringify(userSettings(), null, 2)}\n`);
    symlinkSync(target, file);
    const inTarget = () => JSON.parse(readFileSync(target, 'utf8')) as Settings;
    expect(cli('install').code).toBe(0);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(wscHandlers(inTarget(), 'Stop')).toHaveLength(1);
    expect(readdirSync(join(dir, 'dotfiles'))).toEqual(['claude-settings.json']);
    expect(cli('uninstall').code).toBe(0);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(wscHandlers(inTarget(), 'Stop')).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('writes through a dangling symlink', () => {
    const target = join(dir, 'dotfiles', 'claude-settings.json');
    symlinkSync(target, file);
    expect(cli('install').code).toBe(0);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('forward.mjs');
  });

  it('rejects unknown commands', () => {
    const r = cli('explode');
    expect(r.code).toBe(2);
    expect(existsSync(file)).toBe(false);
  });
});
