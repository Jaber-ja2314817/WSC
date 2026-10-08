// Grid A* (4-directional) with a binary heap and a tiny turn penalty so routes look natural.
// Pure TS — used by the director in the renderer and by layout.ts to route corridors.
import type { StationLayout, TilePos } from './layoutTypes';

export interface WalkGrid {
  width: number;
  height: number;
  walkable: boolean[];
}

export interface FindPathOptions {
  /** Max node expansions before giving up (default 20_000). */
  maxNodes?: number;
}

// Integer costs: a step always outweighs any number of turns along a realistic path.
const STEP = 100_000;
const TURN = 1;
const DIRS: readonly [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const NO_DIR = 4;

class MinHeap {
  private items: { f: number; h: number; seq: number; state: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: { f: number; h: number; seq: number; state: number }): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }

  pop(): { f: number; h: number; seq: number; state: number } | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }

  private less(
    x: { f: number; h: number; seq: number },
    y: { f: number; h: number; seq: number },
  ): boolean {
    if (x.f !== y.f) return x.f < y.f;
    if (x.h !== y.h) return x.h < y.h;
    return x.seq < y.seq;
  }
}

const inBounds = (g: WalkGrid, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < g.width && y < g.height;

const isWalkable = (g: WalkGrid, x: number, y: number): boolean =>
  inBounds(g, x, y) && g.walkable[y * g.width + x] === true;

/** Nearest walkable tile to `to` (by Manhattan rings, fixed scan order), or null. */
function nearestWalkable(g: WalkGrid, to: TilePos, maxRadius = 3): TilePos | null {
  for (let d = 1; d <= maxRadius; d++) {
    for (let dy = -d; dy <= d; dy++) {
      const rest = d - Math.abs(dy);
      const xs = rest === 0 ? [0] : [-rest, rest];
      for (const dx of xs) {
        if (isWalkable(g, to.x + dx, to.y + dy)) return { x: to.x + dx, y: to.y + dy };
      }
    }
  }
  return null;
}

/**
 * Shortest 4-directional path from `from` to `to`. The result excludes `from` and includes the
 * goal. If `to` isn't walkable, routes to its nearest walkable neighbor. `from` may itself be
 * blocked (a sprite standing on a prop). Returns [] when already there, null when unreachable.
 */
export function findPath(
  grid: WalkGrid,
  from: TilePos,
  to: TilePos,
  opts?: FindPathOptions,
): TilePos[] | null {
  const maxNodes = opts?.maxNodes ?? 20_000;
  const sx = Math.round(from.x);
  const sy = Math.round(from.y);
  if (!inBounds(grid, sx, sy)) return null;
  let goal: TilePos | null = { x: Math.round(to.x), y: Math.round(to.y) };
  if (!isWalkable(grid, goal.x, goal.y)) goal = nearestWalkable(grid, goal);
  if (!goal) return null;
  if (goal.x === sx && goal.y === sy) return [];

  const w = grid.width;
  const states = w * grid.height * 5;
  const gScore = new Float64Array(states).fill(Infinity);
  const parent = new Int32Array(states).fill(-1);
  const heap = new MinHeap();
  const h = (x: number, y: number): number => (Math.abs(x - goal.x) + Math.abs(y - goal.y)) * STEP;

  const start = (sy * w + sx) * 5 + NO_DIR;
  gScore[start] = 0;
  let seq = 0;
  heap.push({ f: h(sx, sy), h: h(sx, sy), seq: seq++, state: start });
  let expanded = 0;

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const idx = Math.floor(cur.state / 5);
    const dir = cur.state % 5;
    const g = gScore[cur.state]!;
    if (cur.f - cur.h > g) continue; // stale heap entry
    const x = idx % w;
    const y = Math.floor(idx / w);
    if (x === goal.x && y === goal.y) {
      const path: TilePos[] = [];
      let s = cur.state;
      while (s !== start && s !== -1) {
        const i = Math.floor(s / 5);
        path.push({ x: i % w, y: Math.floor(i / w) });
        s = parent[s]!;
      }
      return path.reverse();
    }
    if (++expanded > maxNodes) return null;

    for (let d = 0; d < 4; d++) {
      const [dx, dy] = DIRS[d]!;
      const nx = x + dx;
      const ny = y + dy;
      if (!isWalkable(grid, nx, ny)) continue;
      const ng = g + STEP + (dir !== NO_DIR && dir !== d ? TURN : 0);
      const ns = (ny * w + nx) * 5 + d;
      if (ng >= gScore[ns]!) continue;
      gScore[ns] = ng;
      parent[ns] = cur.state;
      const nh = h(nx, ny);
      heap.push({ f: ng + nh, h: nh, seq: seq++, state: ns });
    }
  }
  return null;
}

const CACHE_SIZE = 512;

/** Pathfinder bound to one layout, with a small LRU cache. Make a new one per layout. */
export function makePathfinder(
  layout: Pick<StationLayout, 'width' | 'height' | 'walkable'>,
): (from: TilePos, to: TilePos) => TilePos[] | null {
  const cache = new Map<string, TilePos[] | null>();
  const copy = (p: TilePos[] | null): TilePos[] | null => (p ? p.map((t) => ({ ...t })) : null);
  return (from, to) => {
    const key = `${Math.round(from.x)},${Math.round(from.y)}>${Math.round(to.x)},${Math.round(to.y)}`;
    if (cache.has(key)) {
      const hit = cache.get(key)!;
      cache.delete(key);
      cache.set(key, hit);
      return copy(hit);
    }
    const path = findPath(layout, from, to);
    cache.set(key, path);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return copy(path);
  };
}
