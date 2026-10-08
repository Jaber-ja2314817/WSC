import { beforeEach, describe, expect, it } from 'vitest';
import { StationStore, logText } from '../src/shared/store';
import { ORCHESTRATOR_ID, agentKey, type StationSnapshot } from '../src/shared/types';
import { ev, resetSeq, tool } from './fixtures/events';

const orch = (s: StationSnapshot, session = 'sess-1') =>
  s.agents[agentKey(session, ORCHESTRATOR_ID)];
const sub = (s: StationSnapshot, id: string, session = 'sess-1') => s.agents[agentKey(session, id)];

describe('StationStore', () => {
  let store: StationStore;
  beforeEach(() => {
    resetSeq();
    store = new StationStore();
  });

  describe('event kinds', () => {
    it('session_start creates project, session and idle orchestrator', () => {
      expect(store.apply(ev({ kind: 'session_start' }))).toBe(true);
      const s = store.snapshot();
      expect(Object.keys(s.projects)).toEqual(['proj-a']);
      expect(s.projects['proj-a']?.name).toBe('project-a');
      expect(s.sessions['sess-1']?.agentIds).toEqual([ORCHESTRATOR_ID]);
      expect(orch(s)).toMatchObject({
        isOrchestrator: true,
        label: 'orchestrator',
        status: 'idle',
      });
      expect(s.eventsReceived).toBe(1);
    });

    it('user_prompt makes the orchestrator think', () => {
      store.apply(ev({ kind: 'session_start' }));
      store.apply(ev({ kind: 'user_prompt' }));
      expect(orch(store.snapshot())?.status).toBe('thinking');
    });

    it('agent_spawn creates a labeled thinking subagent', () => {
      store.apply(ev({ kind: 'agent_spawn', agentId: 'a1', label: 'researcher', ts: 5000 }));
      const a = sub(store.snapshot(), 'a1');
      expect(a).toMatchObject({
        status: 'thinking',
        label: 'researcher',
        isOrchestrator: false,
        parentAgentId: ORCHESTRATOR_ID,
        spawnedAt: 5000,
      });
      expect(store.snapshot().sessions['sess-1']?.agentIds).toEqual([ORCHESTRATOR_ID, 'a1']);
    });

    it('tool_start → working with current tool; tool_end → thinking', () => {
      store.apply(
        ev({ kind: 'tool_start', tool: tool('Read', 'read', { summary: 'auth.ts', useId: 'u1' }) }),
      );
      let o = orch(store.snapshot());
      expect(o?.status).toBe('working');
      expect(o?.currentTool).toEqual({
        name: 'Read',
        category: 'read',
        summary: 'auth.ts',
        useId: 'u1',
      });
      expect(o?.toolCalls).toBe(1);
      store.apply(ev({ kind: 'tool_end', tool: tool('Read', 'read', { useId: 'u1', ok: true }) }));
      o = orch(store.snapshot());
      expect(o?.status).toBe('thinking');
      expect(o?.currentTool).toBeUndefined();
    });

    it('a failed tool is not an agent error', () => {
      store.apply(ev({ kind: 'tool_start', tool: tool('Bash', 'execute', { useId: 'u1' }) }));
      store.apply(
        ev({ kind: 'tool_end', tool: tool('Bash', 'execute', { useId: 'u1', ok: false }) }),
      );
      expect(orch(store.snapshot())?.status).toBe('thinking');
    });

    it('parallel tools: ending one keeps the other current', () => {
      store.apply(ev({ kind: 'tool_start', tool: tool('Read', 'read', { useId: 'u1' }) }));
      store.apply(ev({ kind: 'tool_start', tool: tool('Grep', 'search', { useId: 'u2' }) }));
      store.apply(ev({ kind: 'tool_end', tool: tool('Read', 'read', { useId: 'u1' }) }));
      const o = orch(store.snapshot());
      expect(o?.status).toBe('working');
      expect(o?.currentTool?.useId).toBe('u2');
    });

    it('waiting_for_user attaches the tool, then clears on next tool activity', () => {
      store.apply(
        ev({ kind: 'tool_start', agentId: 'a1', tool: tool('Bash', 'execute', { useId: 'u1' }) }),
      );
      store.apply(
        ev({
          kind: 'waiting_for_user',
          agentId: 'a1',
          tool: tool('Bash', 'execute', { useId: 'u1' }),
        }),
      );
      let a = sub(store.snapshot(), 'a1');
      expect(a?.status).toBe('waiting');
      expect(a?.currentTool?.name).toBe('Bash');
      store.apply(
        ev({ kind: 'tool_end', agentId: 'a1', tool: tool('Bash', 'execute', { useId: 'u1' }) }),
      );
      a = sub(store.snapshot(), 'a1');
      expect(a?.status).toBe('thinking');
    });

    it('waiting_for_user with no agent attribution goes to the orchestrator', () => {
      store.apply(ev({ kind: 'waiting_for_user', agentId: '' }));
      expect(orch(store.snapshot())?.status).toBe('waiting');
    });

    it('agent_finish → done with finishedAt; agent_error → error', () => {
      store.apply(ev({ kind: 'agent_spawn', agentId: 'a1' }));
      store.apply(ev({ kind: 'agent_spawn', agentId: 'a2' }));
      store.apply(ev({ kind: 'agent_finish', agentId: 'a1', ts: 9000 }));
      store.apply(ev({ kind: 'agent_error', agentId: 'a2', ts: 9001 }));
      const s = store.snapshot();
      expect(sub(s, 'a1')).toMatchObject({ status: 'done', finishedAt: 9000 });
      expect(sub(s, 'a2')).toMatchObject({ status: 'error', finishedAt: 9001 });
    });

    it('idle sets the orchestrator idle and leaves running subagents alone', () => {
      store.apply(ev({ kind: 'user_prompt' }));
      store.apply(ev({ kind: 'tool_start', agentId: 'a1', tool: tool('Read', 'read') }));
      store.apply(ev({ kind: 'idle' }));
      const s = store.snapshot();
      expect(orch(s)?.status).toBe('idle');
      expect(sub(s, 'a1')?.status).toBe('working');
    });

    it('compacting → thinking with no current tool', () => {
      store.apply(ev({ kind: 'tool_start', tool: tool('Read', 'read') }));
      store.apply(ev({ kind: 'compacting' }));
      const o = orch(store.snapshot());
      expect(o?.status).toBe('thinking');
      expect(o?.currentTool).toBeUndefined();
    });

    it('session_end marks every agent done and sets endedAt', () => {
      store.apply(ev({ kind: 'session_start' }));
      store.apply(ev({ kind: 'tool_start', agentId: 'a1', tool: tool('Read', 'read') }));
      store.apply(ev({ kind: 'session_end', ts: 5000 }));
      const s = store.snapshot();
      expect(s.sessions['sess-1']?.endedAt).toBe(5000);
      expect(orch(s)?.status).toBe('done');
      expect(sub(s, 'a1')?.status).toBe('done');
    });

    it('unknown kinds are counted but change nothing', () => {
      store.apply(ev({ kind: 'session_start' }));
      const odd = ev({ kind: 'mystery' as never });
      expect(store.apply(odd)).toBe(true);
      expect(orch(store.snapshot())?.status).toBe('idle');
    });
  });

  describe('robustness', () => {
    it('auto-creates an unknown subagent from a tool event', () => {
      store.apply(ev({ kind: 'tool_start', agentId: 'ghost', tool: tool('Grep', 'search') }));
      const s = store.snapshot();
      expect(sub(s, 'ghost')).toMatchObject({ label: 'agent', status: 'working' });
      expect(orch(s)).toBeDefined();
    });

    it('later label upgrades an auto-created agent', () => {
      store.apply(ev({ kind: 'tool_start', agentId: 'a1', tool: tool('Grep', 'search') }));
      store.apply(
        ev({ kind: 'tool_end', agentId: 'a1', label: 'Explore', tool: tool('Grep', 'search') }),
      );
      expect(sub(store.snapshot(), 'a1')?.label).toBe('Explore');
    });

    it('dedupes by id', () => {
      const e = ev({ kind: 'tool_start', tool: tool('Read', 'read') });
      expect(store.apply(e)).toBe(true);
      expect(store.apply({ ...e })).toBe(false);
      expect(orch(store.snapshot())?.toolCalls).toBe(1);
      expect(store.snapshot().eventsReceived).toBe(1);
    });

    it('dedupe memory is bounded', () => {
      const small = new StationStore({ dedupeCap: 2 });
      const e1 = ev({ kind: 'idle' });
      small.apply(e1);
      small.apply(ev({ kind: 'idle' }));
      small.apply(ev({ kind: 'idle' }));
      // e1 was evicted, so it is accepted again.
      expect(small.apply({ ...e1 })).toBe(true);
    });

    it('ignores malformed events without throwing', () => {
      const bad: unknown[] = [
        null,
        undefined,
        42,
        {},
        { id: 'x' },
        { id: 'y', sessionId: 's', projectId: '', kind: 'idle' },
        { id: 'z', sessionId: 's', projectId: 'p' },
      ];
      for (const b of bad) expect(store.apply(b as never)).toBe(false);
      expect(store.snapshot().eventsReceived).toBe(0);
    });

    it('treats a non-finite ts as 0 instead of throwing', () => {
      expect(store.apply(ev({ kind: 'idle', ts: Number.NaN }))).toBe(true);
    });

    it('applyMany reports whether anything changed and notifies once', () => {
      let calls = 0;
      const off = store.subscribe(() => calls++);
      const e = ev({ kind: 'idle' });
      expect(store.applyMany([e, ev({ kind: 'user_prompt' })])).toBe(true);
      expect(calls).toBe(1);
      expect(store.applyMany([e])).toBe(false);
      expect(calls).toBe(1);
      off();
      store.apply(ev({ kind: 'idle' }));
      expect(calls).toBe(1);
    });

    it('a throwing listener does not break the store', () => {
      store.subscribe(() => {
        throw new Error('boom');
      });
      expect(store.apply(ev({ kind: 'idle' }))).toBe(true);
    });
  });

  describe('out-of-order', () => {
    it('tool_end before tool_start does not leave the agent working', () => {
      store.apply(ev({ kind: 'tool_end', ts: 2000, tool: tool('Read', 'read', { useId: 'u1' }) }));
      store.apply(
        ev({ kind: 'tool_start', ts: 1500, tool: tool('Read', 'read', { useId: 'u1' }) }),
      );
      const o = orch(store.snapshot());
      expect(o?.status).toBe('thinking');
      expect(o?.toolCalls).toBe(1);
    });

    it('a late tool_start with the same useId after its end, even with newer ts, stays ended', () => {
      store.apply(ev({ kind: 'tool_end', ts: 2000, tool: tool('Read', 'read', { useId: 'u1' }) }));
      store.apply(
        ev({ kind: 'tool_start', ts: 2001, tool: tool('Read', 'read', { useId: 'u1' }) }),
      );
      expect(orch(store.snapshot())?.status).toBe('thinking');
    });

    it('older events after agent_finish do not regress status', () => {
      store.apply(ev({ kind: 'agent_spawn', agentId: 'a1', ts: 1000 }));
      store.apply(ev({ kind: 'agent_finish', agentId: 'a1', ts: 3000 }));
      store.apply(ev({ kind: 'tool_start', agentId: 'a1', ts: 2500, tool: tool('Edit', 'write') }));
      const a = sub(store.snapshot(), 'a1');
      expect(a?.status).toBe('done');
      expect(a?.finishedAt).toBe(3000);
      expect(a?.toolCalls).toBe(1);
    });

    it('a newer event revives a done subagent', () => {
      store.apply(ev({ kind: 'agent_spawn', agentId: 'a1', ts: 1000 }));
      store.apply(ev({ kind: 'agent_finish', agentId: 'a1', ts: 2000 }));
      store.apply(ev({ kind: 'tool_start', agentId: 'a1', ts: 3000, tool: tool('Read', 'read') }));
      const a = sub(store.snapshot(), 'a1');
      expect(a?.status).toBe('working');
      expect(a?.finishedAt).toBeUndefined();
    });

    it('log stays chronological', () => {
      store.apply(ev({ kind: 'idle', ts: 3000 }));
      store.apply(ev({ kind: 'user_prompt', ts: 1000 }));
      store.apply(ev({ kind: 'idle', ts: 2000 }));
      expect(store.snapshot().log.map((l) => l.ts)).toEqual([1000, 2000, 3000]);
    });

    it('stepStartedAt tracks status and tool changes', () => {
      store.apply(
        ev({ kind: 'tool_start', ts: 1000, tool: tool('Read', 'read', { useId: 'u1' }) }),
      );
      store.apply(ev({ kind: 'tool_end', ts: 1100, tool: tool('Read', 'read', { useId: 'u1' }) }));
      store.apply(
        ev({ kind: 'tool_start', ts: 1200, tool: tool('Edit', 'write', { useId: 'u2' }) }),
      );
      expect(orch(store.snapshot())?.stepStartedAt).toBe(1200);
    });
  });

  describe('projects and sessions', () => {
    it('two concurrent projects get stable orders', () => {
      store.apply(
        ev({ kind: 'session_start', sessionId: 's1', projectId: 'p1', projectName: 'one' }),
      );
      store.apply(
        ev({ kind: 'session_start', sessionId: 's2', projectId: 'p2', projectName: 'two' }),
      );
      store.apply(
        ev({
          kind: 'tool_start',
          sessionId: 's1',
          projectId: 'p1',
          agentId: 'a1',
          tool: tool('Read', 'read'),
        }),
      );
      store.apply(
        ev({
          kind: 'tool_start',
          sessionId: 's2',
          projectId: 'p2',
          agentId: 'a1',
          tool: tool('Bash', 'execute'),
        }),
      );
      const s = store.snapshot();
      expect(s.projects['p1']?.order).toBe(0);
      expect(s.projects['p2']?.order).toBe(1);
      // Same agent id in two sessions stays distinct.
      expect(sub(s, 'a1', 's1')?.currentTool?.name).toBe('Read');
      expect(sub(s, 'a1', 's2')?.currentTool?.name).toBe('Bash');
      expect(sub(s, 'a1', 's2')?.projectId).toBe('p2');
    });

    it('two sessions in the same folder share one project', () => {
      store.apply(ev({ kind: 'session_start', sessionId: 's1' }));
      store.apply(ev({ kind: 'session_start', sessionId: 's2' }));
      const s = store.snapshot();
      expect(Object.keys(s.projects)).toEqual(['proj-a']);
      expect(s.projects['proj-a']?.sessionIds).toEqual(['s1', 's2']);
      expect(orch(s, 's1')).toBeDefined();
      expect(orch(s, 's2')).toBeDefined();
    });

    it('updates lastEventAt on project and session', () => {
      store.apply(ev({ kind: 'session_start', ts: 1000 }));
      store.apply(ev({ kind: 'idle', ts: 4000 }));
      const s = store.snapshot();
      expect(s.projects['proj-a']?.lastEventAt).toBe(4000);
      expect(s.sessions['sess-1']?.lastEventAt).toBe(4000);
    });

    it('activity after session_end reopens the session', () => {
      store.apply(ev({ kind: 'session_end', ts: 1000 }));
      store.apply(ev({ kind: 'user_prompt', ts: 2000 }));
      expect(store.snapshot().sessions['sess-1']?.endedAt).toBeUndefined();
    });

    it('clearIdleProjects removes only idle projects', () => {
      store.apply(ev({ kind: 'session_start', sessionId: 's1', projectId: 'p1', ts: 1000 }));
      store.apply(ev({ kind: 'session_start', sessionId: 's2', projectId: 'p2', ts: 50_000 }));
      store.clearIdleProjects(60_000, 30_000);
      const s = store.snapshot();
      expect(Object.keys(s.projects)).toEqual(['p2']);
      expect(s.sessions['s1']).toBeUndefined();
      expect(orch(s, 's1')).toBeUndefined();
    });
  });

  describe('tick', () => {
    it('marks idle-too-long working/thinking agents stale', () => {
      const st = new StationStore({ staleMs: 1000 });
      st.apply(ev({ kind: 'tool_start', agentId: 'a1', ts: 1000, tool: tool('Read', 'read') }));
      expect(st.tick(1500)).toBe(false);
      expect(st.tick(2500)).toBe(true);
      expect(sub(st.snapshot(), 'a1')?.status).toBe('stale');
      // A new event un-stales it.
      st.apply(ev({ kind: 'tool_start', agentId: 'a1', ts: 3000, tool: tool('Edit', 'write') }));
      expect(sub(st.snapshot(), 'a1')?.status).toBe('working');
    });

    it('never marks waiting agents stale', () => {
      const st = new StationStore({ staleMs: 1000 });
      st.apply(ev({ kind: 'waiting_for_user', agentId: 'a1', ts: 1000 }));
      st.tick(100_000);
      expect(sub(st.snapshot(), 'a1')?.status).toBe('waiting');
    });

    it('removes ended sessions after the linger time and ignores their late events', () => {
      const st = new StationStore({ sessionLingerMs: 1000 });
      st.apply(ev({ kind: 'session_start', ts: 1000 }));
      st.apply(ev({ kind: 'tool_start', agentId: 'a1', ts: 1100, tool: tool('Read', 'read') }));
      st.apply(ev({ kind: 'session_end', ts: 2000 }));
      expect(st.tick(2500)).toBe(false);
      expect(st.snapshot().sessions['sess-1']).toBeDefined();
      expect(st.tick(3500)).toBe(true);
      const s = st.snapshot();
      expect(s.sessions['sess-1']).toBeUndefined();
      expect(sub(s, 'a1')).toBeUndefined();
      expect(s.projects['proj-a']?.sessionIds).toEqual([]);
      // A late event from before the end does not resurrect it...
      expect(st.apply(ev({ kind: 'tool_end', agentId: 'a1', ts: 1500 }))).toBe(false);
      // ...but a genuinely newer one (resumed session) does.
      expect(st.apply(ev({ kind: 'session_start', ts: 9000 }))).toBe(true);
      expect(orch(st.snapshot())?.status).toBe('idle');
    });
  });

  describe('log', () => {
    it('is capped, dropping the oldest', () => {
      const st = new StationStore({ logCap: 3 });
      for (let i = 0; i < 5; i++) st.apply(ev({ kind: 'idle', ts: 1000 + i }));
      const log = st.snapshot().log;
      expect(log).toHaveLength(3);
      expect(log.map((l) => l.ts)).toEqual([1002, 1003, 1004]);
    });

    it('uses only the sanitized summary for tool text', () => {
      store.apply(
        ev({
          kind: 'tool_start',
          tool: tool('Read', 'read', { summary: 'auth.ts' }),
          label: 'should-not-appear',
        }),
      );
      const entry = store.snapshot().log[0];
      expect(entry?.text).toBe('Read · auth.ts');
    });

    it('has text for every kind', () => {
      const kinds = [
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
      ] as const;
      for (const kind of kinds) expect(logText(ev({ kind })).length).toBeGreaterThan(0);
      expect(logText(ev({ kind: 'agent_spawn', label: 'researcher' }))).toBe('spawned researcher');
      expect(logText(ev({ kind: 'tool_end', tool: tool('Bash', 'execute', { ok: false }) }))).toBe(
        'Bash failed',
      );
    });
  });

  it('snapshot is a deep copy', () => {
    store.apply(ev({ kind: 'tool_start', tool: tool('Read', 'read', { summary: 'a.ts' }) }));
    const s1 = store.snapshot();
    const o = orch(s1);
    if (o?.currentTool) o.currentTool.summary = 'mutated';
    s1.projects['proj-a']!.sessionIds.push('evil');
    s1.log.length = 0;
    const s2 = store.snapshot();
    expect(orch(s2)?.currentTool?.summary).toBe('a.ts');
    expect(s2.projects['proj-a']?.sessionIds).toEqual(['sess-1']);
    expect(s2.log).toHaveLength(1);
  });
});

describe('lost signal', () => {
  it('finishes a stale subagent after lostMs, but never the orchestrator', () => {
    const store = new StationStore({ staleMs: 1_000, lostMs: 5_000 });
    store.applyMany([
      ev({ kind: 'session_start', ts: 0 }),
      ev({ kind: 'agent_spawn', agentId: 'sub1', ts: 1, label: 'helper' }),
      ev({ kind: 'user_prompt', ts: 2 }),
    ]);
    store.tick(2_000);
    let snap = store.snapshot();
    expect(Object.values(snap.agents).map((a) => a.status)).toEqual(['stale', 'stale']);
    store.tick(10_000);
    snap = store.snapshot();
    const byId = Object.fromEntries(Object.values(snap.agents).map((a) => [a.id, a.status]));
    expect(byId).toEqual({ orchestrator: 'stale', sub1: 'done' });
  });
});

describe('cwd changes', () => {
  it('keeps a session in its original project when later events carry another cwd', () => {
    const store = new StationStore();
    store.applyMany([
      ev({ kind: 'session_start', ts: 0, projectId: 'p-a', projectName: 'a' }),
      ev({ kind: 'user_prompt', ts: 1, projectId: 'p-sub', projectName: 'sub' }),
    ]);
    const snap = store.snapshot();
    expect(Object.keys(snap.projects)).toEqual(['p-a']);
    expect(Object.values(snap.agents).every((a) => a.projectId === 'p-a')).toBe(true);
  });
});
