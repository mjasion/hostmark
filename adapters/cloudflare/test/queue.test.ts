import { DLQ_NAME, type JobMessage, MAX_ATTEMPTS, QUEUE_NAME } from '@hostmark/contract';
import { describeQueueContract, type QueueDelivery } from '@hostmark/core/test/contract';
import { createCloudflareQueue } from '../src/queue';
import { fixtureWorker, newMiniflare } from './miniflare';

/** Backoff 1, 3, 9, 27 s instead of 10, 30, 90, 270 s: the whole schedule is exercised in under a minute. */
const BACKOFF_SCALE = 0.1;

async function poll<T>(waitMs: number, fn: () => T | undefined): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// The real queue implementation and the real consumeBatch, on the Queues emulation of Miniflare (workerd).
describeQueueContract('Cloudflare Queues on Miniflare', async () => {
  const inbox: QueueDelivery[] = [];
  const dead: JobMessage[] = [];
  const mf = newMiniflare([
    fixtureWorker('consumer-harness', {
      name: 'consumer',
      bindings: { BACKOFF_SCALE: String(BACKOFF_SCALE) },
      queueProducers: { QUEUE: QUEUE_NAME },
      // The same settings as wrangler.consumer.jsonc (`pnpm check` holds that file to the contract's numbers).
      queueConsumers: {
        [QUEUE_NAME]: {
          maxBatchSize: 1,
          maxBatchTimeout: 1,
          maxRetires: MAX_ATTEMPTS - 1,
          retryDelay: 10,
          deadLetterQueue: DLQ_NAME,
        },
      },
      serviceBindings: {
        HARNESS: async (request: Request) => {
          const { message, attempt } = (await request.json()) as { message: JobMessage; attempt: number };
          return new Promise<Response>((resolve) => {
            inbox.push({
              message,
              attempt,
              ack: async () => resolve(new Response('ok')),
              fail: async () => resolve(new Response('failed', { status: 500 })),
            });
          });
        },
      },
    }),
    fixtureWorker('dlq-sink', {
      name: 'dlq',
      queueConsumers: [DLQ_NAME],
      serviceBindings: {
        SINK: async (request: Request) => {
          dead.push((await request.json()) as JobMessage);
          return new Response('ok');
        },
      },
    }),
  ]);
  await mf.ready;
  const queue = createCloudflareQueue(await mf.getQueueProducer('QUEUE', 'consumer'));

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

  const next = (waitMs: number) => poll(waitMs, () => inbox.shift());
  return {
    queue,
    consume: {
      maxAttempts: MAX_ATTEMPTS,
      // D101: push consumers have no visibility timeout, so `visibilityTimeoutMs` is left out on purpose.
      firstRetryDelaySeconds: Math.round(10 * BACKOFF_SCALE),
      next: async (waitMs) => (await next(waitMs)) ?? null,
      async deadLettered(count, waitMs) {
        await poll(waitMs, () => (dead.filter((m) => sent.has(m.jobId)).length >= count ? true : undefined));
        return dead.filter((m) => sent.has(m.jobId));
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
      await mf.dispose();
    },
  };
});
