// Project grouping by working directory. Pure — runs in main and renderer.

/** Canonical form of a cwd so the same folder always maps to the same project. */
export function normalizeCwd(cwd: string): string {
  let p = String(cwd).replace(/\\/g, '/');
  // Windows drive letter: "C:/x" → "c:/x"
  p = p.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  // Strip trailing slashes but keep a bare root ("/" or "c:/").
  while (p.length > 1 && p.endsWith('/') && !/^[a-z]:\/$/.test(p)) p = p.slice(0, -1);
  return p;
}

function fnv1a(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic 12-hex-char id for a working directory. */
export function projectIdFor(cwd: string): string {
  const n = normalizeCwd(cwd);
  const a = fnv1a(n, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a(n, 0x9e3779b9).toString(16).padStart(8, '0');
  return (a + b).slice(0, 12);
}

/** Display name for a working directory: its folder basename. */
export function projectNameFor(cwd: string): string {
  const parts = normalizeCwd(cwd).split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return last && !/^[a-z]:$/.test(last) ? last : 'project';
}
