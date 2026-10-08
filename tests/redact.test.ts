import { describe, expect, it } from 'vitest';
import { redactSecrets, summarizeTool } from '../src/shared/redact';

const M = '•••';

describe('redactSecrets', () => {
  it.each([
    ['curl -H "Authorization: Bearer abc.def.ghi" x', 'abc.def.ghi'],
    ['Authorization=Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['export PASSWORD=hunter2', 'hunter2'],
    ['mysql --password=s3cr3t', 's3cr3t'],
    ['passwd: letmein', 'letmein'],
    ['CLIENT_SECRET="very secret value"', 'very secret value'],
    ['GITHUB_TOKEN=abc123', 'abc123'],
    ['api_key: zzz-top', 'zzz-top'],
    ['apiKey=qqq', 'qqq'],
    ['use sk-ant-api03-abcdefghijklmnop', 'sk-ant-api03-abcdefghijklmnop'],
    ['ghp_abcdefghijklmnopqrstuvwxyz123456', 'ghp_abcdefghijklmnopqrstuvwxyz123456'],
    ['gho_abcdefgh12345678', 'gho_abcdefgh12345678'],
    ['github_pat_11ABCDEFG_abcdefgh', 'github_pat_11ABCDEFG_abcdefgh'],
    ['xoxb-1234-5678-abcdefgh', 'xoxb-1234-5678-abcdefgh'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    ['hash 0123456789abcdef0123456789abcdef01 end', '0123456789abcdef0123456789abcdef01'],
    ['git clone https://bob:pa55@example.com/r.git', 'pa55'],
  ])('redacts %s', (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(M);
  });

  it('keeps ordinary text, long paths and identifiers', () => {
    expect(redactSecrets('npm test -- --watch')).toBe('npm test -- --watch');
    const path = 'cat /home/user/project/src/components/navigation/sidebar.tsx';
    expect(redactSecrets(path)).toBe(path);
    expect(redactSecrets('describe_the_very_long_function_name_here')).toBe(
      'describe_the_very_long_function_name_here',
    );
  });

  it('never throws on non-strings', () => {
    expect(redactSecrets(undefined as unknown as string)).toBe('');
  });
});

describe('summarizeTool', () => {
  it('shows only file basenames', () => {
    expect(summarizeTool('Read', { file_path: '/home/user/secret-proj/src/auth.ts' })).toBe(
      'auth.ts',
    );
    expect(summarizeTool('Edit', { file_path: 'C:\\work\\app\\index.ts' })).toBe('index.ts');
    expect(summarizeTool('NotebookEdit', { notebook_path: '/home/user/a/nb.ipynb' })).toBe(
      'nb.ipynb',
    );
  });

  it('shows only the hostname for WebFetch', () => {
    expect(summarizeTool('WebFetch', { url: 'https://docs.example.com/a/b?token=x' })).toBe(
      'docs.example.com',
    );
    expect(summarizeTool('WebFetch', { url: 'not a url' })).toBeUndefined();
  });

  it('truncates and redacts Bash commands', () => {
    const s = summarizeTool('Bash', { command: `API_KEY=abc123 npm run ${'x'.repeat(100)}` });
    expect(s).toBeDefined();
    expect(s).not.toContain('abc123');
    expect(s!.length).toBeLessThanOrEqual(60);
    expect(s!.endsWith('…')).toBe(true);
  });

  it('summarizes search, web search, delegation and mcp', () => {
    expect(summarizeTool('Grep', { pattern: 'TODO' })).toBe('TODO');
    expect(summarizeTool('WebSearch', { query: 'pixi v8 textures' })).toBe('pixi v8 textures');
    expect(summarizeTool('Agent', { subagent_type: 'researcher', description: 'x' })).toBe(
      'researcher',
    );
    expect(summarizeTool('Task', { description: 'write tests' })).toBe('write tests');
    expect(summarizeTool('mcp__github__create_issue', {})).toBe('github: create_issue');
    expect(summarizeTool('UnknownTool', { anything: 1 })).toBeUndefined();
  });

  it('full mode allows longer text but still redacts', () => {
    const cmd = `echo ${'a '.repeat(60)} password=hunter2`;
    const s = summarizeTool('Bash', { command: cmd }, { full: true });
    expect(s!.length).toBeGreaterThan(60);
    expect(s).not.toContain('hunter2');
  });

  it('never throws on weird input', () => {
    expect(summarizeTool('Read', null)).toBeUndefined();
    expect(summarizeTool('Read', 'str')).toBeUndefined();
    expect(summarizeTool('Bash', { command: 42 })).toBeUndefined();
    expect(summarizeTool(undefined as unknown as string, {})).toBeUndefined();
  });
});
