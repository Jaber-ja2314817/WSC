#!/usr/bin/env node
// Installs or removes WSC's status line bridge in a Claude Code settings.json. The bridge passes
// the plan usage Claude Code gives the status line (`rate_limits`) to the app. This is a CLI for
// humans (it prints), not something Claude Code runs.
//
//   node scripts/install-statusline.mjs install|uninstall [--settings <path>]
//
// Default file: $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json. The file is never
// overwritten blindly: it is parsed, merged (scripts/statusline-settings.mjs), backed up next to
// itself as settings.json.wsc-backup-YYYYMMDD-HHMMSS, then replaced atomically. A malformed file
// is left alone. An existing status line keeps working: the bridge runs it and prints its output.
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainedCommand, installStatusLine, removeStatusLine } from './statusline-settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SCRIPT = join(REPO, 'plugin', 'statusline', 'statusline.mjs');

const USAGE = 'usage: node scripts/install-statusline.mjs install|uninstall [--settings <path>]';

class CliError extends Error {}

function parseArgs(argv) {
  const opts = { action: null, settings: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--settings') {
      const v = argv[++i];
      if (!v) throw new CliError('--settings needs a path');
      opts.settings = v;
    } else if (a.startsWith('--settings=')) opts.settings = a.slice('--settings='.length);
    else if (a === '-h' || a === '--help') opts.action = 'help';
    else if ((a === 'install' || a === 'uninstall') && !opts.action) opts.action = a;
    else throw new CliError(`unknown argument: ${a}`);
  }
  if (!opts.action) throw new CliError('missing command');
  return opts;
}

function defaultSettingsPath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(configDir, 'settings.json');
}

/** { exists, settings } — throws CliError on unreadable or malformed files. */
function readSettings(file) {
  if (!existsSync(file)) return { exists: false, settings: {} };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${file}: ${err.code ?? err.message}`);
  }
  if (text.trim() === '') return { exists: true, settings: {} };
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    throw new CliError(
      `${file} is not valid JSON (${err.message}). Fix it first. Nothing changed.`,
    );
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new CliError(`${file} does not contain a JSON object. Nothing changed.`);
  }
  return { exists: true, settings };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Copies the file next to itself; never overwrites an earlier backup. Returns the backup path. */
function backup(file) {
  const base = `${file}.wsc-backup-${stamp()}`;
  for (let n = 0; n < 100; n++) {
    const target = n === 0 ? base : `${base}-${n}`;
    try {
      copyFileSync(file, target, constants.COPYFILE_EXCL);
      return target;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new CliError(`could not create a backup of ${file}`);
}

function writeAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${file}.wsc-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function install(file) {
  const { exists, settings } = readSettings(file);
  if (!existsSync(SCRIPT)) throw new CliError(`status line script not found at ${SCRIPT}`);
  let result;
  try {
    result = installStatusLine(settings, SCRIPT);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new CliError(`${err.message} (in ${file}) Nothing changed.`);
    }
    throw err;
  }
  const { settings: next, changed, wrapped } = result;
  if (!changed) {
    console.log(`The WSC status line bridge is already installed in ${file}. Nothing changed.`);
    return;
  }
  const saved = exists ? backup(file) : null;
  writeAtomic(file, next);
  console.log(`Installed the WSC status line bridge in ${file}.`);
  console.log(`Script: ${SCRIPT}`);
  if (wrapped) {
    const original = chainedCommand(next.statusLine.command);
    console.log(`Your status line still shows: WSC runs \`${original}\` and prints its output.`);
  } else {
    console.log('It prints nothing, so your status line stays empty.');
  }
  if (saved) console.log(`Backup: ${saved}`);
  console.log(
    'Claude Code picks it up on the next status line refresh or in a new session. Plan usage ' +
      'appears in WSC after the first reply in a session.',
  );
}

function uninstall(file) {
  if (!existsSync(file)) {
    console.log(`${file} does not exist. Nothing to remove.`);
    return;
  }
  const { settings } = readSettings(file);
  const { settings: next, changed } = removeStatusLine(settings);
  if (!changed) {
    console.log(`No WSC status line found in ${file}. Nothing changed.`);
    return;
  }
  const saved = backup(file);
  writeAtomic(file, next);
  if (next.statusLine) {
    console.log(`Removed the WSC status line bridge from ${file}; restored your status line:`);
    console.log(`  ${next.statusLine.command}`);
  } else {
    console.log(`Removed the WSC status line from ${file}.`);
  }
  console.log(`Backup: ${saved}`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`WSC: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (opts.action === 'help') {
    console.log(USAGE);
    return 0;
  }
  const file = resolve(opts.settings || defaultSettingsPath());
  try {
    if (opts.action === 'install') install(file);
    else uninstall(file);
    return 0;
  } catch (err) {
    console.error(`WSC: ${err instanceof CliError ? err.message : `failed: ${err.message}`}`);
    return 1;
  }
}

process.exitCode = main();
