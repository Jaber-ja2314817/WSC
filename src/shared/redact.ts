// Privacy: turn raw tool input into a short, sanitized summary.
// Used for both the side panel and speech bubbles.

const MASK = '•••';

// Over-masking only costs a little readability, so where a value's end is ambiguous these rules
// mask too much rather than too little. Every quantifier that can repeat is bounded or consumes
// what it matches, so scanning stays linear: this runs on the main process for every tool call.

/**
 * A shell or JSON string value. An unterminated one runs to the end of the scanned text, unless
 * a space follows the quote: then it closes a string (`rg "token:" src`) rather than opening one.
 */
const QUOTED = String.raw`\\"[^"]*"?|"(?:[^"\\]|\\.)*"|"(?=\S)(?:[^"\\]|\\.)*$|'[^']*'|'(?=\S)[^']*$`;

/** Bare `pass` must stand alone: `DB_PASS=` is a secret, `passed:` and `bypass=` are not. */
const KEY_NAMES = String.raw`pass(?:word|wd|phrase)|(?<![a-z])pass(?![a-z])|pwd|secret|token|credentials?|api[_-]?key|access[_-]?key|private[_-]?key|auth(?![a-z])`;

/** The end of a `key: value` key: the rest of the name, a closing quote, then `=` or `:`. */
const KEY_END = String.raw`[\w-]{0,64}\\?["']?\s*[=:]\s*`;

const PATTERNS: Array<[RegExp, string]> = [
  // PEM private keys: everything from the header on is key material.
  [
    /-----BEGIN [A-Z ]{0,32}PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END [A-Z ]{0,32}PRIVATE KEY(?: BLOCK)?-----|$)/g,
    MASK,
  ],
  // URL userinfo anywhere: URL_RE below takes whole tokens, which can hold several URLs.
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]{0,128}:[^\s/@]{1,256}@/gi, `$1${MASK}@`],
  // Go DSNs have no scheme: user:pass@tcp(host:3306)/db
  [/\b[\w.-]{1,64}:[^\s@/]{1,128}@(tcp|udp|unix)\(/gi, `${MASK}@$1(`],
  // Authorization and cookie headers: the whole value, whatever its scheme.
  [/\b(authorization\\?["']?\s*[:=]\s*\\?["']?)[^'"]+/gi, `$1${MASK}`],
  [/\b((?:set-)?cookie\\?["']?\s*[:=]\s*\\?["']?)[^'"]+/gi, `$1${MASK}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`],
  // Credential flags: curl -u user:pass, --user=user:pass, --password value, --api_key=value
  [/(?<![\w-])((?:-u[ =]?|--user[ =]))(?:"[^"]*"|'[^']*'|[^\s:'"]+:\S+)/g, `$1${MASK}`],
  [
    new RegExp(
      String.raw`((?<![\w-])--?(?:[\w-]{0,32}(?:password|passwd|passphrase|token|secret|credentials?|(?:api|access|private|secret|auth)[_-]?key)|pass|key|auth)[ =])(?!-)(?:${QUOTED}|\S+)`,
      'gi',
    ),
    `$1${MASK}`,
  ],
  // `-p` and `-b` mean a password or a cookie only for these commands (`git checkout -b` is fine).
  [new RegExp(String.raw`\b(sshpass\s+-p\s?)(?:${QUOTED}|\S+)`, 'g'), `$1${MASK}`],
  [
    new RegExp(
      String.raw`\b((?:mysql|mysqldump|mysqladmin|mariadb)\s(?:[^|;&]{0,256}?\s)?-p)(?:${QUOTED}|[^\s'"]\S*)`,
      'g',
    ),
    `$1${MASK}`,
  ],
  [
    new RegExp(
      String.raw`\b(curl\s(?:[^|;]{0,512}?\s)?(?:-b|--cookie)[ =]?)(?:${QUOTED}|\S+)`,
      'g',
    ),
    `$1${MASK}`,
  ],
  // key=value / key: value secrets, including quoted JSON keys.
  [new RegExp(String.raw`((?:${KEY_NAMES})${KEY_END})(?:${QUOTED}|[^\s&]+)`, 'gi'), `$1${MASK}`],
  // camelCase `dbPass`, which the case-insensitive rule above can't tell from `bypass`.
  [
    new RegExp(String.raw`((?<=[a-z])Pass(?![a-z])${KEY_END})(?:${QUOTED}|[^\s&]+)`, 'g'),
    `$1${MASK}`,
  ],
  // Keys set by position: aws configure set aws_secret_access_key value
  [/((?:secret_access_key|session_token|secret_key)\s+)(?!-)\S+/gi, `$1${MASK}`],
  // Signed URLs: ?key=value, &sig=value, X-Amz-Signature=value
  [/([?&][a-z0-9_-]{0,32}(?:key|sig|signature)=)[^&\s#'"]+/gi, `$1${MASK}`],
  // Well-known token shapes
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b[spr]k_(?:live|test)_[A-Za-z0-9]{8,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bxox[a-z]-[A-Za-z0-9-]{8,}/g, MASK],
  [/\bxapp-[A-Za-z0-9-]{8,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, MASK],
];

// Any URL; its userinfo is picked out in code because passwords may hold `@` and `/`.
const URL_RE = /\b[a-z][a-z0-9+.-]{0,30}:\/\/\S+/gi;

// Long hex / base64-ish blobs; only masked when they contain a digit, so long
// identifiers survive. Checked in a callback to keep matching linear.
const BLOB = /[A-Za-z0-9+_=-]{32,}/g;

// Base64 also uses `/`, which the rule above stops at (and never `-` or `_` alongside it). Runs
// with slashes are usually paths, so these are masked only when case and digits change every few characters, as random data does.
const SLASHED_BLOB = /[A-Za-z0-9+/=]{40,}/g;

/** Largest input read at all; bounds the whitespace pass on huge commands. */
const MAX_RAW = 64 * 1024;

/** Upper bound on input scanned; summaries are short, and this keeps regexes cheap. */
const MAX_SCAN = 4096;

function maskUserinfo(url: string): string {
  const start = url.indexOf('://') + 3;
  const rest = url.slice(start);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  let at = authority.lastIndexOf('@');
  if (at < 0) {
    // `host:port/@scope` keeps its path. A "port" that isn't numeric is a password holding `/`.
    const colon = authority.lastIndexOf(':');
    if (colon < 0 || /^\d*$/.test(authority.slice(colon + 1))) return url;
    at = rest.lastIndexOf('@');
  }
  const user = rest.slice(0, Math.max(at, 0));
  // `ssh://git@host` names no one and holds no secret.
  if (user === '' || user === 'git') return url;
  return `${url.slice(0, start)}${MASK}@${rest.slice(at + 1)}`;
}

/** True when a run breaks into words shorter than real names: `aB3dE`, not `NavBarItem2`. */
function looksRandom(run: string): boolean {
  if (!/\d/.test(run) || !/[a-z]/.test(run) || !/[A-Z]/.test(run)) return false;
  const words = run.match(/[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [];
  return words.length * 3.5 >= run.length;
}

/**
 * Flattens the text to one line, so a secret after a `\` line continuation still follows its flag,
 * then clips it at a word boundary so a cut can't leave a partial secret no rule recognises.
 */
function flatten(text: string): string {
  const clipped = text.length > MAX_RAW;
  const flat = (clipped ? text.slice(0, MAX_RAW) : text)
    .replace(/\\\r?\n/g, ' ')
    .replace(/\s+/g, ' ');
  if (!clipped && flat.length <= MAX_SCAN) return flat;
  const cut = flat.lastIndexOf(' ', MAX_SCAN);
  return flat.slice(0, cut >= 0 ? cut : MAX_SCAN);
}

export function redactSecrets(text: string): string {
  if (typeof text !== 'string') return '';
  let out = flatten(text).replace(URL_RE, maskUserinfo);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out
    .replace(SLASHED_BLOB, (m) => (looksRandom(m) ? MASK : m))
    .replace(BLOB, (m) => (/\d/.test(m) ? MASK : m));
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine;
}

/** Redacted one-line text for labels taken from tool input, such as a subagent's description. */
export function safeLabel(text: string, max = 60): string {
  return truncate(redactSecrets(text), max);
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
