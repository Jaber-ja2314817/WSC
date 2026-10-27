// Pure merge logic for installing WSC's hooks into a Claude Code settings.json (for users who
// don't use the plugin). No I/O here: scripts/install-hooks.mjs reads, backs up and writes.
//
// Source of truth: plugin/hooks/hooks.json, with `${CLAUDE_PLUGIN_ROOT}/hooks/forward.mjs`
// replaced by the absolute path of the forwarder.
//
// How a WSC entry is recognised: a hook handler belongs to WSC when its `command`, or any of its
// `args`, refers to a file named `forward.mjs` inside a `plugin/hooks/` folder — i.e. after
// turning backslashes into slashes it contains `plugin/hooks/forward.mjs` preceded by the start of
// the string, a slash, whitespace or a quote, and followed by the end of the string, whitespace
// or a quote. That covers installs by this script, the manual snippet from the first-run screen
// (`<path-to-wsc>/plugin/hooks/forward.mjs`) and moved checkouts, but not some other plugin's
// `.../myplugin/hooks/forward.mjs`. No marker field is added, because Claude Code validates
// hook handler objects.

export const PLUGIN_FORWARD = '${CLAUDE_PLUGIN_ROOT}/hooks/forward.mjs';

const WSC_FORWARD_RE = /(?:^|[\s"'/])plugin\/hooks\/forward\.mjs(?=$|[\s"'])/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function mentionsForwarder(value) {
  return typeof value === 'string' && WSC_FORWARD_RE.test(value.replace(/\\/g, '/'));
}

/** True when a hook handler object is one of WSC's forwarder entries. */
export function isWscHandler(handler) {
  if (!isObject(handler)) return false;
  if (mentionsForwarder(handler.command)) return true;
  return Array.isArray(handler.args) && handler.args.some(mentionsForwarder);
}

function substitute(value, forwardPath) {
  if (typeof value === 'string') return value.split(PLUGIN_FORWARD).join(forwardPath);
  if (Array.isArray(value)) return value.map((v) => substitute(v, forwardPath));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v, forwardPath)]),
    );
  }
  return value;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkSettings(settings) {
  if (!isObject(settings)) throw new TypeError('settings must be a JSON object');
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    throw new TypeError('settings.hooks must be an object');
  }
}

/** Drops WSC handlers from one event's groups; empty groups left behind by that are dropped. */
function stripEvent(groups) {
  let removed = 0;
  const kept = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const hooks = group.hooks.filter((h) => !isWscHandler(h));
    const n = group.hooks.length - hooks.length;
    removed += n;
    if (n === 0) kept.push(group);
    else if (hooks.length > 0) kept.push({ ...group, hooks });
  }
  return { groups: kept, removed };
}

/**
 * Adds WSC's hooks to a settings object. Every other setting and every other hook is kept as is.
 * Idempotent: an event whose WSC handlers already match hooks.json is left untouched; outdated
 * WSC handlers for an event (old path, old options) are replaced.
 * @returns {{ settings: object, added: number, updated: number }} added/updated count events.
 */
export function mergeHooks(settingsObj, hooksJsonObj, forwardPath) {
  checkSettings(settingsObj);
  if (!isObject(hooksJsonObj) || !isObject(hooksJsonObj.hooks)) {
    throw new TypeError('hooks.json must have a "hooks" object');
  }
  if (typeof forwardPath !== 'string' || !forwardPath) {
    throw new TypeError('forwardPath must be a non-empty string');
  }
  const settings = structuredClone(settingsObj);
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  let added = 0;
  let updated = 0;

  for (const [event, wantedGroups] of Object.entries(hooksJsonObj.hooks)) {
    if (!Array.isArray(wantedGroups)) continue;
    const wanted = substitute(wantedGroups, forwardPath);
    const wantedHandlers = wanted.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []));
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const current = existing.flatMap((g) =>
      isObject(g) && Array.isArray(g.hooks) ? g.hooks.filter(isWscHandler) : [],
    );
    if (sameJson(current, wantedHandlers)) continue;

    const { groups } = stripEvent(existing);
    hooks[event] = [...groups, ...wanted];
    if (current.length > 0) updated++;
    else added++;
  }

  if (added + updated > 0) settings.hooks = hooks;
  return { settings, added, updated };
}

/**
 * Removes every WSC hook handler. Groups and events that became empty because of that are
 * dropped (and `hooks` itself when nothing is left); everything else is untouched.
 * @returns {{ settings: object, removed: number }} removed counts handlers.
 */
export function removeHooks(settingsObj) {
  checkSettings(settingsObj);
  const settings = structuredClone(settingsObj);
  if (!isObject(settings.hooks)) return { settings, removed: 0 };
  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const res = stripEvent(groups);
    if (res.removed === 0) continue;
    removed += res.removed;
    if (res.groups.length > 0) settings.hooks[event] = res.groups;
    else delete settings.hooks[event];
  }
  if (removed > 0 && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return { settings, removed };
}
