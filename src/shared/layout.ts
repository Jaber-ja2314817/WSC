// Station layout: center (command table + lounge) with project zones around it in stable slots.
// Pure and deterministic. Coordinates are tiles; see layoutTypes.ts for the contract.
import { findPath } from './astar';
import {
  DESK_H,
  DESK_W,
  type CenterLayout,
  type Decor,
  type DeskSlot,
  type Dir,
  type FloorKind,
  type LayoutInput,
  type Rect,
  type Spot,
  type StationLayout,
  type TilePos,
  type ZoneLayout,
} from './layoutTypes';
import type { StationSnapshot } from './types';

// ---- Center geometry (local coords inside the center rect) ----
const CENTER_W = 22;
const TABLE_Y = 3;
const TABLE_H = 3;
const TABLE_MAX_W = 10;
const TABLE_X = Math.floor((CENTER_W - TABLE_MAX_W) / 2); // 6
const MAX_SEATS = 8;
/** Seat x offsets from TABLE_X per side, central first, so seats never move as the table grows. */
const SEAT_OFFSETS = [4, 6, 2, 8];
const LOUNGE_Y = 9;
const LOUNGE_PER_ROW = 8;

// ---- Zone geometry ----
const DESKS_PER_ROW = 4;
const DESK_PITCH_X = DESK_W + 1; // desk + aisle column
const DESK_PITCH_Y = 3; // desk row + seat row + aisle row
const FOOTPRINT_DESKS = 16;
const ZONE_GAP = 4; // corridor space between footprints
/** Footprint reserved per slot: room for 16 desks plus a nameplate row on top. */
const FP_W = 1 + DESKS_PER_ROW * DESK_PITCH_X; // 13
const FP_H = 1 + 1 + (FOOTPRINT_DESKS / DESKS_PER_ROW) * DESK_PITCH_Y; // 14
const MARGIN = 2;

/** Slot directions: N, E, S, W, NE, SE, SW, NW, then the same ring further out. */
const SLOT_DIRS: readonly [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];

/** Decor that crew can walk over. Everything else blocks its tile. */
const WALKABLE_DECOR = new Set(['rug']);

interface WorldZone {
  zone: ZoneLayout;
  dx: number;
  dy: number;
}

const overlaps = (a: Rect, b: Rect, pad = 0): boolean =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

const spot = (id: string, x: number, y: number, facing: Dir): Spot => ({
  id,
  tile: { x, y },
  facing,
});

function buildCenter(
  orchestratorSeats: number,
  loungeSize: number,
): { center: CenterLayout; w: number; h: number } {
  const seats = Math.min(MAX_SEATS, Math.max(1, Math.floor(orchestratorSeats)));
  const tableW = seats <= 4 ? 6 : TABLE_MAX_W;
  const table: Rect = {
    x: TABLE_X + (TABLE_MAX_W - tableW) / 2,
    y: TABLE_Y,
    w: tableW,
    h: TABLE_H,
  };

  const tableSeats: Spot[] = [];
  for (let i = 0; i < seats; i++) {
    const top = i % 2 === 0;
    const x = TABLE_X + SEAT_OFFSETS[Math.floor(i / 2)]!;
    tableSeats.push(
      spot(`seat:${i}`, x, top ? TABLE_Y - 1 : TABLE_Y + TABLE_H, top ? 'down' : 'up'),
    );
  }

  const below = TABLE_Y + TABLE_H + 1; // 7
  const above = TABLE_Y - 2; // 1
  const reportTiles: [number, number, Dir][] = [
    [11, below, 'up'],
    [9, below, 'up'],
    [13, below, 'up'],
    [11, above, 'down'],
    [9, above, 'down'],
    [13, above, 'down'],
    [TABLE_X - 2, TABLE_Y + 1, 'right'],
    [TABLE_X + TABLE_MAX_W + 1, TABLE_Y + 1, 'left'],
    [7, below, 'up'],
    [15, below, 'up'],
    [7, above, 'down'],
    [15, above, 'down'],
  ];
  const reportSpots = reportTiles.map(([x, y, f], i) => spot(`report:${i}`, x, y, f));

  const loungeCount = Math.max(6, Math.floor(loungeSize) || 0);
  const rows = Math.ceil(loungeCount / LOUNGE_PER_ROW);
  const loungeH = 1 + rows * 3;
  const h = LOUNGE_Y + loungeH + 1;
  const lounge: Rect = { x: 2, y: LOUNGE_Y, w: CENTER_W - 4, h: loungeH };

  const decor: Decor[] = [];
  const loungeSpots: Spot[] = [];
  for (let i = 0; i < loungeCount; i++) {
    const r = Math.floor(i / LOUNGE_PER_ROW);
    const k = i % LOUNGE_PER_ROW;
    const x = 4 + k * 2;
    const sofaY = LOUNGE_Y + 1 + r * 3;
    loungeSpots.push(spot(`lounge:${i}`, x, sofaY + 1, 'down'));
    decor.push({ prop: 'sofa', tile: { x, y: sofaY } });
  }
  decor.push(
    { prop: 'plant', tile: { x: 0, y: 0 } },
    { prop: 'plant', tile: { x: CENTER_W - 1, y: 0 } },
    { prop: 'plant', tile: { x: CENTER_W - 1, y: h - 1 } },
    { prop: 'console', tile: { x: 1, y: TABLE_Y + 1 } },
    { prop: 'bookshelf', tile: { x: CENTER_W - 2, y: TABLE_Y + 1 } },
    { prop: 'lamp', tile: { x: lounge.x, y: LOUNGE_Y + 1 } },
    { prop: 'coffee_machine', tile: { x: lounge.x + lounge.w - 1, y: LOUNGE_Y + 1 } },
    { prop: 'rug', tile: { x: 11, y: LOUNGE_Y + loungeH - 1 } },
  );

  return {
    center: {
      rect: { x: 0, y: 0, w: CENTER_W, h },
      table,
      tableSeats,
      reportSpots,
      lounge,
      loungeSpots,
      arrival: { x: 0, y: h - 1 },
      decor,
    },
    w: CENTER_W,
    h,
  };
}

/** Footprint (incl. nameplate row) for a slot, in world coords relative to the center rect. */
function footprint(slot: number, c: Rect): { fp: Rect; dx: number; dy: number } {
  const ring = Math.floor(slot / SLOT_DIRS.length);
  const [dx, dy] = SLOT_DIRS[slot % SLOT_DIRS.length]!;
  const step = (n: number): number => ring * (n + ZONE_GAP);
  const cx = c.x + Math.floor(c.w / 2);
  const cy = c.y + Math.floor(c.h / 2);
  const x =
    dx > 0
      ? c.x + c.w + ZONE_GAP + step(FP_W)
      : dx < 0
        ? c.x - ZONE_GAP - FP_W - step(FP_W)
        : cx - Math.floor(FP_W / 2);
  const y =
    dy > 0
      ? c.y + c.h + ZONE_GAP + step(FP_H)
      : dy < 0
        ? c.y - ZONE_GAP - FP_H - step(FP_H)
        : cy - Math.floor(FP_H / 2);
  return { fp: { x, y, w: FP_W, h: FP_H }, dx, dy };
}

function buildZone(
  p: { id: string; name: string; agentCount: number },
  slot: number,
  centerRect: Rect,
): WorldZone {
  const desksN = Math.max(4, Math.ceil(Math.max(0, p.agentCount || 0) / 4) * 4);
  const { fp, dx, dy } = footprint(slot, centerRect);
  // Up to 16 desks: 4 per row. Beyond that, grow outward: E/W zones add columns, others rows.
  const sideways = dy === 0 && desksN > FOOTPRINT_DESKS;
  const cols = sideways ? Math.ceil(desksN / DESKS_PER_ROW) : DESKS_PER_ROW;
  const rows = sideways ? DESKS_PER_ROW : Math.ceil(desksN / DESKS_PER_ROW);
  const w = 1 + cols * DESK_PITCH_X;
  const h = 1 + rows * DESK_PITCH_Y;

  // Anchor the side facing the center; extra size extends outward.
  const x = dx > 0 ? fp.x : dx < 0 ? fp.x + fp.w - w : fp.x + Math.floor((fp.w - w) / 2);
  const y =
    dy > 0 ? fp.y + 1 : dy < 0 ? fp.y + fp.h - h : fp.y + 1 + Math.floor((fp.h - 1 - h) / 2);

  const door: TilePos =
    dy < 0
      ? { x: x + Math.floor(w / 2), y: y + h - 1 }
      : dy > 0
        ? { x: x + Math.floor(w / 2), y }
        : dx > 0
          ? { x, y: y + Math.floor(h / 2) }
          : { x: x + w - 1, y: y + Math.floor(h / 2) };

  const desks: DeskSlot[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (desks.length >= desksN) break;
      const deskX = x + 1 + c * DESK_PITCH_X;
      const deskY = y + 1 + r * DESK_PITCH_Y;
      desks.push({
        id: '',
        desk: { x: deskX, y: deskY },
        seat: spot('', deskX, deskY + DESK_H, 'up'),
      });
    }
  }
  // Fill desks nearest the door first (stable tie-break by grid order).
  const dist = (d: DeskSlot): number =>
    Math.abs(d.seat.tile.x - door.x) + Math.abs(d.seat.tile.y - door.y);
  const ordered = desks
    .map((d, i) => ({ d, i }))
    .sort((a, b) => dist(a.d) - dist(b.d) || a.i - b.i)
    .map(({ d }, i) => {
      const id = `${p.id}:desk:${i}`;
      return { id, desk: d.desk, seat: { ...d.seat, id: `${id}:seat` } };
    });

  return {
    dx,
    dy,
    zone: {
      projectId: p.id,
      name: p.name,
      slot,
      rect: { x, y, w, h },
      nameplate: { x: x + Math.floor(w / 2), y: y - 1 },
      door,
      desks: ordered,
      decor: [
        { prop: 'plant', tile: { x, y } },
        { prop: 'plant', tile: { x: x + w - 1, y } },
      ],
    },
  };
}

function shiftZone(z: ZoneLayout, dx: number, dy: number): void {
  const mv = (t: TilePos): void => {
    t.x += dx;
    t.y += dy;
  };
  z.rect.x += dx;
  z.rect.y += dy;
  mv(z.nameplate);
  mv(z.door);
  for (const d of z.desks) {
    mv(d.desk);
    mv(d.seat.tile);
  }
  for (const d of z.decor) mv(d.tile);
}

/** Zone rect including its nameplate row, for overlap checks. */
const zoneBox = (z: ZoneLayout): Rect => ({
  x: z.rect.x,
  y: z.rect.y - 1,
  w: z.rect.w,
  h: z.rect.h + 1,
});

/**
 * Only the facts that change the layout; anything else must not trigger a rebuild.
 * A zone counts only crew that still need a seat: finished agents stay in the snapshot but have
 * left their desks, so they never add space while free seats remain.
 */
export function layoutInputFor(snap: StationSnapshot, loungeSize: number): LayoutInput {
  const agentCount = new Map<string, number>();
  for (const a of Object.values(snap.agents)) {
    if (a.isOrchestrator || a.status === 'done') continue;
    agentCount.set(a.projectId, (agentCount.get(a.projectId) ?? 0) + 1);
  }
  const projects = Object.values(snap.projects)
    .sort((a, b) => a.order - b.order)
    .map((p) => ({
      id: p.id,
      name: p.name,
      order: p.order,
      agentCount: agentCount.get(p.id) ?? 0,
    }));
  const active = Object.values(snap.sessions).filter((s) => s.endedAt === undefined).length;
  return { projects, orchestratorSeats: Math.max(1, active), loungeSize };
}

export function computeLayout(input: LayoutInput): StationLayout {
  const { center, w: cw, h: ch } = buildCenter(input.orchestratorSeats, input.loungeSize);
  // World coords: center rect at the origin; translated at the end.
  const centerRect: Rect = { x: -Math.floor(cw / 2), y: -Math.floor(ch / 2), w: cw, h: ch };

  const projects = [...input.projects].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const placed: WorldZone[] = [];
  projects.forEach((p, slot) => {
    const wz = buildZone(p, slot, centerRect);
    // Earlier slots win; a grown zone pushes later ones outward (never the reverse).
    const blockers = [centerRect, ...placed.map((q) => zoneBox(q.zone))];
    let guard = 0;
    while (blockers.some((b) => overlaps(zoneBox(wz.zone), b, 1)) && guard++ < 500) {
      shiftZone(wz.zone, wz.dx, wz.dy);
    }
    placed.push(wz);
  });
  const zones = placed.map((p) => p.zone);

  // Bounds → translate so everything sits inside a MARGIN border.
  const boxes = [centerRect, ...zones.map(zoneBox)];
  const minX = Math.min(...boxes.map((b) => b.x)) - MARGIN;
  const minY = Math.min(...boxes.map((b) => b.y)) - MARGIN;
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + MARGIN;
  const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + MARGIN;
  const width = maxX - minX;
  const height = maxY - minY;
  const ox = centerRect.x - minX;
  const oy = centerRect.y - minY;
  for (const z of zones) shiftZone(z, -minX, -minY);
  translateCenter(center, ox, oy);

  const floor: (FloorKind | null)[] = new Array<FloorKind | null>(width * height).fill(null);
  const blocked = new Array<boolean>(width * height).fill(false);
  const at = (x: number, y: number): number => y * width + x;
  const fillRect = (r: Rect, kind: FloorKind): void => {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) floor[at(x, y)] = kind;
  };
  const block = (r: Rect): void => {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) blocked[at(x, y)] = true;
  };
  const blockDecor = (d: Decor): void => {
    if (!WALKABLE_DECOR.has(d.prop)) blocked[at(d.tile.x, d.tile.y)] = true;
  };

  fillRect(center.rect, 'center');
  fillRect(center.lounge, 'lounge');
  block(center.table);
  center.decor.forEach(blockDecor);
  for (const z of zones) {
    fillRect(z.rect, 'zone');
    for (const d of z.desks) block({ x: d.desk.x, y: d.desk.y, w: DESK_W, h: DESK_H });
    z.decor.forEach(blockDecor);
  }

  const walkableNow = (): boolean[] => floor.map((f, i) => f !== null && !blocked[i]);

  // Corridors: route each door to the center through empty space (never through other zones).
  for (const [i, z] of zones.entries()) {
    const { dx, dy } = placed[i]!;
    const out: TilePos =
      dy < 0
        ? { x: z.door.x, y: z.door.y + 1 }
        : dy > 0
          ? { x: z.door.x, y: z.door.y - 1 }
          : { x: z.door.x - dx, y: z.door.y };
    const walk = walkableNow();
    const routeGrid = {
      width,
      height,
      walkable: floor.map(
        (f, idx) => f === null || f === 'corridor' || (f === 'center' && walk[idx] === true),
      ),
    };
    // Aim at the nearest point of the center rect, then let A* finish inside the center.
    const target: TilePos = {
      x: Math.min(Math.max(out.x, center.rect.x + 1), center.rect.x + center.rect.w - 2),
      y: Math.min(Math.max(out.y, center.rect.y + 1), center.rect.y + center.rect.h - 2),
    };
    const path = findPath(routeGrid, out, target, { maxNodes: 200_000 }) ?? [];
    for (const t of [out, ...path]) {
      if (floor[at(t.x, t.y)] === null) floor[at(t.x, t.y)] = 'corridor';
    }
  }

  return { width, height, floor, walkable: walkableNow(), center, zones };
}

function translateCenter(c: CenterLayout, ox: number, oy: number): void {
  const mv = (t: TilePos): void => {
    t.x += ox;
    t.y += oy;
  };
  const mvRect = (r: Rect): void => {
    r.x += ox;
    r.y += oy;
  };
  mvRect(c.rect);
  mvRect(c.table);
  mvRect(c.lounge);
  mv(c.arrival);
  for (const s of [...c.tableSeats, ...c.reportSpots, ...c.loungeSpots]) mv(s.tile);
  for (const d of c.decor) mv(d.tile);
}
