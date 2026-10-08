// Home art generator — a cozy pixel house. Pure pixel drawing (no DOM); see ./types.ts for
// prop conventions (anchor bottom-left of footprint; command_table is a 48×48 nine-slice).
import type { FloorKind } from '@shared/layoutTypes';
import type { ToolCategory } from '@shared/types';
import type { CrewStyle } from '../crew';
import { PixelBuffer, hash2, hex, mix, shade } from '../pixelBuffer';
import type { ArtGenerator, GeneratedArt } from './types';

const T = 16;

const C = {
  tileA: hex('#e9dcc4'),
  tileB: hex('#d8c6a6'),
  grout: hex('#b9a483'),
  oak: hex('#a8703f'),
  oakHi: hex('#c08850'),
  oakLo: hex('#80522c'),
  oakSeam: hex('#6a4224'),
  walnut: hex('#6e4528'),
  walnutHi: hex('#8a5a36'),
  walnutLo: hex('#4e2f1a'),
  runner: hex('#9b3d3a'),
  runnerHi: hex('#c4655a'),
  runnerTrim: hex('#e6c06a'),
  paper: hex('#d9c7a3'),
  paperStripe: hex('#c9b38b'),
  skirting: hex('#7a5232'),
  frame: hex('#c79a3e'),
  sky: hex('#8ec8f0'),
  skyHi: hex('#c8e6fb'),
  cream: hex('#f4ead2'),
  sage: hex('#7fa36b'),
  sageHi: hex('#a3c48d'),
  sageLo: hex('#5d7f4e'),
  mustard: hex('#d9a23b'),
  mustardHi: hex('#efc266'),
  rose: hex('#d97a6c'),
  roseHi: hex('#eda093'),
  teal: hex('#4f9a94'),
  tealHi: hex('#7cc0b9'),
  cushion: hex('#e8c96a'),
  leaf: hex('#5fae5a'),
  leafDk: hex('#3f7f3e'),
  pot: hex('#c4683f'),
  potHi: hex('#e08a5c'),
  metal: hex('#9aa3ad'),
  metalHi: hex('#c9d0d6'),
  metalLo: hex('#5f6770'),
  screen: hex('#273b4a'),
  screenGlow: hex('#7fd0e8'),
  lampShade: hex('#f2d58a'),
  lampGlow: hex('#fff3c4'),
  red: hex('#d4544a'),
  blue: hex('#4b78b8'),
  green: hex('#5fae5a'),
  cat: hex('#e09a4a'),
  catDk: hex('#a8652a'),
  grass: hex('#5d8f3f'),
  grassDk: hex('#4c7a33'),
  grassHi: hex('#79ab52'),
  outline: hex('#2e1f16'),
  white: hex('#fbf6ea'),
};

const buf = (w: number, h: number): PixelBuffer => new PixelBuffer(w, h);

// ---------- floors ----------

/** Kitchen: checkered ceramic tiles. */
function kitchenTile(v: number): PixelBuffer {
  const b = buf(T, T);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++) b.fillRect(x * 8, y * 8, 8, 8, (x + y) % 2 ? C.tileB : C.tileA);
  b.line(0, 0, 15, 0, C.grout).line(0, 0, 0, 15, C.grout).line(0, 8, 15, 8, C.grout);
  b.line(8, 0, 8, 15, C.grout);
  if (v === 1) b.set(3, 3, C.white).set(4, 3, C.white);
  if (v === 2) b.set(12, 12, shade(C.tileB, 0.92));
  return b;
}

/** Hardwood planks (rooms and living room). */
function plankTile(v: number, base = C.oak): PixelBuffer {
  const hi = mix(base, C.oakHi, 0.6);
  const seam = shade(base, 0.68);
  const b = buf(T, T).fillRect(0, 0, T, T, base);
  for (const y of [0, 4, 8, 12]) b.line(0, y, 15, y, seam);
  // staggered plank ends
  const offs = [3 + v * 2, 11 - v, 6 + v, 13 - v * 2];
  offs.forEach((x, i) => b.line(x % 16, i * 4 + 1, x % 16, i * 4 + 3, seam));
  for (const y of [2, 6, 10, 14]) b.set((y * 3 + v * 5) % 16, y, hi);
  if (v === 2) b.set(9, 5, shade(base, 0.8)).set(10, 5, shade(base, 0.8));
  return b;
}

/** Living room: warm planks with a soft woven rug pattern on some tiles. */
function livingTile(v: number): PixelBuffer {
  const b = plankTile(v, C.walnutHi);
  if (v === 2) {
    b.fillRect(2, 2, 12, 12, C.rose).strokeRect(2, 2, 12, 12, C.roseHi);
    for (let i = 4; i < 12; i += 3) b.set(i, i, C.cream).set(15 - i, i, C.cream);
  }
  return b;
}

/** Hallway: a patterned runner over dark boards. */
function hallTile(v: number): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.walnut);
  b.fillRect(2, 0, 12, T, C.runner)
    .line(2, 0, 2, 15, C.runnerTrim)
    .line(13, 0, 13, 15, C.runnerTrim);
  for (let y = 2; y < T; y += 6) {
    b.set(7, y, C.runnerHi)
      .set(8, y, C.runnerHi)
      .set(6, y + 1, C.runnerHi)
      .set(9, y + 1, C.runnerHi);
    b.set(7, y + 2, C.runnerHi).set(8, y + 2, C.runnerHi);
  }
  if (v === 1) b.set(4, 9, C.runnerTrim).set(11, 3, C.runnerTrim);
  return b;
}

// ---------- wall ----------

/** Striped wallpaper with skirting and, now and then, a window or a picture frame. */
function wallpaper(): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.paper);
  for (let x = 1; x < T; x += 4) b.line(x, 0, x, 12, C.paperStripe);
  b.fillRect(0, 12, T, 4, C.skirting).line(0, 12, 15, 12, shade(C.skirting, 1.25));
  // little window with curtains
  b.fillRect(4, 2, 8, 8, C.frame).fillRect(5, 3, 6, 6, C.sky).fillRect(5, 3, 6, 2, C.skyHi);
  b.line(8, 3, 8, 8, C.frame).line(5, 6, 10, 6, C.frame);
  b.fillRect(3, 2, 2, 9, C.rose).fillRect(11, 2, 2, 9, C.rose);
  return b;
}

// ---------- props ----------

/** 48×48 nine-slice wooden dining table with a runner and place settings (16 px borders). */
function diningTable(): PixelBuffer {
  const b = buf(48, 48).fillRect(0, 0, 48, 48, C.oak);
  b.strokeRect(0, 0, 48, 48, C.outline).strokeRect(1, 1, 46, 46, C.oakHi);
  // plank grain that survives stretching (horizontal lines tile cleanly)
  for (let y = 6; y < 44; y += 6) b.line(3, y, 44, y, C.oakLo);
  // table runner down the middle
  b.fillRect(3, 19, 42, 10, C.cream)
    .line(3, 19, 44, 19, C.runnerTrim)
    .line(3, 28, 44, 28, C.runnerTrim);
  for (let x = 6; x < 44; x += 4) b.set(x, 23, C.rose).set(x + 1, 24, C.rose);
  // plates + cups in the corners (stay in the fixed border slices)
  for (const [x, y] of [
    [8, 8],
    [40, 8],
    [8, 40],
    [40, 40],
  ] as const) {
    b.disc(x, y, 4, C.white).disc(x, y, 2, C.tileA).set(x, y, C.mustardHi);
  }
  // fruit bowl in the very centre
  b.disc(24, 24, 3, C.teal).set(23, 22, C.red).set(25, 22, C.mustard).set(24, 21, C.green);
  // front edge
  b.fillRect(2, 44, 44, 2, C.oakLo);
  return b;
}

/** 32×24 home desk with a laptop, mug and a sticky note (2×1 footprint, 8 px up). */
function desk(): PixelBuffer {
  const b = buf(32, 24);
  // laptop
  b.fillRect(9, 1, 14, 9, C.metalLo).fillRect(10, 2, 12, 7, C.screen);
  b.line(11, 4, 18, 4, C.screenGlow).line(11, 6, 15, 6, C.screenGlow).set(20, 7, C.mustardHi);
  b.fillRect(7, 10, 18, 2, C.metal).line(8, 10, 23, 10, C.metalHi);
  // mug with steam + plant pot
  b.fillRect(26, 6, 4, 4, C.rose).set(30, 7, C.rose).set(27, 4, C.cream).set(28, 3, C.cream);
  b.fillRect(2, 6, 4, 4, C.pot).set(3, 4, C.leaf).set(4, 3, C.leaf).set(5, 5, C.leafDk);
  b.fillRect(26, 11, 3, 3, C.mustardHi);
  // desktop + drawers
  b.fillRect(0, 10, 32, 5, C.oak).line(0, 10, 31, 10, C.oakHi);
  b.fillRect(0, 15, 32, 9, C.oakLo).line(0, 15, 31, 15, C.outline);
  b.strokeRect(2, 17, 10, 5, C.oakSeam).set(7, 19, C.mustardHi);
  b.strokeRect(20, 17, 10, 5, C.oakSeam).set(25, 19, C.mustardHi);
  b.strokeRect(0, 10, 32, 14, C.outline);
  return b;
}

function chair(): PixelBuffer {
  const b = buf(T, T);
  b.fillRect(4, 1, 8, 7, C.walnut).fillRect(5, 2, 6, 5, C.walnutHi);
  b.line(6, 2, 6, 6, C.walnut).line(9, 2, 9, 6, C.walnut);
  b.fillRect(3, 8, 10, 3, C.oak).fillRect(4, 8, 8, 1, C.oakHi);
  b.fillRect(4, 11, 2, 4, C.walnutLo).fillRect(10, 11, 2, 4, C.walnutLo);
  return b.outline(C.outline);
}

/** Living room armchair. */
function armchair(): PixelBuffer {
  const b = buf(T, T);
  b.fillRect(2, 2, 12, 7, C.sage).fillRect(3, 2, 10, 1, C.sageHi);
  b.fillRect(0, 5, 3, 8, C.sageHi).fillRect(13, 5, 3, 8, C.sageHi);
  b.fillRect(3, 8, 10, 4, C.sageLo).fillRect(4, 8, 8, 2, C.cushion);
  b.fillRect(2, 13, 2, 2, C.walnutLo).fillRect(12, 13, 2, 2, C.walnutLo);
  return b.outline(C.outline);
}

/** Couch with cushions and a throw blanket. */
function couch(): PixelBuffer {
  const b = buf(32, T);
  b.fillRect(1, 1, 30, 7, C.teal).fillRect(1, 1, 30, 1, C.tealHi);
  b.fillRect(1, 8, 30, 5, shade(C.teal, 0.85)).line(16, 8, 16, 12, shade(C.teal, 0.7));
  b.fillRect(0, 4, 3, 10, C.tealHi).fillRect(29, 4, 3, 10, C.tealHi);
  // cushions + blanket
  b.fillRect(4, 3, 6, 5, C.cushion).fillRect(5, 4, 4, 1, C.mustardHi);
  b.fillRect(22, 3, 6, 5, C.rose).fillRect(23, 4, 4, 1, C.roseHi);
  b.fillRect(18, 8, 8, 5, C.cream);
  for (let x = 18; x < 26; x += 2) b.set(x, 12, C.red);
  b.fillRect(2, 13, 2, 2, C.walnutLo).fillRect(28, 13, 2, 2, C.walnutLo);
  return b.outline(C.outline);
}

/** Door sign hung above each room. */
function nameplate(): PixelBuffer {
  const b = buf(32, 10).fillRect(1, 1, 30, 8, C.cream);
  b.strokeRect(0, 0, 32, 10, C.walnut).strokeRect(1, 1, 30, 8, C.oakHi);
  // string + nails
  b.set(4, 0, C.metalHi).set(27, 0, C.metalHi);
  b.set(3, 4, C.rose).set(28, 4, C.rose).set(3, 5, C.rose).set(28, 5, C.rose);
  return b;
}

function door(): PixelBuffer {
  const b = buf(T, T).fillRect(0, 0, T, T, C.walnutLo);
  b.fillRect(2, 0, 12, T, C.walnutHi);
  b.strokeRect(4, 2, 8, 5, C.walnut).strokeRect(4, 9, 8, 5, C.walnut);
  b.set(12, 8, C.mustardHi).set(12, 9, C.mustard);
  return b;
}

function plant(): PixelBuffer {
  const b = buf(T, 24);
  b.fillRect(4, 16, 8, 7, C.pot)
    .fillRect(3, 15, 10, 2, C.potHi)
    .line(5, 18, 10, 18, shade(C.pot, 0.8));
  // big monstera-ish leaves
  for (const [x, y, r] of [
    [8, 6, 3],
    [4, 9, 2],
    [12, 9, 2],
    [6, 12, 2],
    [10, 12, 2],
    [8, 3, 2],
  ] as const) {
    b.disc(x, y, r, C.leaf).set(x, y, C.leafDk);
  }
  b.line(8, 15, 8, 5, C.leafDk).line(8, 11, 5, 9, C.leafDk).line(8, 11, 11, 9, C.leafDk);
  return b.outline(C.outline);
}

/** Kitchen corner: a fridge with magnets and a kettle on top. */
function fridge(): PixelBuffer {
  const b = buf(T, 24).fillRect(2, 4, 12, 20, C.white);
  b.line(2, 12, 13, 12, C.metal).fillRect(12, 6, 1, 4, C.metal).fillRect(12, 14, 1, 5, C.metal);
  b.set(5, 7, C.red).set(8, 8, C.blue).set(6, 15, C.mustard).fillRect(4, 17, 3, 3, C.cream);
  // kettle on top
  b.fillRect(5, 0, 6, 4, C.red).set(11, 1, C.red).set(4, 2, C.metalLo);
  b.line(6, 0, 9, 0, shade(C.red, 1.2));
  return b.outline(C.outline);
}

/** TV on a little stand with a game console. */
function tvStand(): PixelBuffer {
  const b = buf(T, 24);
  b.fillRect(1, 2, 14, 10, C.metalLo).fillRect(2, 3, 12, 8, C.screen);
  b.fillRect(3, 6, 4, 3, C.green).fillRect(9, 5, 3, 3, C.mustard).set(7, 9, C.screenGlow);
  b.fillRect(7, 12, 2, 2, C.metalLo);
  b.fillRect(0, 14, 16, 10, C.walnut).line(0, 14, 15, 14, C.walnutHi);
  b.fillRect(2, 17, 6, 2, C.white).set(3, 18, C.green).fillRect(10, 17, 4, 4, C.walnutLo);
  b.set(11, 21, C.red).set(13, 21, C.blue);
  return b.outline(C.outline);
}

/** Round braided rug (walkable decor). */
function rug(): PixelBuffer {
  const b = buf(32, T);
  for (let r = 7; r >= 1; r -= 2) {
    const color = [C.mustard, C.rose, C.cream, C.teal][(r >> 1) % 4]!;
    for (let y = 0; y < T; y++)
      for (let x = 0; x < 32; x++) {
        const dx = (x - 15.5) / 2;
        const dy = y - 7.5;
        if (dx * dx + dy * dy <= r * r) b.set(x, y, color);
      }
  }
  return b;
}

function lamp(): PixelBuffer {
  const b = buf(T, 24);
  b.fillRect(7, 8, 2, 14, C.walnut).fillRect(4, 22, 8, 2, C.walnutLo);
  b.fillRect(3, 1, 10, 7, C.lampShade).line(4, 1, 11, 1, C.lampGlow).line(3, 7, 12, 7, C.mustard);
  b.set(7, 8, C.lampGlow).set(8, 8, C.lampGlow);
  return b.outline(C.outline);
}

function bookshelf(): PixelBuffer {
  const b = buf(T, 24).fillRect(1, 1, 14, 23, C.walnut);
  b.strokeRect(1, 1, 14, 23, C.walnutHi);
  for (const y of [8, 15, 22]) b.line(2, y, 13, y, C.walnutHi);
  const spines = [C.red, C.teal, C.mustard, C.sage, C.blue, C.rose, C.cream];
  let i = 0;
  for (const y of [2, 9, 16]) {
    for (let x = 3; x < 13; x += 2) {
      const h = 5 + ((i * 7) % 2);
      b.fillRect(x, y + 6 - h, 2, h, spines[i++ % spines.length]!);
    }
  }
  b.set(11, 3, C.leaf).set(12, 4, C.leaf); // a tiny cactus on the top shelf
  return b.outline(C.outline);
}

/** Laundry basket with a sock hanging out. */
function basket(): PixelBuffer {
  const b = buf(T, T).fillRect(2, 5, 12, 10, C.mustard);
  for (let y = 6; y < 15; y += 2) b.line(2, y, 13, y, shade(C.mustard, 0.8));
  for (let x = 3; x < 14; x += 3) b.line(x, 5, x, 14, C.mustardHi);
  b.fillRect(4, 3, 4, 3, C.blue).fillRect(9, 2, 3, 4, C.rose).fillRect(12, 4, 2, 5, C.cream);
  return b.outline(C.outline);
}

// ---------- gear (16×16 icons on desks) ----------

function gearIcon(cat: ToolCategory): PixelBuffer {
  const b = buf(T, T);
  switch (cat) {
    case 'read': // open book
      b.fillRect(1, 4, 7, 9, C.cream).fillRect(8, 4, 7, 9, C.white);
      b.line(8, 4, 8, 12, C.walnut).fillRect(1, 12, 14, 1, C.red);
      for (let y = 6; y < 11; y += 2) b.line(2, y, 6, y, C.metal).line(10, y, 14, y, C.metal);
      break;
    case 'search': // magnifying glass
      b.disc(6, 6, 4, C.walnut).disc(6, 6, 3, C.skyHi).set(5, 4, C.white);
      b.line(9, 9, 13, 13, C.walnutLo).line(10, 9, 14, 13, C.walnut);
      break;
    case 'write': // notepad + pencil
      b.fillRect(2, 3, 9, 11, C.mustardHi).fillRect(2, 3, 9, 2, C.red);
      for (let y = 7; y < 13; y += 2) b.line(3, y, 9, y, C.mustard);
      b.line(13, 2, 8, 11, C.mustard).set(8, 12, C.outline).set(13, 1, C.rose);
      break;
    case 'execute': // toolbox on a workbench
      b.fillRect(1, 12, 14, 3, C.oak).line(1, 12, 14, 12, C.oakHi);
      b.fillRect(3, 6, 10, 6, C.red).fillRect(3, 6, 10, 1, shade(C.red, 1.2));
      b.strokeRect(6, 3, 4, 4, C.metal).fillRect(7, 8, 2, 2, C.metalHi);
      break;
    case 'web': // wifi router with signal waves
      b.fillRect(3, 10, 10, 4, C.white).set(5, 12, C.green).set(7, 12, C.green);
      b.line(5, 10, 4, 6, C.metalLo).line(11, 10, 12, 6, C.metalLo);
      b.line(6, 4, 10, 4, C.screenGlow).line(5, 2, 11, 2, C.screenGlow);
      break;
    case 'delegate': // walkie-talkie
      b.fillRect(5, 4, 6, 11, C.mustard).fillRect(6, 6, 4, 3, C.screen).set(7, 7, C.screenGlow);
      b.line(9, 0, 9, 3, C.metalLo)
        .set(7, 11, C.outline)
        .set(8, 12, C.outline)
        .set(7, 13, C.outline);
      break;
    case 'plan': // corkboard with pinned notes
      b.fillRect(1, 2, 14, 12, C.oakHi).strokeRect(1, 2, 14, 12, C.walnut);
      b.fillRect(3, 4, 4, 4, C.mustardHi)
        .fillRect(9, 4, 4, 3, C.roseHi)
        .fillRect(5, 9, 6, 3, C.skyHi);
      b.set(5, 4, C.red).set(11, 4, C.blue).set(8, 9, C.green);
      break;
    case 'mcp': // extension cord + plug
      b.fillRect(1, 9, 8, 5, C.white).set(3, 11, C.outline).set(6, 11, C.outline);
      b.line(9, 11, 12, 11, C.metalLo).line(12, 11, 12, 5, C.metalLo);
      b.fillRect(10, 2, 5, 4, C.white).set(11, 1, C.metal).set(13, 1, C.metal);
      break;
    default: {
      // a tiny curled-up cat (original design)
      b.disc(8, 10, 5, C.cat).disc(8, 11, 3, shade(C.cat, 1.1));
      b.fillRect(3, 6, 5, 4, C.cat).set(3, 5, C.cat).set(7, 5, C.cat);
      b.set(4, 8, C.outline).set(6, 8, C.outline).set(5, 9, C.rose);
      b.line(11, 13, 14, 11, C.catDk).line(9, 8, 12, 9, C.catDk);
      break;
    }
  }
  return b.outline(C.outline);
}

// ---------- backdrop ----------

/** 256×256 seamlessly tileable garden lawn (the house sits in its yard). */
export function garden(size = 256, seed = 11): PixelBuffer {
  const b = buf(size, size).fillRect(0, 0, size, size, C.grass);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = hash2(x, y, seed);
      if (n > 0.93) b.set(x, y, C.grassHi);
      else if (n < 0.06) b.set(x, y, C.grassDk);
    }
  }
  const flowers = [C.white, C.mustardHi, C.roseHi, C.skyHi];
  for (let i = 0; i < size / 6; i++) {
    const x = Math.floor(hash2(i, 1, seed) * size);
    const y = Math.floor(hash2(i, 2, seed) * size);
    const c = flowers[Math.floor(hash2(i, 3, seed) * flowers.length)] ?? C.white;
    b.set((x + 1) % size, y, shade(c, 0.85)).set(x, (y + 1) % size, shade(c, 0.85));
    b.set(x, (y + size - 1) % size, shade(c, 0.85)).set((x + size - 1) % size, y, shade(c, 0.85));
    b.set(x, y, C.mustard); // flower centre
  }
  return b;
}

// ---------- generator ----------

/** Casual clothes: hoodies, tees, pajamas — slippers instead of boots. */
export const HOME_CREW: CrewStyle = {
  uniform: 'casual',
  outfits: [
    ['#d97a6c', '#f4ead2'], // rose hoodie
    ['#4f9a94', '#e8c96a'], // teal tee
    ['#7fa36b', '#f4ead2'], // sage sweater
    ['#8e7cc3', '#f2d58a'], // lavender pajamas
    ['#d9a23b', '#4e2f1a'], // mustard cardigan
    ['#4b78b8', '#fbf6ea'], // denim shirt
    ['#c4683f', '#f4ead2'], // terracotta hoodie
    ['#e6e0d0', '#d4544a'], // cream knit
  ],
  pants: '#5b5f7a',
  shoes: '#e8c96a',
  outline: '#2e1f16',
  icons: { celebrate: '#efc266', think: '#f4ead2' },
};

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

export const homeGenerator: ArtGenerator = (manifest) => {
  const floors: Record<FloorKind, PixelBuffer[]> = {
    center: range(3).map(kitchenTile),
    lounge: range(3).map(livingTile),
    zone: range(4).map((v) => plankTile(v)),
    corridor: range(2).map(hallTile),
  };
  const gear = Object.fromEntries(
    (
      ['read', 'search', 'write', 'execute', 'web', 'delegate', 'plan', 'mcp', 'other'] as const
    ).map((c) => [c, gearIcon(c)]),
  ) as Record<ToolCategory, PixelBuffer>;
  const art: GeneratedArt = {
    tileSize: manifest.tileSize,
    crewStyle: HOME_CREW,
    crewVariants: 8,
    floors,
    wall: wallpaper(),
    props: {
      command_table: diningTable(),
      desk: desk(),
      chair: chair(),
      lounge_seat: armchair(),
      nameplate: nameplate(),
      door: door(),
      plant: plant(),
      sofa: couch(),
      coffee_machine: fridge(),
      console: tvStand(),
      rug: rug(),
      lamp: lamp(),
      bookshelf: bookshelf(),
      crate: basket(),
    },
    gear,
  };
  // The house sits in its garden.
  art.backdrop = garden();
  return art;
};
