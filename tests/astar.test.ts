import { describe, expect, it } from 'vitest';
import { findPath, makePathfinder, type WalkGrid } from '../src/shared/astar';

/** '.' walkable, '#' blocked. */
function grid(rows: string[]): WalkGrid {
  return {
    width: rows[0]!.length,
    height: rows.length,
    walkable: rows
      .join('')
      .split('')
      .map((c) => c !== '#'),
  };
}

const turns = (path: { x: number; y: number }[], start: { x: number; y: number }): number => {
  let n = 0;
  let prev = start;
  let dir = '';
  for (const p of path) {
    const d = `${p.x - prev.x},${p.y - prev.y}`;
    if (dir && d !== dir) n++;
    dir = d;
    prev = p;
  }
  return n;
};

describe('findPath', () => {
  it('walks a straight line, excluding start and including goal', () => {
    const g = grid(['.....']);
    expect(findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
    ]);
  });

  it('returns [] when already at the goal', () => {
    expect(findPath(grid(['..']), { x: 1, y: 0 }, { x: 1, y: 0 })).toEqual([]);
  });

  it('routes around an obstacle with a shortest path', () => {
    const g = grid(['.....', '.###.', '.....']);
    const path = findPath(g, { x: 0, y: 1 }, { x: 4, y: 1 })!;
    expect(path).toHaveLength(6);
    expect(path.at(-1)).toEqual({ x: 4, y: 1 });
    for (const p of path) expect(g.walkable[p.y * g.width + p.x]).toBe(true);
  });

  it('prefers few turns among equal-length paths', () => {
    const g = grid(['......', '......', '......', '......']);
    const path = findPath(g, { x: 0, y: 0 }, { x: 5, y: 3 })!;
    expect(path).toHaveLength(8);
    expect(turns(path, { x: 0, y: 0 })).toBe(1);
  });

  it('returns null when unreachable', () => {
    const g = grid(['..#..', '..#..']);
    expect(findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 })).toBeNull();
  });

  it('targets the nearest walkable neighbor of a blocked goal', () => {
    const g = grid(['.....', '..#..', '.....']);
    const path = findPath(g, { x: 0, y: 1 }, { x: 2, y: 1 })!;
    const end = path.at(-1)!;
    expect(Math.abs(end.x - 2) + Math.abs(end.y - 1)).toBe(1);
  });

  it('can start on a blocked tile (sprite on a prop)', () => {
    const g = grid(['#...']);
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it('gives up after maxNodes expansions', () => {
    const g = grid(Array.from({ length: 60 }, () => '.'.repeat(60)));
    expect(findPath(g, { x: 0, y: 0 }, { x: 59, y: 59 }, { maxNodes: 10 })).toBeNull();
    expect(findPath(g, { x: 0, y: 0 }, { x: 59, y: 59 })).toHaveLength(118);
  });

  it('returns null for out-of-bounds starts', () => {
    expect(findPath(grid(['..']), { x: -1, y: 0 }, { x: 1, y: 0 })).toBeNull();
  });

  it('rounds fractional coordinates', () => {
    expect(findPath(grid(['...']), { x: 0.2, y: 0 }, { x: 1.8, y: 0.1 })).toHaveLength(2);
  });
});

describe('makePathfinder', () => {
  it('caches results but returns independent copies', () => {
    const find = makePathfinder(grid(['....']));
    const a = find({ x: 0, y: 0 }, { x: 3, y: 0 })!;
    a[0]!.x = 99;
    const b = find({ x: 0, y: 0 }, { x: 3, y: 0 })!;
    expect(b[0]).toEqual({ x: 1, y: 0 });
    expect(find({ x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([]);
  });
});
