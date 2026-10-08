#!/usr/bin/env node
// Records the README media from demo mode (synthetic data only):
//   docs/media/demo.gif          hero GIF (~12 s, 800 px wide, 10 fps)
//   docs/media/theme-<id>.png    one screenshot per built-in theme
//
// Usage: npm run build && node scripts/record-demo.mjs [--seconds 12] [--width 800]
// Frames are captured in Electron's main process (webContents.capturePage), resized natively,
// and encoded with gifenc. Nothing is sent anywhere.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const SECONDS = arg('seconds', 12);
const WIDTH = arg('width', 800);
const FPS = 10;
const THEMES = ['spaceship', 'office', 'home', 'terminal'];
const OUT = 'docs/media';
const WINDOW = { width: 1280, height: 800 };

mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'wsc-record-'));

const app = await electron.launch({
  args: ['.', '--demo'],
  env: {
    ...process.env,
    // Isolated: never touch a real install's runtime/state/settings.
    WSC_RUNTIME_FILE: join(tmp, 'runtime.json'),
    WSC_STATE_FILE: join(tmp, 'state.json'),
    WSC_SETTINGS_FILE: join(tmp, 'settings.json'),
  },
});
const win = await app.firstWindow();
await win.setViewportSize(WINDOW);
await win.waitForSelector('#stage canvas', { timeout: 20_000 });

/** Capture the window in main, resized to `width`; returns RGBA pixels. */
async function grab(width) {
  const { data, w, h } = await app.evaluate(async ({ BrowserWindow }, width) => {
    const bw = BrowserWindow.getAllWindows()[0];
    const img = (await bw.webContents.capturePage()).resize({ width, quality: 'good' });
    const { width: w, height: h } = img.getSize();
    return { data: img.toBitmap().toString('base64'), w, h };
  }, width);
  const bgra = Buffer.from(data, 'base64');
  // nativeImage bitmaps are BGRA; gifenc wants RGBA.
  for (let i = 0; i < bgra.length; i += 4) {
    const b = bgra[i];
    bgra[i] = bgra[i + 2];
    bgra[i + 2] = b;
  }
  return { rgba: new Uint8Array(bgra.buffer, bgra.byteOffset, bgra.length), w, h };
}

async function setTheme(id) {
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()[0].webContents.send('wsc:command', { action: 'theme', arg: id });
  }, id);
  await win.waitForTimeout(1_200);
}

async function savePng(path) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return img.toPNG().toString('base64');
  });
  writeFileSync(path, Buffer.from(b64, 'base64'));
}

// Let the demo get going: agents assigned and walking out.
await win.waitForTimeout(5_000);

// Hero GIF.
const gif = GIFEncoder();
const frames = SECONDS * FPS;
const started = Date.now();
for (let i = 0; i < frames; i++) {
  const due = started + i * (1000 / FPS);
  const wait = due - Date.now();
  if (wait > 0) await win.waitForTimeout(wait);
  const { rgba, w, h } = await grab(WIDTH);
  const palette = quantize(rgba, 256, { format: 'rgb444' });
  gif.writeFrame(applyPalette(rgba, palette, 'rgb444'), w, h, { palette, delay: 1000 / FPS });
}
gif.finish();
writeFileSync(join(OUT, 'demo.gif'), gif.bytes());
const realFps = (frames / ((Date.now() - started) / 1000)).toFixed(1);

// Theme gallery screenshots (the demo keeps running while the theme switches live).
const shots = [];
for (const id of THEMES) {
  await setTheme(id);
  // Runs in the renderer, where `window` exists.
  // eslint-disable-next-line no-undef
  const current = await win.evaluate(() => window.__wscDebug?.().theme);
  if (current !== id) {
    console.warn(`theme "${id}" not available (still showing ${current}); skipped`);
    continue;
  }
  await win.waitForTimeout(1_500);
  const path = join(OUT, `theme-${id}.png`);
  await savePng(path);
  shots.push(path);
}

await app.close();
console.log(`wrote ${join(OUT, 'demo.gif')} (${frames} frames, captured at ~${realFps} fps)`);
for (const s of shots) console.log(`wrote ${s}`);
