#!/usr/bin/env node
// Generates WSC's original pixel-art icons (no dependencies, no third-party art):
//   resources/tray/  — macOS template icons (black + alpha) and colored Windows/Linux icons,
//                       one per status (idle / working / attention), 16 px and 32 px (@2x)
//   resources/icon.png, build/icon.png — app icon (1024 px), resources/icon-512.png
// Run: node scripts/gen-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..');

// ── tiny PNG encoder (RGBA, 8-bit) ─────────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── pixel maps ────────────────────────────────────────────────────────────────
const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
  255,
];

/** Render a char map with a palette, scaled by an integer factor. */
function raster(map, palette, scale = 1) {
  const h = map.length;
  const w = map[0].length;
  const out = Buffer.alloc(w * scale * h * scale * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = palette[map[y][x]];
      if (!c) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((y * scale + dy) * w * scale + (x * scale + dx)) * 4;
          out[i] = c[0];
          out[i + 1] = c[1];
          out[i + 2] = c[2];
          out[i + 3] = c[3];
        }
      }
    }
  }
  return { w: w * scale, h: h * scale, data: out };
}

// 16×16 tray rocket. '#' body, 'o' window (cut out on template), 'f' flame, 'd' status dot.
const TRAY_ROCKET = [
  '.......##.......',
  '......####......',
  '.....######.....',
  '.....##oo##.....',
  '.....#o..o#.....',
  '.....##oo##.....',
  '.....######.....',
  '.....######.....',
  '....########....',
  '...##.####.##...',
  '...#..####..#...',
  '......#..#......',
  '......f..f......',
  '................',
  '................',
  '................',
];

/** Adds a status dot in the bottom-right corner (3×3, with a 1-px transparent gap). */
function withDot(map, kind) {
  if (kind === 'idle') return map;
  const rows = map.map((r) => r.split(''));
  const dot =
    kind === 'attention'
      ? ['ddd', 'd.d', 'ddd'] // hollow ring reads as "!" at 16 px
      : ['ddd', 'ddd', 'ddd'];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) rows[11 + y][11 + x] = '.';
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) rows[12 + y][12 + x] = dot[y][x];
  return rows.map((r) => r.join(''));
}

const STATUS = ['idle', 'working', 'attention'];
const DOT_COLORS = { working: '#5ad1ff', attention: '#ffcf4a' };

function write(rel, png) {
  const file = join(ROOT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
  console.log('wrote', rel);
}

for (const status of STATUS) {
  const map = withDot(TRAY_ROCKET, status);
  // macOS template: black + alpha only (the OS tints it). The window cut-out stays transparent.
  const tpl = { '#': [0, 0, 0, 255], f: [0, 0, 0, 160], d: [0, 0, 0, 255] };
  for (const [scale, suffix] of [
    [1, ''],
    [2, '@2x'],
  ]) {
    const t = raster(map, tpl, scale);
    write(`resources/tray/${status}Template${suffix}.png`, encodePng(t.w, t.h, t.data));
    // Windows/Linux: colored, readable on light and dark task bars.
    const color = {
      '#': hex('#d8deef'),
      o: hex('#2b3a67'),
      f: hex('#ff8a3d'),
      d: hex(DOT_COLORS[status] ?? '#8a93b2'),
    };
    const c = raster(map, color, scale);
    write(`resources/tray/${status}${suffix}.png`, encodePng(c.w, c.h, c.data));
  }
}

// 32×32 app icon: rocket leaving a small station ring, on a deep-space tile.
const APP = [
  '................................',
  '..BBBBBBBBBBBBBBBBBBBBBBBBBBBB..',
  '.BNNNNNNNNNNNNNNNNNNNNNNNNNNNNB.',
  '.BNNNNNNNNsNNNNNNNNNNNNNNNNNNNB.',
  '.BNNNNNNNNNNNNNNNWNNNNNNNNsNNNB.',
  '.BNNNsNNNNNNNNNNWWWNNNNNNNNNNNB.',
  '.BNNNNNNNNNNNNNWWWWWNNNNNNNNNNB.',
  '.BNNNNNNNNNNNNNWWWWWNNNNNNNNNNB.',
  '.BNNNNNNNNNNNNWWccWWWNNNNNNNNNB.',
  '.BNNNNNNNNNNNNWcCCcWWNNNNNsNNNB.',
  '.BNNNNNNNNNNNNWcCCcWWNNNNNNNNNB.',
  '.BNNNNNNNNNNNNWWccWWWNNNNNNNNNB.',
  '.BNNNNNNNNNNNNWWWWWWWNNNNNNNNNB.',
  '.BNNsNNNNNNNNNWWWWWWWNNNNNNNNNB.',
  '.BNNNNNNNNNNNNWWWWWWWNNNNNNNNNB.',
  '.BNNNNNNNNNNNRWWWWWWWRNNNNNNNNB.',
  '.BNNNNNNNNNNRRWWWWWWWRRNNNNNNNB.',
  '.BNNNNNNNNNRRNWWWWWWWNRRNNNNNNB.',
  '.BNNNNNNNNNRNNNWWWWWNNNRNNNNNNB.',
  '.BNNNNNNNNNNNNNNOYYONNNNNNNNNNB.',
  '.BNNNNNNNNNNNNNNOYYONNNNNNNNNNB.',
  '.BNNNNNNNNNNNNNNNOONNNNNNNNNNNB.',
  '.BNNNNNNNNNNNNNNNOONNNNNNNNsNNB.',
  '.BNNNNNNGGGGGGNNNNNNNGGGGGGNNNB.',
  '.BNNNNNGLLLLLLGGGGGGGLLLLLLGNNB.',
  '.BNNNNNGLcLcLLLLLLLLLLLcLcLGNNB.',
  '.BNNNNNGLLLLLLGGGGGGGLLLLLLGNNB.',
  '.BNNNNNNGGGGGGNNNNNNNGGGGGGNNNB.',
  '.BNNNsNNNNNNNNNNNNNNNNNNNNNNNNB.',
  '.BNNNNNNNNNNNNNNNNNNNNNNNNNNNNB.',
  '..BBBBBBBBBBBBBBBBBBBBBBBBBBBB..',
  '................................',
];
const APP_PALETTE = {
  B: hex('#05070f'),
  N: hex('#141a2e'),
  s: hex('#8a93b2'),
  W: hex('#e6e9f5'),
  c: hex('#2b3a67'),
  C: hex('#5ad1ff'),
  R: hex('#ff6b6b'),
  O: hex('#ff8a3d'),
  Y: hex('#ffcf4a'),
  G: hex('#3a4a7a'),
  L: hex('#6f80b8'),
};
for (const [scale, rel] of [
  [32, 'resources/icon.png'],
  [32, 'build/icon.png'],
  [16, 'resources/icon-512.png'],
]) {
  const a = raster(APP, APP_PALETTE, scale);
  write(rel, encodePng(a.w, a.h, a.data));
}
