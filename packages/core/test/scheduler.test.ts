import { MAX_ATTEMPTS, originalKey, STUCK_AFTER_SECONDS } from '@hostmark/contract';
import { dailyStats, files } from '@hostmark/db';
import { eq } from 'drizzle-orm';
import { v7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, databaseUrl, KEYS, type TestDb, USERS } from './helpers/db';
import { fakeImage } from './helpers/fakes';
import { createHarness, type Harness } from './helpers/harness';

let testDb: TestDb;
beforeAll(async () => {
  if (databaseUrl) testDb = await createTestDb();
});
afterAll(async () => {
  await testDb?.close();
});

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe.skipIf(!databaseUrl)('scheduler', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness(testDb);
  });

  const ago = (ms: number) => new Date(h.clock.now().getTime() - ms);

  async function insert(over: Partial<typeof files.$inferInsert> = {}): Promise<string> {
    const id = v7();
    await testDb.db.insert(files).values({
      id,
      userId: USERS.alice,
      status: 'pending_upload',
      contentType: 'image/png',
      originalKey: originalKey(USERS.alice, id),
      expiresAt: new Date(h.clock.now().getTime() + 7 * DAY),
      ...over,
    });
    return id;
  }

  describe('requeue-stuck', () => {
    let staleSince: Date;
    beforeEach(() => {
      staleSince = ago((STUCK_AFTER_SECONDS + 60) * 1000);
    });

    it('requeues stale queued and processing rows and leaves fresh ones alone', async () => {
      const queued = await insert({ status: 'queued', attempts: 0, lastActivityAt: staleSince });
      const processing = await insert({ status: 'processing', attempts: 2, lastActivityAt: staleSince });
      const fresh = await insert({ status: 'processing', attempts: 1, lastActivityAt: ago(MIN) });
      const ready = await insert({ status: 'ready', lastActivityAt: staleSince });

      const result = await h.scheduler['requeue-stuck']();
      expect(result.processed).toBe(2);
      const sent = h.queue.messages('process_image').map((m) => m.fileId);
      expect(sent.sort()).toEqual([queued, processing].sort());
      expect((await h.row(queued)).lastActivityAt).toEqual(h.clock.now());
      expect((await h.row(fresh)).lastActivityAt).toEqual(ago(MIN));
      expect((await h.row(ready)).status).toBe('ready');
    });

    it('claims each row once when two runs overlap', async () => {
      for (let i = 0; i < 5; i++) await insert({ status: 'queued', lastActivityAt: staleSince });
      const [a, b] = await Promise.all([h.scheduler['requeue-stuck'](), h.scheduler['requeue-stuck']()]);
      expect(a.processed + b.processed).toBe(5);
      expect(h.queue.messages('process_image')).toHaveLength(5);
      const again = await h.scheduler['requeue-stuck']();
      expect(again.processed).toBe(0);
    });

    it('fails rows that used all attempts instead of requeueing them', async () => {
      const spent = await insert({
        status: 'processing',
        attempts: MAX_ATTEMPTS,
        lastActivityAt: staleSince,
        lastError: 'boom',
      });
      const silent = await insert({
        status: 'queued',
        attempts: MAX_ATTEMPTS + 1,
        lastActivityAt: staleSince,
      });
      const result = await h.scheduler['requeue-stuck']();
      expect(result.processed).toBe(2);
      expect(h.queue.messages()).toHaveLength(0);
      expect(await h.row(spent)).toMatchObject({ status: 'failed', lastError: 'boom' });
      expect((await h.row(silent)).status).toBe('failed');
      expect((await h.row(silent)).lastError).toMatch(/gave up/);
      // Spec: attempts exhausted counts as a dead letter.
      expect(h.telemetry.of('jobsDeadLettered').reduce((n, r) => n + r.value, 0)).toBe(2);
    });

    it('counts dead letters of failed rows even when the queue send fails (R9)', async () => {
      await insert({
        status: 'queued',
        attempts: MAX_ATTEMPTS,
        lastActivityAt: staleSince,
        lastError: 'boom',
      });
      await insert({ status: 'queued', attempts: 1, lastActivityAt: staleSince });
      h.queue.fail = new Error('queue down');
      await expect(h.scheduler['requeue-stuck']()).rejects.toThrow('queue down');
      expect(h.telemetry.of('jobsDeadLettered').reduce((n, r) => n + r.value, 0)).toBe(1);
    });

    it('keeps the dead-letter count when the claim update throws (X-R9c)', async () => {
      await insert({
        status: 'queued',
        attempts: MAX_ATTEMPTS,
        lastActivityAt: staleSince,
        lastError: 'boom',
      });
      const realUpdate = h.deps.db.update.bind(h.deps.db);
      let calls = 0;
      h.deps.db.update = ((table: never) => {
        if (++calls === 2) throw new Error('claim update failed');
        return realUpdate(table);
      }) as typeof h.deps.db.update;
      await expect(h.scheduler['requeue-stuck']()).rejects.toThrow('claim update failed');
      h.deps.db.update = realUpdate;
      expect(h.telemetry.of('jobsDeadLettered').reduce((n, r) => n + r.value, 0)).toBe(1);
    });

    it('sends a requeued message without chaos (D73)', async () => {
      const id = await h.uploadAndComplete(KEYS.admin, fakeImage(), { 'x-chaos': 'fail' });
      await testDb.db.update(files).set({ lastActivityAt: staleSince }).where(eq(files.id, id));
      h.queue.sent.length = 0;
      await h.scheduler['requeue-stuck']();
      expect(h.queue.messages()[0]?.chaos).toBe('none');
    });

    it('ignores deleted rows', async () => {
      await insert({ status: 'processing', lastActivityAt: staleSince, deletedAt: ago(MIN) });
      expect((await h.scheduler['requeue-stuck']()).processed).toBe(0);
    });

    it('produces messages the handler can finish', async () => {
      const id = await h.uploadAndComplete(KEYS.alice, fakeImage());
      h.queue.sent.length = 0;
      h.clock.advance((STUCK_AFTER_SECONDS + 1) * 1000);
      await h.scheduler['requeue-stuck']();
      await h.deliver(h.queue.messages()[0] as never);
      expect((await h.row(id)).status).toBe('ready');
    });
  });

  describe('cleanup-expired', () => {
    it('runs expired and abandoned files through deleted to purged', async () => {
      const expired = await insert({ status: 'ready', expiresAt: ago(MIN) });
      const abandoned = await insert({ status: 'pending_upload', createdAt: ago(2 * HOUR) });
      const young = await insert({ status: 'pending_upload', createdAt: ago(MIN) });
      const live = await insert({ status: 'ready' });
      for (const id of [expired, abandoned, young, live]) {
        await h.storage.put(originalKey(USERS.alice, id), new Uint8Array([1]), 'image/png');
      }

      const result = await h.scheduler['cleanup-expired']();
      expect(result.processed).toBe(2);
      expect((await h.row(expired)).status).toBe('deleted');
      expect((await h.row(expired)).deletedAt).toEqual(h.clock.now());
      expect((await h.row(abandoned)).status).toBe('deleted');
      expect((await h.row(young)).status).toBe('pending_upload');
      expect((await h.row(live)).status).toBe('ready');

      for (const msg of h.queue.messages('delete_file')) await h.deliver(msg);
      expect((await h.row(expired)).purgedAt).not.toBeNull();
      expect((await h.row(abandoned)).purgedAt).not.toBeNull();
      expect(h.storage.objects.has(originalKey(USERS.alice, expired))).toBe(false);
      expect(h.storage.objects.has(originalKey(USERS.alice, live))).toBe(true);

      expect((await h.scheduler['cleanup-expired']()).processed).toBe(0);
    });

    it('re-enqueues deleted rows that were not purged and is idempotent', async () => {
      const id = await insert({ status: 'deleted', deletedAt: ago(HOUR) });
      expect((await h.scheduler['cleanup-expired']()).processed).toBe(1);
      expect((await h.scheduler['cleanup-expired']()).processed).toBe(1);
      for (const msg of h.queue.messages('delete_file')) await h.deliver(msg);
      expect((await h.row(id)).purgedAt).not.toBeNull();
      expect((await h.scheduler['cleanup-expired']()).processed).toBe(0);
    });

    it('does not touch user deleted rows beyond purging them', async () => {
      const id = await insert({
        status: 'deleted',
        deletedAt: ago(DAY),
        expiresAt: ago(HOUR),
        purgedAt: ago(HOUR),
      });
      expect((await h.scheduler['cleanup-expired']()).processed).toBe(0);
      expect((await h.row(id)).deletedAt).toEqual(ago(DAY));
    });
  });

  describe('daily-stats', () => {
    // The fake clock is 2026-11-02T12:00Z, so the previous day is 2026-11-01.
    const dayStart = new Date('2026-11-01T00:00:00.000Z');
    const at = (hour: number) => new Date(dayStart.getTime() + hour * HOUR);

    async function seedDay() {
      // Processing times 1 s, 2 s, 3 s, 4 s, 10 s
      for (const [i, s] of [1, 2, 3, 4, 10].entries()) {
        await insert({
          status: 'ready',
          bytes: 1000,
          createdAt: at(1 + i),
          queuedAt: at(1 + i),
          readyAt: new Date(at(1 + i).getTime() + s * 1000),
        });
      }
      await insert({ status: 'failed', bytes: 500, createdAt: at(8), queuedAt: at(8) });
      await insert({ status: 'pending_upload', createdAt: at(9) });
      await insert({
        status: 'ready',
        bytes: 1,
        createdAt: new Date(dayStart.getTime() - MIN),
        queuedAt: dayStart,
        readyAt: dayStart,
      });
      await insert({
        status: 'ready',
        bytes: 1,
        createdAt: new Date(dayStart.getTime() + DAY),
        queuedAt: dayStart,
        readyAt: dayStart,
      });
    }

    it('aggregates the previous UTC day by creation time', async () => {
      await seedDay();
      const result = await h.scheduler['daily-stats']();
      // 6 uploads on the previous day plus 1 on the day before, which is recomputed as well.
      expect(result.processed).toBe(7);
      const [row] = await testDb.db.select().from(dailyStats).where(eq(dailyStats.day, '2026-11-01'));
      expect(row).toMatchObject({
        day: '2026-11-01',
        platform: 'test-portable',
        uploads: 6,
        ready: 5,
        failed: 1,
        bytesIn: 5500,
        p50ProcessingMs: 3000,
        p95ProcessingMs: 8800,
      });
    });

    it('picks up a file that became ready after the previous run and covers the two last days', async () => {
      const id = await insert({ status: 'queued', bytes: 100, createdAt: at(22), queuedAt: at(22) });
      await h.scheduler['daily-stats']();
      const dayRow = () =>
        testDb.db
          .select()
          .from(dailyStats)
          .where(eq(dailyStats.day, '2026-11-01'))
          .then((r) => r[0]);
      expect(await dayRow()).toMatchObject({ ready: 0 });

      // Ready at 00:03 on the next day, before the 00:05 run of 2026-11-02 would have been too late.
      await testDb.db
        .update(files)
        .set({ status: 'ready', readyAt: new Date(dayStart.getTime() + DAY + 3 * MIN) })
        .where(eq(files.id, id));
      h.clock.advance(DAY);
      await h.scheduler['daily-stats']();
      const days = await testDb.db.select().from(dailyStats).orderBy(dailyStats.day);
      expect(days.map((r) => r.day)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
      expect(await dayRow()).toMatchObject({ uploads: 1, ready: 1, p50ProcessingMs: 3 * MIN + 2 * HOUR });
    });

    it('never counts more failures than uploads, because a rejected upload was never queued', async () => {
      await insert({
        status: 'failed',
        bytes: 500,
        createdAt: at(3),
        lastError: 'upload exceeds the size limit',
      });
      await h.scheduler['daily-stats']();
      const [row] = await testDb.db.select().from(dailyStats).where(eq(dailyStats.day, '2026-11-01'));
      expect(row).toMatchObject({ uploads: 0, failed: 0 });
    });

    it('overwrites on rerun instead of duplicating', async () => {
      await seedDay();
      await h.scheduler['daily-stats']();
      await insert({
        status: 'ready',
        bytes: 100,
        createdAt: at(12),
        queuedAt: at(12),
        readyAt: new Date(at(12).getTime() + 1000),
      });
      await h.scheduler['daily-stats']();
      const rows = await testDb.db.select().from(dailyStats).where(eq(dailyStats.day, '2026-11-01'));
      expect(rows).toHaveLength(1);
      expect(await testDb.db.select().from(dailyStats)).toHaveLength(2);
      expect(rows[0]).toMatchObject({ uploads: 7, ready: 6, bytesIn: 5600 });
    });

    it('writes a zero row with null percentiles for an empty day', async () => {
      await h.scheduler['daily-stats']();
      const [row] = await testDb.db.select().from(dailyStats).where(eq(dailyStats.day, '2026-11-01'));
      expect(row).toMatchObject({
        uploads: 0,
        ready: 0,
        failed: 0,
        bytesIn: 0,
        p50ProcessingMs: null,
        p95ProcessingMs: null,
      });
    });
  });

  describe('observability', () => {
    it('records a log line and a duration metric per run, using the job name', async () => {
      await h.scheduler['cleanup-expired']();
      await h.scheduler['requeue-stuck']();
      await h.scheduler['daily-stats']();
      const finished = h.telemetry.logs.filter((l) => l.msg === 'scheduler job finished');
      expect(finished.map((l) => l.fields?.job)).toEqual(['cleanup-expired', 'requeue-stuck', 'daily-stats']);
      for (const l of finished) expect(l.fields).toMatchObject({ processed: 0, durationMs: 0 });
      expect(h.telemetry.of('schedulerRunDurationMs').map((r) => r.attrs?.['scheduler.job'])).toEqual([
        'cleanup-expired',
        'requeue-stuck',
        'daily-stats',
      ]);
    });

    it('logs and rethrows failures', async () => {
      h.queue.fail = new Error('queue down');
      await insert({ status: 'queued', lastActivityAt: ago(HOUR) });
      await expect(h.scheduler['requeue-stuck']()).rejects.toThrow('queue down');
      expect(h.telemetry.logs.some((l) => l.level === 'error' && l.msg === 'scheduler job failed')).toBe(
        true,
      );
      expect(h.telemetry.of('schedulerRunDurationMs').map((r) => r.attrs)).toEqual([
        { 'scheduler.job': 'requeue-stuck' },
      ]);
    });
  });
});
