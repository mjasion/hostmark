import { type JobMessage, originalKey, variantKey } from '@hostmark/contract';
import { files, fileVariants } from '@hostmark/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidImageError } from '../src/errors';
import { createTestDb, databaseUrl, KEYS, type TestDb, USERS } from './helpers/db';
import { fakeImage } from './helpers/fakes';
import { createHarness, type Harness, lastMessage } from './helpers/harness';

let testDb: TestDb;
beforeAll(async () => {
  if (databaseUrl) testDb = await createTestDb();
});
afterAll(async () => {
  await testDb?.close();
});

const message = (fileId: string, over: Partial<JobMessage> = {}): JobMessage => ({
  v: 1,
  type: 'process_image',
  jobId: crypto.randomUUID(),
  fileId,
  enqueuedAt: '2026-11-02T12:00:00.000Z',
  chaos: 'none',
  ...over,
});

describe.skipIf(!databaseUrl)('process_image', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness(testDb);
  });

  const variantRows = (id: string) =>
    testDb.db.select().from(fileVariants).where(eq(fileVariants.fileId, id));

  it('takes an upload to ready through the API and the handler', async () => {
    const bytes = fakeImage(2000, 1000);
    const id = await h.uploadAndComplete(KEYS.alice, bytes);
    h.clock.advance(5000);
    await h.deliver(lastMessage(h));

    const row = await h.row(id);
    expect(row).toMatchObject({ status: 'ready', width: 2000, height: 1000, attempts: 1, lastError: null });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.readyAt?.toISOString()).toBe('2026-11-02T12:00:05.000Z');
    expect(row.lastActivityAt.toISOString()).toBe('2026-11-02T12:00:05.000Z');
    expect(row.queuedAt?.toISOString()).toBe('2026-11-02T12:00:00.000Z');

    const variants = await variantRows(id);
    expect(variants.map((v) => v.size).sort((a, b) => a - b)).toEqual([128, 512, 1600]);
    for (const v of variants) {
      expect(v.storageKey).toBe(variantKey(USERS.alice, id, v.size));
      expect(h.storage.objects.get(v.storageKey)?.contentType).toBe('image/webp');
    }

    const body = (await (await h.request(`/api/files/${id}`, { key: KEYS.alice })).json()) as {
      status: string;
      variants: { size: number; url: string; bytes: number }[];
    };
    expect(body.status).toBe('ready');
    expect(body.variants).toHaveLength(3);

    expect(h.telemetry.of('enqueueToStartMs')[0]?.value).toBe(5000);
    expect(h.telemetry.of('uploadToReadyMs')[0]?.value).toBe(5000);
    expect(h.telemetry.of('processingDurationMs')).toHaveLength(1);
  });

  it('does no work when a completed job is redelivered', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    await h.deliver(lastMessage(h));
    const before = await h.row(id);
    const gets = h.storage.gets;
    h.clock.advance(60_000);
    await h.deliver(lastMessage(h), { attempt: 2 });
    expect(h.images.calls).toBe(1);
    expect(h.storage.gets).toBe(gets);
    expect(await h.row(id)).toEqual(before);
    expect(h.telemetry.of('processingDurationMs')).toHaveLength(1);
    // Skipped deliveries are not queue latency.
    expect(h.telemetry.of('enqueueToStartMs')).toHaveLength(1);
  });

  it('records enqueue to start once, on the first claim only', async () => {
    const id = await h.uploadAndComplete(KEYS.admin, fakeImage(), { 'x-chaos': 'fail' });
    h.clock.advance(2000);
    await expect(h.deliver(lastMessage(h), { attempt: 1 })).rejects.toThrow();
    h.clock.advance(60_000);
    await expect(h.deliver(lastMessage(h), { attempt: 2 })).rejects.toThrow();
    expect((await h.row(id)).attempts).toBe(2);
    expect(h.telemetry.of('enqueueToStartMs').map((r) => r.value)).toEqual([2000]);
  });

  it('acks messages for unknown, deleted and failed files without work', async () => {
    await h.deliver(message(crypto.randomUUID()));
    const deleted = await h.uploadAndComplete(KEYS.alice, fakeImage());
    await h.request(`/api/files/${deleted}`, { method: 'DELETE', key: KEYS.alice });
    await h.deliver(lastMessage(h));
    expect(h.images.calls).toBe(0);
    expect((await h.row(deleted)).status).toBe('deleted');

    const failed = await h.uploadAndComplete(KEYS.alice, new TextEncoder().encode('garbage'));
    await h.deliver(lastMessage(h));
    const before = await h.row(failed);
    expect(before.status).toBe('failed');
    const calls = h.images.calls;
    await h.deliver(lastMessage(h), { attempt: 2 });
    expect(h.images.calls).toBe(calls);
    expect(await h.row(failed)).toEqual(before);
  });

  it('drops malformed messages instead of retrying them forever', async () => {
    await expect(h.handler({ nope: true } as never, h.ctx())).resolves.toBeUndefined();
    await expect(
      h.handler(message(crypto.randomUUID(), { type: 'explode' as never }), h.ctx()),
    ).resolves.toBeUndefined();
    expect(h.telemetry.logs.filter((l) => l.msg === 'invalid job message dropped')).toHaveLength(2);
  });

  it('survives a delete racing the job and writes nothing back', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    const original = h.images.process.bind(h.images);
    h.images.process = async (input, sizes) => {
      await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
      return original(input, sizes);
    };
    await expect(h.deliver(lastMessage(h))).resolves.toBeUndefined();
    expect(await h.row(id)).toMatchObject({ status: 'deleted', readyAt: null, width: null });
    expect(await variantRows(id)).toHaveLength(0);
    // The purge may already have run, so the job removes the objects it wrote.
    expect(h.storage.objects.has(variantKey(USERS.alice, id, 128))).toBe(false);
    expect(h.telemetry.of('processingDurationMs')).toHaveLength(0);
  });

  it('does not delete the variants of a file that an overlapping delivery already made ready (B1)', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    const msg = lastMessage(h);
    const original = h.images.process.bind(h.images);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    // Delivery A stalls inside the transform; delivery B runs to completion first.
    h.images.process = async (input, sizes) => {
      if (++calls === 1) await gate;
      return original(input, sizes);
    };
    const a = h.deliver(msg, { attempt: 1 });
    // Wait until A has claimed and entered the transform.
    while (calls === 0) await new Promise((r) => setTimeout(r, 5));
    await h.deliver(msg, { attempt: 2 });
    expect((await h.row(id)).status).toBe('ready');
    release();
    await a;

    expect(await h.row(id)).toMatchObject({ status: 'ready', attempts: 2 });
    expect(await variantRows(id)).toHaveLength(3);
    for (const size of [128, 512, 1600]) {
      expect(h.storage.objects.has(variantKey(USERS.alice, id, size))).toBe(true);
    }
    expect(h.telemetry.of('processingDurationMs')).toHaveLength(1);
  });

  it('removes variants that a late job wrote after the purge ran (M1)', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    const msg = lastMessage(h);
    await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
    await h.deliver(message(id, { type: 'delete_file' }));
    expect((await h.row(id)).purgedAt).not.toBeNull();
    // Written by a delivery that was already running when the purge happened.
    await h.storage.put(variantKey(USERS.alice, id, 512), new Uint8Array([1]), 'image/webp');

    await h.deliver(msg, { attempt: 2 });
    expect(h.storage.objects.has(variantKey(USERS.alice, id, 512))).toBe(false);
    expect(h.images.calls).toBe(0);
  });

  it('retries when the cleanup of a deleted file fails instead of swallowing the error (M1)', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    const original = h.images.process.bind(h.images);
    h.images.process = async (input, sizes) => {
      await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
      return original(input, sizes);
    };
    const realDelete = h.storage.delete.bind(h.storage);
    h.storage.delete = async () => {
      throw new Error('storage unavailable');
    };
    await expect(h.deliver(lastMessage(h))).rejects.toThrow('storage unavailable');
    expect(h.storage.objects.has(variantKey(USERS.alice, id, 128))).toBe(true);

    // The platform redelivers; the file is deleted, so the claim misses and the stray objects go.
    h.storage.delete = realDelete;
    await h.deliver(lastMessage(h), { attempt: 2 });
    expect(h.storage.objects.has(variantKey(USERS.alice, id, 128))).toBe(false);
  });

  it('does not count a dead letter when the file was deleted meanwhile (m1)', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    h.images.process = async () => {
      await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
      throw new Error('boom');
    };
    await expect(h.deliver(lastMessage(h), { attempt: 5 })).rejects.toThrow('boom');
    expect(h.telemetry.of('jobsDeadLettered')).toHaveLength(0);
  });

  it('fails the file once its own counter reaches the maximum, even if the platform restarted its count (m3)', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    await testDb.db.update(files).set({ attempts: 4 }).where(eq(files.id, id));
    h.images.failWith = new Error('boom');
    // Final only through the file's counter: recorded and acknowledged, no retry is wasted (D72).
    await expect(h.deliver(lastMessage(h), { attempt: 1 })).resolves.toBeUndefined();
    expect(await h.row(id)).toMatchObject({ status: 'failed', attempts: 5 });
    expect(h.telemetry.of('jobsDeadLettered')).toHaveLength(1);
  });

  it('rethrows when the platform counter is final, so the message reaches the DLQ (D55)', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    await testDb.db.update(files).set({ attempts: 4 }).where(eq(files.id, id));
    h.images.failWith = new Error('boom');
    await expect(h.deliver(lastMessage(h), { attempt: 5 })).rejects.toThrow('boom');
    expect(await h.row(id)).toMatchObject({ status: 'failed' });
    expect(h.telemetry.of('jobsDeadLettered')).toHaveLength(1);
  });

  it('logs the cause of a permanent failure (N8)', async () => {
    await h.uploadAndComplete(KEYS.alice, fakeImage());
    h.images.failWith = new InvalidImageError('Cannot decode jpeg image', {
      cause: new Error('wasm trap: unreachable'),
    });
    await h.deliver(lastMessage(h));
    const logged = h.telemetry.logs.find((l) => l.msg === 'process_image failed permanently');
    expect(logged?.fields?.cause).toBe('Error: wasm trap: unreachable');
  });

  it('retries a failed cleanup of a deleted file even when the file counter is final (X-R4)', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    await testDb.db.update(files).set({ attempts: 4 }).where(eq(files.id, id));
    const original = h.images.process.bind(h.images);
    h.images.process = async (input, sizes) => {
      await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
      return original(input, sizes);
    };
    const realDelete = h.storage.delete.bind(h.storage);
    h.storage.delete = async () => {
      throw new Error('storage unavailable');
    };
    // The platform counter is not final, the file counter is: the throw keeps the retry alive.
    await expect(h.deliver(lastMessage(h), { attempt: 1 })).rejects.toThrow('storage unavailable');
    expect(h.storage.objects.has(variantKey(USERS.alice, id, 128))).toBe(true);
    h.storage.delete = realDelete;
    await h.deliver(lastMessage(h), { attempt: 2 });
    expect(h.storage.objects.has(variantKey(USERS.alice, id, 128))).toBe(false);
  });

  it('warns and rethrows when the cleanup on a claim miss fails (X-R10)', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
    h.storage.delete = async () => {
      throw new Error('storage unavailable');
    };
    await expect(h.deliver(lastMessage(h))).rejects.toThrow('storage unavailable');
    expect(
      h.telemetry.logs.some((l) => l.level === 'warn' && l.msg.includes('could not remove the variants')),
    ).toBe(true);
  });

  it('logs a warning before it rethrows a failed variant cleanup (R10)', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    const original = h.images.process.bind(h.images);
    h.images.process = async (input, sizes) => {
      await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
      return original(input, sizes);
    };
    h.storage.delete = async () => {
      throw new Error('storage unavailable');
    };
    await expect(h.deliver(lastMessage(h), { attempt: 5 })).rejects.toThrow('storage unavailable');
    expect(
      h.telemetry.logs.some((l) => l.level === 'warn' && l.msg.includes('could not remove the variants')),
    ).toBe(true);
  });

  it('keeps raw error details out of last_error and in the log (m17)', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    h.images.failWith = new Error('NoSuchKey: originals/user-alice/secret-key <Resource>');
    await expect(h.deliver(lastMessage(h))).rejects.toThrow('NoSuchKey');
    const { lastError } = await h.row(id);
    expect(lastError).toBe('processing failed');
    const logged = h.telemetry.logs.find((l) => l.msg === 'process_image will be retried');
    expect(String((logged?.fields?.error as Error | undefined)?.message)).toContain('NoSuchKey');
  });

  it('reprocesses after a crash without conflicting on file_variants', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    await h.deliver(lastMessage(h));
    await testDb.db.update(files).set({ status: 'processing', readyAt: null }).where(eq(files.id, id));
    await h.deliver(lastMessage(h), { attempt: 2 });
    expect(await variantRows(id)).toHaveLength(3);
    expect(await h.row(id)).toMatchObject({ status: 'ready', attempts: 2 });
  });

  it('keeps queued_at when a file is processed after requeue', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    const queuedAt = (await h.row(id)).queuedAt;
    h.clock.advance(3_600_000);
    await h.deliver(lastMessage(h));
    expect((await h.row(id)).queuedAt).toEqual(queuedAt);
    expect(h.telemetry.of('uploadToReadyMs')[0]?.value).toBe(3_600_000);
  });

  describe('chaos and failures (D17)', () => {
    it('chaos=fail throws on every attempt and fails the file at the last one', async () => {
      const id = await h.uploadAndComplete(KEYS.admin, fakeImage(), { 'x-chaos': 'fail' });
      expect(lastMessage(h).chaos).toBe('fail');

      for (let attempt = 1; attempt <= 4; attempt++) {
        await expect(h.deliver(lastMessage(h), { attempt })).rejects.toThrow('chaos=fail');
        expect(await h.row(id)).toMatchObject({
          status: 'processing',
          lastError: 'chaos=fail',
          attempts: attempt,
        });
        expect(h.telemetry.of('jobsRetried')).toHaveLength(attempt);
        expect(h.telemetry.of('jobsDeadLettered')).toHaveLength(0);
      }

      await expect(h.deliver(lastMessage(h), { attempt: 5, maxAttempts: 5 })).rejects.toThrow('chaos=fail');
      expect(await h.row(id)).toMatchObject({ status: 'failed', lastError: 'chaos=fail', attempts: 5 });
      expect(h.telemetry.of('jobsDeadLettered')).toHaveLength(1);
      expect(h.telemetry.of('jobsRetried')).toHaveLength(4);

      // Nothing more to do after the file failed.
      await h.deliver(lastMessage(h), { attempt: 6 });
      expect((await h.row(id)).attempts).toBe(5);
    });

    it('chaos=crash crashes on the first claim only, keyed off files.attempts', async () => {
      const id = await h.uploadAndComplete(KEYS.admin, fakeImage(), { 'x-chaos': 'crash' });
      await expect(h.deliver(lastMessage(h))).rejects.toThrow('crash');
      expect(h.crashes).toBe(1);
      expect(await h.row(id)).toMatchObject({ status: 'processing', attempts: 1 });
      // A platform that does not count the stalled delivery still reports attempt 1.
      await h.deliver(lastMessage(h), { attempt: 1 });
      expect(h.crashes).toBe(1);
      expect(await h.row(id)).toMatchObject({ status: 'ready', attempts: 2 });
    });

    it('chaos=slow waits 45 s on the clock and then completes', async () => {
      const id = await h.uploadAndComplete(KEYS.admin, fakeImage(), { 'x-chaos': 'slow' });
      await h.deliver(lastMessage(h));
      expect(h.clock.sleeps).toEqual([45_000]);
      expect((await h.row(id)).status).toBe('ready');
      expect(h.telemetry.of('processingDurationMs')[0]?.value).toBe(45_000);
    });

    it('records last_error and retries until the final attempt for real errors', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
      h.images.failWith = new Error('wasm out of memory');
      await expect(h.deliver(lastMessage(h), { attempt: 3 })).rejects.toThrow('wasm out of memory');
      expect(await h.row(id)).toMatchObject({ status: 'processing', lastError: 'processing failed' });
      expect(h.telemetry.of('jobsRetried')).toHaveLength(1);

      await expect(h.deliver(lastMessage(h), { attempt: 5 })).rejects.toThrow('wasm out of memory');
      expect((await h.row(id)).status).toBe('failed');
      expect(h.telemetry.of('jobsDeadLettered')).toHaveLength(1);
    });

    it('treats a missing original as a retryable error', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
      h.storage.objects.delete((await h.row(id)).originalKey);
      await expect(h.deliver(lastMessage(h))).rejects.toThrow('original object is missing');
      expect((await h.row(id)).lastError).toBe('original object is missing');
    });

    it('fails an undecodable image permanently and acks', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, new TextEncoder().encode('garbage'));
      await expect(h.deliver(lastMessage(h), { attempt: 1 })).resolves.toBeUndefined();
      expect(await h.row(id)).toMatchObject({ status: 'failed' });
      expect((await h.row(id)).lastError).toBe('not an image');
      expect(h.telemetry.of('jobsRetried')).toHaveLength(0);
      expect(h.telemetry.of('jobsDeadLettered')).toHaveLength(0);
      expect(await variantRows(id)).toHaveLength(0);
    });

    it('honours InvalidImageError from any processor', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
      h.images.failWith = new InvalidImageError('truncated');
      await expect(h.deliver(lastMessage(h))).resolves.toBeUndefined();
      expect(await h.row(id)).toMatchObject({ status: 'failed', lastError: 'truncated' });
    });
  });

  describe('deduplication (per user)', () => {
    it('copies variants of a ready file with the same hash and the same user', async () => {
      const bytes = fakeImage(1200, 800, 'same');
      const first = await h.uploadAndComplete(KEYS.alice, bytes);
      await h.deliver(lastMessage(h));
      const second = await h.uploadAndComplete(KEYS.alice, bytes);
      await h.deliver(lastMessage(h));

      expect(h.images.calls).toBe(1);
      expect(await h.row(second)).toMatchObject({ status: 'ready', width: 1200, height: 800 });
      expect((await h.row(second)).sha256).toBe((await h.row(first)).sha256);
      const rows = await variantRows(second);
      expect(rows).toHaveLength(3);
      for (const v of rows) {
        expect(v.storageKey).toBe(variantKey(USERS.alice, second, v.size));
        expect(h.storage.objects.get(v.storageKey)?.body).toEqual(
          h.storage.objects.get(variantKey(USERS.alice, first, v.size))?.body,
        );
      }
    });

    it('does not deduplicate across users', async () => {
      const bytes = fakeImage(1200, 800, 'shared');
      await h.uploadAndComplete(KEYS.alice, bytes);
      await h.deliver(lastMessage(h));
      const bobs = await h.uploadAndComplete(KEYS.bob, bytes);
      await h.deliver(lastMessage(h));
      expect(h.images.calls).toBe(2);
      expect((await h.row(bobs)).status).toBe('ready');
    });

    it('ignores deleted sources and processes normally when their objects are gone', async () => {
      const bytes = fakeImage(900, 900, 'gone');
      const first = await h.uploadAndComplete(KEYS.alice, bytes);
      await h.deliver(lastMessage(h));
      for (const size of [128, 512, 1600]) h.storage.objects.delete(variantKey(USERS.alice, first, size));
      const second = await h.uploadAndComplete(KEYS.alice, bytes);
      await h.deliver(lastMessage(h));
      expect(h.images.calls).toBe(2);
      expect((await h.row(second)).status).toBe('ready');

      await h.request(`/api/files/${first}`, { method: 'DELETE', key: KEYS.alice });
      await h.request(`/api/files/${second}`, { method: 'DELETE', key: KEYS.alice });
      const third = await h.uploadAndComplete(KEYS.alice, bytes);
      await h.deliver(lastMessage(h));
      expect(h.images.calls).toBe(3);
      expect((await h.row(third)).status).toBe('ready');
    });
  });
});

describe.skipIf(!databaseUrl)('delete_file', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness(testDb);
  });

  const deleteMsg = (id: string) => message(id, { type: 'delete_file' });

  async function readyThenDeleted() {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    await h.deliver(lastMessage(h));
    await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
    return id;
  }

  it('removes the original and all variants, the variant rows, and sets purged_at', async () => {
    const id = await readyThenDeleted();
    h.clock.advance(1000);
    await h.deliver(deleteMsg(id));
    expect(h.storage.objects.size).toBe(0);
    expect(await testDb.db.select().from(fileVariants).where(eq(fileVariants.fileId, id))).toHaveLength(0);
    expect((await h.row(id)).purgedAt?.toISOString()).toBe(h.clock.now().toISOString());
  });

  it('is idempotent', async () => {
    const id = await readyThenDeleted();
    await h.deliver(deleteMsg(id));
    const purgedAt = (await h.row(id)).purgedAt;
    h.clock.advance(1000);
    await h.deliver(deleteMsg(id));
    expect((await h.row(id)).purgedAt).toEqual(purgedAt);
  });

  it('only acts on deleted files', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    await h.deliver(lastMessage(h));
    const objects = h.storage.objects.size;
    await h.deliver(deleteMsg(id));
    await h.deliver(deleteMsg(crypto.randomUUID()));
    expect(h.storage.objects.size).toBe(objects);
    expect((await h.row(id)).purgedAt).toBeNull();
  });

  it('computes keys, so objects of an interrupted process_image are removed too', async () => {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
    await h.storage.put(variantKey(USERS.alice, id, 512), new Uint8Array([1]), 'image/webp');
    await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
    await h.deliver(deleteMsg(id));
    expect(h.storage.objects.has(variantKey(USERS.alice, id, 512))).toBe(false);
    expect(h.storage.objects.has(originalKey(USERS.alice, id))).toBe(false);
  });
});
