import { files } from '@hostmark/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, databaseUrl, KEYS, type TestDb } from '../../core/test/helpers/db';
import { fakeImage } from '../../core/test/helpers/fakes';
import { createHarness, type Harness } from '../../core/test/helpers/harness';
import { createAuth } from '../src';

const ORIGIN = 'http://hostmark.test';
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!databaseUrl)('the cookie path through createApp and createAuth', () => {
  let testDb: TestDb;
  let h: Harness;
  let cookie: string;
  let userId: string;

  const call = (
    path: string,
    init: RequestInit & { json?: unknown; origin?: string | null; cookie?: boolean } = {},
  ) => {
    const { json, origin = ORIGIN, cookie: withCookie = true, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (withCookie) headers.set('cookie', cookie);
    if (origin) headers.set('origin', origin);
    let body = rest.body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      headers.set('content-type', 'application/json');
    }
    return h.app.request(`${ORIGIN}${path}`, { ...rest, headers, body });
  };

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(async () => {
    await testDb.close();
  });
  beforeEach(async () => {
    h = await createHarness(testDb, {
      auth: createAuth({ db: testDb.db, secret: 'x'.repeat(40), baseUrl: ORIGIN, signupEnabled: true }),
    });
    const res = await h.app.request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'web@example.test', password: PASSWORD, name: 'Web' }),
    });
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    userId = ((await res.json()) as { user: { id: string } }).user.id;
  });

  /** Uploads through the cookie and returns the file id; the bytes go to the fake storage. */
  const upload = async (): Promise<string> => {
    const bytes = fakeImage();
    const res = await call('/api/uploads', {
      method: 'POST',
      json: { contentType: 'image/png', bytes: bytes.byteLength },
    });
    expect(res.status).toBe(201);
    const { fileId } = (await res.json()) as { fileId: string };
    const row = await h.row(fileId);
    await h.storage.put(row.originalKey, bytes, 'image/png');
    return fileId;
  };

  it('runs upload, complete, processing, get, list, patch and delete as the session user', async () => {
    const id = await upload();
    const row = await h.row(id);
    expect(row).toMatchObject({ userId, apiKeyId: null });

    expect((await call(`/api/uploads/${id}/complete`, { method: 'POST' })).status).toBe(200);
    const msg = h.queue.messages('process_image').at(-1);
    if (!msg) throw new Error('no job');
    await h.deliver(msg);

    const got = await call(`/api/files/${id}`, { origin: null });
    expect(((await got.json()) as { status: string }).status).toBe('ready');
    const list = (await (await call('/api/files', { origin: null })).json()) as { items: { id: string }[] };
    expect(list.items.map((f) => f.id)).toEqual([id]);

    const patched = await call(`/api/files/${id}`, { method: 'PATCH', json: { isPublic: true } });
    expect(((await patched.json()) as { isPublic: boolean }).isPublic).toBe(true);
    expect((await call(`/api/files/${id}`, { method: 'DELETE' })).status).toBe(204);
  });

  it("cannot see another user's files", async () => {
    const other = await h.upload(KEYS.alice, fakeImage());
    expect((await call(`/api/files/${other}`, { origin: null })).status).toBe(404);
    expect((await call(`/api/files/${other}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('streams the SSE status of its own file, authenticated by the cookie alone', async () => {
    const id = await upload();
    const res = await call(`/api/files/${id}/events`, {
      origin: null,
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(first).toContain('event: status');
    expect(first).toContain('"status":"pending_upload"');

    const noCookie = await call(`/api/files/${id}/events`, { origin: null, cookie: false });
    expect(noCookie.status).toBe(401);
    const other = await h.upload(KEYS.alice, fakeImage());
    expect((await call(`/api/files/${other}/events`, { origin: null })).status).toBe(404);
  });

  describe('same-origin check on mutations (D7, D51)', () => {
    it.each([
      ['no Origin', null],
      ['a foreign Origin', 'https://evil.example'],
      ['a lookalike host', 'http://hostmark.test.evil.example'],
      ['an unparsable Origin', 'null'],
    ])('rejects a cookie POST with %s', async (_name, origin) => {
      const before = await testDb.db.select().from(files);
      const res = await call('/api/uploads', {
        method: 'POST',
        origin,
        json: { contentType: 'image/png', bytes: 5 },
      });
      expect(res.status).toBe(403);
      expect(await testDb.db.select().from(files)).toHaveLength(before.length);
    });

    it('rejects PATCH and DELETE across origins', async () => {
      const id = await upload();
      expect(
        (
          await call(`/api/files/${id}`, {
            method: 'PATCH',
            origin: 'https://evil.example',
            json: { isPublic: true },
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(`/api/files/${id}`, { method: 'DELETE', origin: 'https://evil.example' })).status,
      ).toBe(403);
      expect((await h.row(id)).deletedAt).toBeNull();
    });

    it('accepts the host the browser used, taken from x-forwarded-host behind a proxy', async () => {
      const res = await h.app.request('http://api.internal:8080/api/uploads', {
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://app.example.test',
          host: 'api.internal:8080',
          'x-forwarded-host': 'App.Example.test, api.internal:8080',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ contentType: 'image/png', bytes: 5 }),
      });
      expect(res.status).toBe(201);
    });

    it('does not apply to Bearer requests', async () => {
      const res = await h.request('/api/uploads', {
        method: 'POST',
        key: KEYS.alice,
        json: { contentType: 'image/png', bytes: 5 },
      });
      expect(res.status).toBe(201);
    });

    it('does not let a cookie plus a hostile Origin ride on a Bearer header, and a bad Bearer is not rescued by the cookie', async () => {
      const res = await call('/api/files', { headers: { authorization: 'Bearer nope' } });
      expect(res.status).toBe(401);
    });

    it('does not apply to reads', async () => {
      expect((await call('/api/files', { origin: 'https://evil.example' })).status).toBe(200);
    });
  });

  it('never gives a session the admin role', async () => {
    const res = await call('/api/debug/cpu?ms=1', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/Admin key required/);
    const id = await upload();
    const chaos = await call(`/api/uploads/${id}/complete`, {
      method: 'POST',
      headers: { 'x-chaos': 'fail' },
    });
    expect(chaos.status).toBe(403);
    const admin = await h.request('/api/debug/cpu?ms=1', { method: 'POST', key: KEYS.admin });
    expect(admin.status).toBe(200);
  });
});
