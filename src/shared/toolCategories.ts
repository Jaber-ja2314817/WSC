// Tool name → category. Extend DEFAULT_TOOL_CATEGORIES or pass user overrides.
import type { ToolCategory } from './types';

export const DEFAULT_TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: 'read',
  NotebookRead: 'read',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  ToolSearch: 'search',
  Edit: 'write',
  Write: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Bash: 'execute',
  PowerShell: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  Monitor: 'execute',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'delegate',
  Agent: 'delegate',
  SendMessage: 'delegate',
  SubagentHandback: 'delegate',
  TodoWrite: 'plan',
  TaskCreate: 'plan',
  TaskUpdate: 'plan',
  TaskList: 'plan',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
};

const has = (o: Record<string, ToolCategory>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/** Never throws; unknown tools fall back to 'other'. */
export function categorizeTool(
  name: string,
  overrides?: Record<string, ToolCategory>,
): ToolCategory {
  if (typeof name !== 'string' || name === '') return 'other';
  if (overrides && has(overrides, name)) return overrides[name] ?? 'other';
  if (name.startsWith('mcp__')) return 'mcp';
  return has(DEFAULT_TOOL_CATEGORIES, name) ? (DEFAULT_TOOL_CATEGORIES[name] ?? 'other') : 'other';
}
