import { describe, expect, it } from 'vitest';
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
