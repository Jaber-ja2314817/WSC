// Spaceship art generator — pure pixel drawing (no DOM). See ./types.ts for prop conventions.
import type { FloorKind } from '@shared/layoutTypes';
import type { ToolCategory } from '@shared/types';
import type { CrewStyle } from '../crew';
import { PixelBuffer, hash2, hex, mix, shade, type RGBA } from '../pixelBuffer';
import type { ArtGenerator, GeneratedArt } from './types';

const T = 16;

const C = {
  void: hex('#03050d'),
  deck: hex('#1d2747'),
  deckSeam: hex('#121a33'),
  deckHi: hex('#28345c'),
  rivet: hex('#3a4878'),
  carpet: hex('#3a2347'),
  carpetDot: hex('#47295a'),
  zone: hex('#202c3f'),
  zoneSeam: hex('#151e2e'),
  zoneHi: hex('#2a3851'),
  grate: hex('#151a26'),
  grateLine: hex('#0c1019'),
  rail: hex('#2b3448'),
  hull: hex('#2e3a5c'),
  hullHi: hex('#45557f'),
  hullLo: hex('#1b2238'),
  metal: hex('#3b4a7a'),
  metalHi: hex('#5a6fae'),
  metalLo: hex('#222c4a'),
  screen: hex('#0d2a3d'),
  cyan: hex('#4fd8ff'),
  cyanDim: hex('#2a7fa3'),
  green: hex('#4fd88a'),
  amber: hex('#ffcc4d'),
  red: hex('#ff5a6a'),
  purple: hex('#5a3d7a'),
  purpleHi: hex('#7a58a3'),
  leaf: hex('#3fbf6a'),
  leafDk: hex('#257a45'),
  glass: hex('#9fd8ff', 150),
  outline: hex('#0a0d1a'),
  white: hex('#e6ecff'),
  wood: hex('#6a4a3a'),
};

const buf = (w: number, h: number): PixelBuffer => new PixelBuffer(w, h);

// ---------- floors ----------

function deckTile(v: number): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.deck);
  b.line(0, 0, 15, 0, C.deckSeam).line(0, 0, 0, 15, C.deckSeam);
  b.line(1, 1, 14, 1, C.deckHi).line(1, 1, 1, 14, C.deckHi);
  for (const [x, y] of [
    [3, 3],
    [12, 3],
    [3, 12],
    [12, 12],
  ] as const)
    b.set(x, y, C.rivet);
  if (v === 1) b.fillRect(4, 7, 8, 2, C.deckSeam).fillRect(5, 7, 6, 1, C.cyanDim);
  if (v === 2) for (let x = 5; x <= 10; x += 2) b.line(x, 5, x, 10, C.deckSeam);
  if (v === 3) b.strokeRect(5, 5, 6, 6, C.deckHi);
  return b;
}

function carpetTile(v: number): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.carpet);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) if ((x + y * 3) % 6 === 0) b.set(x, y, C.carpetDot);
  if (v === 1) b.set(7, 7, C.purpleHi).set(8, 8, C.purpleHi);
  if (v === 2) b.line(2, 13, 5, 13, shade(C.carpet, 0.8));
  return b;
}

function zoneTile(v: number): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.zone);
  b.line(0, 0, 15, 0, C.zoneSeam).line(0, 0, 0, 15, C.zoneSeam);
  b.strokeRect(3, 3, 10, 10, C.zoneHi);
  if (v === 1) b.fillRect(6, 6, 4, 4, C.zoneSeam);
  if (v === 2) b.set(1, 1, C.rivet).set(14, 14, C.rivet);
  if (v === 3) b.line(4, 12, 11, 12, mix(C.zoneHi, C.cyanDim, 0.4));
  return b;
}

function grateTile(v: number): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.grate);
  for (let y = 1; y < T; y += 3) b.line(1, y, 14, y, C.grateLine);
  b.line(0, 0, 0, 15, C.rail).line(15, 0, 15, 15, shade(C.rail, 0.8));
  if (v === 1) b.set(7, 5, C.amber).set(8, 5, C.amber);
  return b;
}

// ---------- wall ----------

function hullWall(): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.hull);
  b.fillRect(0, 0, T, 2, C.hullHi).fillRect(0, 14, T, 2, C.hullLo);
  // porthole with stars
  b.disc(8, 8, 3, C.hullLo).disc(8, 8, 2, C.void);
  b.set(7, 7, C.white).set(9, 9, C.cyanDim);
  b.set(2, 4, C.rivet).set(13, 4, C.rivet).set(2, 11, C.rivet).set(13, 11, C.rivet);
  return b;
}

// ---------- props ----------

/** 48×48 nine-slice holo command table (16 px borders). */
function commandTable(): PixelBuffer {
  const b = buf(48, 48).fillRect(0, 0, 48, 48, C.metal);
  b.strokeRect(0, 0, 48, 48, C.outline).strokeRect(1, 1, 46, 46, C.metalHi);
  b.fillRect(4, 4, 40, 40, C.metalLo);
  b.fillRect(6, 6, 36, 36, C.screen);
  // holo grid in the borders' inner edge (stays crisp when the middle stretches)
  for (let i = 8; i < 40; i += 4) {
    b.set(i, 6, C.cyanDim).set(i, 41, C.cyanDim).set(6, i, C.cyanDim).set(41, i, C.cyanDim);
  }
  for (let x = 16; x < 32; x++)
    for (let y = 16; y < 32; y++) if ((x + y) % 8 === 0) b.set(x, y, mix(C.screen, C.cyanDim, 0.5));
  // corner projectors
  for (const [x, y] of [
    [6, 6],
    [40, 6],
    [6, 40],
    [40, 40],
  ] as const)
    b.fillRect(x, y, 2, 2, C.cyan);
  // front edge lip
  b.fillRect(2, 44, 44, 2, C.metalHi);
  return b;
}

/** 32×24 console desk (2×1 footprint, extends 8 px up). */
function desk(): PixelBuffer {
  const b = buf(32, 24);
  // monitor
  b.fillRect(8, 0, 16, 10, C.metalLo).fillRect(9, 1, 14, 7, C.screen);
  b.line(10, 3, 18, 3, C.cyanDim).line(10, 5, 15, 5, C.cyanDim).set(20, 6, C.green);
  b.fillRect(15, 9, 2, 2, C.metal);
  // desktop + front
  b.fillRect(0, 10, 32, 6, C.metal).line(0, 10, 31, 10, C.metalHi);
  b.fillRect(9, 12, 14, 2, shade(C.metal, 0.75)).line(10, 12, 21, 12, C.metalHi);
  b.fillRect(0, 16, 32, 8, C.metalLo).line(0, 16, 31, 16, C.outline);
  b.set(3, 19, C.green).set(5, 19, C.amber);
  b.strokeRect(0, 10, 32, 14, C.outline);
  return b;
}

function chair(): PixelBuffer {
  const b = buf(T, T);
  b.fillRect(4, 2, 8, 6, C.purple).fillRect(4, 2, 8, 1, C.purpleHi);
  b.fillRect(3, 8, 10, 4, shade(C.purple, 0.85)).fillRect(7, 12, 2, 3, C.metalLo);
  b.fillRect(4, 15, 8, 1, C.metal);
  return b.outline(C.outline);
}

function bench(): PixelBuffer {
  const b = buf(T, T);
  b.fillRect(1, 4, 14, 4, C.purple).fillRect(1, 4, 14, 1, C.purpleHi);
  b.fillRect(1, 8, 14, 4, shade(C.purple, 0.8));
  b.fillRect(2, 12, 2, 3, C.metalLo).fillRect(12, 12, 2, 3, C.metalLo);
  return b.outline(C.outline);
}

function sofa(): PixelBuffer {
  const b = buf(32, T);
  b.fillRect(1, 2, 30, 6, C.purple).fillRect(1, 2, 30, 1, C.purpleHi);
  b.fillRect(1, 8, 30, 5, shade(C.purple, 0.85)).line(16, 8, 16, 12, shade(C.purple, 0.7));
  b.fillRect(0, 4, 3, 10, C.purpleHi).fillRect(29, 4, 3, 10, C.purpleHi);
  b.fillRect(2, 13, 2, 2, C.metalLo).fillRect(28, 13, 2, 2, C.metalLo);
  return b.outline(C.outline);
}

function nameplate(): PixelBuffer {
  const b = buf(32, 10).fillRect(0, 0, 32, 10, hex('#1b2442'));
  b.strokeRect(0, 0, 32, 10, C.cyan).strokeRect(1, 1, 30, 8, C.metalLo);
  b.set(2, 2, C.rivet).set(29, 2, C.rivet).set(2, 7, C.rivet).set(29, 7, C.rivet);
  return b;
}

function door(): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.metalLo);
  b.fillRect(2, 0, 12, T, C.metal).line(7, 0, 7, 15, C.outline).line(8, 0, 8, 15, C.metalHi);
  for (let y = 0; y < T; y += 4) {
    b.set(0, y, C.amber)
      .set(1, y + 1, C.amber)
      .set(14, y, C.amber)
      .set(15, y + 1, C.amber);
  }
  b.set(5, 7, C.green).set(10, 7, C.green);
  return b;
}

function plant(): PixelBuffer {
  const b = buf(T, 24);
  // glass hydroponic tube
  b.fillRect(4, 14, 8, 9, C.glass).strokeRect(4, 14, 8, 9, C.metalHi);
  b.fillRect(3, 22, 10, 2, C.metal);
  b.line(6, 21, 6, 16, C.leafDk).line(9, 21, 9, 15, C.leafDk);
  // leaves above
  for (const [x, y] of [
    [8, 6],
    [5, 8],
    [11, 9],
    [7, 11],
    [10, 12],
    [4, 12],
    [8, 3],
  ] as const) {
    b.disc(x, y, 2, C.leaf).set(x, y, C.leafDk);
  }
  b.line(8, 13, 8, 4, C.leafDk);
  return b.outline(C.outline);
}

function replicator(): PixelBuffer {
  const b = buf(T, 24).fillRect(2, 2, 12, 22, C.metal);
  b.fillRect(2, 2, 12, 2, C.metalHi).fillRect(4, 6, 8, 5, C.screen).line(5, 8, 10, 8, C.cyan);
  b.fillRect(4, 13, 8, 6, C.void).fillRect(6, 16, 4, 3, C.white).set(7, 15, C.amber);
  b.set(4, 21, C.green).set(6, 21, C.red);
  return b.outline(C.outline);
}

function consoleProp(): PixelBuffer {
  const b = buf(T, 24).fillRect(2, 8, 12, 16, C.metalLo);
  b.fillRect(1, 2, 14, 8, C.metal).fillRect(2, 3, 12, 5, C.screen);
  b.line(3, 4, 10, 4, C.green).line(3, 6, 8, 6, C.cyanDim);
  for (let x = 3; x < 13; x += 3) b.set(x, 12, C.amber).set(x + 1, 14, C.cyan);
  return b.outline(C.outline);
}

function rug(): PixelBuffer {
  const b = buf(32, T).fillRect(0, 2, 32, 12, shade(C.purple, 0.7));
  b.strokeRect(1, 3, 30, 10, C.purpleHi);
  for (let x = 4; x < 28; x += 4) b.set(x, 8, C.cyanDim);
  return b;
}

function lamp(): PixelBuffer {
  const b = buf(T, 24);
  b.fillRect(7, 6, 2, 16, C.metal).fillRect(4, 22, 8, 2, C.metalLo);
  b.disc(8, 4, 3, mix(C.cyan, C.white, 0.4)).disc(8, 4, 1, C.white);
  return b.outline(C.outline);
}

function storageRack(): PixelBuffer {
  const b = buf(T, 24).fillRect(1, 1, 14, 23, C.metalLo);
  b.strokeRect(1, 1, 14, 23, C.metal);
  for (const y of [7, 13, 19]) b.line(2, y, 13, y, C.metal);
  const colors = [C.cyanDim, C.amber, C.purpleHi, C.green, C.red];
  let i = 0;
  for (const y of [2, 8, 14, 20]) {
    for (let x = 3; x < 13; x += 3) b.fillRect(x, y + 1, 2, 4, colors[i++ % colors.length]!);
  }
  return b.outline(C.outline);
}

function crate(): PixelBuffer {
  const b = buf(T, T).fillRect(2, 3, 12, 12, hex('#5c6a8a'));
  b.strokeRect(2, 3, 12, 12, hex('#3c465f')).line(2, 3, 13, 14, hex('#3c465f'));
  b.fillRect(2, 3, 12, 1, hex('#7d8cad')).set(12, 5, C.amber);
  return b.outline(C.outline);
}

// ---------- gear (16×16 icons drawn on desks) ----------

function gearIcon(cat: ToolCategory): PixelBuffer {
  const b = buf(T, T);
  switch (cat) {
    case 'read': // data pad with scroll
      b.fillRect(4, 2, 8, 12, C.metalLo).fillRect(5, 3, 6, 9, C.screen);
      for (let y = 4; y < 11; y += 2) b.line(6, y, 9, y, C.cyan);
      break;
    case 'search': // radar scanner
      b.disc(8, 8, 6, C.screen).disc(8, 8, 3, shade(C.screen, 1.3));
      b.line(8, 8, 13, 4, C.green).set(5, 10, C.amber);
      break;
    case 'write': // glowing keyboard
      b.fillRect(1, 8, 14, 6, C.metal);
      for (let x = 2; x < 14; x += 2) b.set(x, 9, C.cyan).set(x + 1, 11, C.cyan);
      b.fillRect(4, 12, 8, 1, C.cyanDim);
      break;
    case 'execute': // engine terminal
      b.fillRect(1, 2, 14, 11, C.metalLo).fillRect(2, 3, 12, 8, C.void);
      b.line(3, 5, 4, 6, C.green).line(4, 6, 3, 7, C.green).line(6, 7, 8, 7, C.green);
      b.fillRect(3, 13, 10, 2, C.red);
      break;
    case 'web': // comms dish
      b.line(3, 4, 9, 10, C.metalHi).line(2, 6, 7, 11, C.metalHi).line(3, 4, 2, 6, C.metalHi);
      b.line(9, 10, 7, 11, C.metalHi).line(6, 7, 11, 2, C.metal).set(12, 1, C.cyan);
      b.fillRect(6, 11, 4, 4, C.metalLo);
      break;
    case 'delegate': // intercom
      b.fillRect(3, 2, 10, 12, C.metal).fillRect(4, 3, 8, 6, C.metalLo);
      for (let y = 4; y < 8; y += 2) b.line(5, y, 10, y, C.outline);
      b.disc(8, 11, 1, C.amber);
      break;
    case 'plan': // holo board / checklist
      b.fillRect(2, 2, 12, 12, mix(C.screen, C.cyanDim, 0.3)).strokeRect(2, 2, 12, 12, C.cyan);
      for (const y of [5, 8, 11]) b.set(4, y, C.green).line(6, y, 11, y, C.white);
      break;
    case 'mcp': // external link console
      b.fillRect(2, 4, 10, 10, C.metalLo).strokeRect(2, 4, 10, 10, C.metal);
      b.line(7, 9, 13, 3, C.amber).line(10, 3, 13, 3, C.amber).line(13, 3, 13, 6, C.amber);
      break;
    default: // toolbox
      b.fillRect(2, 7, 12, 7, C.red).fillRect(2, 7, 12, 1, shade(C.red, 1.2));
      b.strokeRect(5, 4, 6, 4, C.metalHi).fillRect(7, 9, 2, 2, C.metalLo);
      break;
  }
  return b.outline(C.outline);
}

// ---------- backdrop ----------

/** 256×256 seamlessly tileable starfield. */
export function starfield(size = 256, seed = 7): PixelBuffer {
  const b = buf(size, size).fillRect(0, 0, size, size, C.void);
  const tints: RGBA[] = [C.white, hex('#9fc4ff'), hex('#ffe9b0'), hex('#ffb3d9'), hex('#7a86b3')];
  for (let i = 0; i < size * 1.1; i++) {
    const x = Math.floor(hash2(i, 1, seed) * size);
    const y = Math.floor(hash2(i, 2, seed) * size);
    const t = tints[Math.floor(hash2(i, 3, seed) * tints.length)] ?? C.white;
    const bright = hash2(i, 4, seed);
    b.set(x, y, bright > 0.6 ? t : shade(t, 0.45));
    if (bright > 0.985) {
      const dim = shade(t, 0.5);
      b.set((x + 1) % size, y, dim).set((x + size - 1) % size, y, dim);
      b.set(x, (y + 1) % size, dim).set(x, (y + size - 1) % size, dim);
    }
  }
  // faint nebula dither
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = Math.sin((x / size) * Math.PI * 2) * Math.cos((y / size) * Math.PI * 4);
      if (n > 0.55 && (x + y) % 3 === 0 && b.get(x, y) === C.void) b.set(x, y, hex('#120c2a'));
    }
  }
  return b;
}

// ---------- generator ----------

export const SPACESHIP_CREW: CrewStyle = {
  uniform: 'jumpsuit',
  outfits: [
    ['#2f6fd6', '#ffcc4d'],
    ['#c8414f', '#e6ecff'],
    ['#2e9e6a', '#ffcc4d'],
    ['#8a4fd6', '#4fd8ff'],
    ['#d6862f', '#1d2747'],
    ['#2fa7c4', '#ff8fb1'],
    ['#5a6378', '#4fd8ff'],
    ['#b8355f', '#ffe066'],
  ],
  shoes: '#1b1e2e',
  outline: '#0a0d1a',
};

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

export const spaceshipGenerator: ArtGenerator = (manifest) => {
  const floors: Record<FloorKind, PixelBuffer[]> = {
    center: range(4).map(deckTile),
    lounge: range(3).map(carpetTile),
    zone: range(4).map(zoneTile),
    corridor: range(2).map(grateTile),
  };
  const gear = Object.fromEntries(
    (
      ['read', 'search', 'write', 'execute', 'web', 'delegate', 'plan', 'mcp', 'other'] as const
    ).map((c) => [c, gearIcon(c)]),
  ) as Record<ToolCategory, PixelBuffer>;
  const art: GeneratedArt = {
    tileSize: manifest.tileSize,
    crewStyle: SPACESHIP_CREW,
    crewVariants: 8,
    floors,
    wall: hullWall(),
    props: {
      command_table: commandTable(),
      desk: desk(),
      chair: chair(),
      lounge_seat: bench(),
      nameplate: nameplate(),
      door: door(),
      plant: plant(),
      sofa: sofa(),
      coffee_machine: replicator(),
      console: consoleProp(),
      rug: rug(),
      lamp: lamp(),
      bookshelf: storageRack(),
      crate: crate(),
    },
    gear,
  };
  if (manifest.ambient?.starfield !== false) art.backdrop = starfield();
  return art;
};
