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
