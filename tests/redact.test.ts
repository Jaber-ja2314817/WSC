import { describe, expect, it } from 'vitest';
import { redactSecrets, safeLabel, summarizeTool } from '../src/shared/redact';

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

  it.each([
    // Quoted keys
    [`curl -d '{"password":"hunter2xx"}' x`, 'hunter2xx'],
    [`{"api_key": "abc123 def"}`, 'abc123 def'],
    [`{'token': 'tok3n value'}`, 'tok3n value'],
    [`{"Authorization":"Basic dXNlcjpwYXNz"}`, 'dXNlcjpwYXNz'],
    [String.raw`curl -d "{\"password\":\"two words\"}" x`, 'two words'],
    // Key names
    ['DB_PASS=hunter2', 'hunter2'],
    ['MYSQL_PASS=hunter2', 'hunter2'],
    ['--pass=hunter2', 'hunter2'],
    ['AWS_ACCESS_KEY=hunter2', 'hunter2'],
    ['PRIVATE_KEY=hunter2', 'hunter2'],
    ['AUTH=hunter2', 'hunter2'],
    ['CREDENTIALS=hunter2', 'hunter2'],
    ['const dbPass = "hunter2"', 'hunter2'],
    [`${'A'.repeat(70)}_PASSWORD=hunter2`, 'hunter2'],
    // Cookies and custom headers
    ['curl -H "Cookie: sessionid=hunter2" x', 'hunter2'],
    ['curl -b "sid=hunter2" x', 'hunter2'],
    ['curl -sS https://example.com --cookie sid=hunter2', 'hunter2'],
    ['curl -H "X-Auth: hunter2" x', 'hunter2'],
    // Signed URLs
    ['curl https://example.com/a?key=hunter2', 'hunter2'],
    ['curl "https://example.com/a?b=1&sig=hunter2"', 'hunter2'],
    ['https://example.com/a?X-Amz-Signature=hunter2', 'hunter2'],
    // Authorization schemes
    ['Authorization: ApiKey abc123def', 'abc123def'],
    ['Authorization: Bot abc123def', 'abc123def'],
    ['Authorization: Digest username=bob', 'username=bob'],
    // Connection strings
    ['redis://:hunter2xx@localhost:6379/0', 'hunter2xx'],
    ['postgres://u:p@ssw0rd@db/app', 'ssw0rd'],
    ['postgres://u:pa/ssw0rd@db/app', 'ssw0rd'],
    ['https://ab12cd34ef56@github.com/a/b', 'ab12cd34ef56'],
    ['root:hunter2xx@tcp(127.0.0.1:3306)/db', 'hunter2xx'],
    // Flags
    ['sshpass -p hunter2 ssh host', 'hunter2'],
    ['mysql -phunter2', 'hunter2'],
    ['mysql -u root -phunter2 db', 'hunter2'],
    ['curl -uadmin:hunter2 x', 'hunter2'],
    ['curl --user=admin:hunter2 x', 'hunter2'],
    ['tool --secret-key hunter2', 'hunter2'],
    ['tool --api_key hunter2', 'hunter2'],
    ['tool --key hunter2', 'hunter2'],
    ['tool --password "correct horse battery"', 'horse battery'],
    [String.raw`PASSWORD="ab\"c horse"`, 'horse'],
    ['password=ab;cd1234', 'cd1234'],
    ['password=ab,cd1234', 'cd1234'],
    ['mysql --password \\\n  hunter2', 'hunter2'],
    // Token shapes
    ['ASIAABCDEFGHIJKLMNOP', 'ASIAABCDEFGHIJKLMNOP'],
    ['glpat-abcdefghijklmnop', 'glpat-abcdefghijklmnop'],
    ['sk_live_abcdefghijklmnop', 'sk_live_abcdefghijklmnop'],
    ['xoxc-1234-abcdefgh', 'xoxc-1234-abcdefgh'],
    ['xoxs-1234-abcdefgh', 'xoxs-1234-abcdefgh'],
    ['xapp-1-abcdefgh', 'xapp-1-abcdefgh'],
    ['npm_abcdefghij0123456789abcdefghij012345', 'npm_abcdefghij0123456789abcdefghij012345'],
    ['eyJhbGci.eyJzdWIi.c2lnbmF0dXJl', 'eyJzdWIi'],
    // Base64 with slashes
    ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'K7MDENG'],
    ['aws configure set aws_secret_access_key abcd/efgh', 'abcd/efgh'],
    ['aws configure set aws_session_token hunter2', 'hunter2'],
    // Private keys
    [
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----',
      'MIIEvQIBADANBgkq',
    ],
    ['echo "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkq', 'MIIEvQIBADANBgkq'],
  ])('redacts bypass %s', (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(M);
  });

  it.each([
    ['git clone git@github.com:acme/app.git'],
    ['git clone ssh://git@github.com/acme/app.git'],
    ['git checkout -b feature/login'],
    ['git push -u origin main'],
    ['curl https://example.com/a@b'],
    ['curl https://example.com:8080/a@b'],
    ['open http://localhost:5173/@fs/home/user/app/index.html'],
    ['curl "https://example.com/?email=a@b.example"'],
    ['npm install --save-dev @types/node'],
    ['npx vitest run tests/store.test.ts'],
    ['sort --key-file x'],
    ['tests passed: 10'],
    ['bypass=1 compass=2'],
    ['author: Sam'],
    ['echo $npm_lifecycle_event'],
    ['mysql -u root -p db'],
    ['mysql --protocol=tcp -P 3306'],
    ['src/components/NavigationBar2/SideBarItem3/IndexPageWithLayout'],
  ])('leaves %s alone', (input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it('stays fast on adversarial runs', () => {
    for (const unit of ['token-', 'a://', '--', 'a:b@', 'pass', ':/@', '"\\']) {
      const input = unit.repeat(Math.ceil(4096 / unit.length));
      const start = performance.now();
      redactSecrets(input);
      expect(performance.now() - start, unit).toBeLessThan(100);
    }
  });

  it('finds a secret that sits past the scan limit once whitespace is gone', () => {
    const secret = '0123456789abcdef0123456789abcdef01';
    for (const gap of [4080, 70_000]) {
      expect(redactSecrets(`${' '.repeat(gap)}${secret}`)).not.toContain('0123456789abcdef');
    }
  });

  it('does not leave a partial secret where the scan was clipped', () => {
    const out = redactSecrets(`${'word '.repeat(818)}abcdefghij${'x'.repeat(40)}`);
    expect(out).not.toContain('abcdefghij');
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

describe('redactSecrets: regressions', () => {
  it.each([
    ['R=redis://h1:6379,redis://user:hunter2xyzQ@h2:6379', 'hunter2xyzQ'],
    [
      'psql postgres://admin:hunter2xyzQ@db1/app,postgres://admin:hunter2xyzQ@db2/app',
      'hunter2xyzQ',
    ],
    ['{"urls":["https://a.example.com","https://user:hunter2xyzQ@b.example.com"]}', 'hunter2xyzQ'],
    ['curl "https://proxy/?target=https://user:hunter2xyzQ@b/x"', 'hunter2xyzQ'],
    ['password=ab}hunter2xyzQ', 'hunter2xyzQ'],
    ['token:ab}hunter2xyzQ', 'hunter2xyzQ'],
  ])('leaks nothing from %s', (text, secret) => {
    expect(redactSecrets(text)).not.toContain(secret);
  });

  it.each([
    ['rg "token:" src/ -l && npm test', 'npm test'],
    ['--user-data-dir=/tmp/a:b', '--user-data-dir=/tmp/a:b'],
    [
      'cat logs/9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f/subagents/agent-a1b2c3d4e5.jsonl',
      'agent-a1b2c3d4e5.jsonl',
    ],
  ])('keeps %s readable', (text, kept) => {
    expect(redactSecrets(text)).toContain(kept);
  });
});

describe('safeLabel', () => {
  it('redacts and truncates to one line', () => {
    expect(safeLabel('Deploy with API_KEY=abc123def')).toBe(`Deploy with API_KEY=${M}`);
    expect(safeLabel('a\n  b')).toBe('a b');
    const long = safeLabel('x '.repeat(100));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
    expect(safeLabel('x '.repeat(100), 10).length).toBeLessThanOrEqual(10);
  });

  it('never throws on non-strings', () => {
    expect(safeLabel(undefined as unknown as string)).toBe('');
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
