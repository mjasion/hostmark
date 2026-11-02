import { PubSub } from '@google-cloud/pubsub';
import { type JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import {
  describeImageProcessorContract,
  describeObjectStorageContract,
  describeQueueContract,
  type QueueDelivery,
} from '@hostmark/core/test/contract';
import { createWasmImageProcessor } from '@hostmark/image';
import { nodeLoader } from '@hostmark/image/node';
import { makeJpeg } from '@hostmark/node-runtime/testing/fixtures';
import { createS3Storage } from '@hostmark/storage-s3';
import { AwsClient } from 'aws4fetch';
import { describe, expect, it } from 'vitest';
import { startConsumer } from '../src/consumer';
import { createPubSubQueue } from '../src/queue';

// The queue suite runs against the official Pub/Sub emulator: PUBSUB_EMULATOR_HOST=127.0.0.1:55800 (README).
// The storage suite runs against any S3 server as a stand-in for the Cloud Storage XML API: S3_TEST_ENDPOINT.
const emulator = process.env.PUBSUB_EMULATOR_HOST;
const endpoint = process.env.S3_TEST_ENDPOINT;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY ?? 'hostmark';
const secretAccessKey = process.env.S3_TEST_SECRET_KEY ?? 'hostmark-local-secret';

const quiet = () => {};
const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet } as never;
const project = 'hostmark-contract';

async function poll<T>(waitMs: number, fn: () => T | undefined): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describeImageProcessorContract('gcp: wasm + node loader', async () => ({
  processor: createWasmImageProcessor(nodeLoader),
  fixtures: {
    large: await makeJpeg(2400, 1800),
    small: await makeJpeg(64, 48),
    withMetadata: await makeJpeg(800, 600, 6),
    rotated: { body: await makeJpeg(800, 600, 6), width: 800, height: 600, orientation: 6 },
  },
}));

if (emulator) {
  describeQueueContract('gcp: Pub/Sub emulator', async () => {
    // A fresh topology per run, shaped like infra/pubsub.tf: subscription with a 10 s ack deadline and a dead letter topic.
    const id = crypto.randomUUID().slice(0, 8);
    const topicName = `contract-${id}`;
    const dltName = `contract-${id}-dlq`;
    const subName = `contract-${id}-worker`;
    const dltSubName = `contract-${id}-dlq-reader`;
    const admin = new PubSub({ projectId: project });
    await admin.createTopic(topicName);
    await admin.createTopic(dltName);
    await admin.topic(dltName).createSubscription(dltSubName);
    await admin.topic(topicName).createSubscription(subName, {
      ackDeadlineSeconds: 10,
      deadLetterPolicy: {
        deadLetterTopic: `projects/${project}/topics/${dltName}`,
        maxDeliveryAttempts: MAX_ATTEMPTS,
      },
    });

    const queue = createPubSubQueue({ project, topic: topicName, logger });
    const inbox: QueueDelivery[] = [];
    // The real consumer with its handler parked until the test settles the delivery. Backoff at 10 %, and a hold of 3 s
    // so that an unsettled delivery stops being renewed and comes back after the 10 s ack deadline.
    const consumer = startConsumer({
      project,
      subscription: subName,
      logger,
      concurrency: 20,
      backoffScale: 0.1,
      leaseSeconds: 10,
      renewEverySeconds: 2,
      maxHoldSeconds: 3,
      closeGraceMs: 1000,
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
    const dltSub = admin.subscription(dltSubName);

    return {
      queue,
      consume: {
        maxAttempts: MAX_ATTEMPTS,
        next: async (waitMs) => (await next(waitMs)) ?? null,
        async deadLettered(count, waitMs) {
          const got: JobMessage[] = [];
          const deadline = Date.now() + waitMs;
          const listener = (m: { data: Buffer; ack(): void }) => {
            got.push(JSON.parse(m.data.toString()) as JobMessage);
            m.ack();
          };
          dltSub.on('message', listener);
          while (got.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
          dltSub.off('message', listener);
          return got;
        },
        firstRetryDelaySeconds: 1,
        visibilityTimeoutMs: 10_000,
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
        await dltSub.close();
        await admin.close();
      },
    };
  });
} else {
  describe.skip('Queue contract: gcp: Pub/Sub emulator (set PUBSUB_EMULATOR_HOST)', () => {
    it('skipped', () => {});
  });
}

if (endpoint) {
  describeObjectStorageContract(
    'gcp: S3 API via createS3Storage (stand-in for the Cloud Storage XML API)',
    async () => {
      const region = 'us-east-1';
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
    },
  );
} else {
  describe.skip('Object storage contract: gcp: S3 API (set S3_TEST_ENDPOINT)', () => {
    it('skipped', () => {});
  });
}

it('keeps the attempt bound of the platform equal to core', () => {
  expect(MAX_ATTEMPTS).toBe(5);
});
