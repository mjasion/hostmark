import { DLQ_NAME, type JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import { describeQueueContract, type QueueDelivery } from '@hostmark/core/test/contract';
import { Queue as BullQueue } from 'bullmq';
import { describe, it } from 'vitest';
import { startConsumer } from '../src/consumer';
import { createBullQueue, redisConnection } from '../src/queue';

// Against the Redis of the compose stack: REDIS_TEST_URL=redis://127.0.0.1:56379
const redisUrl = process.env.REDIS_TEST_URL;

const quiet = () => {};
const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet } as never;

/** Resolves when `fn` returns a value, polling until `waitMs` has passed. */
async function poll<T>(
  waitMs: number,
  fn: () => T | undefined | Promise<T | undefined>,
): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 25));
  }
}

if (redisUrl) {
  describeQueueContract('BullMQ on Redis', async () => {
    // A fresh queue per run keeps the suite independent of whatever the stack's worker is doing.
    const name = `contract-${crypto.randomUUID()}`;
    const queue = createBullQueue(redisUrl, name);

    // The real consumer, with its handler parked until the test acknowledges or fails the delivery.
    // The backoff is 1 % of the production schedule; the long smoke step covers the real one.
    const inbox: QueueDelivery[] = [];
    const consumer = startConsumer({
      redisUrl,
      queueName: name,
      logger,
      concurrency: 1,
      backoffScale: 0.01,
      handler: (message, ctx) =>
        new Promise<void>((resolve, reject) => {
          inbox.push({
            message,
            attempt: ctx.attempt,
            ack: async () => resolve(),
            fail: async () => reject(new Error('test failure')),
          });
        }),
    });
    const next = (waitMs: number) => poll(waitMs, () => inbox.shift());
    // The dead letter queue is the stack's own and shared with other test files: only messages sent here count.
    const sent = new Set<string>();
    const send = queue.send.bind(queue);
    const sendBatch = queue.sendBatch.bind(queue);
    queue.send = async (m, o) => {
      sent.add(m.jobId);
      return send(m, o);
    };
    queue.sendBatch = async (ms) => {
      for (const m of ms) sent.add(m.jobId);
      return sendBatch(ms);
    };
    const dlq = new BullQueue<JobMessage>(DLQ_NAME, { connection: redisConnection(redisUrl) });
    const states = ['waiting', 'delayed', 'completed', 'failed'] as const;

    return {
      queue,
      consume: {
        maxAttempts: MAX_ATTEMPTS,
        next: async (waitMs) => (await next(waitMs)) ?? null,
        async deadLettered(count, waitMs) {
          const jobs = await poll(waitMs, async () => {
            const all = (await dlq.getJobs([...states], 0, -1)).filter((j) => sent.has(j.data.jobId));
            return all.length >= count ? all : undefined;
          });
          return (jobs ?? []).map((j) => j.data);
        },
      },
      async receive(max, waitMs) {
        const got: JobMessage[] = [];
        const deadline = Date.now() + waitMs;
        while (got.length < max) {
          const d = await next(Math.max(0, deadline - Date.now()));
          if (!d) break;
          got.push(d.message);
          await d.ack();
        }
        return got;
      },
      async close() {
        for (const d of inbox.splice(0)) await d.ack();
        await consumer.close();
        await queue.close();
        await dlq.close();
        const cleaner = new BullQueue(name, { connection: redisConnection(redisUrl) });
        await cleaner.obliterate({ force: true });
        await cleaner.close();
      },
    };
  });
} else {
  describe.skip('Queue contract: BullMQ on Redis (set REDIS_TEST_URL)', () => {
    it('skipped', () => {});
  });
}
