// The port contract suites of a Node adapter against its stand-ins (Redis and an S3 server), shared by every adapter that
// runs on this runtime. The services come from the environment, as for the other tests: REDIS_TEST_URL and
// S3_TEST_ENDPOINT. Without them the suites show as skipped; the image contract needs nothing and always runs.
import { DLQ_NAME, type JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import {
  describeImageProcessorContract,
  describeObjectStorageContract,
  describeQueueContract,
  type QueueDelivery,
} from '@hostmark/core/test/contract';
import { createWasmImageProcessor } from '@hostmark/image';
import { nodeLoader } from '@hostmark/image/node';
import { createS3Storage } from '@hostmark/storage-s3';
import { AwsClient } from 'aws4fetch';
import { Queue as BullQueue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { startConsumer } from '../consumer';
import { createBullQueue, redisConnection } from '../queue';
import { makeJpeg } from './fixtures';

const quiet = () => {};
/** Lock of the contract's BullMQ consumer: short, so that a lost renewal shows within seconds. */
const RENEWAL_TEST_LOCK_MS = 2_000;
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

export function describeNodePortContracts(label: string): void {
  // Against the Redis of a stack or a throwaway container: REDIS_TEST_URL=redis://127.0.0.1:56379
  const redisUrl = process.env.REDIS_TEST_URL;
  // Against any S3 server: S3_TEST_ENDPOINT=http://127.0.0.1:59000 (the MinIO of the compose stack)
  const endpoint = process.env.S3_TEST_ENDPOINT;
  const accessKeyId = process.env.S3_TEST_ACCESS_KEY ?? 'hostmark';
  const secretAccessKey = process.env.S3_TEST_SECRET_KEY ?? 'hostmark-local-secret';
  const region = 'us-east-1';

  // Needs no services, so it always runs: it proves the Node loader finds the .wasm files from this package.
  describeImageProcessorContract(`${label}: wasm + node loader`, async () => ({
    processor: createWasmImageProcessor(nodeLoader),
    fixtures: {
      large: await makeJpeg(2400, 1800),
      small: await makeJpeg(64, 48),
      withMetadata: await makeJpeg(800, 600, 6),
      rotated: { body: await makeJpeg(800, 600, 6), width: 800, height: 600, orientation: 6 },
    },
  }));

  if (redisUrl) {
    describeQueueContract(`${label}: BullMQ on Redis`, async () => {
      // A fresh queue per run keeps the suite independent of whatever else uses the Redis.
      const name = `contract-${crypto.randomUUID()}`;
      const queue = createBullQueue(redisUrl, name);

      // The real consumer, with its handler parked until the test acknowledges or fails the delivery.
      // The backoff is 1 % of the production schedule; the long smoke step covers the real one. The lock is 2 s
      // instead of the production minute, so the renewal test watches a held delivery across several lock periods.
      const inbox: QueueDelivery[] = [];
      const consumer = startConsumer({
        redisUrl,
        queueName: name,
        logger,
        concurrency: 1,
        backoffScale: 0.01,
        lockDurationMs: RENEWAL_TEST_LOCK_MS,
        stalledIntervalMs: RENEWAL_TEST_LOCK_MS,
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
      // The dead letter queue is shared with other test files: only messages sent here count.
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
          renewalMs: RENEWAL_TEST_LOCK_MS,
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
    describe.skip(`Queue contract: ${label}: BullMQ on Redis (set REDIS_TEST_URL)`, () => {
      it('skipped', () => {});
    });
  }

  if (endpoint) {
    describeObjectStorageContract(`${label}: S3 via createS3Storage`, async () => {
      const bucket = `contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const admin = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region });
      const created = await admin.fetch(`${endpoint}/${bucket}`, { method: 'PUT' });
      expect(created.status).toBe(200);
      return {
        storage: createS3Storage({ endpoint, bucket, region, accessKeyId, secretAccessKey }),
        capabilities: { rejectsWrongLength: true, rejectsWrongContentType: true, expiresUrls: true },
        close: async () => {
          await admin.fetch(`${endpoint}/${bucket}`, { method: 'DELETE' });
        },
      };
    });
  } else {
    describe.skip(`Object storage contract: ${label}: S3 via createS3Storage (set S3_TEST_ENDPOINT)`, () => {
      it('skipped', () => {});
    });
  }
}
