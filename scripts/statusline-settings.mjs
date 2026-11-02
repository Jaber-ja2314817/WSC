// Pure merge logic for installing WSC's status line bridge into a Claude Code settings.json.
// No I/O here: scripts/install-statusline.mjs reads, backs up and writes.
//
// Claude Code runs exactly one `statusLine` command, and plugins can't define one, so the bridge
// (plugin/statusline/statusline.mjs) goes into user settings:
//
// - no status line yet      → `node "<script>"` (prints nothing, so nothing changes visually);
// - the user has their own  → `node "<script>" --then <base64url of their command>`: the bridge
//                             runs their command with the same stdin and prints its output, and
//                             every other key (padding, refreshInterval, …) is kept;
// - uninstall               → restores their command exactly, or removes the key.
//
// How the WSC status line is recognised: after turning backslashes into slashes, its command
// contains `plugin/statusline/statusline.mjs` preceded by the start of the string, a slash,
// whitespace or a quote, and followed by the end of the string, whitespace or a quote.

const WSC_STATUSLINE_RE = /(?:^|[\s"'/])plugin\/statusline\/statusline\.mjs(?=$|[\s"'])/;
const THEN_RE = /\s--then(?:\s+|=)([A-Za-z0-9_-]+)\s*$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True when a statusLine object is WSC's bridge. */
export function isWscStatusLine(statusLine) {
  return (
    isObject(statusLine) &&
    typeof statusLine.command === 'string' &&
    WSC_STATUSLINE_RE.test(statusLine.command.replace(/\\/g, '/'))
  );
}

/**
 * Quotes the script path for the shell Claude Code runs the command in (sh/bash, or cmd.exe /
 * Git Bash on Windows). Windows paths use forward slashes, which node and both shells accept.
 */
export function quotePath(scriptPath) {
  if (typeof scriptPath !== 'string' || !scriptPath) {
    throw new TypeError('scriptPath must be a non-empty string');
  }
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(scriptPath)) {
    const p = scriptPath.replace(/\\/g, '/');
    if (p.includes('"')) throw new TypeError(`unsupported character in path: ${scriptPath}`);
    return `"${p}"`;
  }
  return `"${scriptPath.replace(/["\\$`]/g, '\\$&')}"`;
}

/** The command string for the bridge, optionally chaining an original command. */
export function bridgeCommand(scriptPath, original) {
  const base = `node ${quotePath(scriptPath)}`;
  return original ? `${base} --then ${Buffer.from(original, 'utf8').toString('base64url')}` : base;
}

/** The original command a WSC status line chains (decoded `--then`), or null. */
export function chainedCommand(command) {
  const m = typeof command === 'string' ? THEN_RE.exec(command) : null;
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64url').toString('utf8');
  return decoded.trim() ? decoded : null;
}

function checkSettings(settings) {
  if (!isObject(settings)) throw new TypeError('settings must be a JSON object');
}

/**
 * Installs the bridge. Returns { settings, changed, wrapped } where `wrapped` means the user's
 * own status line command is now run through the bridge. Never mutates its input.
 * Throws TypeError when the existing statusLine is not a command status line.
 */
export function installStatusLine(settingsObj, scriptPath) {
  checkSettings(settingsObj);
  const settings = structuredClone(settingsObj);
  const current = settings.statusLine;

  if (current === undefined) {
    settings.statusLine = { type: 'command', command: bridgeCommand(scriptPath) };
    return { settings, changed: true, wrapped: false };
  }
  if (
    !isObject(current) ||
    current.type !== 'command' ||
    typeof current.command !== 'string' ||
    !current.command.trim()
  ) {
    throw new TypeError(
      'statusLine is not a { "type": "command", "command": "…" } object, so WSC cannot chain it. ' +
        'Change or remove it by hand, then run the installer again.',
    );
  }

  if (isWscStatusLine(current)) {
    const original = chainedCommand(current.command);
    const command = bridgeCommand(scriptPath, original);
    if (command === current.command) return { settings, changed: false, wrapped: !!original };
    settings.statusLine = { ...current, command };
    return { settings, changed: true, wrapped: !!original };
  }

  settings.statusLine = { ...current, command: bridgeCommand(scriptPath, current.command) };
  return { settings, changed: true, wrapped: true };
}

/**
 * Removes the bridge: restores the chained original command, or deletes `statusLine` when the
 * bridge ran alone. Anything that isn't WSC's is left unchanged. Never mutates its input.
 */
export function removeStatusLine(settingsObj) {
  checkSettings(settingsObj);
  const settings = structuredClone(settingsObj);
  const current = settings.statusLine;
  if (!isWscStatusLine(current)) return { settings, changed: false };
  const original = chainedCommand(current.command);
  if (original) settings.statusLine = { ...current, command: original };
  else delete settings.statusLine;
  return { settings, changed: true };
}
