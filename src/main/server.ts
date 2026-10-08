// Ingest server: receives forwarded hook payloads on 127.0.0.1 only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface IngestServerOptions {
  port: number;
  token: string;
  /** Max request body in bytes (default 256 KB). */
  maxBytes?: number;
  version?: string;
  host?: '127.0.0.1';
  onPayload: (raw: unknown, receivedAt: number) => void;
}

export interface IngestServer {
  port: number;
  close(): Promise<void>;
  stats(): { received: number; rejected: number };
}

const DEFAULT_MAX_BYTES = 256 * 1024;

function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b); // keep timing roughly constant
    return false;
  }
  return timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent) return;
  if (body === undefined) {
    res.writeHead(status, { 'content-length': '0' });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startIngestServer(opts: IngestServerOptions): Promise<IngestServer> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const host = opts.host ?? '127.0.0.1';
  let received = 0;
  let rejected = 0;

  const reject = (res: ServerResponse, status: number, req?: IncomingMessage): void => {
    rejected++;
    send(res, status, { ok: false });
    if (req && !req.complete) req.resume();
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = (req.url ?? '').split('?')[0];
    if (req.headers.origin !== undefined) return reject(res, 403, req);
    if (!tokenMatches(req.headers['x-wsc-token'], opts.token)) return reject(res, 401, req);

    if (req.method === 'GET' && url === '/v1/health') {
      return send(res, 200, { ok: true, app: 'wsc', version: opts.version ?? '', received });
    }
    if (req.method !== 'POST' || url !== '/v1/events') return reject(res, 404, req);

    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBytes) {
      rejected++;
      send(res, 413, { ok: false });
      req.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        rejected++;
        send(res, 413, { ok: false });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      aborted = true;
    });
    req.on('end', () => {
      if (aborted) return;
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(res, 400);
      }
      received++;
      send(res, 204);
      try {
        opts.onPayload(payload, Date.now());
      } catch {
        // Never let a consumer bug take down the server.
      }
    });
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      try {
        send(res, 500, { ok: false });
      } catch {
        // ignore
      }
    }
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;

  let port: number;
  try {
    port = await listen(server, opts.port, host);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    port = await listen(server, 0, host);
  }

  return {
    port,
    stats: () => ({ received, rejected }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
