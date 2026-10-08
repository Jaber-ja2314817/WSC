// Crew sprite generator — pure (PixelBuffer only, no DOM/Pixi), unit-tested.
//
// Sprite: CREW_W × CREW_H (16 × 24) px. Feet anchor = bottom-center: pixel (8, 23), i.e. Pixi
// anchor (0.5, 1) placed at the bottom-center of the crew member's tile. Rows 0–4 are reserved
// for status icons (!, ?, …, waves, sparkles); the hair starts at row 5.
//
// Themes reuse this with a CrewStyle (outfit palettes + uniform kind), so every theme gets every
// CrewAnim × facing × variant without hand-drawn art.
import type { Dir } from '@shared/layoutTypes';
import type { CrewAnim } from '../director/types';
import { PixelBuffer, hex, shade, type RGBA } from './pixelBuffer';

export const CREW_W = 16;
export const CREW_H = 24;
/** Feet pixel; use Pixi anchor (0.5, 1). */
export const CREW_FEET = { x: 8, y: 23 } as const;

export type Uniform = 'jumpsuit' | 'casual' | 'mono';
export type Accessory = 'none' | 'glasses' | 'badge' | 'cap' | 'headband';

export interface CrewStyle {
  /** [main, accent] outfit colors, cycled by variant. */
  outfits: [string, string][];
  uniform: Uniform;
  pants?: string;
  shoes?: string;
  outline?: string;
  skins?: string[];
  hairs?: string[];
  /** For `mono`: [dark, mid, light] used for every part. */
  mono?: [string, string, string];
  icons?: Partial<Record<'error' | 'wait' | 'think' | 'comms' | 'celebrate', string>>;
}

export interface CrewVariant {
  skin: RGBA;
  hair: RGBA;
  hairStyle: 0 | 1 | 2 | 3;
  outfit: RGBA;
  accent: RGBA;
  pants: RGBA;
  shoes: RGBA;
  accessory: Accessory;
}

const DEFAULT_SKINS = ['#f6d0b1', '#e8b48f', '#d39a6a', '#a8693f', '#7a4a2a', '#5a3620'];
const DEFAULT_HAIRS = [
  '#2a1b12',
  '#5b3a1e',
  '#a0642a',
  '#d9b44a',
  '#e8e4d8',
  '#b8433a',
  '#3d4a8a',
  '#2f7a6a',
  '#c46aa0',
];
const ACCESSORIES: Accessory[] = [
  'none',
  'glasses',
  'badge',
  'cap',
  'none',
  'headband',
  'glasses',
  'badge',
];

const FRAME_COUNTS: Record<CrewAnim, number> = {
  idle: 4,
  walk: 4,
  sit: 2,
  type: 2,
  read: 2,
  scan: 3,
  terminal: 2,
  comms: 2,
  report: 2,
  celebrate: 2,
  error: 2,
  wait: 2,
  think: 3,
};

const FPS: Record<CrewAnim, number> = {
  idle: 2,
  walk: 8,
  sit: 1,
  type: 6,
  read: 1.5,
  scan: 2,
  terminal: 5,
  comms: 3,
  report: 3,
  celebrate: 5,
  error: 3,
  wait: 2,
  think: 3,
};

export const crewFrameCount = (anim: CrewAnim): number => FRAME_COUNTS[anim] ?? 1;
export const crewAnimFps = (anim: CrewAnim): number => FPS[anim] ?? 2;

/** Deterministic appearance variants for a style. */
export function crewVariants(style: CrewStyle, count = 8): CrewVariant[] {
  const out: CrewVariant[] = [];
  const outfits: [string, string][] =
    style.outfits.length > 0 ? style.outfits : [['#3d6fb6', '#f2c14e']];
  if (style.uniform === 'mono') {
    const [dark, mid, light] = style.mono ?? ['#0f3b1f', '#2fae5a', '#9bffb8'];
    for (let i = 0; i < count; i++) {
      out.push({
        skin: hex(light),
        hair: hex(mid),
        hairStyle: (i % 4) as CrewVariant['hairStyle'],
        outfit: hex(mid),
        accent: hex(light),
        pants: hex(dark),
        shoes: hex(dark),
        accessory: ACCESSORIES[i % ACCESSORIES.length] ?? 'none',
      });
    }
    return out;
  }
  const skins = style.skins?.length ? style.skins : DEFAULT_SKINS;
  const hairs = style.hairs?.length ? style.hairs : DEFAULT_HAIRS;
  for (let i = 0; i < count; i++) {
    const [main, accent] = outfits[i % outfits.length] ?? ['#3d6fb6', '#f2c14e'];
    const outfit = hex(main);
    out.push({
      skin: hex(skins[(i * 5 + 1) % skins.length] ?? DEFAULT_SKINS[0]!),
      hair: hex(hairs[(i * 3 + 1) % hairs.length] ?? DEFAULT_HAIRS[0]!),
      hairStyle: (i % 4) as CrewVariant['hairStyle'],
      outfit,
      accent: hex(accent),
      pants: style.uniform === 'jumpsuit' ? shade(outfit, 0.78) : hex(style.pants ?? '#3a3f5c'),
      shoes: hex(style.shoes ?? '#23243a'),
      accessory: ACCESSORIES[i % ACCESSORIES.length] ?? 'none',
    });
  }
  return out;
}

type Arm = 'down' | 'swingF' | 'swingB' | 'fwd' | 'fwdHigh' | 'up' | 'out' | 'ear' | 'chin';
type Eyes = 'open' | 'left' | 'right' | 'closed';
type Icon = 'error' | 'wait' | 'think' | 'comms' | 'celebrate';

interface Pose {
  seated: boolean;
  /** Walk leg phase 0–3. */
  legs: number;
  armL: Arm;
  armR: Arm;
  eyes: Eyes;
  headset: boolean;
  pad: boolean;
  padGlow: boolean;
  /** Whole-body lift in px (celebrate jump). */
  lift: number;
  icon?: Icon;
}

const base = (over: Partial<Pose>): Pose => ({
  seated: false,
  legs: 0,
  armL: 'down',
  armR: 'down',
  eyes: 'open',
  headset: false,
  pad: false,
  padGlow: false,
  lift: 0,
  ...over,
});

function poseFor(anim: CrewAnim, f: number): Pose {
  switch (anim) {
    case 'idle':
      return base({ eyes: f === 3 ? 'closed' : 'open' });
    case 'walk': {
      const swing: [Arm, Arm] =
        f === 0 ? ['swingF', 'swingB'] : f === 2 ? ['swingB', 'swingF'] : ['down', 'down'];
      return base({ legs: f, armL: swing[0], armR: swing[1] });
    }
    case 'sit':
      return base({ seated: true, eyes: f === 1 ? 'closed' : 'open' });
    case 'type':
      return base({ seated: true, armL: f ? 'fwdHigh' : 'fwd', armR: f ? 'fwd' : 'fwdHigh' });
    case 'read':
      return base({
        seated: true,
        armL: 'fwd',
        armR: 'fwd',
        pad: true,
        padGlow: f === 1,
        eyes: f ? 'right' : 'left',
      });
    case 'scan':
      return base({
        seated: true,
        armL: 'fwd',
        armR: 'fwd',
        eyes: (['left', 'open', 'right'] as const)[f] ?? 'open',
      });
    case 'terminal':
      return base({ seated: true, armL: f ? 'fwd' : 'fwdHigh', armR: f ? 'fwd' : 'fwdHigh' });
    case 'comms':
      return base({ seated: true, headset: true, armL: 'ear', armR: 'fwd', icon: 'comms' });
    case 'report':
      return base({ armR: f ? 'fwdHigh' : 'out', eyes: 'open' });
    case 'celebrate':
      return base({ armL: 'up', armR: 'up', lift: f, icon: 'celebrate' });
    case 'error':
      return base({ armL: 'ear', armR: 'ear', icon: 'error', eyes: f ? 'closed' : 'open' });
    case 'wait':
      return base({ armR: 'up', icon: 'wait' });
    case 'think':
      return base({ seated: true, armR: 'chin', icon: 'think' });
    default:
      return base({});
  }
}

const EYE = hex('#1a1c2c');
const GLASS_FRAME = hex('#2a2f45');
const GLASS_LENS = hex('#bfe9ff');
const HEADSET = hex('#2b2e3f');
const PAD_FRAME = hex('#2a2f45');

function drawHair(b: PixelBuffer, v: CrewVariant, facing: Dir, y0: number): void {
  const h = v.hair;
  const hs = shade(h, 0.8);
  if (facing === 'up') {
    b.fillRect(5, 5 + y0, 6, 6, h).fillRect(6, 10 + y0, 4, 1, hs);
    if (v.hairStyle === 1)
      b.fillRect(5, 11 + y0, 6, 2, hs)
        .fillRect(4, 6 + y0, 1, 5, h)
        .fillRect(11, 6 + y0, 1, 5, h);
  } else if (facing === 'down') {
    b.fillRect(5, 5 + y0, 6, 2, h)
      .set(5, 7 + y0, h)
      .set(10, 7 + y0, h);
    if (v.hairStyle === 0) b.set(6, 7 + y0, hs);
    if (v.hairStyle === 1)
      b.fillRect(4, 6 + y0, 1, 6, h)
        .fillRect(11, 6 + y0, 1, 6, h)
        .set(5, 8 + y0, h)
        .set(10, 8 + y0, h);
    if (v.hairStyle === 2) b.fillRect(6, 7 + y0, 4, 1, hs);
  } else {
    // left-facing profile (right is mirrored): back of the head is on the right.
    b.fillRect(5, 5 + y0, 6, 2, h)
      .fillRect(8, 7 + y0, 3, 3, h)
      .set(5, 7 + y0, hs);
    if (v.hairStyle === 1)
      b.fillRect(9, 10 + y0, 3, 3, h)
        .set(11, 7 + y0, h)
        .set(11, 8 + y0, h);
  }
  if (v.hairStyle === 2) {
    for (const x of [5, 7, 9]) b.set(x + (facing === 'left' ? 1 : 0), 4 + y0, h);
  }
  if (v.hairStyle === 3) {
    const bx = facing === 'left' ? 9 : 7;
    b.fillRect(bx, 3 + y0, 2, 2, h).set(bx, 3 + y0, hs);
  }
}

function drawAccessory(b: PixelBuffer, v: CrewVariant, facing: Dir, y0: number): void {
  switch (v.accessory) {
    case 'glasses':
      if (facing === 'down') {
        b.fillRect(5, 9 + y0, 6, 1, GLASS_FRAME)
          .set(6, 9 + y0, GLASS_LENS)
          .set(9, 9 + y0, GLASS_LENS);
      } else if (facing === 'left') {
        b.fillRect(5, 9 + y0, 3, 1, GLASS_FRAME).set(6, 9 + y0, GLASS_LENS);
      }
      break;
    case 'cap':
      b.fillRect(5, 4 + y0, 6, 2, v.accent);
      if (facing === 'down') b.fillRect(5, 6 + y0, 6, 1, shade(v.accent, 0.75));
      if (facing === 'left') b.fillRect(3, 6 + y0, 4, 1, shade(v.accent, 0.75));
      break;
    case 'headband':
      b.fillRect(5, 6 + y0, 6, 1, v.accent);
      break;
    default:
      break;
  }
}

/** Front/back arm on one side. side -1 = left (x=4), +1 = right (x=11). */
function drawArmFront(
  b: PixelBuffer,
  v: CrewVariant,
  arm: Arm,
  side: -1 | 1,
  y0: number,
  back: boolean,
): void {
  const x = side < 0 ? 4 : 11;
  const inX = x - side; // toward the body
  const sleeve = shade(v.outfit, 0.9);
  const hand = v.skin;
  switch (arm) {
    case 'down':
    case 'swingB':
      b.fillRect(x, 13 + y0, 1, 4, sleeve).set(x, 17 + y0, hand);
      break;
    case 'swingF':
      b.fillRect(x, 13 + y0, 1, 3, sleeve).set(x, 16 + y0, hand);
      break;
    case 'fwd':
      b.fillRect(x, 13 + y0, 1, 2, sleeve).set(inX, 15 + y0, sleeve);
      if (!back) b.set(inX, 16 + y0, hand);
      break;
    case 'fwdHigh':
      b.fillRect(x, 13 + y0, 1, 2, sleeve);
      if (!back) b.set(inX, 14 + y0, hand);
      else b.set(inX, 14 + y0, sleeve);
      break;
    case 'up':
      b.fillRect(x, 9 + y0, 1, 4, sleeve).set(x, 8 + y0, hand);
      break;
    case 'out':
      b.fillRect(x, 13 + y0, 1, 2, sleeve)
        .fillRect(side < 0 ? x - 2 : x + 1, 14 + y0, 2, 1, sleeve)
        .set(side < 0 ? x - 3 : x + 3, 14 + y0, hand);
      break;
    case 'ear':
      b.fillRect(x, 11 + y0, 1, 3, sleeve).set(x, 10 + y0, hand);
      break;
    case 'chin':
      b.fillRect(x, 13 + y0, 1, 2, sleeve).set(inX, 12 + y0, hand);
      break;
  }
}

/** The single visible arm in a left-facing profile. */
function drawArmSide(b: PixelBuffer, v: CrewVariant, arm: Arm, y0: number): void {
  const sleeve = shade(v.outfit, 0.82);
  const hand = v.skin;
  switch (arm) {
    case 'down':
      b.fillRect(8, 13 + y0, 1, 4, sleeve).set(8, 17 + y0, hand);
      break;
    case 'swingF':
      b.fillRect(8, 13 + y0, 1, 2, sleeve)
        .set(7, 15 + y0, sleeve)
        .set(6, 16 + y0, hand);
      break;
    case 'swingB':
      b.fillRect(8, 13 + y0, 1, 2, sleeve)
        .set(9, 15 + y0, sleeve)
        .set(10, 16 + y0, hand);
      break;
    case 'fwd':
      b.fillRect(8, 13 + y0, 1, 2, sleeve)
        .fillRect(6, 15 + y0, 2, 1, sleeve)
        .set(5, 15 + y0, hand);
      break;
    case 'fwdHigh':
      b.fillRect(8, 13 + y0, 1, 1, sleeve)
        .fillRect(6, 14 + y0, 2, 1, sleeve)
        .set(5, 14 + y0, hand);
      break;
    case 'up':
      b.fillRect(8, 9 + y0, 1, 4, sleeve).set(8, 8 + y0, hand);
      break;
    case 'out':
      b.fillRect(8, 13 + y0, 1, 1, sleeve)
        .fillRect(5, 14 + y0, 4, 1, sleeve)
        .set(4, 14 + y0, hand);
      break;
    case 'ear':
      b.fillRect(8, 11 + y0, 1, 3, sleeve).set(8, 10 + y0, hand);
      break;
    case 'chin':
      b.fillRect(8, 13 + y0, 1, 2, sleeve)
        .set(7, 12 + y0, sleeve)
        .set(6, 11 + y0, hand);
      break;
  }
}

function drawLegs(b: PixelBuffer, v: CrewVariant, facing: Dir, p: Pose, lift: number): void {
  const pants = v.pants;
  const shoes = v.shoes;
  const back = shade(pants, 0.8);
  if (p.seated) {
    if (facing === 'left') {
      b.fillRect(4, 21 - lift, 5, 2, pants)
        .fillRect(3, 22 - lift, 2, 1, pants)
        .fillRect(2, 23 - lift, 3, 1, shoes);
    } else {
      b.fillRect(5, 21 - lift, 6, 2, pants)
        .fillRect(5, 23 - lift, 2, 1, shoes)
        .fillRect(9, 23 - lift, 2, 1, shoes);
    }
    return;
  }
  if (facing === 'left') {
    if (p.legs === 1 || p.legs === 3) {
      const front = p.legs === 1 ? pants : back;
      const rear = p.legs === 1 ? back : pants;
      b.fillRect(6, 18 - lift, 4, 1, pants);
      b.fillRect(9, 19 - lift, 2, 4, rear).fillRect(9, 23 - lift, 3, 1, shoes);
      b.fillRect(5, 19 - lift, 2, 4, front).fillRect(4, 23 - lift, 3, 1, shoes);
    } else {
      b.fillRect(7, 18 - lift, 2, 5, pants).fillRect(5, 23 - lift, 4, 1, shoes);
    }
    return;
  }
  // front / back views
  const lifted = (side: -1 | 1): boolean =>
    (p.legs === 1 && side < 0) || (p.legs === 3 && side > 0);
  for (const side of [-1, 1] as const) {
    const lx = side < 0 ? 6 : 8;
    const fx = side < 0 ? 5 : 8;
    const up = lifted(side) ? 1 : 0;
    b.fillRect(lx, 18 - lift, 2, 5 - up, side < 0 ? pants : shade(pants, 0.92));
    b.fillRect(fx, 23 - lift - up, 3, 1, shoes);
  }
}

function drawIcon(b: PixelBuffer, icon: Icon, f: number, style: CrewStyle): void {
  const dark = hex('#141526');
  const col = (k: Icon, d: string): RGBA => hex(style.icons?.[k] ?? d);
  switch (icon) {
    case 'error': {
      const c = f ? shade(col('error', '#ff4d5e'), 1.25) : col('error', '#ff4d5e');
      b.fillRect(7, 0, 2, 3, c).fillRect(7, 4, 2, 1, c);
      b.set(6, 0, dark)
        .set(9, 0, dark)
        .set(6, 1, dark)
        .set(9, 1, dark)
        .set(6, 2, dark)
        .set(9, 2, dark);
      break;
    }
    case 'wait': {
      const c = col('wait', '#ffcc4d');
      const dx = f ? 1 : 0;
      b.fillRect(6 + dx, 0, 3, 1, c)
        .set(9 + dx, 1, c)
        .set(8 + dx, 2, c)
        .set(8 + dx, 4, c);
      break;
    }
    case 'think': {
      const c = col('think', '#e6ecff');
      for (let i = 0; i <= f && i < 3; i++) b.set(5 + i * 3, 3, c);
      break;
    }
    case 'comms': {
      const c = col('comms', '#4fd8ff');
      if (f === 0) b.set(13, 7, c).set(13, 8, c);
      else b.set(13, 7, c).set(13, 8, c).set(14, 6, c).set(15, 7, c).set(15, 8, c).set(14, 9, c);
      break;
    }
    case 'celebrate': {
      const c = col('celebrate', '#ffe066');
      const pts = f
        ? [
            [2, 1],
            [13, 3],
          ]
        : [
            [3, 3],
            [12, 1],
          ];
      for (const [x, y] of pts) {
        b.set(x!, y!, c)
          .set(x! - 1, y!, c)
          .set(x! + 1, y!, c)
          .set(x!, y! - 1, c)
          .set(x!, y! + 1, c);
      }
      break;
    }
  }
}

/** Draw one crew frame. `frame` is taken modulo crewFrameCount(anim). */
export function drawCrewFrame(
  v: CrewVariant,
  style: CrewStyle,
  anim: CrewAnim,
  facing: Dir,
  frame: number,
): PixelBuffer {
  const n = crewFrameCount(anim);
  const f = ((frame % n) + n) % n;
  const p = poseFor(anim, f);
  const profile: Dir = facing === 'right' ? 'left' : facing;
  const b = new PixelBuffer(CREW_W, CREW_H);
  const lift = p.lift;
  const y0 = (p.seated ? 3 : 0) - lift;
  const skinShade = shade(v.skin, 0.85);

  drawLegs(b, v, profile, p, lift);

  // Torso
  if (profile === 'left') {
    b.fillRect(6, 13 + y0, 4, 5, v.outfit).fillRect(9, 13 + y0, 1, 5, shade(v.outfit, 0.82));
    if (style.uniform === 'jumpsuit')
      b.set(6, 13 + y0, v.accent).fillRect(6, 17 + y0, 4, 1, shade(v.accent, 0.8));
  } else {
    b.fillRect(5, 13 + y0, 6, 5, v.outfit);
    b.fillRect(profile === 'up' ? 5 : 10, 13 + y0, 1, 5, shade(v.outfit, 0.82));
    if (style.uniform === 'jumpsuit') {
      if (profile === 'down') b.fillRect(7, 13 + y0, 2, 1, v.accent);
      b.fillRect(5, 17 + y0, 6, 1, shade(v.accent, 0.8));
    } else if (style.uniform === 'casual' && profile === 'down') {
      b.set(7, 13 + y0, shade(v.outfit, 1.2)).set(8, 13 + y0, shade(v.outfit, 1.2));
    }
    if (v.accessory === 'badge' && profile === 'down') b.set(9, 14 + y0, v.accent);
  }

  // Head
  b.fillRect(5, 6 + y0, 6, 6, v.skin);
  b.fillRect(7, 12 + y0, 2, 1, skinShade);
  if (profile === 'left') b.set(4, 9 + y0, v.skin).set(4, 10 + y0, skinShade);
  drawHair(b, v, profile, y0);

  // Eyes
  if (profile === 'down') {
    const ex = p.eyes === 'left' ? -1 : p.eyes === 'right' ? 1 : 0;
    const c = p.eyes === 'closed' ? skinShade : EYE;
    b.set(6 + ex, 9 + y0, c).set(9 + ex, 9 + y0, c);
    b.set(7, 11 + y0, skinShade).set(8, 11 + y0, skinShade);
  } else if (profile === 'left') {
    const ex = p.eyes === 'left' ? -1 : p.eyes === 'right' ? 1 : 0;
    b.set(6 + ex, 9 + y0, p.eyes === 'closed' ? skinShade : EYE);
  }
  drawAccessory(b, v, profile, y0);

  // Headset
  if (p.headset) {
    b.fillRect(5, 5 + y0, 6, 1, HEADSET);
    if (profile === 'left')
      b.fillRect(8, 8 + y0, 2, 2, HEADSET).line(8, 10 + y0, 5, 11 + y0, HEADSET);
    else b.fillRect(4, 8 + y0, 1, 2, HEADSET).fillRect(11, 8 + y0, 1, 2, HEADSET);
    if (profile === 'down') b.set(5, 11 + y0, HEADSET);
  }

  // Arms + held pad
  if (profile === 'left') {
    if (p.pad)
      b.fillRect(2, 13 + y0, 3, 4, PAD_FRAME).fillRect(
        3,
        14 + y0,
        1,
        2,
        p.padGlow ? shade(v.accent, 1.3) : v.accent,
      );
    drawArmSide(b, v, p.armR, y0);
  } else {
    const back = profile === 'up';
    if (p.pad && !back) {
      b.fillRect(5, 14 + y0, 6, 3, PAD_FRAME).fillRect(
        6,
        15 + y0,
        4,
        1,
        p.padGlow ? shade(v.accent, 1.3) : v.accent,
      );
    }
    drawArmFront(b, v, p.armL, -1, y0, back);
    drawArmFront(b, v, p.armR, 1, y0, back);
  }

  b.outline(hex(style.outline ?? '#141526'));

  const out = facing === 'right' ? b.mirrorX() : b;
  if (p.icon) drawIcon(out, p.icon, f, style);
  return out;
}

export interface CrewFrameSet {
  variants: CrewVariant[];
  /** Key: `${variant}:${anim}:${facing}` → frames. */
  frames: Map<string, PixelBuffer[]>;
}

export const crewKey = (variant: number, anim: CrewAnim, facing: Dir): string =>
  `${variant}:${anim}:${facing}`;

/** Every frame for every variant/anim/facing (pure). */
export function generateCrewSet(
  style: CrewStyle,
  anims: readonly CrewAnim[],
  count = 8,
): CrewFrameSet {
  const variants = crewVariants(style, count);
  const frames = new Map<string, PixelBuffer[]>();
  const facings: Dir[] = ['down', 'left', 'right', 'up'];
  variants.forEach((v, vi) => {
    for (const anim of anims) {
      for (const facing of facings) {
        const list: PixelBuffer[] = [];
        for (let f = 0; f < crewFrameCount(anim); f++)
          list.push(drawCrewFrame(v, style, anim, facing, f));
        frames.set(crewKey(vi, anim, facing), list);
      }
    }
  });
  return { variants, frames };
}
