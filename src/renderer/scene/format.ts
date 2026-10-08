// Small pure helpers for scene labels (kept separate so they're testable without Pixi).
import type { ZoneStatusView } from '../director/types';

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function truncateLabel(label: string, max = 14): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export function zoneSummary(z: ZoneStatusView | undefined): string {
  if (!z) return '';
  const parts: string[] = [];
  if (z.working) parts.push(`▶${z.working}`);
  if (z.waiting) parts.push(`⏸${z.waiting}`);
  if (z.done) parts.push(`✓${z.done}`);
  return parts.join(' ');
}

export interface Box {
  /** Center x. */
  x: number;
  /** Bottom y (screen px, y grows downward). */
  bottom: number;
  w: number;
  h: number;
}

/**
 * Greedy de-overlap for speech bubbles: boxes are processed bottom-up and each one is lifted
 * above any already-placed box it would intersect. Returns the adjusted bottoms, in input order.
 */
export function stackBoxes(boxes: Box[], gap = 3): number[] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b]!.bottom - boxes[a]!.bottom);
  const placed: { l: number; r: number; t: number; b: number }[] = [];
  const out = boxes.map((b) => b.bottom);
  for (const i of order) {
    const box = boxes[i]!;
    const l = box.x - box.w / 2;
    const r = box.x + box.w / 2;
    let bottom = box.bottom;
    for (let guard = 0; guard < 64; guard++) {
      const top = bottom - box.h;
      const hit = placed.find((p) => l < p.r && r > p.l && top < p.b + gap && bottom > p.t - gap);
      if (!hit) break;
      bottom = hit.t - gap;
    }
    placed.push({ l, r, t: bottom - box.h, b: bottom });
    out[i] = bottom;
  }
  return out;
}
