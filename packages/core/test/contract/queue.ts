import type { JobMessage } from '@hostmark/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queue } from '../../src/ports';

/** One delivery of a message with the redelivery bookkeeping an adapter must provide. */
export interface QueueDelivery {
  message: JobMessage;
  /** 1 on the first delivery, +1 on each redelivery after a failure. */
  attempt: number;
  ack(): Promise<void>;
  /** Reports a failed handler run: redelivered, or dead-lettered when the attempts are used up. */
  fail(): Promise<void>;
}

/** Optional capability: consuming with acknowledgement. Without it the redelivery tests are skipped. */
export interface QueueConsumeHarness {
  /** Attempts after which a failing message is dead-lettered (MAX_ATTEMPTS). */
  maxAttempts: number;
  next(waitMs: number): Promise<QueueDelivery | null>;
  /** Messages that reached the dead letter queue, waiting up to `waitMs` for `count` of them. */
  deadLettered(count: number, waitMs: number): Promise<JobMessage[]>;
  /**
   * Seconds that the platform makes a message wait after the first failed attempt (D17: BACKOFF_SECONDS[0], times
   * any test scale). Absent when the platform cannot be made to honour it; the test is then a visible skip.
   */
  firstRetryDelaySeconds?: number;
  /**
   * Milliseconds after which a delivery that is neither acknowledged nor failed comes back as the next attempt
   * (the visibility timeout of D17, possibly shortened for the test). Absent when the platform has no such timer,
   * which is the case for push consumers, where a handler that throws or runs out of time is the only way back.
   */
  visibilityTimeoutMs?: number;
  /**
   * Milliseconds of the lock, lease or visibility that the real consumer renews while its handler runs. With it, a
   * delivery the test holds (neither acknowledged nor failed, its handler still running) must not come back for
   * several times this long. Absent when `next` does not hand out deliveries of a renewing consumer.
   */
  renewalMs?: number;
}

/** How long a message that should not come back is watched for: past any visibility timeout or lock of the harness. */
function quietPeriodMs(consume: QueueConsumeHarness): number {
  const longest = Math.max(consume.visibilityTimeoutMs ?? 0, consume.renewalMs ?? 0);
  return Math.max(1_500, longest * 1.5 + 1_000);
}

/** Fails if `jobId` is delivered again within `ms`; other messages are acknowledged away. */
async function expectNoDeliveryOf(consume: QueueConsumeHarness, jobId: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const d = await consume.next(Math.min(500, Math.max(0, deadline - Date.now())));
    if (!d) continue;
    const again = d.message.jobId === jobId;
    await d.ack();
    expect(again, `${jobId} was delivered again (attempt ${d.attempt})`).toBe(false);
  }
}

export interface QueueContractHarness {
  queue: Queue;
  consume?: QueueConsumeHarness;
  /** Waits up to `waitMs` for messages and returns what arrived (at most `max`), in delivery order. */
  receive(max: number, waitMs: number): Promise<JobMessage[]>;
  close?(): Promise<void>;
}

const message = (fileId: string): JobMessage => ({
  v: 1,
  type: 'process_image',
  jobId: crypto.randomUUID(),
  fileId,
  enqueuedAt: new Date().toISOString(),
  chaos: 'none',
});

/** The next delivery of `jobId`; deliveries of other messages (leftovers of earlier tests) are acknowledged away. */
async function nextFor(
  consume: QueueConsumeHarness,
  jobId: string,
  timeoutMs = 45_000,
): Promise<QueueDelivery> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await consume.next(2000);
    if (!d) continue;
    if (d.message.jobId === jobId) return d;
    await d.ack();
  }
  throw new Error(`no delivery for ${jobId}`);
}

/** Behaviour every Queue adapter must show. The factory builds a fresh, empty queue. */
export function describeQueueContract(name: string, factory: () => Promise<QueueContractHarness>): void {
  describe(`Queue contract: ${name}`, () => {
    let h: QueueContractHarness;
    beforeAll(async () => {
      h = await factory();
    });
    afterAll(async () => {
      await h?.close?.();
    });

    it('delivers a sent message unchanged', async () => {
      const msg = message(crypto.randomUUID());
      await h.queue.send(msg);
      const got = await h.receive(1, 10_000);
      expect(got).toEqual([msg]);
    });

    it('delivers every message of a batch', async () => {
      const msgs = Array.from({ length: 12 }, () => message(crypto.randomUUID()));
      await h.queue.sendBatch(msgs);
      const got: JobMessage[] = [];
      const deadline = Date.now() + 15_000;
      while (got.length < msgs.length && Date.now() < deadline)
        got.push(...(await h.receive(msgs.length, 2000)));
      expect(got.map((m) => m.jobId).sort()).toEqual(msgs.map((m) => m.jobId).sort());
    });

    it('accepts an empty batch', async () => {
      await expect(h.queue.sendBatch([])).resolves.toBeUndefined();
    });

    it('holds a delayed message back and delivers it afterwards', async () => {
      const msg = message(crypto.randomUUID());
      await h.queue.send(msg, { delaySeconds: 2 });
      expect(await h.receive(1, 500)).toEqual([]);
      const got = await h.receive(1, 10_000);
      expect(got).toEqual([msg]);
    });

    it('delivers a batch above the 100 message limit of the platform queues', async () => {
      const msgs = Array.from({ length: 250 }, () => message(crypto.randomUUID()));
      await h.queue.sendBatch(msgs);
      const got: JobMessage[] = [];
      const deadline = Date.now() + 30_000;
      while (got.length < msgs.length && Date.now() < deadline)
        got.push(...(await h.receive(msgs.length, 2000)));
      expect(got.map((m) => m.jobId).sort()).toEqual(msgs.map((m) => m.jobId).sort());
    });

    it('pings when it can', async (ctx) => {
      if (!h.queue.ping) return ctx.skip();
      await expect(h.queue.ping()).resolves.toBeUndefined();
    });

    describe('consume with acknowledgement', () => {
      it('redelivers a failed message with a higher attempt number', async (ctx) => {
        if (!h.consume) return ctx.skip();
        const msg = message(crypto.randomUUID());
        await h.queue.send(msg);
        const first = await nextFor(h.consume, msg.jobId);
        expect(first.attempt).toBe(1);
        await first.fail();
        const second = await nextFor(h.consume, msg.jobId);
        expect(second.attempt).toBe(2);
        expect(second.message).toEqual(msg);
        await second.ack();
      });

      it('makes a failed message wait for the backoff before the next attempt', async (ctx) => {
        const delay = h.consume?.firstRetryDelaySeconds;
        if (!h.consume || delay === undefined) return ctx.skip();
        const msg = message(crypto.randomUUID());
        await h.queue.send(msg);
        const first = await nextFor(h.consume, msg.jobId);
        const failedAt = Date.now();
        await first.fail();
        const second = await nextFor(h.consume, msg.jobId, delay * 1000 + 20_000);
        const waited = Date.now() - failedAt;
        expect(second.attempt).toBe(2);
        expect(waited).toBeGreaterThanOrEqual(delay * 1000 * 0.9);
        // A fail() that does nothing brings the message back only after the visibility timeout. When that is clearly
        // longer than the backoff, the redelivery must come well before it.
        const visibility = h.consume.visibilityTimeoutMs;
        const upper =
          visibility !== undefined && visibility > delay * 1000 * 2 + 2_000
            ? visibility * 0.8
            : delay * 1000 + 15_000;
        expect(waited).toBeLessThan(upper);
        await second.ack();
      }, 90_000);

      it('redelivers a message that was neither acknowledged nor failed after the visibility timeout', async (ctx) => {
        const timeout = h.consume?.visibilityTimeoutMs;
        if (!h.consume || timeout === undefined) return ctx.skip();
        const msg = message(crypto.randomUUID());
        await h.queue.send(msg);
        const first = await nextFor(h.consume, msg.jobId);
        const deliveredAt = Date.now();
        expect(first.attempt).toBe(1);
        const second = await nextFor(h.consume, msg.jobId, timeout + 20_000);
        expect(second.attempt).toBe(2);
        expect(Date.now() - deliveredAt).toBeGreaterThanOrEqual(timeout * 0.9);
        await second.ack();
      }, 90_000);

      it('does not redeliver an acknowledged message, also after the visibility timeout', async (ctx) => {
        if (!h.consume) return ctx.skip();
        const msg = message(crypto.randomUUID());
        await h.queue.send(msg);
        await (await nextFor(h.consume, msg.jobId)).ack();
        await expectNoDeliveryOf(h.consume, msg.jobId, quietPeriodMs(h.consume));
      }, 90_000);

      it('renews a delivery whose handler is still running, so it does not come back', async (ctx) => {
        const renewal = h.consume?.renewalMs;
        if (!h.consume || renewal === undefined) return ctx.skip();
        const msg = message(crypto.randomUUID());
        await h.queue.send(msg);
        const held = await nextFor(h.consume, msg.jobId);
        await expectNoDeliveryOf(h.consume, msg.jobId, renewal * 3);
        await held.ack();
        await expectNoDeliveryOf(h.consume, msg.jobId, quietPeriodMs(h.consume));
      }, 90_000);

      it('moves a message to the dead letter queue after maxAttempts failures', async (ctx) => {
        if (!h.consume) return ctx.skip();
        const msg = message(crypto.randomUUID());
        await h.queue.send(msg);
        for (let attempt = 1; attempt <= h.consume.maxAttempts; attempt++) {
          const d = await nextFor(h.consume, msg.jobId);
          expect(d.attempt).toBe(attempt);
          await d.fail();
        }
        const dead = await h.consume.deadLettered(1, 15_000);
        expect(dead.map((m) => m.jobId)).toContain(msg.jobId);
        // Nothing is left to deliver once it is dead.
        const again = await h.consume.next(500);
        expect(again?.message.jobId).not.toBe(msg.jobId);
      }, 180_000);
    });
  });
}
