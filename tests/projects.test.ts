import { describe, expect, it } from 'vitest';
import { normalizeCwd, projectIdFor, projectNameFor } from '../src/shared/projects';

describe('projects', () => {
  it('normalizes separators, trailing slashes and drive letters', () => {
    expect(normalizeCwd('/home/user/app/')).toBe('/home/user/app');
    expect(normalizeCwd('/home/user/app///')).toBe('/home/user/app');
    expect(normalizeCwd('C:\\Users\\user\\app\\')).toBe('c:/Users/user/app');
    expect(normalizeCwd('/')).toBe('/');
    expect(normalizeCwd('C:\\')).toBe('c:/');
  });

  it('produces stable 12-hex ids', () => {
    const id = projectIdFor('/home/user/app');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(projectIdFor('/home/user/app')).toBe(id);
    expect(projectIdFor('/home/user/app/')).toBe(id);
  });

  it('distinguishes different folders', () => {
    expect(projectIdFor('/home/user/a')).not.toBe(projectIdFor('/home/user/b'));
    expect(projectIdFor('/home/user/app')).not.toBe(projectIdFor('/home/user/app2'));
  });

  it('treats Windows paths with either separator as the same project', () => {
    expect(projectIdFor('C:\\work\\app')).toBe(projectIdFor('c:/work/app/'));
  });

  it('uses the folder basename as the name', () => {
    expect(projectNameFor('/home/user/my-app/')).toBe('my-app');
    expect(projectNameFor('C:\\work\\tool')).toBe('tool');
    expect(projectNameFor('/')).toBe('project');
    expect(projectNameFor('C:\\')).toBe('project');
    expect(projectNameFor('')).toBe('project');
  });
});
