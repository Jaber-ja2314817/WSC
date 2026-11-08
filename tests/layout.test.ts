import { describe, expect, it } from 'vitest';
import { findPath } from '../src/shared/astar';
import { SlotBook, computeLayout, layoutInputFor } from '../src/shared/layout';
import {
  DESK_H,
  DESK_W,
  type LayoutInput,
  type Rect,
  type StationLayout,
  type TilePos,
} from '../src/shared/layoutTypes';
import { StationStore } from '../src/shared/store';
import { ev, resetSeq } from './fixtures/events';

const projects = (n: number, agentCount = 4): LayoutInput['projects'] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `proj-${i}`, order: i, agentCount }));

const input = (n: number, agentCount = 4, seats = 1): LayoutInput => ({
  projects: projects(n, agentCount),
  orchestratorSeats: seats,
  loungeSize: 6,
});

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inRect = (t: TilePos, r: Rect): boolean =>
  t.x >= r.x && t.y >= r.y && t.x < r.x + r.w && t.y < r.y + r.h;

const walkable = (l: StationLayout, t: TilePos): boolean =>
  t.x >= 0 &&
  t.y >= 0 &&
  t.x < l.width &&
  t.y < l.height &&
  l.walkable[t.y * l.width + t.x] === true;

function allSpots(l: StationLayout): TilePos[] {
  return [
    ...l.center.tableSeats.map((s) => s.tile),
    ...l.center.reportSpots.map((s) => s.tile),
    ...l.center.loungeSpots.map((s) => s.tile),
    l.center.arrival,
    ...l.zones.flatMap((z) => [z.door, ...z.desks.map((d) => d.seat.tile)]),
  ];
}

const cases: [number, number][] = [
  [0, 4],
  [1, 1],
  [1, 4],
  [3, 4],
  [6, 4],
  [6, 16],
  [9, 4],
  [3, 20],
  [9, 20],
];

describe.each(cases)('computeLayout with %i projects × %i agents', (n, agents) => {
  const l = computeLayout(input(n, agents, Math.max(1, n)));

  it('has one zone per project with enough desks', () => {
    expect(l.zones).toHaveLength(n);
    for (const z of l.zones) {
      expect(z.desks.length).toBeGreaterThanOrEqual(Math.max(4, agents));
      expect(z.desks.length % 4).toBe(0);
    }
  });

  it('never overlaps zones with each other or the center', () => {
    for (const [i, a] of l.zones.entries()) {
      expect(overlaps(a.rect, l.center.rect)).toBe(false);
      for (const b of l.zones.slice(i + 1)) expect(overlaps(a.rect, b.rect)).toBe(false);
    }
  });

  it('keeps everything in bounds with a margin', () => {
    const rects = [l.center.rect, ...l.zones.map((z) => z.rect)];
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(1);
      expect(r.y).toBeGreaterThanOrEqual(1);
      expect(r.x + r.w).toBeLessThan(l.width);
      expect(r.y + r.h).toBeLessThan(l.height);
    }
    expect(l.floor).toHaveLength(l.width * l.height);
    expect(l.walkable).toHaveLength(l.width * l.height);
  });

  it('makes every seat, spot, door and the arrival walkable', () => {
    for (const t of allSpots(l)) expect(walkable(l, t), JSON.stringify(t)).toBe(true);
  });

  it('places desks inside their zone and blocks desk tiles', () => {
    for (const z of l.zones) {
      for (const d of z.desks) {
        expect(inRect(d.desk, z.rect)).toBe(true);
        expect(inRect({ x: d.desk.x + DESK_W - 1, y: d.desk.y + DESK_H - 1 }, z.rect)).toBe(true);
        expect(walkable(l, d.desk)).toBe(false);
        expect(inRect(d.seat.tile, z.rect)).toBe(true);
      }
      expect(new Set(z.desks.map((d) => d.id)).size).toBe(z.desks.length);
    }
  });

  it('connects every desk seat to the lounge and the table', () => {
    const starts = [l.center.loungeSpots[0]!.tile, l.center.tableSeats[0]!.tile, l.center.arrival];
    for (const s of starts) {
      for (const z of l.zones) {
        for (const d of [z.desks[0]!, z.desks.at(-1)!]) {
          const p = findPath(l, s, d.seat.tile);
          expect(p, `${z.name} ${d.id}`).not.toBeNull();
          expect(p!.at(-1)).toEqual(d.seat.tile);
        }
      }
      for (const spot of [
        ...l.center.loungeSpots,
        ...l.center.reportSpots,
        ...l.center.tableSeats,
      ]) {
        expect(findPath(l, s, spot.tile)?.at(-1) ?? s).toEqual(spot.tile);
      }
    }
  });
});

describe('computeLayout center', () => {
  it('provides lounge spots, ≥8 report spots and a seat per session', () => {
    const l = computeLayout({ projects: [], orchestratorSeats: 20, loungeSize: 10 });
    expect(l.center.tableSeats).toHaveLength(20);
    expect(l.center.loungeSpots).toHaveLength(10);
    expect(l.center.reportSpots.length).toBeGreaterThanOrEqual(8);
    expect(
      computeLayout({ projects: [], orchestratorSeats: 0, loungeSize: 2 }).center.loungeSpots,
    ).toHaveLength(6);
  });

  it('gives every seat its own free tile, past the 8 chairs at the table', () => {
    const l = computeLayout({ projects: [], orchestratorSeats: 500, loungeSize: 24 });
    const seats = l.center.tableSeats;
    expect(seats.length).toBeGreaterThanOrEqual(50);
    const key = (t: { x: number; y: number }): string => `${t.x},${t.y}`;
    expect(new Set(seats.map((s) => key(s.tile))).size).toBe(seats.length);
    const taken = new Set(
      [...l.center.reportSpots, ...l.center.loungeSpots].map((s) => key(s.tile)),
    );
    for (const s of seats) {
      expect(taken.has(key(s.tile)), key(s.tile)).toBe(false);
      expect(l.walkable[s.tile.y * l.width + s.tile.x], key(s.tile)).toBe(true);
    }
  });

  it('keeps seat i in place as the table grows', () => {
    const small = computeLayout({ projects: [], orchestratorSeats: 2, loungeSize: 6 });
    const big = computeLayout({ projects: [], orchestratorSeats: 8, loungeSize: 6 });
    expect(big.center.table.w).toBeGreaterThan(small.center.table.w);
    expect(big.center.tableSeats.slice(0, 2)).toEqual(small.center.tableSeats);
  });

  it('puts the lounge inside the center and below the table', () => {
    const l = computeLayout(input(2));
    const c = l.center;
    expect(c.lounge.y).toBeGreaterThan(c.table.y + c.table.h);
    expect(c.lounge.y + c.lounge.h).toBeLessThanOrEqual(c.rect.y + c.rect.h);
    for (const s of c.loungeSpots) expect(inRect(s.tile, c.lounge)).toBe(true);
  });
});

describe('computeLayout stability', () => {
  it('is deterministic', () => {
    expect(computeLayout(input(6, 7, 3))).toEqual(computeLayout(input(6, 7, 3)));
  });

  it('keeps existing zones in place when a project is added', () => {
    const three = computeLayout(input(3));
    const four = computeLayout(input(4));
    const offset = (l: StationLayout): TilePos => ({ x: l.center.rect.x, y: l.center.rect.y });
    const rel = (l: StationLayout, i: number): Rect => {
      const o = offset(l);
      const r = l.zones[i]!.rect;
      return { x: r.x - o.x, y: r.y - o.y, w: r.w, h: r.h };
    };
    for (let i = 0; i < 3; i++) expect(rel(four, i)).toEqual(rel(three, i));
  });

  it('assigns slots by project order, not input order', () => {
    const p = projects(3);
    const l = computeLayout({
      projects: [p[2]!, p[0]!, p[1]!],
      orchestratorSeats: 1,
      loungeSize: 6,
    });
    expect(l.zones.map((z) => z.projectId)).toEqual(['p0', 'p1', 'p2']);
    expect(l.zones.map((z) => z.slot)).toEqual([0, 1, 2]);
  });

  it('puts the nameplate above the zone and the door on its edge', () => {
    for (const z of computeLayout(input(8)).zones) {
      expect(z.nameplate.y).toBe(z.rect.y - 1);
      const onEdge =
        z.door.x === z.rect.x ||
        z.door.x === z.rect.x + z.rect.w - 1 ||
        z.door.y === z.rect.y ||
        z.door.y === z.rect.y + z.rect.h - 1;
      expect(onEdge).toBe(true);
    }
  });
});

describe('stable placement', () => {
  const rel = (l: StationLayout, id: string): { x: number; y: number } => {
    const z = l.zones.find((q) => q.projectId === id)!;
    return { x: z.rect.x - l.center.rect.x, y: z.rect.y - l.center.rect.y };
  };

  it('leaves other zones where they are when a project goes', () => {
    const book = new SlotBook();
    const all = projects(3);
    const before = computeLayout(book.assign({ ...input(3), projects: all }));
    const after = computeLayout(book.assign({ ...input(3), projects: all.slice(1) }));
    expect(after.zones.map((z) => z.slot)).toEqual([1, 2]);
    expect(rel(after, 'p1')).toEqual(rel(before, 'p1'));
    expect(rel(after, 'p2')).toEqual(rel(before, 'p2'));
  });

  it('gives a new project the freed slot and nothing else moves', () => {
    const book = new SlotBook();
    const all = projects(4);
    book.assign({ ...input(3), projects: all.slice(0, 3) });
    book.assign({ ...input(3), projects: [all[1]!, all[2]!] });
    const next = book.assign({ ...input(3), projects: [all[1]!, all[2]!, all[3]!] });
    expect(next.projects.map((p) => [p.id, p.slot])).toEqual([
      ['p1', 1],
      ['p2', 2],
      ['p3', 0],
    ]);
  });

  it('keeps every project in its slot when the input repeats', () => {
    const book = new SlotBook();
    const first = book.assign(input(5));
    expect(book.assign(input(5))).toEqual(first);
  });

  it('places zones by project order when no slots are given', () => {
    const l = computeLayout(input(3));
    expect(l.zones.map((z) => z.slot)).toEqual([0, 1, 2]);
  });

  it('keeps desk ids on the same tiles when a zone adds a row', () => {
    for (let slot = 0; slot < 8; slot++) {
      const count = (agents: number): StationLayout => {
        const ps = projects(8).map((p, i) => ({ ...p, agentCount: i === slot ? agents : 0 }));
        return computeLayout({ ...input(8), projects: ps });
      };
      const seat = (l: StationLayout): Map<string, string> => {
        const c = l.center.rect;
        const z = l.zones[slot]!;
        return new Map(z.desks.map((d) => [d.id, `${d.seat.tile.x - c.x},${d.seat.tile.y - c.y}`]));
      };
      const small = seat(count(4));
      const big = seat(count(8));
      const kept = [...small].filter(([id]) => big.has(id));
      for (const [id, tile] of kept) expect(big.get(id)).toBe(tile);
      // North/south rooms grow outward, so nobody has to move at all.
      if (slot === 0 || slot === 2) expect(kept).toHaveLength(small.size);
    }
  });
});

describe('layoutInputFor', () => {
  const deskCount = (store: StationStore): number =>
    computeLayout(layoutInputFor(store.snapshot(), 6)).zones[0]!.desks.length;

  it('seats new crew at free desks instead of adding space', () => {
    resetSeq();
    const store = new StationStore();
    store.apply(ev({ kind: 'session_start' }));
    const desks = deskCount(store);
    // Agents come and go one after another: the room never needs more than one seat.
    for (let i = 0; i < 12; i++) {
      store.apply(ev({ kind: 'agent_spawn', agentId: `a${i}` }));
      expect(deskCount(store)).toBe(desks);
      store.apply(ev({ kind: 'agent_finish', agentId: `a${i}` }));
    }
    expect(deskCount(store)).toBe(desks);
  });

  it('counts only crew that still need a seat, never the orchestrator', () => {
    resetSeq();
    const store = new StationStore();
    store.apply(ev({ kind: 'session_start' }));
    for (let i = 0; i < 6; i++) store.apply(ev({ kind: 'agent_spawn', agentId: `a${i}` }));
    store.apply(ev({ kind: 'agent_finish', agentId: 'a0' }));
    store.apply(ev({ kind: 'agent_finish', agentId: 'a1' }));
    // Four left, so the room fits in one row. An errored agent still counts as crew.
    const input = layoutInputFor(store.snapshot(), 6);
    expect(input.projects).toEqual([{ id: 'proj-a', name: 'project-a', order: 0, agentCount: 4 }]);
    expect(input.orchestratorSeats).toBe(1);
    store.apply(ev({ kind: 'agent_spawn', agentId: 'a6' }));
    store.apply(ev({ kind: 'agent_error', agentId: 'a6' }));
    expect(layoutInputFor(store.snapshot(), 6).projects[0]!.agentCount).toBe(8);
  });

  it('does not change when a spawn fits the desks the room already has', () => {
    resetSeq();
    const store = new StationStore();
    store.apply(ev({ kind: 'session_start' }));
    const key = (): string => JSON.stringify(layoutInputFor(store.snapshot(), 6));
    const before = key();
    for (let i = 0; i < 4; i++) store.apply(ev({ kind: 'agent_spawn', agentId: `a${i}` }));
    expect(key()).toBe(before);
    store.apply(ev({ kind: 'agent_spawn', agentId: 'a4' }));
    expect(key()).not.toBe(before);
  });

  it('keeps a seat at the table for a session that has ended but not left yet', () => {
    resetSeq();
    const store = new StationStore();
    store.apply(ev({ kind: 'session_start', sessionId: 'sess-1' }));
    store.apply(ev({ kind: 'session_start', sessionId: 'sess-2' }));
    store.apply(ev({ kind: 'session_end', sessionId: 'sess-1' }));
    expect(layoutInputFor(store.snapshot(), 6).orchestratorSeats).toBe(2);
  });

  it('adds space only once every seat is taken', () => {
    resetSeq();
    const store = new StationStore();
    store.apply(ev({ kind: 'session_start' }));
    const desks = deskCount(store);
    for (let i = 0; i < desks; i++) store.apply(ev({ kind: 'agent_spawn', agentId: `a${i}` }));
    expect(deskCount(store)).toBe(desks);
    store.apply(ev({ kind: 'agent_spawn', agentId: 'extra' }));
    expect(deskCount(store)).toBeGreaterThan(desks);
  });
});
