import { describe, expect, it } from 'vitest';
import { CommandGate, decideTheme } from '../src/main/rendererLink';

const THEME_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function gate(maxQueued?: number) {
  const sent: [string, string][] = [];
  const g = new CommandGate<string, string>((t, c) => sent.push([t, c]), maxQueued);
  return { g, sent };
}

describe('CommandGate', () => {
  it('holds commands sent before the renderer listens, even with a loaded window', () => {
    const { g, sent } = gate();
    g.send('win', 'a');
    g.send(null, 'b');
    expect(sent).toEqual([]);
    g.markReady('win');
    expect(sent).toEqual([
      ['win', 'a'],
      ['win', 'b'],
    ]);
  });

  it('sends straight through once ready', () => {
    const { g, sent } = gate();
    g.markReady('win');
    g.send('win', 'a');
    expect(sent).toEqual([['win', 'a']]);
  });

  it('holds commands for a replacement window until that one is ready', () => {
    const { g, sent } = gate();
    g.markReady('old');
    g.send('new', 'a');
    expect(sent).toEqual([]);
    g.markReady('new');
    expect(sent).toEqual([['new', 'a']]);
  });

  it('holds commands while a window reloads', () => {
    const { g, sent } = gate();
    g.markReady('win');
    g.markLoading('win');
    g.send('win', 'a');
    expect(sent).toEqual([]);
    g.markReady('win');
    expect(sent).toEqual([['win', 'a']]);
  });

  it('keeps only the newest commands when nothing ever listens', () => {
    const { g, sent } = gate(2);
    for (const c of ['a', 'b', 'c']) g.send(null, c);
    g.markReady('win');
    expect(sent.map(([, c]) => c)).toEqual(['b', 'c']);
  });
});

describe('decideTheme', () => {
  it('defers until the renderer reported its themes, so built-ins are not called unknown', () => {
    expect(decideTheme('office', ['spaceship'], false, THEME_ID)).toBe('defer');
    expect(decideTheme('office', ['spaceship', 'office'], true, THEME_ID)).toBe('known');
  });

  it('calls out an id nobody knows and refuses a malformed one', () => {
    expect(decideTheme('typo', ['spaceship'], true, THEME_ID)).toBe('unknown');
    expect(decideTheme('../etc', ['spaceship'], false, THEME_ID)).toBe('invalid');
  });
});
