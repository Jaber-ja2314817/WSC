import { describe, expect, it } from 'vitest';
import { BUBBLE_PRIORITY, BubbleQueue } from '../src/shared/bubbles';

describe('BubbleQueue', () => {
  it('shows a bubble and expires it after its TTL', () => {
    const q = new BubbleQueue({ ttlMs: 1000 });
    expect(q.push({ crewId: 'a', kind: 'status', text: 'reading a.ts' }, 0)).toBe(true);
    expect(q.visible(500)).toHaveLength(1);
    expect(q.visible(1000)).toHaveLength(0);
  });

  it('ignores empty text', () => {
    const q = new BubbleQueue();
    expect(q.push({ crewId: 'a', kind: 'status', text: '   ' }, 0)).toBe(false);
  });

  it('enforces a per-crew gap unless urgent', () => {
    const q = new BubbleQueue({ perCrewGapMs: 1200 });
    expect(q.push({ crewId: 'a', kind: 'catchphrase', text: 'On it!' }, 0)).toBe(true);
    expect(q.push({ crewId: 'a', kind: 'status', text: 'reading x' }, 500)).toBe(false);
    expect(
      q.push(
        { crewId: 'a', kind: 'status', text: 'waiting for you', priority: BUBBLE_PRIORITY.urgent },
        600,
      ),
    ).toBe(true);
    expect(q.push({ crewId: 'b', kind: 'status', text: 'reading y' }, 500)).toBe(true);
  });

  it('replaces an older status bubble of the same crew', () => {
    const q = new BubbleQueue({ perCrewGapMs: 0 });
    q.push({ crewId: 'a', kind: 'status', text: 'reading x' }, 0);
    q.push({ crewId: 'a', kind: 'status', text: 'editing y' }, 10);
    const vis = q.visible(20);
    expect(vis.map((b) => b.text)).toEqual(['editing y']);
  });

  it('caps bubbles per crew and stacks them without overlap', () => {
    const q = new BubbleQueue({ perCrewGapMs: 0, maxPerCrew: 2 });
    q.push({ crewId: 'a', kind: 'catchphrase', text: 'one' }, 0);
    q.push({ crewId: 'a', kind: 'status', text: 'two' }, 10);
    q.push({ crewId: 'a', kind: 'catchphrase', text: 'three' }, 20);
    const vis = q.visible(30);
    expect(vis).toHaveLength(2);
    // lowest priority oldest ("one") was evicted
    expect(vis.map((b) => b.text).sort()).toEqual(['three', 'two']);
    const stacks = vis.map((b) => b.stack).sort();
    expect(stacks).toEqual([0, 1]);
    // newest sits closest to the head
    expect(vis.find((b) => b.text === 'three')!.stack).toBe(0);
  });

  it('limits the global birth rate per second', () => {
    const q = new BubbleQueue({ maxPerSecond: 3, maxVisible: 20 });
    const shown = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      q.push({ crewId: id, kind: 'status', text: 'x' }, 100),
    );
    expect(shown).toEqual([true, true, true, false, false]);
    expect(q.push({ crewId: 'f', kind: 'status', text: 'x' }, 1200)).toBe(true);
  });

  it('evicts the lowest priority when the screen is full, never a higher one', () => {
    const q = new BubbleQueue({ maxVisible: 2, maxPerSecond: 100, perCrewGapMs: 0 });
    q.push({ crewId: 'a', kind: 'catchphrase', text: 'cp' }, 0);
    q.push({ crewId: 'b', kind: 'status', text: 'st' }, 1);
    expect(q.push({ crewId: 'c', kind: 'status', text: 'st2' }, 2)).toBe(true);
    expect(q.visible(3).map((b) => b.text)).toEqual(['st', 'st2']);
    // a catchphrase cannot displace statuses
    expect(q.push({ crewId: 'd', kind: 'catchphrase', text: 'cp2' }, 4)).toBe(false);
  });

  it('clearCrew drops its bubbles', () => {
    const q = new BubbleQueue();
    q.push({ crewId: 'a', kind: 'status', text: 'x' }, 0);
    q.clearCrew('a');
    expect(q.visible(1)).toEqual([]);
  });

  it('is deterministic', () => {
    const run = (): string[] => {
      const q = new BubbleQueue({ perCrewGapMs: 0 });
      q.push({ crewId: 'a', kind: 'status', text: 'x' }, 0);
      q.push({ crewId: 'b', kind: 'catchphrase', text: 'y' }, 0);
      return q.visible(1).map((b) => `${b.id}:${b.crewId}:${b.stack}`);
    };
    expect(run()).toEqual(run());
  });
});
