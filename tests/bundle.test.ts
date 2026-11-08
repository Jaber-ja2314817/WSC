import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The packaged app ships no node_modules (electron-builder.yml), so an external import in the main
// process crashes it before any window opens. Running from the repo hides that: Node finds the
// package in the repo's node_modules. `npm run build` first; CI builds before testing.
const MAIN = resolve('out/main/index.js');
const built = existsSync(MAIN);

function externalImports(code: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /^\s*import\s[^'"]*?from\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) found.add(m[1]!);
  return [...found];
}

describe('externalImports', () => {
  it('finds every import form', () => {
    const code = [
      'import { z } from "zod";',
      'import "side-effect";',
      'const a = await import("lazy");',
      'const b = require("old");',
    ].join('\n');
    expect(externalImports(code).sort()).toEqual(['lazy', 'old', 'side-effect', 'zod']);
  });
});

describe('main process bundle', () => {
  it('is required on CI', () => {
    if (process.env['CI']) expect(built).toBe(true);
  });

  it.skipIf(!built)('imports only electron, node:* and its own chunks', () => {
    const bad = externalImports(readFileSync(MAIN, 'utf8')).filter(
      (m) => m !== 'electron' && !m.startsWith('node:') && !m.startsWith('.'),
    );
    expect(bad).toEqual([]);
  });
});
