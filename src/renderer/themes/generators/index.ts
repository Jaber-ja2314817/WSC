// Built-in art generators, keyed by the id a theme.json names in `art.generator`.
// Adding a built-in theme: add its generator here and a folder under /themes with theme.json.
import { homeGenerator } from './home';
import { officeGenerator } from './office';
import { spaceshipGenerator } from './spaceship';
import { terminalGenerator } from './terminal';
import type { ArtGenerator } from './types';

export const BUILT_IN_GENERATORS: Readonly<Record<string, ArtGenerator>> = {
  spaceship: spaceshipGenerator,
  office: officeGenerator,
  home: homeGenerator,
  terminal: terminalGenerator,
};
