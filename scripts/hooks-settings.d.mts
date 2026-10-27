// Types for scripts/hooks-settings.mjs (used by tests/hooksInstall.test.ts).
export declare const PLUGIN_FORWARD: string;
export declare function isWscHandler(handler: unknown): boolean;
export declare function mergeHooks(
  settingsObj: Record<string, unknown>,
  hooksJsonObj: { hooks: Record<string, unknown> },
  forwardPath: string,
): { settings: Record<string, unknown>; added: number; updated: number };
export declare function removeHooks(settingsObj: Record<string, unknown>): {
  settings: Record<string, unknown>;
  removed: number;
};
