// Manual-install snippet for ~/.claude/settings.json, generated from the plugin's own hooks.json
// so the two can never drift apart.
import hooksConfig from '../../../plugin/hooks/hooks.json';

export const PLUGIN_INSTALL = [
  '/plugin marketplace add Jaber-ja2314817/WSC',
  '/plugin install wsc@wsc',
];

const PLUGIN_PATH = '${CLAUDE_PLUGIN_ROOT}/hooks/forward.mjs';
const MANUAL_PATH = '<path-to-wsc>/plugin/hooks/forward.mjs';

export function manualHookSnippet(): string {
  const json = JSON.stringify({ hooks: hooksConfig.hooks }, null, 2);
  return json.split(PLUGIN_PATH).join(MANUAL_PATH);
}
