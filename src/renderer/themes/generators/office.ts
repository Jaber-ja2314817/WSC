// Office art generator — pure pixel drawing (no DOM). See ./types.ts for prop conventions.
// A cozy pixel office: wooden meeting table, break room with couches and a coffee machine,
// desk pods with monitors and plants.
import type { FloorKind } from '@shared/layoutTypes';
import type { ToolCategory } from '@shared/types';
import type { CrewStyle } from '../crew';
import { PixelBuffer, hash2, hex, mix, shade } from '../pixelBuffer';
import type { ArtGenerator, GeneratedArt } from './types';

const T = 16;

const C = {
  outline: hex('#2a1d17'),
  // floors
  meetCarpet: hex('#7a3f3a'),
  meetCarpetDot: hex('#8c4b44'),
  meetCarpetLo: hex('#6a3532'),
  breakTile: hex('#e8dcc4'),
  breakTileAlt: hex('#d7c7a8'),
  breakGrout: hex('#bfae8e'),
  officeCarpet: hex('#4f6b6a'),
  officeCarpetHi: hex('#5c7a78'),
  officeCarpetLo: hex('#435c5b'),
  hallTile: hex('#cbb894'),
  hallTileLo: hex('#b39f7b'),
  hallLine: hex('#9c8865'),
  // walls
  drywall: hex('#efe4cf'),
  drywallLo: hex('#d8c9ac'),
  baseboard: hex('#8a5a3c'),
  windowSky: hex('#9fd4e8'),
  windowSkyHi: hex('#c9ecf5'),
  blinds: hex('#f7f1e3'),
  frame: hex('#7a5236'),
  // wood + furniture
  wood: hex('#a56a3f'),
  woodHi: hex('#c4864f'),
  woodLo: hex('#7a4a2b'),
  woodDark: hex('#5c3720'),
  fabric: hex('#2f8f8a'),
  fabricHi: hex('#45aca6'),
  fabricLo: hex('#226c68'),
  mustard: hex('#d9a441'),
  mustardHi: hex('#ecbf5e'),
  mustardLo: hex('#b0832f'),
  metal: hex('#8c929c'),
  metalHi: hex('#b6bcc6'),
  metalLo: hex('#5c626c'),
  dark: hex('#2b2e36'),
  screen: hex('#1f3b4d'),
  screenHi: hex('#62c6d6'),
  paper: hex('#fbf7ec'),
  ink: hex('#4a4f5a'),
  red: hex('#d9534f'),
  green: hex('#5cb85c'),
  amber: hex('#f0ad4e'),
  teal: hex('#2bb0a6'),
  leaf: hex('#4caf50'),
  leafHi: hex('#7bcf6a'),
  leafDk: hex('#2e7d32'),
  pot: hex('#c8643b'),
  potLo: hex('#9c4a2a'),
  coffee: hex('#5a3a28'),
  white: hex('#ffffff'),
  lampShade: hex('#f6e7b5'),
  lampGlow: hex('#fff6d6'),
};

const buf = (w: number, h: number): PixelBuffer => new PixelBuffer(w, h);

// ---------- floors ----------

/** Meeting-room carpet: warm burgundy with a small diamond weave. */
function meetingCarpet(v: number): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.meetCarpet);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const d = (x + y) % 8;
      const e = (x - y + 16) % 8;
      if (d === 0 || e === 0) b.set(x, y, C.meetCarpetDot);
    }
  if (v === 1) b.set(4, 4, C.meetCarpetLo).set(11, 11, C.meetCarpetLo);
  if (v === 2) b.set(8, 3, C.meetCarpetLo).set(3, 9, C.meetCarpetLo);
  return b;
}

/** Break-room checker tiles (cream and sand). */
function breakTile(v: number): PixelBuffer {
  const b = buf(T, T);
  b.fillRect(0, 0, 8, 8, C.breakTile).fillRect(8, 8, 8, 8, C.breakTile);
  b.fillRect(8, 0, 8, 8, C.breakTileAlt).fillRect(0, 8, 8, 8, C.breakTileAlt);
  b.line(0, 0, 15, 0, C.breakGrout).line(0, 0, 0, 15, C.breakGrout);
  b.line(0, 8, 15, 8, C.breakGrout).line(8, 0, 8, 15, C.breakGrout);
  if (v === 1) b.set(3, 4, shade(C.breakTile, 0.94)).set(12, 11, shade(C.breakTile, 0.94));
  if (v === 2) b.set(11, 3, C.breakGrout);
  return b;
}

/** Office carpet tiles: teal-grey squares, alternating grain. */
function officeCarpet(v: number): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.officeCarpet);
  const horizontal = v % 2 === 0;
  for (let i = 1; i < T; i += 3) {
    if (horizontal) b.line(1, i, 14, i, C.officeCarpetHi);
    else b.line(i, 1, i, 14, C.officeCarpetHi);
  }
  b.line(0, 0, 15, 0, C.officeCarpetLo).line(0, 0, 0, 15, C.officeCarpetLo);
  if (v === 3) b.set(6, 9, C.officeCarpetLo).set(7, 9, C.officeCarpetLo);
  return b;
}

/** Hallway: long sandy linoleum planks. */
function hallTile(v: number): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.hallTile);
  b.line(0, 0, 15, 0, C.hallLine).line(0, 8, 15, 8, C.hallLine);
  const seam = v === 1 ? 4 : 11;
  b.line(seam, 1, seam, 7, C.hallTileLo).line(
    (seam + 8) % 16,
    9,
    (seam + 8) % 16,
    15,
    C.hallTileLo,
  );
  if (v === 1) b.set(13, 4, C.hallTileLo);
  return b;
}

// ---------- wall ----------

/** Drywall with a window and half-drawn blinds, wooden baseboard. */
function officeWall(): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.drywall);
  b.fillRect(0, 0, T, 1, C.drywallLo).fillRect(0, 13, T, 3, C.baseboard);
  b.line(0, 13, 15, 13, shade(C.baseboard, 1.2));
  // window
  b.fillRect(3, 2, 10, 9, C.frame).fillRect(4, 3, 8, 7, C.windowSky);
  b.set(5, 8, C.windowSkyHi).set(6, 7, C.windowSkyHi).set(10, 4, C.windowSkyHi);
  for (let y = 3; y < 7; y += 1) if (y % 2 === 1) b.line(4, y, 11, y, C.blinds);
  b.line(8, 3, 8, 9, C.frame);
  return b;
}

// ---------- props ----------

/** 48×48 nine-slice long wooden meeting table (16 px borders). */
function meetingTable(): PixelBuffer {
  const b = buf(48, 48).fillRect(0, 0, 48, 48, C.wood);
  b.strokeRect(0, 0, 48, 48, C.outline).strokeRect(1, 1, 46, 46, C.woodHi);
  // wood grain in the stretchable middle stays horizontal
  for (let y = 4; y < 44; y += 3) {
    for (let x = 3; x < 45; x++) if (hash2(x >> 2, y, 11) > 0.45) b.set(x, y, C.woodLo);
  }
  // inlay border
  b.strokeRect(5, 5, 38, 38, C.woodLo).strokeRect(6, 6, 36, 36, shade(C.wood, 1.08));
  // a few papers and a laptop near the corners (kept inside the borders so they don't stretch)
  b.fillRect(7, 8, 6, 5, C.paper).line(8, 9, 11, 9, C.ink).line(8, 11, 10, 11, C.ink);
  b.fillRect(35, 34, 7, 5, C.metalLo).fillRect(36, 35, 5, 3, C.screen).set(38, 36, C.screenHi);
  b.disc(38, 9, 2, C.white).set(38, 9, C.coffee);
  // front edge
  b.fillRect(2, 44, 44, 3, C.woodLo).line(2, 44, 45, 44, C.woodDark);
  return b;
}

/** 32×24 desk with a monitor (2×1 footprint, extends 8 px up). */
function officeDesk(): PixelBuffer {
  const b = buf(32, 24);
  // monitor + stand
  b.fillRect(9, 0, 14, 10, C.dark).fillRect(10, 1, 12, 7, C.screen);
  b.line(11, 3, 17, 3, C.screenHi).line(11, 5, 15, 5, mix(C.screen, C.screenHi, 0.5));
  b.fillRect(15, 10, 2, 2, C.metalLo);
  // little plant + mug
  b.fillRect(2, 6, 3, 4, C.pot).disc(3, 4, 2, C.leaf).set(3, 3, C.leafHi);
  b.fillRect(26, 7, 3, 3, C.white).set(29, 8, C.white).set(27, 7, C.coffee);
  // desktop
  b.fillRect(0, 10, 32, 5, C.woodHi).line(0, 10, 31, 10, shade(C.woodHi, 1.12));
  b.fillRect(10, 12, 12, 2, C.metalHi).line(11, 12, 20, 12, C.white);
  // front panel + drawers
  b.fillRect(0, 15, 32, 9, C.wood).line(0, 15, 31, 15, C.woodLo);
  b.strokeRect(22, 16, 9, 7, C.woodLo).line(25, 19, 27, 19, C.woodDark);
  b.strokeRect(0, 10, 32, 14, C.outline);
  return b;
}

/** Rolling office chair (back toward the viewer). */
function officeChair(): PixelBuffer {
  const b = buf(T, T);
  b.fillRect(4, 1, 8, 7, C.dark).fillRect(5, 2, 6, 5, shade(C.dark, 1.3));
  b.fillRect(3, 8, 10, 3, C.dark).fillRect(7, 11, 2, 2, C.metalLo);
  b.line(3, 14, 12, 14, C.metal).set(3, 15, C.dark).set(12, 15, C.dark).set(8, 15, C.dark);
  return b.outline(C.outline);
}

/** One-seat couch cushion (lounge seat). */
function couchSeat(): PixelBuffer {
  const b = buf(T, T);
  b.fillRect(1, 3, 14, 5, C.mustard).fillRect(1, 3, 14, 1, C.mustardHi);
  b.fillRect(1, 8, 14, 4, C.mustardLo).line(2, 8, 13, 8, C.mustard);
  b.fillRect(0, 5, 2, 8, C.mustardHi).fillRect(14, 5, 2, 8, C.mustardHi);
  b.fillRect(2, 12, 2, 3, C.woodDark).fillRect(12, 12, 2, 3, C.woodDark);
  return b.outline(C.outline);
}

/** 32×16 teal sofa with throw pillows. */
function officeSofa(): PixelBuffer {
  const b = buf(32, T);
  b.fillRect(1, 2, 30, 6, C.fabric).fillRect(1, 2, 30, 1, C.fabricHi);
  b.fillRect(1, 8, 30, 5, C.fabricLo).line(16, 8, 16, 12, shade(C.fabricLo, 0.8));
  b.fillRect(0, 4, 3, 10, C.fabricHi).fillRect(29, 4, 3, 10, C.fabricHi);
  // pillows
  b.fillRect(4, 4, 5, 4, C.mustard).set(4, 4, C.mustardHi);
  b.fillRect(23, 4, 5, 4, hex('#e07a5f')).set(23, 4, hex('#f0a08a'));
  b.fillRect(2, 13, 2, 2, C.woodDark).fillRect(28, 13, 2, 2, C.woodDark);
  return b.outline(C.outline);
}

function officeNameplate(): PixelBuffer {
  const b = buf(32, 10).fillRect(0, 0, 32, 10, C.woodLo);
  b.strokeRect(0, 0, 32, 10, C.woodDark).fillRect(2, 2, 28, 6, hex('#d9c08a'));
  b.strokeRect(2, 2, 28, 6, hex('#b8995c'));
  b.set(1, 1, C.mustardHi).set(30, 1, C.mustardHi).set(1, 8, C.mustardHi).set(30, 8, C.mustardHi);
  return b;
}

/** Wooden door with a frosted glass panel. */
function officeDoor(): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.frame);
  b.fillRect(2, 0, 12, T, C.wood).strokeRect(2, 0, 12, T, C.woodDark);
  b.fillRect(4, 2, 8, 6, mix(C.windowSky, C.white, 0.5)).strokeRect(4, 2, 8, 6, C.woodLo);
  b.set(11, 10, C.mustardHi).set(11, 11, C.mustardLo);
  b.fillRect(4, 10, 5, 4, shade(C.wood, 0.9));
  return b;
}

/** Potted fiddle-leaf fig. */
function fiddleLeaf(): PixelBuffer {
  const b = buf(T, 24);
  b.fillRect(4, 17, 8, 6, C.pot).fillRect(3, 16, 10, 2, shade(C.pot, 1.15));
  b.fillRect(4, 22, 8, 2, C.potLo);
  b.line(8, 16, 8, 6, C.woodDark);
  for (const [x, y, r] of [
    [8, 4, 2],
    [5, 7, 2],
    [11, 7, 2],
    [5, 11, 2],
    [11, 11, 2],
    [8, 9, 2],
    [7, 14, 1],
  ] as const) {
    b.disc(x, y, r, C.leaf)
      .set(x, y - 1, C.leafHi)
      .set(x, y + 1, C.leafDk);
  }
  return b.outline(C.outline);
}

/** Coffee machine with a carafe and a glowing ready light. */
function coffeeMachine(): PixelBuffer {
  const b = buf(T, 24).fillRect(2, 2, 12, 20, C.dark);
  b.fillRect(2, 2, 12, 3, shade(C.dark, 1.4)).fillRect(4, 6, 8, 3, C.metalLo);
  b.set(5, 7, C.green).set(7, 7, C.red);
  // drip area + carafe
  b.fillRect(4, 11, 8, 8, C.metalLo).fillRect(5, 14, 6, 5, mix(C.white, C.windowSky, 0.3));
  b.fillRect(5, 16, 6, 3, C.coffee).line(5, 14, 10, 14, C.metalHi);
  // steam
  b.set(7, 0, hex('#ffffff', 140)).set(8, 1, hex('#ffffff', 110)).set(9, 0, hex('#ffffff', 90));
  b.fillRect(1, 22, 14, 2, C.metal);
  return b.outline(C.outline);
}

/** Printer/copier (the office "console"). */
function copier(): PixelBuffer {
  const b = buf(T, 24).fillRect(1, 9, 14, 15, C.metalHi);
  b.fillRect(1, 9, 14, 2, C.white).fillRect(2, 13, 12, 1, C.metal);
  b.fillRect(2, 5, 12, 4, C.metal).fillRect(3, 3, 10, 3, C.paper);
  b.line(4, 4, 11, 4, C.ink);
  b.fillRect(10, 11, 3, 1, C.screen).set(4, 11, C.green);
  b.fillRect(3, 16, 10, 3, C.metal).fillRect(3, 20, 10, 3, C.metal);
  b.line(6, 17, 9, 17, C.metalLo).line(6, 21, 9, 21, C.metalLo);
  return b.outline(C.outline);
}

function officeRug(): PixelBuffer {
  const b = buf(32, T).fillRect(0, 2, 32, 12, hex('#3d5a80'));
  b.strokeRect(1, 3, 30, 10, hex('#e0c07a'));
  for (let x = 4; x < 28; x += 4) b.set(x, 8, hex('#e07a5f')).set(x + 2, 6, hex('#98c1d9'));
  for (let x = 0; x < 32; x += 2) b.set(x, 1, hex('#e0c07a')).set(x, 14, hex('#e0c07a'));
  return b;
}

function floorLamp(): PixelBuffer {
  const b = buf(T, 24);
  b.fillRect(7, 8, 2, 14, C.woodDark).fillRect(4, 22, 8, 2, C.woodDark);
  b.fillRect(4, 2, 8, 6, C.lampShade).line(3, 7, 12, 7, shade(C.lampShade, 0.85));
  b.line(5, 2, 10, 2, C.lampGlow).set(6, 3, C.lampGlow);
  return b.outline(C.outline);
}

function bookshelf(): PixelBuffer {
  const b = buf(T, 24).fillRect(1, 1, 14, 23, C.wood);
  b.strokeRect(1, 1, 14, 23, C.woodDark);
  for (const y of [7, 13, 19]) b.line(2, y, 13, y, C.woodDark);
  const spines = [C.red, C.teal, C.mustard, hex('#3d5a80'), C.green, hex('#e07a5f')];
  let i = 0;
  for (const y of [2, 8, 14, 20]) {
    let x = 3;
    while (x < 13) {
      const w = 1 + Math.floor(hash2(x, y, 5) * 2);
      const h = 4 - Math.floor(hash2(x, y, 9) * 2);
      b.fillRect(x, y + (5 - h), w, h, spines[i++ % spines.length]!);
      x += w + 1;
    }
  }
  return b.outline(C.outline);
}

/** Filing cabinet with a cardboard box on top (the office "crate"). */
function filingCabinet(): PixelBuffer {
  const b = buf(T, T).fillRect(2, 4, 12, 12, C.metal);
  b.strokeRect(2, 4, 12, 12, C.metalLo).line(2, 10, 13, 10, C.metalLo);
  b.line(6, 7, 9, 7, C.metalHi).line(6, 13, 9, 13, C.metalHi);
  b.fillRect(4, 0, 8, 4, hex('#c79a5b')).line(4, 1, 11, 1, hex('#a87c43'));
  return b.outline(C.outline);
}

// ---------- gear (16×16 icons drawn on desks) ----------

function gearIcon(cat: ToolCategory): PixelBuffer {
  const b = buf(T, T);
  switch (cat) {
    case 'read': // document
      b.fillRect(3, 1, 10, 14, C.paper).fillRect(10, 1, 3, 3, shade(C.paper, 0.85));
      for (let y = 5; y < 13; y += 2) b.line(5, y, 10, y, C.ink);
      break;
    case 'search': // magnifier
      b.disc(6, 6, 4, C.metalLo).disc(6, 6, 3, C.windowSky).set(5, 4, C.white);
      b.line(9, 9, 13, 13, C.woodDark).line(10, 9, 14, 13, C.woodDark);
      break;
    case 'write': // keyboard
      b.fillRect(1, 7, 14, 7, C.metalHi);
      for (let x = 2; x < 14; x += 2) b.set(x, 8, C.ink).set(x + 1, 10, C.ink);
      b.line(4, 12, 11, 12, C.ink);
      break;
    case 'execute': // terminal monitor
      b.fillRect(1, 2, 14, 10, C.dark).fillRect(2, 3, 12, 8, hex('#101418'));
      b.line(3, 5, 4, 6, C.green).line(4, 6, 3, 7, C.green).line(6, 7, 8, 7, C.green);
      b.fillRect(6, 12, 4, 2, C.metalLo).fillRect(4, 14, 8, 1, C.metal);
      break;
    case 'web': // globe
      b.disc(8, 7, 6, hex('#3d8bd9')).set(5, 4, C.leaf).fillRect(4, 5, 3, 3, C.leaf);
      b.fillRect(9, 8, 4, 3, C.leaf).line(2, 7, 14, 7, hex('#7fb8ee'));
      b.fillRect(6, 13, 4, 1, C.woodDark).fillRect(4, 14, 8, 1, C.woodDark);
      break;
    case 'delegate': // desk phone
      b.fillRect(2, 7, 12, 7, C.dark).fillRect(3, 4, 10, 3, shade(C.dark, 1.4));
      for (let x = 5; x < 12; x += 2) b.set(x, 9, C.metalHi).set(x, 11, C.metalHi);
      b.set(12, 8, C.red);
      break;
    case 'plan': // whiteboard with sticky notes
      b.fillRect(1, 2, 14, 10, C.white).strokeRect(1, 2, 14, 10, C.metal);
      b.fillRect(3, 4, 3, 3, C.mustardHi).fillRect(7, 4, 3, 3, hex('#98c1d9'));
      b.fillRect(11, 7, 3, 3, hex('#f4a6a6')).line(3, 9, 8, 9, C.ink);
      b.line(4, 12, 3, 15, C.metal).line(11, 12, 12, 15, C.metal);
      break;
    case 'mcp': // plug + cable
      b.fillRect(3, 6, 6, 6, C.white).strokeRect(3, 6, 6, 6, C.metal);
      b.line(4, 3, 4, 6, C.metalLo).line(7, 3, 7, 6, C.metalLo);
      b.line(9, 9, 14, 9, C.dark).line(14, 9, 14, 14, C.dark);
      break;
    default: // coffee mug
      b.fillRect(4, 5, 7, 9, C.white).fillRect(5, 6, 5, 2, C.coffee);
      b.strokeRect(11, 7, 3, 4, C.white).set(6, 10, C.red).set(7, 10, C.red);
      b.set(6, 2, hex('#ffffff', 140)).set(8, 1, hex('#ffffff', 110));
      break;
  }
  return b.outline(C.outline);
}

// ---------- backdrop ----------

/** 64×64 tileable warm wallpaper pattern shown around the office. */
export function wallpaper(size = 64): PixelBuffer {
  const base = hex('#2b211c');
  const b = buf(size, size).fillRect(0, 0, size, size, base);
  const stripe = hex('#30251f');
  const motif = hex('#3a2c24');
  for (let x = 0; x < size; x += 8) b.line(x, 0, x, size - 1, stripe);
  for (let y = 4; y < size; y += 16) {
    for (let x = 4; x < size; x += 16) {
      b.set(x, y - 1, motif)
        .set(x - 1, y, motif)
        .set(x + 1, y, motif)
        .set(x, y + 1, motif);
    }
  }
  return b;
}

// ---------- generator ----------

/** Business casual: shirts, sweaters and cardigans with lanyards/badges as accents. */
export const OFFICE_CREW: CrewStyle = {
  uniform: 'casual',
  outfits: [
    ['#4a7bb7', '#f2f2f2'], // blue shirt, white lanyard
    ['#c0564b', '#f2c14e'], // brick sweater
    ['#5d8c5a', '#fbf7ec'], // sage cardigan
    ['#e0a43a', '#3d5a80'], // mustard sweater, navy badge
    ['#7a5ea8', '#f2f2f2'], // purple shirt
    ['#2f8f8a', '#e07a5f'], // teal polo
    ['#f2efe6', '#3d5a80'], // white shirt, navy tie
    ['#8a5a3c', '#f2c14e'], // brown cardigan
  ],
  pants: '#3a3f52',
  shoes: '#2a1d17',
  outline: '#2a1d17',
  hairs: ['#2a1b12', '#6b4226', '#c98b3c', '#e8d29a', '#3b3b3b', '#a3402c', '#8c8c8c'],
};

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

export const officeGenerator: ArtGenerator = (manifest) => {
  const floors: Record<FloorKind, PixelBuffer[]> = {
    center: range(3).map(meetingCarpet),
    lounge: range(3).map(breakTile),
    zone: range(4).map(officeCarpet),
    corridor: range(2).map(hallTile),
  };
  const gear = Object.fromEntries(
    (
      ['read', 'search', 'write', 'execute', 'web', 'delegate', 'plan', 'mcp', 'other'] as const
    ).map((c) => [c, gearIcon(c)]),
  ) as Record<ToolCategory, PixelBuffer>;
  return {
    tileSize: manifest.tileSize,
    crewStyle: OFFICE_CREW,
    crewVariants: 8,
    floors,
    wall: officeWall(),
    props: {
      command_table: meetingTable(),
      desk: officeDesk(),
      chair: officeChair(),
      lounge_seat: couchSeat(),
      nameplate: officeNameplate(),
      door: officeDoor(),
      plant: fiddleLeaf(),
      sofa: officeSofa(),
      coffee_machine: coffeeMachine(),
      console: copier(),
      rug: officeRug(),
      lamp: floorLamp(),
      bookshelf: bookshelf(),
      crate: filingCabinet(),
    },
    gear,
    backdrop: wallpaper(),
  } satisfies GeneratedArt;
};
