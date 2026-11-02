import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { BACKOFF_SECONDS, type JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
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
import { createSqsQueue, handleSqsEvent } from '../src/queue';
import { startEventSourceMapping } from './esm';

// Stand-ins: ElasticMQ for SQS and MinIO for S3, in throwaway containers (README, "Tests"). Without the variables the
// suites show as skipped; the image contract needs nothing and always runs.
const sqsEndpoint = process.env.SQS_TEST_ENDPOINT; // http://127.0.0.1:55811
const s3Endpoint = process.env.S3_TEST_ENDPOINT; // http://127.0.0.1:55810
const accessKeyId = process.env.S3_TEST_ACCESS_KEY ?? 'hostmark';
const secretAccessKey = process.env.S3_TEST_SECRET_KEY ?? 'hostmark-local-secret';
const region = 'us-east-1';

describeImageProcessorContract('aws: wasm + node loader', async () => ({
  processor: createWasmImageProcessor(nodeLoader),
  fixtures: {
    large: await makeJpeg(2400, 1800),
    small: await makeJpeg(64, 48),
    withMetadata: await makeJpeg(800, 600, 6),
    rotated: { body: await makeJpeg(800, 600, 6), width: 800, height: 600, orientation: 6 },
  },
}));

// Retry delays at 10 % of D17: 1, 3, 9 and 27 s. The queue timeout is 5 s here and 6 times the function timeout
// (15 minutes of worker time) in the template.
const BACKOFF_SCALE = 0.1;
const VISIBILITY_TIMEOUT_S = 5;

async function poll<T>(waitMs: number, fn: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 25));
  }
}

if (sqsEndpoint) {
  describeQueueContract('aws: SQS on ElasticMQ', async () => {
    const sqs = new SQSClient({
      region,
      endpoint: sqsEndpoint,
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    const dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `dlq-${suffix}` })))
      .QueueUrl as string;
    const dlqArn = (
      await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))
    ).Attributes?.QueueArn as string;
    const queueUrl = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `jobs-${suffix}`,
          Attributes: {
            VisibilityTimeout: String(VISIBILITY_TIMEOUT_S),
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: MAX_ATTEMPTS }),
          },
        }),
      )
    ).QueueUrl as string;
    const queue = createSqsQueue(sqs, queueUrl);

    const inbox: QueueDelivery[] = [];
    const parked: Array<() => void> = [];
    const mapping = startEventSourceMapping(sqs, queueUrl, (record) =>
      handleSqsEvent(
        { Records: [record] },
        {
          sqs,
          queueUrl,
          backoffScale: BACKOFF_SCALE,
          handler: (message, ctx) =>
            new Promise<void>((resolve, reject) => {
              parked.push(resolve);
              inbox.push({
                message,
                attempt: ctx.attempt,
                ack: async () => resolve(),
                fail: async () => reject(new Error('test failure')),
              });
            }),
        },
      ),
    );

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
    const next = (waitMs: number) => poll(waitMs, async () => inbox.shift());

    return {
      queue,
      consume: {
        maxAttempts: MAX_ATTEMPTS,
        next: async (waitMs) => (await next(waitMs)) ?? null,
        firstRetryDelaySeconds: Math.round((BACKOFF_SECONDS[0] ?? 0) * BACKOFF_SCALE),
        visibilityTimeoutMs: VISIBILITY_TIMEOUT_S * 1000,
        async deadLettered(count, waitMs) {
          const found = new Map<string, JobMessage>();
          await poll(waitMs, async () => {
            const res = await sqs.send(
              new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
            );
            for (const m of res.Messages ?? []) {
              const body = JSON.parse(m.Body as string) as JobMessage;
              if (sent.has(body.jobId)) found.set(body.jobId, body);
            }
            return found.size >= count ? true : undefined;
          });
          return [...found.values()];
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
        for (const resolve of parked) resolve();
        await mapping.stop();
        await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
      },
    };
  });
} else {
  describe.skip('Queue contract: aws: SQS on ElasticMQ (set SQS_TEST_ENDPOINT)', () => {
    it('skipped', () => {});
  });
}

if (s3Endpoint) {
  describeObjectStorageContract('aws: S3 via createS3Storage on MinIO', async () => {
    const bucket = `contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const admin = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region });
    const created = await admin.fetch(`${s3Endpoint}/${bucket}`, { method: 'PUT' });
    expect(created.status).toBe(200);
    return {
      storage: createS3Storage({ endpoint: s3Endpoint, bucket, region, accessKeyId, secretAccessKey }),
      capabilities: { rejectsWrongLength: true, rejectsWrongContentType: true, expiresUrls: true },
      close: async () => {
        await admin.fetch(`${s3Endpoint}/${bucket}`, { method: 'DELETE' });
      },
    };
  });
} else {
  describe.skip('Object storage contract: aws: S3 on MinIO (set S3_TEST_ENDPOINT)', () => {
    it('skipped', () => {});
  });
}
