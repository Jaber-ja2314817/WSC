// Types for scripts/statusline-settings.mjs (used by tests/statuslineInstall.test.ts).
export declare function isWscStatusLine(statusLine: unknown): boolean;
export declare function quotePath(scriptPath: string): string;
export declare function bridgeCommand(scriptPath: string, original?: string | null): string;
export declare function chainedCommand(command: unknown): string | null;
export declare function installStatusLine(
  settingsObj: Record<string, unknown>,
  scriptPath: string,
): { settings: Record<string, unknown>; changed: boolean; wrapped: boolean };
export declare function removeStatusLine(settingsObj: Record<string, unknown>): {
  settings: Record<string, unknown>;
  changed: boolean;
};
