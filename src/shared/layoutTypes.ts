// Station layout contract. Computed by layout.ts (pure); drawn by the scene; walked by the director.
// All coordinates are in TILES (integer), origin top-left. Themes never compute layout.

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface TilePos {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FloorKind = 'center' | 'lounge' | 'zone' | 'corridor';

/** A place a crew sprite stands or sits, facing a direction. */
export interface Spot {
  id: string;
  tile: TilePos;
  facing: Dir;
}

export interface DeskSlot {
  id: string;
  /** Top-left tile of the desk prop (desk is DESK_W × DESK_H tiles). */
  desk: TilePos;
  /** Where the worker sits, facing the desk. */
  seat: Spot;
}

export interface Decor {
  /** Theme prop name, e.g. 'plant', 'sofa', 'coffee_machine', 'console'. Unknown names are skipped. */
  prop: string;
  tile: TilePos;
}

export interface ZoneLayout {
  projectId: string;
  name: string;
  /** Stable placement slot (project creation order). */
  slot: number;
  rect: Rect;
  nameplate: TilePos;
  /** Opening in the zone wall that paths go through. */
  door: TilePos;
  desks: DeskSlot[];
  decor: Decor[];
}

export interface CenterLayout {
  rect: Rect;
  /** Central command table prop footprint. */
  table: Rect;
  /** One per orchestrator (session), around the table. */
  tableSeats: Spot[];
  /** Where crew stand to report to the orchestrators, facing the table. */
  reportSpots: Spot[];
  lounge: Rect;
  loungeSpots: Spot[];
  /** Where extra crew "arrive" when the lounge pool is exhausted. */
  arrival: TilePos;
  decor: Decor[];
}

export interface StationLayout {
  /** Grid size in tiles. */
  width: number;
  height: number;
  /** Row-major, width*height. Floor kind per tile, or null for empty space / walls. */
  floor: (FloorKind | null)[];
  /** Row-major, width*height. true = a crew sprite can stand here. */
  walkable: boolean[];
  center: CenterLayout;
  zones: ZoneLayout[];
}

export interface LayoutInput {
  /** Projects in stable order (ProjectState.order ascending). */
  projects: { id: string; name: string; order: number; agentCount: number }[];
  /** Number of orchestrator seats needed (active sessions), min 1. */
  orchestratorSeats: number;
  /** Lounge pool size (settings, default 6). */
  loungeSize: number;
}

export const DESK_W = 2;
export const DESK_H = 1;
