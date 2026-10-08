import { describe, expect, it } from 'vitest';
import { categorizeTool } from '../src/shared/toolCategories';

describe('categorizeTool', () => {
  it.each([
    ['Read', 'read'],
    ['NotebookRead', 'read'],
    ['Grep', 'search'],
    ['Glob', 'search'],
    ['LS', 'search'],
    ['Edit', 'write'],
    ['Write', 'write'],
    ['MultiEdit', 'write'],
    ['NotebookEdit', 'write'],
    ['Bash', 'execute'],
    ['PowerShell', 'execute'],
    ['WebFetch', 'web'],
    ['WebSearch', 'web'],
    ['Task', 'delegate'],
    ['Agent', 'delegate'],
    ['TodoWrite', 'plan'],
    ['ExitPlanMode', 'plan'],
    ['mcp__github__create_issue', 'mcp'],
  ] as const)('%s → %s', (name, cat) => expect(categorizeTool(name)).toBe(cat));

  it('falls back to other for unknown or invalid names', () => {
    expect(categorizeTool('SomeFutureTool')).toBe('other');
    expect(categorizeTool('')).toBe('other');
    expect(categorizeTool(undefined as unknown as string)).toBe('other');
    expect(categorizeTool(42 as unknown as string)).toBe('other');
    expect(categorizeTool('toString')).toBe('other');
    expect(categorizeTool('__proto__')).toBe('other');
  });

  it('applies overrides first', () => {
    expect(categorizeTool('Bash', { Bash: 'web' })).toBe('web');
    expect(categorizeTool('MyTool', { MyTool: 'plan' })).toBe('plan');
    expect(categorizeTool('mcp__x__y', { mcp__x__y: 'read' })).toBe('read');
  });
});
