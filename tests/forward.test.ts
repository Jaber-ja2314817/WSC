import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const FORWARD = resolve('plugin/hooks/forward.mjs');
const BODY = JSON.stringify({
  hook_event_name: 'PreToolUse',
  session_id: 'sess-1',
  cwd: '/home/user/demo',
  tool_name: 'Read',
});

let dir: string;
let runtimeFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wsc-fwd-'));
  runtimeFile = join(dir, 'runtime.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(input: string): Promise<RunResult> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [FORWARD], {
      env: { ...process.env, WSC_RUNTIME_FILE: runtimeFile },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
    child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
    child.on('close', (code) => done({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)),
  );
}

// Node startup itself takes time; the budget is for our own waiting on top of it.
const STARTUP_SLACK_MS = 400;

describe('forward.mjs', () => {
  it('exits 0 silently when no runtime file exists', async () => {
    const r = await run(BODY);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeLessThan(300 + STARTUP_SLACK_MS);
  });

  it('exits 0 silently with an invalid runtime file', async () => {
    writeFileSync(runtimeFile, 'not json');
    const r = await run(BODY);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('exits 0 silently when the app is not listening', async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: 1, version: '0' }));
    const r = await run(BODY);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeLessThan(300 + STARTUP_SLACK_MS);
  });

  it('forwards the exact body with the token', async () => {
    const got: { body: string; token: unknown; path?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += String(d)));
      req.on('end', () => {
        got.push({ body, token: req.headers['x-wsc-token'], path: req.url });
        res.writeHead(204).end();
      });
    });
    const port = await listen(server);
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 'secret', pid: 1, version: '0' }));
    try {
      const r = await run(BODY);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(got).toEqual([{ body: BODY, token: 'secret', path: '/v1/events' }]);
    } finally {
      server.close();
    }
  });

  it('gives up on a server that never responds', async () => {
    const server = createServer(() => {
      /* never respond */
    });
    const port = await listen(server);
    writeFileSync(runtimeFile, JSON.stringify({ port, token: 't', pid: 1, version: '0' }));
    try {
      const r = await run(BODY);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(r.ms).toBeLessThan(300 + STARTUP_SLACK_MS);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
