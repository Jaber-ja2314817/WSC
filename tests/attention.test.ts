import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAppFlags, writeAppFlags } from '../src/main/appState';
import { holdUntilDismissed, waitingAlerts } from '../src/main/attention';
import { StationStore } from '../src/shared/store';
import type { StationSnapshot } from '../src/shared/types';
import { ev } from './fixtures/events';

const waitingSnapshot = (): StationSnapshot => {
  const store = new StationStore();
  store.apply(ev({ kind: 'session_start', ts: 1 }));
  store.apply(ev({ kind: 'waiting_for_user', ts: 2 }));
  return store.snapshot();
};

describe('waitingAlerts', () => {
  it('announces a wait once, and again after it ended', () => {
    const notified = new Set<string>();
    const snap = waitingSnapshot();
    expect(waitingAlerts(snap, notified, true)).toHaveLength(1);
    expect(waitingAlerts(snap, notified, true)).toEqual([]);
    expect(waitingAlerts({ ...snap, agents: {} }, notified, true)).toEqual([]);
    expect(waitingAlerts(snap, notified, true)).toHaveLength(1);
  });

  it('names no tool input', () => {
    const [body] = waitingAlerts(waitingSnapshot(), new Set(), true);
    expect(body).toMatch(/^The orchestrator in .+ needs your input$/);
  });

  it('stays silent when disabled, and a later enable does not replay the same wait', () => {
    const notified = new Set<string>();
    const snap = waitingSnapshot();
    expect(waitingAlerts(snap, notified, false)).toEqual([]);
    expect(waitingAlerts(snap, notified, true)).toEqual([]);
  });
});

describe('holdUntilDismissed', () => {
  it.each(['click', 'close', 'failed'])('releases a notification on %s', (event) => {
    const held = new Set<EventEmitter>();
    const n = new EventEmitter();
    holdUntilDismissed(held, n);
    expect(held.has(n)).toBe(true);
    n.emit(event);
    expect(held.size).toBe(0);
  });

  it('does not grow forever when a platform never reports a close', () => {
    const held = new Set<EventEmitter>();
    for (let i = 0; i < 40; i++) holdUntilDismissed(held, new EventEmitter());
    expect(held.size).toBe(16);
  });
});

describe('writeAppFlags', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wsc-state-'));
    process.env['WSC_STATE_FILE'] = join(dir, 'state.json');
  });
  afterEach(async () => {
    delete process.env['WSC_STATE_FILE'];
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces the file atomically instead of rewriting it in place', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, '{}');
    const before = (await stat(file)).ino;
    writeAppFlags({ hasReceivedEvents: true });
    expect((await stat(file)).ino).not.toBe(before);
    expect(await readdir(dir)).toEqual(['state.json']);
    expect(readAppFlags().hasReceivedEvents).toBe(true);
  });
});
