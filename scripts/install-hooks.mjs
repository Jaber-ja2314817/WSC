#!/usr/bin/env node
// Installs or removes WSC's hooks in a Claude Code settings.json, for people who don't use the
// plugin. This is a CLI for humans (it prints), not a hook.
//
//   node scripts/install-hooks.mjs install|uninstall [--settings <path>] [--force]
//
// Default file: $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json. The file is never
// overwritten blindly: it is parsed, merged (scripts/hooks-settings.mjs), backed up next to itself
// as settings.json.wsc-backup-YYYYMMDD-HHMMSS, then replaced atomically. A malformed file is left
// alone.
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeHooks, removeHooks } from './hooks-settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const HOOKS_JSON = join(REPO, 'plugin', 'hooks', 'hooks.json');
const FORWARD = join(REPO, 'plugin', 'hooks', 'forward.mjs');
const PLUGIN_ID = 'wsc@wsc';

const USAGE =
  'usage: node scripts/install-hooks.mjs install|uninstall [--settings <path>] [--force]';

class CliError extends Error {}

function parseArgs(argv) {
  const opts = { action: null, settings: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--settings') {
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
  if (
    settings.hooks !== undefined &&
    (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))
  ) {
    throw new CliError(`"hooks" in ${file} is not an object. Nothing changed.`);
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

/** The real file behind a symlink, even a dangling one: renaming over a link would replace it. */
function followLinks(file) {
  try {
    return realpathSync(file);
  } catch {
    try {
      return resolve(dirname(file), readlinkSync(file));
    } catch {
      return file; // New file.
    }
  }
}

function writeAtomic(path, value) {
  const file = followLinks(path);
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

function install(file, force) {
  const { exists, settings } = readSettings(file);
  if (settings.enabledPlugins?.[PLUGIN_ID] === true && !force) {
    throw new CliError(
      `The WSC plugin (${PLUGIN_ID}) is enabled in ${file}. It already provides these hooks, and ` +
        'installing them here too would send every event twice. Use the plugin, or disable it ' +
        'first; pass --force to install anyway.',
    );
  }
  if (!existsSync(FORWARD)) throw new CliError(`forwarder not found at ${FORWARD}`);
  const hooksJson = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const { settings: next, added, updated } = mergeHooks(settings, hooksJson, FORWARD);
  if (added + updated === 0) {
    console.log(`WSC hooks are already installed in ${file}. Nothing changed.`);
    return;
  }
  const saved = exists ? backup(file) : null;
  writeAtomic(file, next);
  console.log(`Installed WSC hooks in ${file}: ${added} event(s) added, ${updated} updated.`);
  console.log(`Forwarder: ${FORWARD}`);
  if (saved) console.log(`Backup: ${saved}`);
  console.log('Restart running Claude Code sessions (or check /hooks) to pick them up.');
}

function uninstall(file) {
  if (!existsSync(file)) {
    console.log(`${file} does not exist. Nothing to remove.`);
    return;
  }
  const { settings } = readSettings(file);
  const { settings: next, removed } = removeHooks(settings);
  if (removed === 0) {
    console.log(`No WSC hooks found in ${file}. Nothing changed.`);
    return;
  }
  const saved = backup(file);
  writeAtomic(file, next);
  console.log(`Removed ${removed} WSC hook entr${removed === 1 ? 'y' : 'ies'} from ${file}.`);
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
    if (opts.action === 'install') install(file, opts.force);
    else uninstall(file);
    return 0;
  } catch (err) {
    console.error(`WSC: ${err instanceof CliError ? err.message : `failed: ${err.message}`}`);
    return 1;
  }
}

process.exitCode = main();
