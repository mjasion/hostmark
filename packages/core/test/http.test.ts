import { MAX_UPLOAD_BYTES } from '@hostmark/contract';
import { files } from '@hostmark/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionAuth } from '../src/deps';
import { createApp } from '../src/http/app';
import { createTestDb, databaseUrl, KEYS, type TestDb, USERS } from './helpers/db';
import { createTestTelemetry, fakeImage, MemoryQueue } from './helpers/fakes';
import { createHarness, type Harness, lastMessage } from './helpers/harness';

let testDb: TestDb;
beforeAll(async () => {
  if (databaseUrl) testDb = await createTestDb();
});
afterAll(async () => {
  await testDb?.close();
});

const problemOf = async (res: Response) => {
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  return (await res.json()) as {
    type: string;
    title: string;
    status: number;
    detail?: string;
    traceId?: string;
    errors?: { path: string; message: string }[];
  };
};

describe.skipIf(!databaseUrl)('http', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness(testDb);
  });

  describe('headers and errors', () => {
    it('answers /api/health without touching any dependency', async () => {
      const boom = new Proxy(
        {},
        {
          get: () => {
            throw new Error('dependency touched');
          },
        },
      );
      const app = createApp(() => ({
        ...h.deps,
        db: boom as never,
        storage: boom as never,
        queue: boom as never,
        images: boom as never,
      }));
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('sets trace, platform and version headers and no-store on /api', async () => {
      const res = await h.request('/api/health');
      expect(res.headers.get('x-trace-id')).toMatch(/^[0-9a-f]{32}$/);
      expect(res.headers.get('x-platform')).toBe('test-portable');
      expect(res.headers.get('x-version')).toBe('abc1234');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    });

    it('returns problem+json for unknown routes with all headers', async () => {
      const res = await h.request('/nope');
      expect(res.status).toBe(404);
      const p = await problemOf(res);
      expect(p.status).toBe(404);
      expect(p.traceId).toBe(res.headers.get('x-trace-id'));
      expect(res.headers.get('x-platform')).toBe('test-portable');
    });

    it('does not leak internals on an unexpected 500 and keeps the headers', async () => {
      const db = new Proxy(h.deps.db, {
        get(target, prop, receiver) {
          if (prop === 'select') throw new Error('connect failed postgres://u:hunter2@db.internal/app');
          return Reflect.get(target, prop, receiver);
        },
      });
      const app = createApp(() => ({ ...h.deps, db }));
      const res = await app.request('/api/stats', { headers: { authorization: `Bearer ${KEYS.alice}` } });
      expect(res.status).toBe(500);
      const text = await res.clone().text();
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('db.internal');
      const p = await problemOf(res);
      expect(p.title).toBe('Internal Server Error');
      expect(p.traceId).toBe(res.headers.get('x-trace-id'));
      expect(res.headers.get('x-platform')).toBe('test-portable');
      expect(res.headers.get('x-version')).toBe('abc1234');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(h.telemetry.logs.some((l) => l.level === 'error' && l.msg === 'unhandled error')).toBe(true);
    });

    it('keeps the D9 headers and logs the cause when resolving dependencies fails (m18)', async () => {
      let fail = false;
      const app = createApp(() => {
        if (fail) throw new Error('config missing: DATABASE_URL');
        return h.deps;
      });
      expect((await app.request('/api/health')).status).toBe(200);
      fail = true;
      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
      const res = await app.request('/api/health');
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(res.headers.get('x-platform')).toBe('test-portable');
      expect(res.headers.get('x-version')).toBe('abc1234');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(errors.join('')).toContain('config missing: DATABASE_URL');
      const media = await app.request(`/media/${crypto.randomUUID()}/128.webp`);
      expect(media.status).toBe(500);
      expect(media.headers.get('cache-control')).toBe('no-store');
      expect(await res.clone().text()).not.toContain('DATABASE_URL');
      expect((await problemOf(res)).traceId).toBe(res.headers.get('x-trace-id'));
    });

    it('records request duration by route pattern, not by raw path', async () => {
      const id = crypto.randomUUID();
      await h.request(`/api/files/${id}`, { key: KEYS.alice });
      await h.request('/some/random/path-1');
      const rec = h.telemetry.of('httpRequestDuration');
      expect(rec[0]?.attrs).toMatchObject({
        'http.route': '/api/files/:id',
        'http.response.status_code': 404,
        'http.request.method': 'GET',
      });
      expect(rec[1]?.attrs).toMatchObject({ 'http.route': 'unmatched' });
    });

    it('counts a cold start once per module instance', async () => {
      vi.resetModules();
      const fresh = await import('../src/http/app');
      const telemetry = createTestTelemetry();
      const app = fresh.createApp(() => ({ ...h.deps, telemetry }));
      await app.request('/api/health');
      await app.request('/api/health');
      expect(telemetry.of('coldStart')).toHaveLength(1);
    });

    it('serves the OpenAPI document', async () => {
      const res = await h.request('/api/openapi.json');
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        paths: Record<string, unknown>;
        components: { securitySchemes: object };
      };
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          '/api/health',
          '/api/uploads',
          '/api/files/{id}',
          '/api/files/{id}/events',
          '/api/rum',
        ]),
      );
      expect(doc.components.securitySchemes).toHaveProperty('bearerAuth');
    });
  });

  describe('authentication', () => {
    it('rejects missing, malformed and unknown credentials with 401', async () => {
      for (const headers of [
        {} as Record<string, string>,
        { authorization: 'Basic abc' },
        { authorization: 'Bearer wrong' },
        { authorization: 'Bearer ' },
      ]) {
        const res = await h.request('/api/files', { headers });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        expect((await problemOf(res)).status).toBe(401);
      }
    });

    it('never logs the key', async () => {
      await h.request('/api/files', { key: 'super-secret-value' });
      expect(JSON.stringify(h.telemetry.logs)).not.toContain('super-secret-value');
    });

    describe('session cookie', () => {
      const auth: SessionAuth = {
        handler: async () => new Response('auth-handler', { status: 201 }),
        getSession: async (headers) =>
          headers.get('cookie') === 'session=alice' ? { userId: USERS.alice } : null,
      };
      beforeEach(async () => {
        h = await createHarness(testDb, { auth });
      });

      it('authenticates reads by cookie', async () => {
        const res = await h.request('/api/files', { headers: { cookie: 'session=alice' } });
        expect(res.status).toBe(200);
      });

      it('rejects an unknown session', async () => {
        const res = await h.request('/api/files', { headers: { cookie: 'session=eve' } });
        expect(res.status).toBe(401);
      });

      it('requires same origin on mutating cookie requests only', async () => {
        const body = { contentType: 'image/png', bytes: 10 };
        const noOrigin = await h.request('/api/uploads', {
          method: 'POST',
          json: body,
          headers: { cookie: 'session=alice', host: 'app.test' },
        });
        expect(noOrigin.status).toBe(403);
        const cross = await h.request('/api/uploads', {
          method: 'POST',
          json: body,
          headers: { cookie: 'session=alice', host: 'app.test', origin: 'https://evil.test' },
        });
        expect(cross.status).toBe(403);
        const same = await h.request('/api/uploads', {
          method: 'POST',
          json: body,
          headers: { cookie: 'session=alice', host: 'app.test', origin: 'https://app.test' },
        });
        expect(same.status).toBe(201);
        const [row] = await h.deps.db.select().from(files);
        expect(row).toMatchObject({ userId: USERS.alice, apiKeyId: null });
      });

      it('takes the first entry of x-forwarded-host and accepts either header', async () => {
        const post = (headers: Record<string, string>) =>
          h.request('/api/uploads', {
            method: 'POST',
            json: { contentType: 'image/png', bytes: 10 },
            headers: { cookie: 'session=alice', ...headers },
          });
        // Proxy chain: the browser used app.example.com.
        expect(
          (
            await post({
              host: 'api.internal',
              'x-forwarded-host': 'app.example.com, lb.internal',
              origin: 'https://app.example.com',
            })
          ).status,
        ).toBe(201);
        // The proxy kept the browser's Host and sent its own x-forwarded-host.
        expect(
          (
            await post({
              host: 'app.example.com',
              'x-forwarded-host': 'lb.internal',
              origin: 'https://app.example.com',
            })
          ).status,
        ).toBe(201);
        expect(
          (
            await post({
              host: 'api.internal',
              'x-forwarded-host': 'lb.internal, app.example.com',
              origin: 'https://app.example.com',
            })
          ).status,
        ).toBe(403);
      });

      it('skips the origin check for Bearer requests', async () => {
        const res = await h.request('/api/uploads', {
          method: 'POST',
          key: KEYS.alice,
          json: { contentType: 'image/png', bytes: 10 },
          headers: { origin: 'https://evil.test' },
        });
        expect(res.status).toBe(201);
      });

      it('mounts the auth handler at /api/auth/*', async () => {
        const res = await h.request('/api/auth/sign-in/email', { method: 'POST' });
        expect(res.status).toBe(201);
        expect(await res.text()).toBe('auth-handler');
        expect(res.headers.get('x-platform')).toBe('test-portable');
      });
    });

    it('returns 404 for /api/auth/* when no auth is configured', async () => {
      const res = await h.request('/api/auth/sign-in/email', { method: 'POST' });
      expect(res.status).toBe(404);
      await problemOf(res);
    });
  });

  describe('POST /api/uploads', () => {
    const post = (json: unknown, key: string = KEYS.alice) =>
      h.request('/api/uploads', { method: 'POST', key, json });

    it('creates a pending file and a presigned URL', async () => {
      const res = await post({ contentType: 'image/jpeg', bytes: 1234 });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        fileId: string;
        uploadUrl: string;
        uploadHeaders: Record<string, string>;
        expiresAt: string;
      };
      const row = await h.row(body.fileId);
      expect(row).toMatchObject({
        status: 'pending_upload',
        userId: USERS.alice,
        apiKeyId: h.apiKeyIds.alice,
        contentType: 'image/jpeg',
        originalKey: `originals/${USERS.alice}/${body.fileId}`,
      });
      expect(row.expiresAt.toISOString()).toBe('2026-11-09T12:00:00.000Z');
      expect(body.uploadUrl).toContain(row.originalKey);
      expect(body.uploadUrl).toContain('len=1234');
      expect(body.uploadHeaders).toEqual({ 'content-type': 'image/jpeg' });
      expect(body.expiresAt).toBe('2026-11-02T12:10:00.000Z');
      expect(body.fileId[14]).toBe('7');
    });

    it('rejects invalid bodies with 400 and field errors', async () => {
      const res = await post({ contentType: 'image/gif', bytes: -1 });
      expect(res.status).toBe(400);
      const p = await problemOf(res);
      expect(p.traceId).toBeTruthy();
      expect(p.errors?.map((e) => e.path)).toEqual(
        expect.arrayContaining(['json.contentType', 'json.bytes']),
      );
    });

    it('rejects malformed JSON with 400', async () => {
      const res = await h.request('/api/uploads', {
        method: 'POST',
        key: KEYS.alice,
        body: '{nope',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
      await problemOf(res);
    });

    it('answers 413, not 400, for a size beyond the safe integer range (D24)', async () => {
      const res = await h.request('/api/uploads', {
        method: 'POST',
        key: KEYS.alice,
        body: '{"contentType":"image/png","bytes":90071992547409930}',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(413);
      const fractional = await post({ contentType: 'image/png', bytes: 1.5 });
      expect(fractional.status).toBe(400);
    });

    it('answers 413 above 10 MiB and accepts exactly 10 MiB', async () => {
      expect((await post({ contentType: 'image/png', bytes: MAX_UPLOAD_BYTES + 1 })).status).toBe(413);
      expect((await post({ contentType: 'image/png', bytes: MAX_UPLOAD_BYTES })).status).toBe(201);
    });
  });

  describe('POST /api/uploads/:id/complete', () => {
    const complete = (id: string, key: string = KEYS.alice, headers: Record<string, string> = {}) =>
      h.request(`/api/uploads/${id}/complete`, { method: 'POST', key, headers });

    it('queues the file and enqueues a traced job', async () => {
      const id = await h.upload(KEYS.alice, fakeImage());
      const res = await complete(id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id,
        status: 'queued',
        bytes: fakeImage().byteLength,
        variants: [],
      });
      const row = await h.row(id);
      expect(row.queuedAt?.toISOString()).toBe(h.clock.now().toISOString());
      expect(h.queue.sent).toHaveLength(1);
      expect(lastMessage(h)).toMatchObject({
        v: 1,
        type: 'process_image',
        fileId: id,
        chaos: 'none',
        enqueuedAt: h.clock.now().toISOString(),
      });
    });

    it('builds the job from the canonical id when the path uses uppercase hex (m10)', async () => {
      const id = await h.upload(KEYS.alice, fakeImage());
      const res = await complete(id.toUpperCase());
      expect(res.status).toBe(200);
      expect(lastMessage(h).fileId).toBe(id);
      await h.deliver(lastMessage(h));
      expect((await h.row(id)).status).toBe('ready');
    });

    it('is 409 without an uploaded object', async () => {
      const created = await h.request('/api/uploads', {
        method: 'POST',
        key: KEYS.alice,
        json: { contentType: 'image/png', bytes: 10 },
      });
      const { fileId } = (await created.json()) as { fileId: string };
      expect((await complete(fileId)).status).toBe(409);
      expect(h.queue.sent).toHaveLength(0);
    });

    it('is 409 on a second complete', async () => {
      const id = await h.upload(KEYS.alice, fakeImage());
      expect((await complete(id)).status).toBe(200);
      expect((await complete(id)).status).toBe(409);
      expect(h.queue.sent).toHaveLength(1);
    });

    it('is 413 for an oversized object and deletes it', async () => {
      const id = await h.upload(KEYS.alice, fakeImage());
      await h.storage.put((await h.row(id)).originalKey, new Uint8Array(MAX_UPLOAD_BYTES + 1), 'image/png');
      const res = await complete(id);
      expect(res.status).toBe(413);
      const row = await h.row(id);
      expect(await h.storage.head(row.originalKey)).toBeNull();
      expect(row.status).toBe('failed');
    });

    it('hides another user’s file with 404', async () => {
      const id = await h.upload(KEYS.alice, fakeImage());
      expect((await complete(id, KEYS.bob)).status).toBe(404);
    });

    it('is 400 for a malformed id or chaos value', async () => {
      expect((await complete('not-a-uuid')).status).toBe(400);
      const id = await h.upload(KEYS.alice, fakeImage());
      expect((await complete(id, KEYS.admin, { 'x-chaos': 'explode' })).status).toBe(400);
    });

    it('is 403 for any x-chaos from a non-admin, valid or not, and passes it from an admin', async () => {
      const id = await h.upload(KEYS.alice, fakeImage());
      expect((await complete(id, KEYS.alice, { 'x-chaos': 'fail' })).status).toBe(403);
      expect((await complete(id, KEYS.alice, { 'x-chaos': 'explode' })).status).toBe(403);
      expect((await complete(id, KEYS.alice, { 'x-chaos': 'none' })).status).toBe(403);
      expect((await complete('not-a-uuid', KEYS.alice, { 'x-chaos': 'fail' })).status).toBe(403);
      expect((await h.row(id)).status).toBe('pending_upload');

      const adminId = await h.upload(KEYS.admin, fakeImage());
      expect((await complete(adminId, KEYS.admin, { 'x-chaos': 'crash' })).status).toBe(200);
      expect(lastMessage(h).chaos).toBe('crash');
    });

    it('reverts the status and answers 503 when enqueueing fails', async () => {
      const id = await h.upload(KEYS.alice, fakeImage());
      h.queue.fail = new Error('queue down');
      const res = await complete(id);
      expect(res.status).toBe(503);
      await problemOf(res);
      expect(await h.row(id)).toMatchObject({ status: 'pending_upload', queuedAt: null });
      h.queue.fail = null;
      expect((await complete(id)).status).toBe(200);
    });

    it('requires authentication', async () => {
      expect(
        (await h.request(`/api/uploads/${crypto.randomUUID()}/complete`, { method: 'POST' })).status,
      ).toBe(401);
    });
  });

  describe('files', () => {
    it('returns 404 for a missing file and for another user’s file', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
      expect((await h.request(`/api/files/${id}`, { key: KEYS.bob })).status).toBe(404);
      expect((await h.request(`/api/files/${crypto.randomUUID()}`, { key: KEYS.alice })).status).toBe(404);
      expect((await h.request('/api/files/xyz', { key: KEYS.alice })).status).toBe(400);
      expect((await h.request(`/api/files/${id}`, { key: KEYS.alice })).status).toBe(200);
    });

    it('presigns variant URLs for ready files without per-item storage calls', async () => {
      const ids = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await h.uploadAndComplete(KEYS.alice, fakeImage(2000, 1000, String(i))));
        await h.deliver(lastMessage(h));
      }
      h.storage.gets = 0;
      h.storage.presigned.length = 0;
      const res = await h.request('/api/files', { key: KEYS.alice });
      const body = (await res.json()) as {
        items: { id: string; status: string; variants: { size: number; url: string; bytes: number }[] }[];
      };
      expect(body.items).toHaveLength(3);
      for (const item of body.items) {
        expect(item.status).toBe('ready');
        expect(item.variants.map((v) => v.size)).toEqual([128, 512, 1600]);
        expect(item.variants[0]?.url).toContain(`variants/${USERS.alice}/${item.id}/128.webp`);
      }
      expect(h.storage.gets).toBe(0);
      expect(h.storage.presigned).toHaveLength(9);
    });

    it('lists newest first with cursor pagination, per user', async () => {
      const mine: string[] = [];
      for (let i = 0; i < 5; i++) mine.push(await h.upload(KEYS.alice, fakeImage()));
      await h.upload(KEYS.bob, fakeImage());
      const first = (await (await h.request('/api/files?limit=2', { key: KEYS.alice })).json()) as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      expect(first.items.map((i) => i.id)).toEqual([mine[4], mine[3]]);
      expect(first.nextCursor).toBe(mine[3]);
      const second = (await (
        await h.request(`/api/files?limit=2&cursor=${first.nextCursor}`, { key: KEYS.alice })
      ).json()) as typeof first;
      expect(second.items.map((i) => i.id)).toEqual([mine[2], mine[1]]);
      const last = (await (
        await h.request(`/api/files?limit=2&cursor=${second.nextCursor}`, { key: KEYS.alice })
      ).json()) as typeof first;
      expect(last.items.map((i) => i.id)).toEqual([mine[0]]);
      expect(last.nextCursor).toBeNull();
    });

    it('validates list parameters', async () => {
      for (const q of ['limit=0', 'limit=101', 'limit=abc', 'cursor=not-a-uuid']) {
        expect((await h.request(`/api/files?${q}`, { key: KEYS.alice })).status).toBe(400);
      }
    });

    it('patches isPublic and hides other users', async () => {
      const id = await h.upload(KEYS.alice, fakeImage());
      const res = await h.request(`/api/files/${id}`, {
        method: 'PATCH',
        key: KEYS.alice,
        json: { isPublic: true },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, isPublic: true });
      expect((await h.row(id)).isPublic).toBe(true);
      expect(
        (await h.request(`/api/files/${id}`, { method: 'PATCH', key: KEYS.bob, json: { isPublic: false } }))
          .status,
      ).toBe(404);
      expect(
        (await h.request(`/api/files/${id}`, { method: 'PATCH', key: KEYS.alice, json: { isPublic: 'yes' } }))
          .status,
      ).toBe(400);
    });

    it('soft deletes once and hides the file afterwards', async () => {
      const id = await h.upload(KEYS.alice, fakeImage());
      expect((await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.bob })).status).toBe(404);
      const res = await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(await h.row(id)).toMatchObject({ status: 'deleted' });
      expect((await h.row(id)).deletedAt).not.toBeNull();
      expect((await h.request(`/api/files/${id}`, { key: KEYS.alice })).status).toBe(404);
      expect((await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice })).status).toBe(404);
      expect(
        (await (await h.request('/api/files', { key: KEYS.alice })).json()) as { items: unknown[] },
      ).toMatchObject({ items: [] });
    });
  });

  describe('GET /api/files/:id/events', () => {
    const events = (text: string) =>
      text
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const lines = Object.fromEntries(
            block.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]),
          );
          return { event: lines.event, data: JSON.parse(lines.data as string) as { status: string } };
        });

    it('streams status changes and closes on a terminal status', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
      let polls = 0;
      h.clock.sleep = async (ms) => {
        h.clock.advance(ms);
        if (++polls === 2) await h.deliver(lastMessage(h));
      };
      const res = await h.request(`/api/files/${id}/events`, { key: KEYS.alice });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const got = events(await res.text());
      expect(got.map((e) => e.data.status)).toEqual(['queued', 'ready']);
      expect(got.every((e) => e.event === 'status')).toBe(true);
    });

    it('closes after the maximum duration', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
      let polls = 0;
      h.clock.sleep = async (ms) => {
        polls++;
        h.clock.advance(ms);
      };
      const res = await h.request(`/api/files/${id}/events`, { key: KEYS.alice });
      const got = events(await res.text());
      expect(got).toHaveLength(1);
      expect(polls).toBe(60);
    });

    it('stops polling when the client disconnects', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
      let polls = 0;
      h.clock.sleep = async (ms) => {
        polls++;
        h.clock.advance(ms);
        await new Promise((r) => setTimeout(r, 10));
      };
      const res = await h.request(`/api/files/${id}/events`, { key: KEYS.alice });
      const reader = (res.body as ReadableStream).getReader();
      await reader.read();
      await reader.cancel();
      await new Promise((r) => setTimeout(r, 50));
      const afterCancel = polls;
      await new Promise((r) => setTimeout(r, 150));
      expect(polls).toBe(afterCancel);
      expect(polls).toBeLessThan(10);
    });

    it('does not start the poll loop for HEAD', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
      let sleeps = 0;
      h.clock.sleep = async (ms) => {
        sleeps++;
        h.clock.advance(ms);
      };
      const res = await h.request(`/api/files/${id}/events`, { method: 'HEAD', key: KEYS.alice });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(sleeps).toBe(0);
    });

    it('is 404 for another user’s file and 401 without credentials', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
      expect((await h.request(`/api/files/${id}/events`, { key: KEYS.bob })).status).toBe(404);
      expect((await h.request(`/api/files/${id}/events`)).status).toBe(401);
    });
  });

  describe('GET /api/stats', () => {
    it('returns the rows of the current platform only', async () => {
      await h.deps.db.execute(
        (await import('drizzle-orm')).sql`insert into daily_stats values
          ('2026-11-01', 'test-portable', 3, 2, 1, 300, 100, 200),
          ('2026-11-01', 'other', 9, 9, 0, 9, null, null)`,
      );
      const res = await h.request('/api/stats', { key: KEYS.alice });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [
          {
            day: '2026-11-01',
            platform: 'test-portable',
            uploads: 3,
            ready: 2,
            failed: 1,
            bytesIn: 300,
            p50ProcessingMs: 100,
            p95ProcessingMs: 200,
          },
        ],
      });
    });
  });

  describe('POST /api/debug/cpu', () => {
    it('is 403 for non-admins, 400 for out of range values, 200 for admins', async () => {
      expect((await h.request('/api/debug/cpu?ms=10', { method: 'POST', key: KEYS.alice })).status).toBe(403);
      // D8: authorization comes before validation.
      expect((await h.request('/api/debug/cpu?ms=0', { method: 'POST', key: KEYS.alice })).status).toBe(403);
      expect((await h.request('/api/debug/cpu', { method: 'POST', key: KEYS.alice })).status).toBe(403);
      expect((await h.request('/api/debug/cpu?ms=0', { method: 'POST', key: KEYS.admin })).status).toBe(400);
      expect((await h.request('/api/debug/cpu?ms=30001', { method: 'POST', key: KEYS.admin })).status).toBe(
        400,
      );
      expect((await h.request('/api/debug/cpu', { method: 'POST', key: KEYS.admin })).status).toBe(400);
      const res = await h.request('/api/debug/cpu?ms=60', { method: 'POST', key: KEYS.admin });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        requestedMs: number;
        elapsedMs: number;
        iterations: number;
        hash: string;
      };
      expect(body.requestedMs).toBe(60);
      expect(body.elapsedMs).toBeGreaterThanOrEqual(60);
      expect(body.iterations).toBeGreaterThan(0);
      expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('POST /api/rum', () => {
    const valid = {
      name: 'LCP',
      value: 1234.5,
      rating: 'good',
      platform: 'cloudflare',
      variant: 'portable',
      topology: 'single',
      region: 'frankfurt',
    };

    it('accepts a metric without authentication and records it', async () => {
      const res = await h.request('/api/rum', { method: 'POST', json: valid });
      expect(res.status).toBe(204);
      expect(h.telemetry.of('webVitals')).toEqual([
        {
          name: 'webVitals',
          value: 1234.5,
          attrs: {
            'web_vital.name': 'LCP',
            'web_vital.rating': 'good',
            'bench.platform': 'cloudflare',
            'bench.variant': 'portable',
            'bench.topology': 'single',
            'client.region': 'frankfurt',
          },
        },
      ]);
    });

    it('rejects unknown keys and values outside the closed lists', async () => {
      expect((await h.request('/api/rum', { method: 'POST', json: { ...valid, extra: 1 } })).status).toBe(
        400,
      );
      expect(
        (await h.request('/api/rum', { method: 'POST', json: { ...valid, platform: 'my-own-platform' } }))
          .status,
      ).toBe(400);
      expect((await h.request('/api/rum', { method: 'POST', json: { ...valid, value: -1 } })).status).toBe(
        400,
      );
      expect(h.telemetry.of('webVitals')).toHaveLength(0);
    });

    it('limits the body size', async () => {
      const res = await h.request('/api/rum', {
        method: 'POST',
        json: { ...valid, region: 'x'.repeat(5000) },
      });
      expect(res.status).toBe(413);
      await problemOf(res);
    });
  });

  describe('GET /media/:id/:size.webp', () => {
    async function readyFile(isPublic: boolean) {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage(800, 600));
      await h.deliver(lastMessage(h));
      if (isPublic)
        await h.request(`/api/files/${id}`, { method: 'PATCH', key: KEYS.alice, json: { isPublic: true } });
      return id;
    }

    it('serves a public ready variant with immutable cache headers', async () => {
      const id = await readyFile(true);
      const res = await h.request(`/media/${id}/512.webp`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('x-trace-id')).toBeTruthy();
      expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('webp:512:fake:800x600');
    });

    it('is 404 for private, not ready, deleted files and unknown sizes', async () => {
      const priv = await readyFile(false);
      expect((await h.request(`/media/${priv}/512.webp`)).status).toBe(404);

      const pending = await h.upload(KEYS.alice, fakeImage());
      await h.request(`/api/files/${pending}`, {
        method: 'PATCH',
        key: KEYS.alice,
        json: { isPublic: true },
      });
      expect((await h.request(`/media/${pending}/128.webp`)).status).toBe(404);

      const pub = await readyFile(true);
      expect((await h.request(`/media/${pub}/256.webp`)).status).toBe(404);
      expect((await h.request(`/media/${pub}/512.png`)).status).toBe(404);
      expect((await h.request(`/media/not-a-uuid/512.webp`)).status).toBe(404);
      await h.request(`/api/files/${pub}`, { method: 'DELETE', key: KEYS.alice });
      // Only deleted_at may hide the file now, not the status.
      await h.deps.db.update(files).set({ status: 'ready' }).where(eq(files.id, pub));
      expect((await h.request(`/media/${pub}/512.webp`)).status).toBe(404);
    });

    it('serves an uppercase id and refuses non-canonical size spellings (m11, m12)', async () => {
      const id = await readyFile(true);
      expect((await h.request(`/media/${id.toUpperCase()}/128.webp`)).status).toBe(200);
      for (const file of ['0128.webp', '00512.webp', '+128.webp']) {
        expect((await h.request(`/media/${id}/${file}`)).status).toBe(404);
      }
    });

    it('does not let a CDN cache a 404 (m19)', async () => {
      const id = await readyFile(false);
      const res = await h.request(`/media/${id}/128.webp`);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('is 404 when the object is missing', async () => {
      const id = await readyFile(true);
      h.storage.objects.clear();
      const res = await h.request(`/media/${id}/128.webp`);
      expect(res.status).toBe(404);
      await problemOf(res);
    });
  });

  describe('GET /api/health/deep', () => {
    it('is 200 when everything answers, and reports unknown for a queue without ping', async () => {
      const ok = await h.request('/api/health/deep');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        status: 'ok',
        checks: { database: { status: 'ok' }, storage: { status: 'ok' }, queue: { status: 'ok' } },
      });

      const app = createApp(() => ({ ...h.deps, queue: new MemoryQueue(false) }));
      const res = await app.request('/api/health/deep');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok', checks: { queue: { status: 'unknown' } } });
    });

    it('is 503 when storage fails, without leaking the error', async () => {
      h.storage.failHead = new Error('S3 secret-token exploded');
      const res = await h.request('/api/health/deep');
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toContain('secret-token');
      expect(JSON.parse(text)).toMatchObject({
        status: 'down',
        checks: { database: { status: 'ok' }, storage: { status: 'down' } },
      });
    });

    it('is 503 when the database fails', async () => {
      const db = new Proxy(h.deps.db, {
        get(target, prop, receiver) {
          if (prop === 'execute') return () => Promise.reject(new Error('db down'));
          return Reflect.get(target, prop, receiver);
        },
      });
      const app = createApp(() => ({ ...h.deps, db }), { probeTimeoutMs: 200 });
      const res = await app.request('/api/health/deep');
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        checks: { database: { status: 'down' }, storage: { status: 'ok' } },
      });
    });

    it('is 503 within the timeout when a dependency hangs', async () => {
      h.storage.failHead = 'hang';
      h.queue.pingImpl = () => new Promise(() => {});
      const started = Date.now();
      const res = await h.request('/api/health/deep');
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        checks: {
          storage: { status: 'down', error: 'timeout' },
          queue: { status: 'down', error: 'timeout' },
        },
      });
    });
  });
});
