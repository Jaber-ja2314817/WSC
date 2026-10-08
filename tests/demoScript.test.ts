import { describe, expect, it } from 'vitest';
import { buildDemoScript, DEMO_DURATION_MS } from '../src/shared/demoScript';
import { StationStore } from '../src/shared/store';
import type { StationEventKind } from '../src/shared/types';

const T0 = 1_700_000_000_000;
const script = buildDemoScript(T0);
const events = script.map((s) => s.event);

const KINDS: StationEventKind[] = [
  'session_start',
  'session_end',
  'agent_spawn',
  'agent_finish',
  'agent_error',
  'tool_start',
  'tool_end',
  'waiting_for_user',
  'user_prompt',
  'idle',
  'compacting',
];

describe('buildDemoScript', () => {
  it('is ordered, fits in one loop and uses valid kinds', () => {
    for (let i = 1; i < script.length; i++) {
      expect(script[i]!.at).toBeGreaterThanOrEqual(script[i - 1]!.at);
    }
    expect(script.at(-1)!.at).toBeLessThan(DEMO_DURATION_MS);
    for (const e of events) {
      expect(KINDS).toContain(e.kind);
      expect(e.source).toBe('demo');
      expect(e.ts).toBe(T0 + script.find((s) => s.event === e)!.at);
    }
  });

  it('has two projects at the start and a third that appears mid-demo', () => {
    const firstSeen = new Map<string, number>();
    for (const s of script) {
      if (!firstSeen.has(s.event.projectName)) firstSeen.set(s.event.projectName, s.at);
    }
    expect([...firstSeen.keys()]).toEqual(['moonbase-planner', 'rocket-app', 'asteroid-tools']);
    expect(firstSeen.get('rocket-app')).toBeLessThan(5_000);
    expect(firstSeen.get('asteroid-tools')).toBeGreaterThanOrEqual(20_000);
    expect(firstSeen.get('asteroid-tools')).toBeLessThan(35_000);
  });

  it('includes delegation, a waiting agent, an error and session ends', () => {
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of ['agent_spawn', 'waiting_for_user', 'agent_error', 'session_end'] as const) {
      expect(kinds).toContain(k);
    }
    const labels = events.filter((e) => e.kind === 'agent_spawn').map((e) => e.label);
    expect(labels).toEqual(
      expect.arrayContaining(['researcher', 'frontend-dev', 'backend-dev', 'test-writer']),
    );
    const categories = new Set(events.map((e) => e.tool?.category).filter(Boolean));
    for (const c of ['web', 'read', 'write', 'search', 'execute', 'delegate', 'plan']) {
      expect(categories).toContain(c);
    }
  });

  it('has unique ids, and fresh ids on every loop', () => {
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const next = buildDemoScript(T0 + DEMO_DURATION_MS).map((s) => s.event.id);
    expect(next.some((id) => ids.includes(id))).toBe(false);
  });

  it('pairs every tool_start with a tool_end', () => {
    const starts = events.filter((e) => e.kind === 'tool_start').map((e) => e.tool!.useId);
    const ends = new Set(events.filter((e) => e.kind === 'tool_end').map((e) => e.tool!.useId));
    for (const id of starts) expect(ends).toContain(id);
  });

  it('is synthetic only', () => {
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/\/Users\/|\/home\/(?!demo)|C:\\\\/);
  });

  it('plays cleanly through the store', () => {
    const store = new StationStore();
    for (const e of events) store.apply(e);
    const snap = store.snapshot();
    expect(Object.values(snap.projects).map((p) => p.name)).toEqual([
      'moonbase-planner',
      'rocket-app',
      'asteroid-tools',
    ]);
    // After the last event every session has ended.
    expect(Object.values(snap.sessions).every((s) => s.endedAt !== undefined)).toBe(true);
    expect(snap.eventsReceived).toBe(events.length);
  });
});
