import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLaunchInfo,
  decodeHookPayload,
  enclosingAppBundle,
  launchFilePath,
  parseHookArgs,
  writeLaunchInfo,
} from '../src/main/launchInfo';

const enc = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');

describe('buildLaunchInfo', () => {
  it('packaged macOS: points at the enclosing .app bundle', () => {
    const info = buildLaunchInfo({
      version: '1.2.3',
      execPath: '/Applications/WSC.app/Contents/MacOS/WSC',
      appPath: '/Applications/WSC.app/Contents/Resources/app.asar',
      isPackaged: true,
      platform: 'darwin',
    });
    expect(info).toEqual({
      version: '1.2.3',
      command: '/Applications/WSC.app/Contents/MacOS/WSC',
      args: [],
      macBundle: '/Applications/WSC.app',
    });
  });

  it('packaged macOS in a folder whose name contains .app', () => {
    expect(enclosingAppBundle('/home/user/my.apps/x/WSC.app/Contents/MacOS/WSC', '/')).toBe(
      '/home/user/my.apps/x/WSC.app',
    );
    expect(enclosingAppBundle('/usr/bin/wsc', '/')).toBeUndefined();
  });

  it('packaged Windows/Linux: the executable alone', () => {
    const info = buildLaunchInfo({
      version: '1.0.0',
      execPath: '/opt/WSC/wsc',
      appPath: '/opt/WSC/resources/app.asar',
      isPackaged: true,
      platform: 'linux',
    });
    expect(info).toEqual({ version: '1.0.0', command: '/opt/WSC/wsc', args: [] });
  });

  it('unpackaged: the electron binary plus the app folder', () => {
    const info = buildLaunchInfo({
      version: '0.1.0',
      execPath: '/home/user/wsc/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      appPath: '/home/user/wsc',
      isPackaged: false,
      platform: 'darwin',
    });
    expect(info.command).toContain('Electron');
    expect(info.args).toEqual(['/home/user/wsc']);
    expect(info.macBundle).toBeUndefined();
  });
});

describe('writeLaunchInfo', () => {
  let dir: string;
  const prev = process.env['WSC_RUNTIME_FILE'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wsc-launch-'));
    process.env['WSC_RUNTIME_FILE'] = join(dir, 'sub', 'runtime.json');
  });

  afterEach(async () => {
    if (prev === undefined) delete process.env['WSC_RUNTIME_FILE'];
    else process.env['WSC_RUNTIME_FILE'] = prev;
    await rm(dir, { recursive: true, force: true });
  });

  it('writes launch.json next to the runtime file with mode 0600', async () => {
    writeLaunchInfo({ version: '0.1.0', command: '/opt/WSC/wsc', args: [] });
    expect(launchFilePath()).toBe(join(dir, 'sub', 'launch.json'));
    const parsed = JSON.parse(await readFile(launchFilePath(), 'utf8')) as unknown;
    expect(parsed).toEqual({ version: '0.1.0', command: '/opt/WSC/wsc', args: [] });
    if (process.platform !== 'win32') {
      expect((await stat(launchFilePath())).mode & 0o777).toBe(0o600);
    }
  });
});

describe('parseHookArgs', () => {
  const payload = {
    session_id: 'sess-0001',
    cwd: '/home/user/proj-a',
    hook_event_name: 'SessionStart',
    note: 'ünïcødé ✓',
  };

  it('decodes --from-hook and a base64url payload', () => {
    const r = parseHookArgs(['/x/WSC', '--from-hook', `--hook-payload=${enc(payload)}`]);
    expect(r).toEqual({ fromHook: true, payload });
  });

  it('no flags: not from a hook', () => {
    expect(parseHookArgs(['/x/WSC', '--compact'])).toEqual({ fromHook: false });
  });

  it('ignores invalid, non-object and oversized payloads', () => {
    expect(decodeHookPayload('not base64!')).toBeUndefined();
    expect(decodeHookPayload(Buffer.from('{oops', 'utf8').toString('base64url'))).toBeUndefined();
    expect(decodeHookPayload(enc([1, 2]))).toBeUndefined();
    expect(decodeHookPayload(enc('str'))).toBeUndefined();
    expect(decodeHookPayload('')).toBeUndefined();
    const big = { session_id: 's', pad: 'x'.repeat(16 * 1024) };
    expect(decodeHookPayload(enc(big))).toBeUndefined();
    const r = parseHookArgs(['--from-hook', `--hook-payload=${enc(big)}`]);
    expect(r).toEqual({ fromHook: true });
  });

  it('accepts padded base64 too', () => {
    const b64 = Buffer.from(JSON.stringify({ a: 1 }), 'utf8').toString('base64');
    expect(decodeHookPayload(b64.replace(/\+/g, '-').replace(/\//g, '_'))).toEqual({ a: 1 });
  });
});
