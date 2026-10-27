// Frame pacing: how often the station redraws. Pure — no Pixi or DOM imports.
// Crew sprite animations run at ≤ 8 fps, so a still scene only needs a slow redraw, as fast as
// its quickest sprite loop; walks, fades, camera moves and pointer input get a smooth rate.
// Hidden windows draw nothing.
import type { CrewAnim, DirectorFrame } from '../director/types';

/** Walks, fades, camera moves, pointer input. */
export const MOTION_FPS = 30;
/** Still scene with a waiting-for-you pulse (ring, blinking nameplate). Also the idle ceiling. */
export const IDLE_FPS = 10;
/** Still scene floor: elapsed-time labels and the slowest sprite loops. */
export const MIN_IDLE_FPS = 4;
/** Pointer or keyboard input keeps the motion rate this long (hover labels, tooltips). */
export const INPUT_GRACE_MS = 1_000;
/** A bubble sits still until it fades out over its last this-many ms. */
export const BUBBLE_FADE_MS = 400;

/** True while anything in the frame moves or fades. */
export function frameHasMotion(frame: DirectorFrame | null, now: number): boolean {
  if (!frame) return false;
  for (const b of frame.bubbles) {
    const left = b.bornAt + b.ttlMs - now;
    if (left > 0 && left < BUBBLE_FADE_MS) return true;
  }
  for (const c of frame.crew) {
    if (c.anim === 'walk' || c.phase.startsWith('walking') || c.phase === 'arriving') return true;
    if (c.alpha > 0 && c.alpha < 1) return true;
  }
  return false;
}

/**
 * Redraw rate a still frame needs: its fastest visible sprite loop, or IDLE_FPS while a
 * waiting-for-you highlight pulses, clamped to [MIN_IDLE_FPS, IDLE_FPS].
 */
export function stillFps(frame: DirectorFrame | null, animFps: (anim: CrewAnim) => number): number {
  if (!frame) return MIN_IDLE_FPS;
  if (Object.values(frame.zones).some((z) => z.flashing)) return IDLE_FPS;
  let fps = MIN_IDLE_FPS;
  for (const c of frame.crew) {
    if (c.alpha <= 0) continue;
    if (c.highlight) return IDLE_FPS;
    fps = Math.max(fps, animFps(c.anim));
  }
  return Math.min(IDLE_FPS, Math.ceil(fps));
}

export interface PaceInput {
  hidden: boolean;
  /** frameHasMotion() of the last frame. */
  motion: boolean;
  /** stillFps() of the last frame. */
  still: number;
  /** Camera easing, keyboard panning, zone unfolding. */
  sceneBusy: boolean;
  /** ms since the last pointer/keyboard input. */
  sinceInputMs: number;
}

/** Target redraw rate; 0 = stop drawing. */
export function targetFps(p: PaceInput): number {
  if (p.hidden) return 0;
  if (p.motion || p.sceneBusy || p.sinceInputMs < INPUT_GRACE_MS) return MOTION_FPS;
  return Math.max(MIN_IDLE_FPS, Math.min(IDLE_FPS, p.still));
}
