import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createClient } from '../src';

const uuid = '0192f1c2-7b3a-7c1e-8a4d-3f2b1c0d9e8f';

function fake(respond: (req: Request) => Response) {
  const calls: Request[] = [];
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const req = new Request(new URL(input, 'http://test.invalid'), init);
    calls.push(req);
    return respond(req);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

describe('client', () => {
  it('sends the bearer key, query and JSON body', async () => {
    const { fetchFn, calls } = fake(() =>
      json(
        { fileId: uuid, uploadUrl: 'https://s/x', uploadHeaders: {}, expiresAt: '2026-10-31T12:10:00.000Z' },
        { status: 201 },
      ),
    );
    const c = createClient({ baseUrl: 'http://api/', apiKey: 'k', fetch: fetchFn });
    const res = await c.createUpload({ contentType: 'image/png', bytes: 5 });
    expect(res.fileId).toBe(uuid);
    expect(calls[0]?.url).toBe('http://api/api/uploads');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer k');
    expect(await calls[0]?.json()).toEqual({ contentType: 'image/png', bytes: 5 });
  });

  it('serialises list queries and skips undefined values', async () => {
    const { fetchFn, calls } = fake(() => json({ items: [], nextCursor: null }));
    await createClient({ fetch: fetchFn }).listFiles({ limit: 10, cursor: undefined });
    expect(new URL(calls[0]?.url ?? '').search).toBe('?limit=10');
  });

  it('sends x-chaos on complete', async () => {
    const { fetchFn, calls } = fake(() => new Response('{}', { status: 500 }));
    await createClient({ fetch: fetchFn })
      .completeUpload(uuid, { chaos: 'fail' })
      .catch(() => undefined);
    expect(calls[0]?.headers.get('x-chaos')).toBe('fail');
  });

  it('throws ApiError carrying the problem document', async () => {
    const problem = { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' };
    const { fetchFn } = fake(
      () =>
        new Response(JSON.stringify(problem), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    const err = await createClient({ fetch: fetchFn })
      .getFile(uuid)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.problem).toEqual(problem);
  });

  it('throws ApiError with a null problem for foreign bodies', async () => {
    const { fetchFn } = fake(() => new Response('<html>', { status: 502 }));
    const err = await createClient({ fetch: fetchFn })
      .stats()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.problem).toBeNull();
  });

  it('resolves deepHealth for 503', async () => {
    const body = {
      status: 'down',
      checks: { database: { status: 'down' }, storage: { status: 'ok' }, queue: { status: 'unknown' } },
    };
    const { fetchFn } = fake(() => json(body, { status: 503 }));
    expect((await createClient({ fetch: fetchFn }).deepHealth()).status).toBe('down');
  });

  it('returns nothing for 204', async () => {
    const { fetchFn } = fake(() => new Response(null, { status: 204 }));
    await expect(createClient({ fetch: fetchFn }).deleteFile(uuid)).resolves.toBeUndefined();
  });

  it('rejects a response that does not match the schema', async () => {
    const { fetchFn } = fake(() => json({ status: 'weird' }));
    await expect(createClient({ fetch: fetchFn }).health()).rejects.toThrow();
  });
});

describe('client option handling', () => {
  it('strips trailing slashes from baseUrl and sends no authorization without a key', async () => {
    const { fetchFn, calls } = fake(() => json({ status: 'ok' }));
    await createClient({ baseUrl: 'http://api///', fetch: fetchFn }).health();
    expect(calls[0]?.url).toBe('http://api/api/health');
    expect(calls[0]?.headers.has('authorization')).toBe(false);
    expect(calls[0]?.headers.get('accept')).toBe('application/json');
  });

  it('lets a request header override the headers hook, and sends credentials as configured', async () => {
    const seen: RequestInit[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return json({ fileId: uuid, status: 'queued' });
    }) as unknown as typeof fetch;
    const c = createClient({
      fetch: fetchFn,
      credentials: 'include',
      headers: () => ({ traceparent: '00-a-b-01', 'x-chaos': 'slow' }),
    });
    await c.completeUpload(uuid, { chaos: 'fail' }).catch(() => undefined);
    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers.traceparent).toBe('00-a-b-01');
    expect(headers['x-chaos']).toBe('fail');
    expect(seen[0]?.credentials).toBe('include');
  });

  it('sends no x-chaos unless asked', async () => {
    const { fetchFn, calls } = fake(() => new Response('{}', { status: 500 }));
    await createClient({ fetch: fetchFn })
      .completeUpload(uuid)
      .catch(() => undefined);
    expect(calls[0]?.headers.has('x-chaos')).toBe(false);
  });

  it('uses the right verb and path for every call', async () => {
    const { fetchFn, calls } = fake(() => new Response(null, { status: 204 }));
    const c = createClient({ baseUrl: 'http://api', fetch: fetchFn });
    const attempts = [
      c.updateFile(uuid, { isPublic: true }),
      c.deleteFile(uuid),
      c.rum({ name: 'LCP', value: 1, platform: 'aws', variant: 'portable', topology: 'single' }),
      c.debugCpu(250),
      c.stats(),
      c.getFile(uuid),
      c.listFiles({ limit: 5, cursor: uuid }),
    ].map((p) => p.catch(() => undefined));
    await Promise.all(attempts);
    expect(calls.map((r) => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`)).toEqual([
      `PATCH /api/files/${uuid}`,
      `DELETE /api/files/${uuid}`,
      'POST /api/rum',
      'POST /api/debug/cpu?ms=250',
      'GET /api/stats',
      `GET /api/files/${uuid}`,
      `GET /api/files?limit=5&cursor=${uuid}`,
    ]);
    expect(await calls[2]?.json()).toEqual({
      name: 'LCP',
      value: 1,
      platform: 'aws',
      variant: 'portable',
      topology: 'single',
    });
    expect(c.eventsUrl(uuid)).toBe(`http://api/api/files/${uuid}/events`);
  });

  it('treats other 5xx answers of deepHealth as errors', async () => {
    const { fetchFn } = fake(() => json({}, { status: 502 }));
    await expect(createClient({ fetch: fetchFn }).deepHealth()).rejects.toBeInstanceOf(ApiError);
  });

  it.each([
    ['not JSON', 'oops'],
    ['not a problem', JSON.stringify({ status: 'bad' })],
    ['a status below 400', JSON.stringify({ type: 't', title: 't', status: 200 })],
  ])('gives a null problem when an error body is %s', async (_name, body) => {
    const { fetchFn } = fake(
      () => new Response(body, { status: 500, headers: { 'content-type': 'application/problem+json' } }),
    );
    const err = await createClient({ fetch: fetchFn })
      .stats()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.problem).toBeNull();
    expect(err.message).toBe('HTTP 500');
  });

  it('puts the problem title and detail in the error message', async () => {
    const problem = { type: 'about:blank', title: 'Conflict', status: 409, detail: 'File is ready' };
    const { fetchFn } = fake(
      () =>
        new Response(JSON.stringify(problem), {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    const err = await createClient({ fetch: fetchFn })
      .completeUpload(uuid)
      .catch((e) => e);
    expect(err.message).toBe('Conflict: File is ready');
    expect(err.response.status).toBe(409);
  });

  it('propagates network failures untouched', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(createClient({ fetch: fetchFn }).health()).rejects.toThrow('fetch failed');
  });
});

// The same client over a real socket and the global fetch: what the fake cannot show is how headers, bodies and
// status lines survive the wire.
describe('client over HTTP', () => {
  let server: Server;
  let baseUrl: string;
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        const path = req.url ?? '';
        if (path === '/api/health')
          return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
        if (path.startsWith('/api/files/') && req.method === 'DELETE') return void res.writeHead(204).end();
        if (path === '/api/health/deep')
          return void res.writeHead(503, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              status: 'down',
              checks: {
                database: { status: 'down', error: 'x' },
                storage: { status: 'ok' },
                queue: { status: 'unknown' },
              },
            }),
          );
        if (path === '/api/uploads')
          return void res
            .writeHead(401, { 'content-type': 'application/problem+json', 'www-authenticate': 'Bearer' })
            .end(JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401, traceId: 'abc' }));
        res.writeHead(404).end('<html>nope</html>');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('parses a 200, an empty 204 and the 503 of deep health', async () => {
    const c = createClient({ baseUrl, apiKey: 'secret' });
    expect(await c.health()).toEqual({ status: 'ok' });
    await expect(c.deleteFile(uuid)).resolves.toBeUndefined();
    expect((await c.deepHealth()).checks.database.status).toBe('down');
    const health = seen.find((r) => r.url === '/api/health');
    expect(health?.headers.authorization).toBe('Bearer secret');
    expect(health?.headers.accept).toBe('application/json');
  });

  it('sends the JSON body and content type, and surfaces the problem of a 401', async () => {
    const err = await createClient({ baseUrl })
      .createUpload({ contentType: 'image/png', bytes: 5 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.problem?.traceId).toBe('abc');
    expect(err.response.headers.get('www-authenticate')).toBe('Bearer');
    const sent = seen.find((r) => r.url === '/api/uploads');
    expect(sent?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent?.body ?? '')).toEqual({ contentType: 'image/png', bytes: 5 });
  });

  it('turns an HTML 404 from a proxy into an ApiError without a problem', async () => {
    const err = await createClient({ baseUrl })
      .stats()
      .catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.problem).toBeNull();
  });

  it('rejects when nothing listens', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(createClient({ baseUrl: url }).health()).rejects.toThrow();
  });
});
