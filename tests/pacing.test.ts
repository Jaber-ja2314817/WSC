import { describe, expect, it } from 'vitest';
import type { CrewAnim, CrewView, DirectorFrame } from '../src/renderer/director/types';
import {
  BUBBLE_FADE_MS,
  IDLE_FPS,
  INPUT_GRACE_MS,
  MIN_IDLE_FPS,
  MOTION_FPS,
  frameHasMotion,
  stillFps,
  targetFps,
} from '../src/renderer/scene/pacing';

const crew = (over: Partial<CrewView> = {}): CrewView => ({
  id: 'crew-1',
  isOrchestrator: false,
  label: 'crew',
  variant: 0,
  x: 1,
  y: 1,
  facing: 'down',
  anim: 'idle',
  phase: 'lounge_idle',
  status: 'idle',
  stepStartedAt: 0,
  highlight: false,
  alpha: 1,
  ...over,
});
const frame = (c: CrewView[], bubbles = 0): DirectorFrame => ({
  crew: c,
  bubbles: Array.from({ length: bubbles }, (_, i) => ({
    id: `b${i}`,
    crewId: 'crew-1',
    kind: 'status' as const,
    text: 'fake',
    bornAt: 0,
    ttlMs: 1000,
    stack: 0,
  })),
  zones: {},
});
const still = {
  hidden: false,
  motion: false,
  still: IDLE_FPS,
  sceneBusy: false,
  sinceInputMs: 60_000,
};

describe('frame pacing', () => {
  it('sees no motion in a still scene or an empty frame', () => {
    expect(frameHasMotion(null, 0)).toBe(false);
    expect(frameHasMotion(frame([crew(), crew({ anim: 'type', phase: 'working' })]), 0)).toBe(
      false,
    );
  });

  it('sees walks, arrivals and fades as motion', () => {
    expect(frameHasMotion(frame([crew({ anim: 'walk' })]), 0)).toBe(true);
    expect(frameHasMotion(frame([crew({ phase: 'walking_to_zone' })]), 0)).toBe(true);
    expect(frameHasMotion(frame([crew({ phase: 'arriving' })]), 0)).toBe(true);
    expect(frameHasMotion(frame([crew({ alpha: 0.5 })]), 0)).toBe(true);
    // Fully faded out is not a fade in progress.
    expect(frameHasMotion(frame([crew({ alpha: 0 })]), 0)).toBe(false);
  });

  it('sees a bubble as motion only while it fades out', () => {
    // bornAt 0, ttl 1000: still until 1000 - BUBBLE_FADE_MS, fading after, gone at 1000.
    const f = frame([crew()], 1);
    expect(frameHasMotion(f, 100)).toBe(false);
    expect(frameHasMotion(f, 1000 - BUBBLE_FADE_MS + 1)).toBe(true);
    expect(frameHasMotion(f, 1000)).toBe(false);
  });

  it('draws nothing while hidden', () => {
    expect(targetFps({ ...still, hidden: true, motion: true })).toBe(0);
  });

  it('idles slowly when still, smoothly when moving or busy or touched', () => {
    expect(targetFps(still)).toBe(IDLE_FPS);
    expect(targetFps({ ...still, motion: true })).toBe(MOTION_FPS);
    expect(targetFps({ ...still, sceneBusy: true })).toBe(MOTION_FPS);
    expect(targetFps({ ...still, sinceInputMs: INPUT_GRACE_MS - 1 })).toBe(MOTION_FPS);
    expect(targetFps({ ...still, sinceInputMs: INPUT_GRACE_MS })).toBe(IDLE_FPS);
  });

  it('a still scene redraws as fast as its quickest sprite loop, within limits', () => {
    const fps = (a: CrewAnim): number => ({ idle: 2, type: 6, walk: 8 })[a as string] ?? 1;
    expect(stillFps(null, fps)).toBe(MIN_IDLE_FPS);
    expect(stillFps(frame([crew()]), fps)).toBe(MIN_IDLE_FPS);
    expect(stillFps(frame([crew(), crew({ anim: 'type' })]), fps)).toBe(6);
    // Invisible crew don't count; a pulsing highlight or flashing nameplate needs IDLE_FPS.
    expect(stillFps(frame([crew({ anim: 'type', alpha: 0 })]), fps)).toBe(MIN_IDLE_FPS);
    expect(stillFps(frame([crew({ highlight: true })]), fps)).toBe(IDLE_FPS);
    const flashing = {
      ...frame([crew()]),
      zones: { z: { working: 0, waiting: 1, done: 0, flashing: true, dimmed: false } },
    };
    expect(stillFps(flashing, fps)).toBe(IDLE_FPS);
    expect(stillFps(frame([crew({ anim: 'walk' })]), () => 60)).toBe(IDLE_FPS);
    expect(targetFps({ ...still, still: 6 })).toBe(6);
    expect(targetFps({ ...still, still: 1 })).toBe(MIN_IDLE_FPS);
  });
});
