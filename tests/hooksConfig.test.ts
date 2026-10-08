import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Handler {
  type: string;
  command: string;
  args?: string[];
  async?: boolean;
  timeout?: number;
}
const config = JSON.parse(readFileSync('plugin/hooks/hooks.json', 'utf8')) as {
  hooks: Record<string, { matcher?: string; hooks: Handler[] }[]>;
};

// Headless runs exit before async hooks fire, so turn/session end must be synchronous.
const SYNC_EVENTS = new Set(['Stop', 'SessionEnd']);

describe('plugin/hooks/hooks.json', () => {
  it('registers every event the normalizer understands', () => {
    expect(Object.keys(config.hooks).sort()).toEqual(
      [
        'CwdChanged',
        'Notification',
        'PermissionDenied',
        'PermissionRequest',
        'PostCompact',
        'PostToolBatch',
        'PostToolUse',
        'PostToolUseFailure',
        'PreCompact',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'StopFailure',
        'SubagentStart',
        'SubagentStop',
        'UserPromptSubmit',
      ].sort(),
    );
  });

  it.each(Object.entries(config.hooks))('%s runs the silent forwarder', (event, groups) => {
    for (const g of groups) {
      expect(g.matcher).toBeUndefined();
      for (const h of g.hooks) {
        expect(h.type).toBe('command');
        expect(h.args?.[0]).toBe('${CLAUDE_PLUGIN_ROOT}/hooks/forward.mjs');
        if (SYNC_EVENTS.has(event)) {
          expect(h.async).toBeUndefined();
          expect(h.timeout).toBeLessThanOrEqual(2);
        } else {
          expect(h.async).toBe(true);
        }
      }
    }
  });
});
