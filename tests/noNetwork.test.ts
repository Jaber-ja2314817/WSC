// Local only: a static scan of every source file for outbound network calls. Each call site
// must be on the allowlist below with a reason, and must target 127.0.0.1 / localhost.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src', 'plugin'];
const EXTS = /\.(ts|tsx|mjs|js|cjs)$/;

/** Network primitives. Matching lines must be allowlisted. */
const NETWORK_CALL =
  /\bfetch\(|\bhttps?\.(request|get)\(|from 'node:https'|require\(['"]https['"]\)|\bnet\.connect\(|new WebSocket\(|XMLHttpRequest|sendBeacon|new EventSource\(|openExternal\(/;

/** file → reason. Every listed call must hit 127.0.0.1 (or open the user's own browser). */
const ALLOWED: Record<string, string> = {
  'plugin/hooks/forward.mjs': 'forwards hook payloads to the local app on 127.0.0.1',
  'plugin/statusline/statusline.mjs': 'forwards status line rate_limits to the app on 127.0.0.1',
  'plugin/scripts/launch.mjs': 'talks to the running app on 127.0.0.1 for /station',
  'src/main/station.ts': 'Test connection: self-request to its own /v1/health on 127.0.0.1',
  'src/main/index.ts': 'external https links open in the user browser (never fetched by the app)',
  'src/main/windows.ts': 'external https links open in the user browser (never fetched by the app)',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return EXTS.test(name) ? [p] : [];
  });
}

const files = ROOTS.flatMap((r) => walk(r)).map((p) => relative('.', p).replace(/\\/g, '/'));

const hits = files.flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
    .filter((h) => NETWORK_CALL.test(h.text) && !h.text.startsWith('//')),
);

describe('no outbound network', () => {
  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('only allowlisted files contain network calls', () => {
    const unexpected = hits.filter((h) => !(h.file in ALLOWED));
    expect(unexpected, JSON.stringify(unexpected, null, 2)).toEqual([]);
  });

  it('every fetch targets 127.0.0.1', () => {
    for (const h of hits.filter((x) => /\bfetch\(/.test(x.text))) {
      expect(h.text, `${h.file}:${h.line}`).toMatch(/fetch\(`http:\/\/127\.0\.0\.1:/);
    }
  });

  it('openExternal is only used for https links, behind a check', () => {
    for (const h of hits.filter((x) => x.text.includes('openExternal('))) {
      expect(h.text, `${h.file}:${h.line}`).toMatch(/startsWith\('https:\/\/'\)/);
    }
  });

  it('servers bind to 127.0.0.1 only', () => {
    const listens = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => /\.listen\(/.test(l))
        .map((text) => ({ file, text: text.trim() })),
    );
    expect(listens.length).toBeGreaterThan(0);
    for (const l of listens) expect(l.text, l.file).toMatch(/127\.0\.0\.1|host/);
  });
});
