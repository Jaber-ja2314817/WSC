import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isPidAlive,
  readRuntimeFile,
  removeRuntimeFile,
  runtimeFilePath,
  writeRuntimeFile,
} from '../src/main/runtimeFile';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsc-rt-'));
  process.env['WSC_RUNTIME_FILE'] = join(dir, 'nested', 'runtime.json');
});

afterEach(() => {
  delete process.env['WSC_RUNTIME_FILE'];
  rmSync(dir, { recursive: true, force: true });
});

const info = { port: 47821, token: 'abc', pid: process.pid, version: '0.1.0' };

describe('runtime file', () => {
  it('honours the env override', () => {
    expect(runtimeFilePath()).toBe(join(dir, 'nested', 'runtime.json'));
  });

  it('writes and reads back', () => {
    writeRuntimeFile(info);
    expect(readRuntimeFile()).toEqual(info);
  });

  it.skipIf(process.platform === 'win32')('is user-only (0600)', () => {
    writeRuntimeFile(info);
    expect(statSync(runtimeFilePath()).mode & 0o777).toBe(0o600);
  });

  it('returns null for missing or invalid files', () => {
    expect(readRuntimeFile()).toBeNull();
    writeRuntimeFile(info);
    writeFileSync(runtimeFilePath(), '{"port":"x"}');
    expect(readRuntimeFile()).toBeNull();
    writeFileSync(runtimeFilePath(), 'garbage');
    expect(readRuntimeFile()).toBeNull();
  });

  it('removes only its own file', () => {
    writeRuntimeFile({ ...info, pid: 999999 });
    removeRuntimeFile();
    expect(readRuntimeFile()).not.toBeNull();
    removeRuntimeFile(999999);
    expect(readRuntimeFile()).toBeNull();
  });

  it('detects live and dead pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
