// Thin DOM/Pixi layer: PixelBuffer → canvas → nearest-scaled Texture.
import { CanvasSource, Texture } from 'pixi.js';
import type { PixelBuffer } from './pixelBuffer';

export * from './pixelBuffer';

export function bufferToCanvas(buf: PixelBuffer): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = buf.width;
  canvas.height = buf.height;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.putImageData(new ImageData(buf.data.slice(), buf.width, buf.height), 0, 0);
  return canvas;
}

/** Crisp (nearest) texture from a pixel buffer. */
export function bufferToTexture(buf: PixelBuffer): Texture {
  const source = new CanvasSource({
    resource: bufferToCanvas(buf),
    scaleMode: 'nearest',
    antialias: false,
    autoGenerateMipmaps: false,
  });
  return new Texture({ source });
}
