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
import {
  bridgeCommand,
  chainedCommand,
  installStatusLine,
  isWscStatusLine,
  quotePath,
  removeStatusLine,
} from '../scripts/statusline-settings.mjs';

const CLI = resolve('scripts/install-statusline.mjs');
const SCRIPT = '/home/user/wsc/plugin/statusline/statusline.mjs';
const OWN = 'bash /home/user/.claude/statusline.sh "$HOME" | head -1';

interface StatusLine {
  type: string;
  command: string;
  padding?: number;
  refreshInterval?: number;
}
type Settings = Record<string, unknown> & { statusLine?: StatusLine };

/** Synthetic user settings with unrelated keys. */
const userSettings = (statusLine?: StatusLine): Settings => ({
  model: 'opus',
  permissions: { allow: ['Bash(npm test:*)'], deny: [] },
  env: { FOO: 'bar' },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
  ...(statusLine ? { statusLine } : {}),
});

describe('quotePath / bridgeCommand', () => {
  it('quotes POSIX paths and escapes shell-active characters', () => {
    expect(quotePath(SCRIPT)).toBe(`"${SCRIPT}"`);
    expect(quotePath('/home/user/my $dir/`x`/"q"/a.mjs')).toBe(
      '"/home/user/my \\$dir/\\`x\\`/\\"q\\"/a.mjs"',
    );
  });

  it('writes Windows paths with forward slashes', () => {
    expect(quotePath('C:\\Users\\user\\wsc\\plugin\\statusline\\statusline.mjs')).toBe(
      '"C:/Users/user/wsc/plugin/statusline/statusline.mjs"',
    );
  });

  it('round-trips the chained command through base64url', () => {
    const cmd = bridgeCommand(SCRIPT, OWN);
    expect(cmd).toMatch(
      /^node "\/home\/user\/wsc\/plugin\/statusline\/statusline\.mjs" --then [\w-]+$/,
    );
    expect(chainedCommand(cmd)).toBe(OWN);
    expect(chainedCommand(bridgeCommand(SCRIPT))).toBeNull();
  });
});

describe('isWscStatusLine', () => {
  it.each([
    [{ type: 'command', command: `node "${SCRIPT}"` }, true],
    [{ type: 'command', command: bridgeCommand(SCRIPT, OWN) }, true],
    [
      {
        type: 'command',
        command: 'node "C:\\Users\\user\\wsc\\plugin\\statusline\\statusline.mjs"',
      },
      true,
    ],
    [{ type: 'command', command: 'node /home/user/x/statusline/statusline.mjs' }, false],
    [{ type: 'command', command: 'node /home/user/myplugin/statusline/statusline.mjs' }, false],
    [{ type: 'command', command: OWN }, false],
    [null, false],
    [`node "${SCRIPT}"`, false],
  ])('%j → %s', (statusLine, expected) => {
    expect(isWscStatusLine(statusLine)).toBe(expected);
  });
});

describe('installStatusLine', () => {
  it('adds a minimal command status line when there is none', () => {
    const { settings, changed, wrapped } = installStatusLine(userSettings(), SCRIPT);
    expect(changed).toBe(true);
    expect(wrapped).toBe(false);
    expect(settings.statusLine).toEqual({ type: 'command', command: `node "${SCRIPT}"` });
  });

  it('preserves unrelated settings and does not mutate its input', () => {
    const input = userSettings({ type: 'command', command: OWN, padding: 2 });
    const before = JSON.stringify(input);
    const { settings } = installStatusLine(input, SCRIPT);
    expect(JSON.stringify(input)).toBe(before);
    const withoutStatusLine = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'statusLine'));
    expect(withoutStatusLine(settings)).toEqual(withoutStatusLine(input));
  });

  it('is idempotent', () => {
    for (const start of [userSettings(), userSettings({ type: 'command', command: OWN })]) {
      const once = installStatusLine(start, SCRIPT).settings;
      const twice = installStatusLine(once, SCRIPT);
      expect(twice.changed).toBe(false);
      expect(twice.settings).toEqual(once);
    }
  });

  it('wraps an existing command, keeping its other keys, and uninstall restores it exactly', () => {
    const original = userSettings({
      type: 'command',
      command: OWN,
      padding: 0,
      refreshInterval: 5,
    });
    const { settings, changed, wrapped } = installStatusLine(original, SCRIPT);
    expect(changed).toBe(true);
    expect(wrapped).toBe(true);
    const sl = (settings as Settings).statusLine!;
    expect(sl).toEqual({
      type: 'command',
      command: bridgeCommand(SCRIPT, OWN),
      padding: 0,
      refreshInterval: 5,
    });
    expect(chainedCommand(sl.command)).toBe(OWN);
    const removed = removeStatusLine(settings);
    expect(removed.changed).toBe(true);
    expect(removed.settings).toEqual(original);
  });

  it('updates the path of a moved checkout and keeps the chained command', () => {
    const old = installStatusLine(
      userSettings({ type: 'command', command: OWN, padding: 1 }),
      '/home/user/old/plugin/statusline/statusline.mjs',
    ).settings;
    const moved = installStatusLine(old, SCRIPT);
    expect(moved.changed).toBe(true);
    expect(moved.wrapped).toBe(true);
    expect((moved.settings as Settings).statusLine).toEqual({
      type: 'command',
      command: bridgeCommand(SCRIPT, OWN),
      padding: 1,
    });
  });

  it.each([
    ['a string', 'node x.mjs'],
    ['null', null],
    ['an array', []],
    ['a non-command type', { type: 'static', text: 'hi' }],
    ['a command without a string', { type: 'command', command: 42 }],
    ['an empty command', { type: 'command', command: '  ' }],
  ])('throws a TypeError when statusLine is %s', (_label, statusLine) => {
    const input = { ...userSettings(), statusLine };
    expect(() => installStatusLine(input, SCRIPT)).toThrow(TypeError);
    expect(() => installStatusLine(input, SCRIPT)).toThrow(/by hand/);
  });

  it('rejects settings that are not objects', () => {
    expect(() => installStatusLine([] as never, SCRIPT)).toThrow(TypeError);
    expect(() => removeStatusLine(null as never)).toThrow(TypeError);
  });
});

describe('removeStatusLine', () => {
  it('deletes the key when the bridge ran alone', () => {
    const installed = installStatusLine(userSettings(), SCRIPT).settings;
    const { settings, changed } = removeStatusLine(installed);
    expect(changed).toBe(true);
    expect(settings).toEqual(userSettings());
  });

  it('leaves a status line that is not WSC unchanged', () => {
    const s = userSettings({ type: 'command', command: OWN });
    expect(removeStatusLine(s)).toEqual({ settings: s, changed: false });
    expect(removeStatusLine(userSettings())).toEqual({ settings: userSettings(), changed: false });
  });
});

// ── CLI (temp files only) ────────────────────────────────────────────────────────────────────
describe('install-statusline.mjs', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wsc-statusline-'));
    file = join(dir, 'settings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'unused'), ...env },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const cli = (...args: string[]) => run([...args, '--settings', file]);
  const backups = (d = dir) =>
    readdirSync(d).filter((f) => f.startsWith('settings.json.wsc-backup-'));
  const read = (f = file) => JSON.parse(readFileSync(f, 'utf8')) as Settings;
  const realScript = resolve('plugin/statusline/statusline.mjs');

  it('installs into an existing file with a timestamped backup and wraps the status line', () => {
    const original = `${JSON.stringify(userSettings({ type: 'command', command: OWN }), null, 2)}\n`;
    writeFileSync(file, original);
    const r = cli('install');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Installed the WSC status line bridge');
    expect(r.stdout).toContain(OWN);
    const b = backups();
    expect(b).toHaveLength(1);
    expect(b[0]).toMatch(/^settings\.json\.wsc-backup-\d{8}-\d{6}$/);
    expect(readFileSync(join(dir, b[0]!), 'utf8')).toBe(original);
    expect(readFileSync(file, 'utf8')).toMatch(/^\{\n {2}"model": "opus",/);
    const s = read();
    expect(s.permissions).toEqual(userSettings().permissions);
    expect(s.statusLine!.command).toBe(bridgeCommand(realScript, OWN));
    expect(readdirSync(dir).filter((f) => f.includes('wsc-tmp'))).toEqual([]);
  });

  it('is idempotent and uninstall restores the original status line', () => {
    writeFileSync(file, JSON.stringify(userSettings({ type: 'command', command: OWN })));
    expect(cli('install').code).toBe(0);
    const after = readFileSync(file, 'utf8');
    const r = cli('install');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already installed');
    expect(readFileSync(file, 'utf8')).toBe(after);
    expect(backups()).toHaveLength(1);
    const u = cli('uninstall');
    expect(u.code).toBe(0);
    expect(u.stdout).toContain('restored your status line');
    expect(read()).toEqual(userSettings({ type: 'command', command: OWN }));
  });

  it('creates the file when it does not exist, without a backup', () => {
    expect(cli('install').code).toBe(0);
    expect(read().statusLine).toEqual({ type: 'command', command: bridgeCommand(realScript) });
    expect(backups()).toEqual([]);
    expect(cli('uninstall').code).toBe(0);
    expect(read()).toEqual({});
  });

  it('does not refuse while the wsc@wsc plugin is enabled', () => {
    writeFileSync(file, JSON.stringify({ enabledPlugins: { 'wsc@wsc': true } }));
    expect(cli('install').code).toBe(0);
    expect(isWscStatusLine(read().statusLine)).toBe(true);
  });

  it.each(['{ "model": ', '[1, 2]', '{"statusLine": "echo hi"}'])(
    'refuses to touch a malformed file: %s',
    (content) => {
      writeFileSync(file, content);
      const r = cli('install');
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Nothing changed/);
      expect(r.stdout).toBe('');
      expect(readFileSync(file, 'utf8')).toBe(content);
      expect(backups()).toEqual([]);
    },
  );

  it('uses $CLAUDE_CONFIG_DIR/settings.json when no --settings is given', () => {
    const configDir = join(dir, 'config');
    mkdirSync(configDir);
    const target = join(configDir, 'settings.json');
    writeFileSync(target, JSON.stringify({ model: 'opus' }));
    const r = run(['install'], { CLAUDE_CONFIG_DIR: configDir });
    expect(r.code).toBe(0);
    expect(isWscStatusLine(read(target).statusLine)).toBe(true);
    expect(backups(configDir)).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('keeps a symlinked settings file a symlink', () => {
    const target = join(dir, 'dotfiles', 'claude-settings.json');
    mkdirSync(join(dir, 'dotfiles'));
    writeFileSync(target, '{"model":"opus"}\n');
    symlinkSync(target, file);
    expect(cli('install').code).toBe(0);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(isWscStatusLine(read(target).statusLine)).toBe(true);
    expect(readdirSync(join(dir, 'dotfiles'))).toEqual(['claude-settings.json']);
    expect(cli('uninstall').code).toBe(0);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(read(target).statusLine).toBeUndefined();
  });

  it('rejects unknown commands', () => {
    const r = cli('explode');
    expect(r.code).toBe(2);
    expect(existsSync(file)).toBe(false);
  });
});
