// Dev-only art sheet: every crew anim/facing/variant plus floors, props and gear in one grid.
// Usage (devtools or a scratch entry): `app.stage.addChild(renderArtSheet(theme))`.
import { AnimatedSprite, Container, Sprite } from 'pixi.js';
import type { Dir, FloorKind } from '@shared/layoutTypes';
import type { ToolCategory } from '@shared/types';
import { CREW_ANIMS } from '../director/types';
import type { ThemeRuntime } from './types';

const FACINGS: Dir[] = ['down', 'left', 'right', 'up'];
const FLOORS: FloorKind[] = ['center', 'lounge', 'zone', 'corridor'];
const CATEGORIES: ToolCategory[] = [
  'read',
  'search',
  'write',
  'execute',
  'web',
  'delegate',
  'plan',
  'mcp',
  'other',
];
const PROPS = [
  'command_table',
  'desk',
  'chair',
  'lounge_seat',
  'nameplate',
  'door',
  'plant',
  'sofa',
  'coffee_machine',
  'console',
  'rug',
  'lamp',
  'bookshelf',
  'crate',
];

export function renderArtSheet(theme: ThemeRuntime, variants = theme.crewVariants): Container {
  const root = new Container();
  const cell = 20;
  let y = 0;

  // Crew: one row per variant × facing, one column per anim (animated).
  for (let v = 0; v < variants; v++) {
    for (const facing of FACINGS) {
      CREW_ANIMS.forEach((anim, i) => {
        const s = new AnimatedSprite({
          textures: theme.crewFrames(v, anim, facing),
          autoUpdate: true,
        });
        s.animationSpeed = theme.crewFps(anim) / 60;
        s.play();
        s.position.set(i * cell, y);
        root.addChild(s);
      });
      y += 26;
    }
    y += 4;
  }

  // Floors + wall
  let x = 0;
  for (const kind of FLOORS) {
    for (let i = 0; i < 4; i++) {
      const s = new Sprite(theme.floor(kind, i * 7, i * 3));
      s.position.set(x, y);
      root.addChild(s);
      x += 18;
    }
  }
  const wall = new Sprite(theme.wall());
  wall.position.set(x, y);
  root.addChild(wall);
  y += 24;

  // Props
  x = 0;
  for (const name of PROPS) {
    const t = theme.prop(name);
    if (!t) continue;
    const s = new Sprite(t);
    s.position.set(x, y);
    root.addChild(s);
    x += t.width + 4;
  }
  y += 52;

  // Gear
  CATEGORIES.forEach((c, i) => {
    const s = new Sprite(theme.gear(c));
    s.position.set(i * 20, y);
    root.addChild(s);
  });
  return root;
}
