// The director driven by the real store, layout and pathfinder, the way the renderer wires them.
import { describe, expect, it } from 'vitest';
import { Director } from '../src/renderer/director/director';
import type { CrewView, DirectorFrame } from '../src/renderer/director/types';
import { makePathfinder } from '../src/shared/astar';
import { SlotBook, computeLayout, layoutInputFor } from '../src/shared/layout';
import type { StationLayout, TilePos } from '../src/shared/layoutTypes';
import { StationStore } from '../src/shared/store';
import type { StationEvent } from '../src/shared/types';

const T0 = 1_700_000_000_000;
const STEP = 33;

class Floor {
  store = new StationStore();
  now = T0;
  loungeSize = 6;
  layouts = 0;
  layout!: StationLayout;
  frame!: DirectorFrame;
  private key = '';
  private seq = 0;
  private pf: (a: TilePos, b: TilePos) => TilePos[] | null = () => null;
  private readonly book = new SlotBook();
  readonly dir = new Director({
    findPath: (a, b) => this.pf(a, b),
    phrases: () => ['x'],
    random: () => 0.9,
    settings: { loungeSize: this.loungeSize },
  });

  push(): void {
    const snap = this.store.snapshot();
    const input = this.book.assign(layoutInputFor(snap, this.loungeSize));
    const key = JSON.stringify(input);
    if (key !== this.key || !this.layout) {
      this.key = key;
      this.layout = computeLayout(input);
      this.pf = makePathfinder(this.layout);
      this.dir.setLayout(this.layout);
      this.layouts++;
    }
    this.dir.setSnapshot(snap, this.now);
  }

  apply(p: Partial<StationEvent> & { kind: StationEvent['kind'] }): void {
    this.store.apply({
      id: `e${++this.seq}`,
      source: 'hook',
      ts: this.now,
      projectId: 'proj-a',
      projectName: 'project-a',
      sessionId: 'sess-a',
      agentId: 'orchestrator',
      ...p,
    });
    this.push();
  }

  session(n: string): void {
    this.apply({
      kind: 'session_start',
      sessionId: `sess-${n}`,
      projectId: `proj-${n}`,
      projectName: `project-${n}`,
    });
  }

  spawn(agentId: string, n = 'a'): void {
    this.apply({
      kind: 'agent_spawn',
      agentId,
      label: agentId,
      sessionId: `sess-${n}`,
      projectId: `proj-${n}`,
      projectName: `project-${n}`,
    });
  }

  run(ms: number): void {
    for (let t = 0; t < ms; t += STEP) {
      this.now += STEP;
      this.frame = this.dir.update(this.now, STEP);
    }
  }

  crew(label: string): CrewView {
    return this.frame.crew.find((c) => c.label === label && !c.isOrchestrator)!;
  }

  zone(n = 'a'): StationLayout['zones'][number] {
    return this.layout.zones.find((z) => z.projectId === `proj-${n}`)!;
  }

  orchestratorTiles(): string[] {
    return this.frame.crew.filter((c) => c.isOrchestrator).map((c) => `${c.x},${c.y}`);
  }

  /** Crew position relative to the center, which stays put as the grid is translated. */
  rel(label: string): { x: number; y: number } {
    const c = this.crew(label);
    const o = this.layout.center.rect;
    return { x: c.x - o.x, y: c.y - o.y };
  }
}

const seated = (f: Floor, label: string, n = 'a'): boolean => {
  const c = f.crew(label);
  return f.zone(n).desks.some((d) => d.seat.tile.x === c.x && d.seat.tile.y === c.y);
};

describe('Director on the real floor', () => {
  it('sends a new agent to the desk a finished one just left', () => {
    const f = new Floor();
    f.session('a');
    for (const a of ['a1', 'a2', 'a3', 'a4']) f.spawn(a);
    f.run(8000);
    f.apply({ kind: 'agent_finish', agentId: 'a1' });
    f.run(200);
    f.spawn('a5');
    // Well before a1 is done reporting, so a5 didn't wait for it to clear out.
    f.run(4700);
    expect(seated(f, 'a5')).toBe(true);
  });

  it('never seats two orchestrators together while one lingers', () => {
    const f = new Floor();
    f.session('a');
    f.session('b');
    f.run(500);
    f.apply({ kind: 'session_end', sessionId: 'sess-a' });
    f.run(500);
    const tiles = f.orchestratorTiles();
    expect(tiles).toHaveLength(2);
    expect(new Set(tiles).size).toBe(2);
  });

  it('gives a later session its own seat after earlier ones are removed', () => {
    const f = new Floor();
    for (const n of ['a', 'b', 'c']) f.session(n);
    f.run(500);
    for (const n of ['a', 'b']) f.store.removeProject(`proj-${n}`, ++f.now);
    f.push();
    f.run(1500);
    f.now += 1;
    f.session('d');
    f.run(1000);
    const tiles = f.orchestratorTiles();
    expect(tiles).toHaveLength(2);
    expect(new Set(tiles).size).toBe(2);
    expect(f.layout.center.tableSeats.map((s) => `${s.tile.x},${s.tile.y}`)).toEqual(
      expect.arrayContaining(tiles),
    );
  });

  it('seats a session that returns while it fades out', () => {
    const f = new Floor();
    f.session('a');
    f.session('b');
    f.run(500);
    f.store.removeProject('proj-a', ++f.now);
    f.push();
    f.run(100);
    f.now += 1;
    f.session('c');
    f.now += 1;
    f.session('a');
    f.run(1000);
    const tiles = f.orchestratorTiles();
    expect(tiles).toHaveLength(3);
    expect(new Set(tiles).size).toBe(3);
  });

  it('keeps seats apart when a session joins while others fade out', () => {
    const f = new Floor();
    for (const n of ['a', 'b', 'c', 'd']) f.session(n);
    f.run(500);
    for (const n of ['a', 'b', 'd']) f.store.removeProject(`proj-${n}`, ++f.now);
    f.push();
    f.run(100);
    f.now += 1;
    f.session('e');
    f.run(1000);
    const tiles = f.orchestratorTiles();
    expect(tiles).toHaveLength(2);
    expect(new Set(tiles).size).toBe(2);
  });

  it('gives every session its own tile beyond the 8 chairs', () => {
    const f = new Floor();
    for (let i = 0; i < 30; i++) f.session(`n${i}`);
    f.run(500);
    const tiles = f.orchestratorTiles();
    expect(tiles).toHaveLength(30);
    expect(new Set(tiles).size).toBe(30);
  });

  it('keeps seated crew in place when another zone is removed', () => {
    const f = new Floor();
    for (const n of ['a', 'b', 'c']) f.session(n);
    f.spawn('c1', 'c');
    f.run(8000);
    const before = f.rel('c1');
    f.store.removeProject('proj-a', ++f.now);
    f.push();
    f.run(STEP);
    expect(f.rel('c1')).toEqual(before);
  });

  it('keeps seated crew at their desk when a north room adds a row', () => {
    const f = new Floor();
    f.session('a');
    for (const a of ['a1', 'a2', 'a3', 'a4']) f.spawn(a);
    f.run(8000);
    const before = ['a1', 'a2', 'a3', 'a4'].map((a) => f.rel(a));
    f.spawn('a5');
    f.run(STEP);
    expect(['a1', 'a2', 'a3', 'a4'].map((a) => f.rel(a))).toEqual(before);
  });

  it('walks crew to a desk that really moved, and they get there', () => {
    const f = new Floor();
    f.session('a');
    f.session('b'); // slot 1: an east room, which grows both ways along the wall
    for (const a of ['b1', 'b2', 'b3', 'b4']) f.spawn(a, 'b');
    f.run(8000);
    const before = f.rel('b1');
    f.spawn('b5', 'b');
    f.run(STEP);
    const after = f.rel('b1');
    // One frame of walking covers a fraction of a tile; a snap would cover at least one.
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeLessThan(1);
    f.run(8000);
    for (const a of ['b1', 'b2', 'b3', 'b4', 'b5']) expect(seated(f, a, 'b')).toBe(true);
  });

  it('keeps crew bound when the lounge shrinks and an extra arrives', () => {
    const f = new Floor();
    f.session('a');
    const crew = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    for (const a of crew) f.spawn(a);
    f.run(8000);
    const ids = crew.map((a) => f.crew(a).id);
    f.loungeSize = 3;
    f.dir.setSettings({ loungeSize: 3 });
    f.push();
    f.run(1000);
    f.spawn('n1');
    f.run(8000);
    expect(crew.map((a) => f.crew(a)?.id)).toEqual(ids);
    expect(crew.every((a) => seated(f, a))).toBe(true);
    expect(seated(f, 'n1')).toBe(true);
  });

  it('frees every desk once a project and its crew are gone', () => {
    const f = new Floor();
    f.session('a');
    for (const a of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) f.spawn(a);
    f.run(8000);
    f.loungeSize = 3;
    f.dir.setSettings({ loungeSize: 3 });
    f.push();
    f.spawn('n1');
    f.run(8000);
    f.store.removeProject('proj-a', ++f.now);
    f.push();
    f.run(6000);
    f.now += 1;
    f.session('a');
    f.spawn('r1');
    f.run(8000);
    expect(seated(f, 'r1')).toBe(true);
  });

  it('rebuilds the layout only when a spawn or finish changes the room', () => {
    const f = new Floor();
    f.session('a');
    const start = f.layouts;
    for (const a of ['a1', 'a2', 'a3', 'a4']) f.spawn(a);
    f.run(500);
    f.apply({ kind: 'agent_finish', agentId: 'a1' });
    f.spawn('a5');
    f.apply({ kind: 'agent_finish', agentId: 'a2' });
    expect(f.layouts).toBe(start);
  });
});
