// Privacy: turn raw tool input into a short, sanitized summary.
// Used for both the side panel and speech bubbles.

const MASK = '•••';

const PATTERNS: Array<[RegExp, string]> = [
  // URL userinfo: https://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // Authorization headers / bearer tokens
  [/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s'"]+/gi, `$1${MASK}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`],
  // key=value / key: value secrets
  [
    /\b([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key)[A-Za-z0-9_-]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;]+)/gi,
    `$1${MASK}`,
  ],
  // Credential flags: curl -u user:pass / --user user:pass, --password value, --token value
  [/(\s(?:-u|--user)\s+)[^\s:]+:\S+/g, `$1${MASK}`],
  [/(--?(?:password|passwd|pass|token|secret|api-?key)\s+)(?!-)\S+/gi, `$1${MASK}`],
  // Well-known token shapes
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, MASK],
  [/\bxox[abpr]-[A-Za-z0-9-]{8,}/g, MASK],
  [/\bAKIA[0-9A-Z]{12,}/g, MASK],
];

// Long hex / base64-ish blobs; only masked when they contain a digit, so long
// identifiers survive. Checked in a callback to keep matching linear.
const BLOB = /[A-Za-z0-9+_=-]{32,}/g;

/** Upper bound on input scanned; summaries are short, and this keeps regexes cheap. */
const MAX_SCAN = 4096;

export function redactSecrets(text: string): string {
  if (typeof text !== 'string') return '';
  let out = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out.replace(BLOB, (m) => (/\d/.test(m) ? MASK : m));
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine;
}

function str(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function hostname(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Short sanitized summary of a tool call; undefined when nothing safe to show. Never throws. */
export function summarizeTool(
  name: string,
  input: unknown,
  opts?: { full?: boolean; max?: number },
): string | undefined {
  try {
    const max = opts?.full ? Math.max(opts.max ?? 0, 200) : (opts?.max ?? 60);
    const clean = (s: string | undefined): string | undefined =>
      s === undefined ? undefined : truncate(redactSecrets(s), max);
    switch (name) {
      case 'Read':
      case 'Edit':
      case 'Write':
      case 'MultiEdit':
      case 'NotebookEdit':
      case 'NotebookRead': {
        const p = str(input, 'file_path') ?? str(input, 'notebook_path') ?? str(input, 'path');
        return p ? clean(basename(p)) : undefined;
      }
      case 'Grep':
      case 'Glob':
        return clean(str(input, 'pattern'));
      case 'Bash':
      case 'PowerShell':
        return clean(str(input, 'command'));
      case 'WebFetch': {
        const u = str(input, 'url');
        return u ? clean(hostname(u)) : undefined;
      }
      case 'WebSearch':
        return clean(str(input, 'query'));
      case 'Task':
      case 'Agent':
        return clean(str(input, 'subagent_type') ?? str(input, 'description'));
      default: {
        if (typeof name === 'string' && name.startsWith('mcp__')) {
          const [, server, ...rest] = name.split('__');
          if (server && rest.length) return clean(`${server}: ${rest.join('__')}`);
        }
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
}
