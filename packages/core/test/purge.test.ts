import { type JobMessage, VARIANT_SIZES } from '@hostmark/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publicPaths } from '../src/http/purge';
import type { CachePurger } from '../src/ports';
import { createTestDb, databaseUrl, KEYS, type TestDb } from './helpers/db';
import { fakeImage } from './helpers/fakes';
import { createHarness, type Harness, lastMessage } from './helpers/harness';

const deleteMessage = (fileId: string): JobMessage => ({
  v: 1,
  type: 'delete_file',
  jobId: crypto.randomUUID(),
  fileId,
  enqueuedAt: '2026-11-02T12:00:00.000Z',
  chaos: 'none',
});

class RecordingPurger implements CachePurger {
  calls: string[][] = [];
  failures = 0;
  async purge(paths: string[]) {
    this.calls.push(paths);
    if (this.failures > 0) {
      this.failures--;
      throw new Error('cdn down');
    }
  }
}

describe('publicPaths', () => {
  it('lists every cacheable URL of a file', () => {
    const id = '0b8b5f0e-1111-4222-8333-444455556666';
    expect(publicPaths(id)).toEqual([...VARIANT_SIZES.map((s) => `/media/${id}/${s}.webp`), `/f/${id}`]);
  });
});

let testDb: TestDb;
beforeAll(async () => {
  if (databaseUrl) testDb = await createTestDb();
});
afterAll(async () => {
  await testDb?.close();
});

// D100: a CDN caches /media for a year, so leaving the public state must purge it.
describe.skipIf(!databaseUrl)('CDN purge on unpublish and delete', () => {
  let h: Harness;
  let purger: RecordingPurger;
  beforeEach(async () => {
    h = await createHarness(testDb);
    purger = new RecordingPurger();
    h.deps.purger = purger;
  });

  const patch = (id: string, isPublic: boolean) =>
    h.request(`/api/files/${id}`, { method: 'PATCH', key: KEYS.alice, json: { isPublic } });

  it('purges when a file becomes private, not when it becomes public', async () => {
    const id = await h.upload(KEYS.alice, fakeImage());
    expect((await patch(id, true)).status).toBe(200);
    expect(purger.calls).toEqual([]);
    expect((await patch(id, false)).status).toBe(200);
    expect(purger.calls).toEqual([publicPaths(id)]);
  });

  it('answers 503 when the purge fails, and the same request retries it', async () => {
    const id = await h.upload(KEYS.alice, fakeImage());
    await patch(id, true);
    purger.failures = 1;
    expect((await patch(id, false)).status).toBe(503);
    expect((await h.row(id)).isPublic).toBe(false);
    expect((await patch(id, false)).status).toBe(200);
    expect(purger.calls).toEqual([publicPaths(id), publicPaths(id)]);
  });

  it('purges on delete without failing the request, and again in the delete_file job', async () => {
    const id = await h.upload(KEYS.alice, fakeImage());
    purger.failures = 1;
    expect((await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice })).status).toBe(204);
    expect(purger.calls).toEqual([publicPaths(id)]);
    // The cleanup job enqueues delete_file for deleted files (D19); here the message is built directly.
    await h.deliver(deleteMessage(id));
    expect(purger.calls).toEqual([publicPaths(id), publicPaths(id)]);
    expect((await h.row(id)).purgedAt).not.toBeNull();
  });

  it('keeps the object when the job cannot purge, so the queue retries before anything is removed', async () => {
    const id = await h.upload(KEYS.alice, fakeImage());
    await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
    purger.calls = [];
    purger.failures = 1;
    await expect(h.deliver(deleteMessage(id))).rejects.toThrow('cdn down');
    expect((await h.row(id)).purgedAt).toBeNull();
  });

  describe('POST /api/debug/purge/:id (S12, S15; D206)', () => {
    const purge = (id: string, key: string) => h.request(`/api/debug/purge/${id}`, { method: 'POST', key });

    it('purges the public paths of a file for an admin key', async () => {
      const id = crypto.randomUUID();
      expect((await purge(id, KEYS.admin)).status).toBe(204);
      expect(purger.calls).toEqual([publicPaths(id)]);
    });

    it('refuses any other key without purging', async () => {
      expect((await purge(crypto.randomUUID(), KEYS.alice)).status).toBe(403);
      expect(purger.calls).toEqual([]);
    });

    it('answers 503 when the CDN refuses, and 501 without a purger', async () => {
      purger.failures = 1;
      expect((await purge(crypto.randomUUID(), KEYS.admin)).status).toBe(503);
      h.deps.purger = undefined;
      expect((await purge(crypto.randomUUID(), KEYS.admin)).status).toBe(501);
    });

    it('validates the id', async () => {
      expect((await purge('not-a-uuid', KEYS.admin)).status).toBe(400);
      expect(purger.calls).toEqual([]);
    });
  });

  // A purge matches the path as written, so an alias of the id must not be served at all.
  it('serves a public file under its canonical path only, so no alias can be cached beyond a purge', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage(800, 600));
    await h.deliver(lastMessage(h));
    await patch(id, true);
    const upper = id.toUpperCase();
    const encodedFirst = `%${id.charCodeAt(0).toString(16)}${id.slice(1)}`;
    expect((await h.request(`/media/${id}/128.webp`)).status).toBe(200);
    expect((await h.request(`/f/${id}`)).status).toBe(200);
    for (const alias of [upper, encodedFirst]) {
      expect((await h.request(`/media/${alias}/128.webp`)).status, `/media/${alias}`).toBe(404);
      expect((await h.request(`/f/${alias}`)).status, `/f/${alias}`).toBe(404);
    }
  });
});
