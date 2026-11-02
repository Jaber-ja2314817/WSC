import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startIngestServer, type IngestServer } from '../src/main/server';

const TOKEN = 'test-token-0123456789';
let server: IngestServer | undefined;
let payloads: unknown[] = [];

async function start(opts: { port?: number; maxBytes?: number } = {}): Promise<IngestServer> {
  payloads = [];
  server = await startIngestServer({
    port: opts.port ?? 0,
    token: TOKEN,
    maxBytes: opts.maxBytes,
    version: '0.1.0',
    onPayload: (p) => payloads.push(p),
  });
  return server;
}

const url = (s: IngestServer, path: string): string => `http://127.0.0.1:${s.port}${path}`;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const payload = { hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd: '/home/user/demo' };

describe('ingest server', () => {
  it('accepts a valid event and delivers the parsed payload', async () => {
    const s = await start();
    const res = await fetch(url(s, '/v1/events'), {
      method: 'POST',
      headers: { 'x-wsc-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(204);
    expect(payloads).toEqual([payload]);
    expect(s.stats().received).toBe(1);
  });

  it('serves health with the token', async () => {
    const s = await start();
    const res = await fetch(url(s, '/v1/health'), { headers: { 'x-wsc-token': TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, app: 'wsc', version: '0.1.0' });
  });

  it.each([undefined, 'wrong', `${TOKEN}x`])('rejects token %s with 401', async (token) => {
    const s = await start();
    const headers: Record<string, string> = token ? { 'x-wsc-token': token } : {};
    const res = await fetch(url(s, '/v1/events'), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(401);
    expect(payloads).toEqual([]);
  });

  it('rejects requests with an Origin header', async () => {
    const s = await start();
    const res = await fetch(url(s, '/v1/events'), {
      method: 'POST',
      headers: { 'x-wsc-token': TOKEN, origin: 'https://evil.example' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(payloads).toEqual([]);
  });

  it('rejects oversized bodies with 413', async () => {
    const s = await start({ maxBytes: 1024 });
    const res = await fetch(url(s, '/v1/events'), {
      method: 'POST',
      headers: { 'x-wsc-token': TOKEN },
      body: JSON.stringify({ big: 'x'.repeat(5000) }),
    }).catch(() => null);
    // Server may reset the socket after replying; either way nothing is delivered.
    if (res) expect(res.status).toBe(413);
    expect(payloads).toEqual([]);
  });

  it('rejects malformed JSON with 400 and keeps running', async () => {
    const s = await start();
    const bad = await fetch(url(s, '/v1/events'), {
      method: 'POST',
      headers: { 'x-wsc-token': TOKEN },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(url(s, '/v1/events'), {
      method: 'POST',
      headers: { 'x-wsc-token': TOKEN },
      body: '{}',
    });
    expect(ok.status).toBe(204);
  });

  it('returns 404 for unknown routes', async () => {
    const s = await start();
    const res = await fetch(url(s, '/nope'), { headers: { 'x-wsc-token': TOKEN } });
    expect(res.status).toBe(404);
  });

  it('survives a throwing consumer', async () => {
    server = await startIngestServer({
      port: 0,
      token: TOKEN,
      onPayload: () => {
        throw new Error('boom');
      },
    });
    const res = await fetch(url(server, '/v1/events'), {
      method: 'POST',
      headers: { 'x-wsc-token': TOKEN },
      body: '{}',
    });
    expect(res.status).toBe(204);
  });

  it('falls back to a free port when the preferred port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const s = await start({ port: taken });
      expect(s.port).not.toBe(taken);
      const res = await fetch(url(s, '/v1/health'), { headers: { 'x-wsc-token': TOKEN } });
      expect(res.status).toBe(200);
    } finally {
      blocker.close();
    }
  });
});

describe('ingest server /v1/command', () => {
  let commands: unknown[] = [];

  async function startWithCommands(): Promise<IngestServer> {
    commands = [];
    server = await startIngestServer({
      port: 0,
      token: TOKEN,
      version: '0.1.0',
      onPayload: () => {},
      onCommand: (cmd) => {
        commands.push(cmd);
        return cmd.action === 'status' ? { running: true, port: 1234 } : undefined;
      },
    });
    return server;
  }

  const post = (s: IngestServer, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url(s, '/v1/command'), {
      method: 'POST',
      headers: { 'x-wsc-token': TOKEN, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('dispatches a valid command and returns its result', async () => {
    const s = await startWithCommands();
    const res = await post(s, { action: 'theme', arg: 'office' });
    expect(res.status).toBe(200);
    expect(commands).toEqual([{ action: 'theme', arg: 'office' }]);
    const status = await post(s, { action: 'status' });
    expect(await status.json()).toEqual({ ok: true, running: true, port: 1234 });
  });

  it('does not count commands as received events', async () => {
    const s = await startWithCommands();
    await post(s, { action: 'focus' });
    expect(s.stats().received).toBe(0);
  });

  it('requires the token', async () => {
    const s = await startWithCommands();
    const res = await post(s, { action: 'focus' }, { 'x-wsc-token': 'nope' });
    expect(res.status).toBe(401);
    expect(commands).toEqual([]);
  });

  it('rejects browser origins', async () => {
    const s = await startWithCommands();
    const res = await post(s, { action: 'focus' }, { origin: 'https://example.com' });
    expect(res.status).toBe(403);
    expect(commands).toEqual([]);
  });

  it.each([{}, { action: 'rm -rf' }, { action: 'theme', arg: 5 }, [], 'focus'])(
    'rejects malformed command %j',
    async (body) => {
      const s = await startWithCommands();
      const res = await post(s, body);
      expect(res.status).toBe(400);
      expect(commands).toEqual([]);
    },
  );

  it('is a 404 when no command handler is configured', async () => {
    const s = await start();
    const res = await post(s, { action: 'focus' });
    expect(res.status).toBe(404);
  });
});

describe('ingest server /v1/limits', () => {
  let limits: unknown[] = [];
  const startWithLimits = async (): Promise<IngestServer> => {
    limits = [];
    payloads = [];
    server = await startIngestServer({
      port: 0,
      token: TOKEN,
      onPayload: (p) => payloads.push(p),
      onLimits: (p) => limits.push(p),
    });
    return server;
  };
  const body = { session_id: 'sess-1', rate_limits: { five_hour: { used_percentage: 5 } } };

  it('delivers status line limits, not as hook events', async () => {
    const s = await startWithLimits();
    const res = await fetch(url(s, '/v1/limits'), {
      method: 'POST',
      headers: { 'x-wsc-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(204);
    expect(limits).toEqual([body]);
    expect(payloads).toEqual([]);
    expect(s.stats().received).toBe(0);
  });

  it('requires the token and rejects browser origins', async () => {
    const s = await startWithLimits();
    const noToken = await fetch(url(s, '/v1/limits'), {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(noToken.status).toBe(401);
    const origin = await fetch(url(s, '/v1/limits'), {
      method: 'POST',
      headers: { 'x-wsc-token': TOKEN, origin: 'https://example.com' },
      body: JSON.stringify(body),
    });
    expect(origin.status).toBe(403);
    expect(limits).toEqual([]);
  });

  it('is a 404 without a limits handler', async () => {
    const s = await start();
    const res = await fetch(url(s, '/v1/limits'), {
      method: 'POST',
      headers: { 'x-wsc-token': TOKEN },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(404);
  });
});
