// DOM-free RGBA pixel buffer used by the art generators. Unit-tested; textures are made in pixel.ts.

/** Packed 0xRRGGBBAA. 0 = fully transparent. */
export type RGBA = number;

export const CLEAR: RGBA = 0;

/** '#rrggbb' (or '#rrggbbaa') → packed RGBA. Invalid input → transparent. */
export function hex(color: string, alpha = 255): RGBA {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (!m || !m[1]) return CLEAR;
  const rgb = parseInt(m[1], 16);
  const a = m[2] ? parseInt(m[2], 16) : alpha;
  return ((rgb << 8) | (a & 0xff)) >>> 0;
}

export function rgbaChannels(c: RGBA): [number, number, number, number] {
  return [(c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff];
}

export function packRgba(r: number, g: number, b: number, a = 255): RGBA {
  const cl = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return ((cl(r) << 24) | (cl(g) << 16) | (cl(b) << 8) | cl(a)) >>> 0;
}

/** Multiply RGB by `factor` (<1 darker, >1 lighter); alpha kept. */
export function shade(c: RGBA, factor: number): RGBA {
  const [r, g, b, a] = rgbaChannels(c);
  if (factor <= 1) return packRgba(r * factor, g * factor, b * factor, a);
  const t = factor - 1;
  return packRgba(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t, a);
}

/** Linear blend of two colors. */
export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  const ca = rgbaChannels(a);
  const cb = rgbaChannels(b);
  return packRgba(
    ca[0] + (cb[0] - ca[0]) * t,
    ca[1] + (cb[1] - ca[1]) * t,
    ca[2] + (cb[2] - ca[2]) * t,
    ca[3] + (cb[3] - ca[3]) * t,
  );
}

/** Deterministic 0..1 hash of integer coordinates (per-tile variation, starfields). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class PixelBuffer {
  readonly data: Uint8ClampedArray<ArrayBuffer>;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): RGBA {
    if (!this.inBounds(x, y)) return CLEAR;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    return packRgba(d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0, d[i + 3] ?? 0);
  }

  /** Opaque enough to count as part of the shape. */
  isSolid(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.data[(y * this.width + x) * 4 + 3]! > 0;
  }

  /** Set one pixel; out-of-bounds writes are ignored. Coordinates are floored. */
  set(x: number, y: number, c: RGBA): this {
    x = Math.floor(x);
    y = Math.floor(y);
    if (!this.inBounds(x, y)) return this;
    const i = (y * this.width + x) * 4;
    this.data[i] = (c >>> 24) & 0xff;
    this.data[i + 1] = (c >>> 16) & 0xff;
    this.data[i + 2] = (c >>> 8) & 0xff;
    this.data[i + 3] = c & 0xff;
    return this;
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGBA): this {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c);
    return this;
  }

  /** 1px rectangle border. */
  strokeRect(x: number, y: number, w: number, h: number, c: RGBA): this {
    if (w <= 0 || h <= 0) return this;
    this.line(x, y, x + w - 1, y, c).line(x, y + h - 1, x + w - 1, y + h - 1, c);
    this.line(x, y, x, y + h - 1, c).line(x + w - 1, y, x + w - 1, y + h - 1, c);
    return this;
  }

  /** Bresenham line, inclusive of both ends. */
  line(x0: number, y0: number, x1: number, y1: number, c: RGBA): this {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
    return this;
  }

  /** Filled circle-ish disc (pixel-art friendly). */
  disc(cx: number, cy: number, r: number, c: RGBA): this {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++)
        if (x * x + y * y <= r * r + r * 0.6) this.set(cx + x, cy + y, c);
    return this;
  }

  /**
   * Draw a 1px outline in `c` around every solid shape: transparent pixels 4-adjacent to a solid
   * pixel become `c`. Operates on a snapshot so the outline never grows twice.
   */
  outline(c: RGBA): this {
    const snap = this.clone();
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (snap.isSolid(x, y)) continue;
        if (
          snap.isSolid(x - 1, y) ||
          snap.isSolid(x + 1, y) ||
          snap.isSolid(x, y - 1) ||
          snap.isSolid(x, y + 1)
        ) {
          this.set(x, y, c);
        }
      }
    }
    return this;
  }

  /** New buffer flipped horizontally. */
  mirrorX(): PixelBuffer {
    const out = new PixelBuffer(this.width, this.height);
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) out.set(this.width - 1 - x, y, this.get(x, y));
    return out;
  }

  /** Copy `src` onto this buffer at (dx, dy); transparent source pixels are skipped. */
  blit(src: PixelBuffer, dx: number, dy: number): this {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        if (src.isSolid(x, y)) this.set(dx + x, dy + y, src.get(x, y));
      }
    }
    return this;
  }

  /** Replace every pixel of color `from` with `to`. */
  recolor(from: RGBA, to: RGBA): this {
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) if (this.get(x, y) === from) this.set(x, y, to);
    return this;
  }

  clone(): PixelBuffer {
    const out = new PixelBuffer(this.width, this.height);
    out.data.set(this.data);
    return out;
  }

  /** Count of solid pixels (tests, sanity checks). */
  solidCount(): number {
    let n = 0;
    for (let i = 3; i < this.data.length; i += 4) if (this.data[i]! > 0) n++;
    return n;
  }
}
