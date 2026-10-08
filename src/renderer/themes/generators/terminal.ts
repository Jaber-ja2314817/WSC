// Terminal art generator — minimal, high-contrast phosphor glyph art (no DOM).
// Everything is drawn as pixel "glyphs" in a 4-color palette so the theme stays readable,
// low-resource and calm; it has no backdrop and only 1–2 frame idle animations via crew.ts.
// See ./types.ts for prop conventions.
import type { FloorKind } from '@shared/layoutTypes';
import type { ToolCategory } from '@shared/types';
import type { CrewStyle } from '../crew';
import { PixelBuffer, hex, type RGBA } from '../pixelBuffer';
import type { ArtGenerator, GeneratedArt } from './types';

const T = 16;

/** Phosphor palette: black, dim, mid, bright — plus amber/red for attention glyphs. */
export const TERMINAL_COLORS = {
  black: '#020a05',
  dim: '#0f3b1f',
  mid: '#2fae5a',
  bright: '#9bffb8',
  amber: '#ffd23f',
  red: '#ff5c5c',
} as const;

const C = {
  black: hex(TERMINAL_COLORS.black),
  floor: hex('#041208'),
  dim: hex(TERMINAL_COLORS.dim),
  mid: hex(TERMINAL_COLORS.mid),
  bright: hex(TERMINAL_COLORS.bright),
  amber: hex(TERMINAL_COLORS.amber),
  red: hex(TERMINAL_COLORS.red),
};

const buf = (w: number, h: number): PixelBuffer => new PixelBuffer(w, h);

/** Stamp a glyph bitmap ('#' = pixel) at (x, y). */
function glyph(b: PixelBuffer, rows: readonly string[], x: number, y: number, c: RGBA): void {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) if (row[dx] === '#') b.set(x + dx, y + dy, c);
  });
}

// ---------- floors: quiet dot grids, one pattern per area ----------

function floorTile(kind: FloorKind, v: number): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.floor);
  switch (kind) {
    case 'center': // ':' grid — the core
      for (const y of [3, 11]) for (const x of [3, 11]) b.set(x, y, C.dim).set(x, y + 2, C.dim);
      if (v === 1) b.set(7, 7, C.dim);
      break;
    case 'lounge': // '~' soft pattern — the idle pool
      for (const y of [4, 12])
        b.set(2, y, C.dim)
          .set(3, y - 1, C.dim)
          .set(4, y, C.dim);
      if (v === 1) b.set(10, 8, C.dim).set(11, 7, C.dim).set(12, 8, C.dim);
      break;
    case 'zone': // '.' grid — process space
      for (const y of [4, 12]) for (const x of [4, 12]) b.set(x, y, C.dim);
      if (v === 1) b.set(8, 8, C.dim);
      break;
    case 'corridor': // '-' dashes — pipes between processes
      b.line(2, 8, 5, 8, C.dim).line(10, 8, 13, 8, C.dim);
      if (v === 1) b.set(8, 8, C.dim);
      break;
  }
  return b;
}

// ---------- walls: box-drawing double lines ----------

function wall(): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.black);
  // '╬'-ish double rule: reads as a wall from any side when tiled.
  b.line(0, 5, 15, 5, C.mid).line(0, 10, 15, 10, C.mid);
  b.line(5, 0, 5, 4, C.dim).line(10, 0, 10, 4, C.dim);
  b.line(5, 11, 5, 15, C.dim).line(10, 11, 10, 15, C.dim);
  return b;
}

// ---------- props ----------

/** 48×48 nine-slice: a double-line box with '+' corners and a blinking-cursor feel inside. */
function commandTable(): PixelBuffer {
  const b = buf(48, 48).fillRect(0, 0, 48, 48, C.black);
  b.strokeRect(1, 1, 46, 46, C.bright).strokeRect(4, 4, 40, 40, C.mid);
  for (const [x, y] of [
    [1, 1],
    [46, 1],
    [1, 46],
    [46, 46],
  ] as const) {
    glyph(b, ['.#.', '###', '.#.'], x - 1, y - 1, C.bright);
  }
  // Prompt line in the stretchable middle.
  glyph(b, ['#..', '.#.', '#..'], 18, 22, C.bright);
  b.fillRect(23, 24, 5, 1, C.mid);
  return b;
}

/** '[__]' desk: 32×16, two tiles wide. */
function desk(): PixelBuffer {
  const b = buf(32, 16);
  glyph(b, ['###', '#..', '#..', '#..', '#..', '###'], 2, 6, C.mid);
  glyph(b, ['###', '..#', '..#', '..#', '..#', '###'], 27, 6, C.mid);
  b.line(7, 11, 24, 11, C.bright);
  b.fillRect(10, 2, 12, 6, C.black).strokeRect(10, 2, 12, 6, C.mid);
  b.line(12, 4, 15, 4, C.bright);
  return b;
}

function chair(): PixelBuffer {
  const b = buf(T, T);
  glyph(b, ['#...#', '#...#', '#####', '#...#'], 5, 7, C.mid);
  return b;
}

/** '[====]' bench: 16×16. */
function loungeSeat(): PixelBuffer {
  const b = buf(T, T);
  glyph(b, ['##', '#.', '##'], 1, 8, C.mid);
  glyph(b, ['##', '.#', '##'], 13, 8, C.mid);
  b.line(3, 9, 12, 9, C.bright);
  return b;
}

function sofa(): PixelBuffer {
  const b = buf(32, 16);
  glyph(b, ['##', '#.', '#.', '##'], 1, 7, C.mid);
  glyph(b, ['##', '.#', '.#', '##'], 29, 7, C.mid);
  b.line(3, 8, 28, 8, C.mid).line(3, 10, 28, 10, C.bright);
  return b;
}

function nameplate(): PixelBuffer {
  const b = buf(T, 8).fillRect(0, 0, T, 8, C.black);
  b.strokeRect(0, 0, T, 8, C.mid);
  glyph(b, ['#..', '.#.', '#..'], 3, 2, C.bright);
  b.line(7, 6, 11, 6, C.bright);
  return b;
}

function door(): PixelBuffer {
  const b = buf(T, T);
  b.line(2, 0, 2, 15, C.mid).line(13, 0, 13, 15, C.mid);
  for (let y = 1; y < 15; y += 3) b.set(7, y, C.dim).set(8, y, C.dim);
  return b;
}

/** '♣' */
function plant(): PixelBuffer {
  const b = buf(T, T);
  glyph(
    b,
    ['...###...', '...###...', '###.#.###', '#########', '###.#.###', '....#....', '...###...'],
    3,
    5,
    C.mid,
  );
  b.set(7, 6, C.bright);
  return b;
}

/** '[c]' coffee. */
function coffee(): PixelBuffer {
  const b = buf(T, 20);
  glyph(b, ['##', '#.', '#.', '#.', '##'], 2, 10, C.mid);
  glyph(b, ['##', '.#', '.#', '.#', '##'], 12, 10, C.mid);
  glyph(b, ['###', '#..', '###'], 6, 11, C.bright);
  b.set(7, 6, C.dim).set(8, 4, C.dim).set(7, 2, C.dim); // steam
  return b;
}

/** '>_' console. */
function consoleProp(): PixelBuffer {
  const b = buf(T, 20).fillRect(1, 5, 14, 12, C.black);
  b.strokeRect(1, 5, 14, 12, C.mid);
  glyph(b, ['#..', '.#.', '#..'], 3, 8, C.bright);
  b.line(7, 12, 11, 12, C.bright);
  return b;
}

function rug(): PixelBuffer {
  const b = buf(32, 16);
  for (let x = 2; x < 30; x += 2) b.set(x, 4, C.dim).set(x + 1, 11, C.dim);
  return b;
}

/** '*' lamp. */
function lamp(): PixelBuffer {
  const b = buf(T, 24);
  glyph(b, ['#.#.#', '.###.', '#####', '.###.', '#.#.#'], 5, 2, C.amber);
  b.line(7, 7, 7, 21, C.mid).line(5, 22, 9, 22, C.mid);
  return b;
}

/** '≡' shelf. */
function bookshelf(): PixelBuffer {
  const b = buf(T, 24);
  b.strokeRect(2, 2, 12, 20, C.mid);
  for (const y of [7, 12, 17]) b.line(4, y, 11, y, C.bright);
  return b;
}

/** '#' crate. */
function crate(): PixelBuffer {
  const b = buf(T, T);
  glyph(b, ['.#..#.', '######', '.#..#.', '######', '.#..#.'], 5, 6, C.mid);
  return b;
}

// ---------- gear: one glyph per tool category ----------

const GEAR_GLYPHS: Record<ToolCategory, { rows: readonly string[]; color: RGBA }> = {
  read: { rows: ['#####', '.....', '#####', '.....', '#####'], color: C.bright }, // ≡
  search: { rows: ['.###.', '#...#', '...#.', '..#..', '.....', '..#..'], color: C.bright }, // ?
  write: { rows: ['....#', '...#.', '..#..', '.#...', '#....', '#####'], color: C.bright }, // ✎-ish
  execute: { rows: ['#....', '.#...', '..#..', '.#...', '#.###'], color: C.bright }, // >_
  web: { rows: ['.###.', '#...#', '#.###', '#.#.#', '#.###', '.#...'], color: C.bright }, // @
  delegate: { rows: ['...#.', '....#', '#####', '....#', '...#.'], color: C.bright }, // →
  plan: { rows: ['.#.#.', '#####', '.#.#.', '#####', '.#.#.'], color: C.bright }, // #
  mcp: { rows: ['..#..', '..#..', '#####', '..#..', '..#..'], color: C.bright }, // +
  other: { rows: ['#.#.#', '.###.', '#####', '.###.', '#.#.#'], color: C.mid }, // *
};

function gearIcon(cat: ToolCategory): PixelBuffer {
  const b = buf(T, T).fillRect(2, 2, 12, 12, C.black);
  b.strokeRect(2, 2, 12, 12, C.dim);
  const g = GEAR_GLYPHS[cat] ?? GEAR_GLYPHS.other;
  const h = g.rows.length;
  glyph(b, g.rows, 6, Math.floor((T - h) / 2), g.color);
  return b;
}

// ---------- generator ----------

export const TERMINAL_CREW: CrewStyle = {
  uniform: 'mono',
  outfits: [],
  mono: [TERMINAL_COLORS.dim, TERMINAL_COLORS.mid, TERMINAL_COLORS.bright],
  outline: TERMINAL_COLORS.black,
  icons: {
    error: TERMINAL_COLORS.red,
    wait: TERMINAL_COLORS.amber,
    think: TERMINAL_COLORS.bright,
    comms: TERMINAL_COLORS.bright,
    celebrate: TERMINAL_COLORS.amber,
  },
};

const FLOOR_KINDS: readonly FloorKind[] = ['center', 'lounge', 'zone', 'corridor'];
const CATEGORIES: readonly ToolCategory[] = [
  'read',
  'search',
  'write',
  'execute',
  'web',
  'delegate',
  'plan',
  'mcp',
  'other',
];

export const terminalGenerator: ArtGenerator = (manifest) => {
  const floors = Object.fromEntries(
    FLOOR_KINDS.map((k) => [k, [0, 1].map((v) => floorTile(k, v))]),
  ) as Record<FloorKind, PixelBuffer[]>;
  const gear = Object.fromEntries(CATEGORIES.map((c) => [c, gearIcon(c)])) as Record<
    ToolCategory,
    PixelBuffer
  >;
  const art: GeneratedArt = {
    tileSize: manifest.tileSize,
    crewStyle: TERMINAL_CREW,
    crewVariants: 8,
    floors,
    wall: wall(),
    props: {
      command_table: commandTable(),
      desk: desk(),
      chair: chair(),
      lounge_seat: loungeSeat(),
      nameplate: nameplate(),
      door: door(),
      plant: plant(),
      sofa: sofa(),
      coffee_machine: coffee(),
      console: consoleProp(),
      rug: rug(),
      lamp: lamp(),
      bookshelf: bookshelf(),
      crate: crate(),
    },
    gear,
  };
  // No backdrop: plain black keeps it low-resource and calm.
  return art;
};
