import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { BACKOFF_SECONDS, JOB_MESSAGE_VERSION, JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqsQueue, handleSqsEvent } from '../src/queue';
import { startEventSourceMapping } from './esm';

// D193 on ElasticMQ. The queue contract passes without `ChangeMessageVisibility`, because a retry after the queue
// visibility timeout is still a retry. Here the queue timeout (30 s) is far longer than the scaled backoff (1 s), so
// only the visibility call can bring a failed message back, or move it to the dead letter queue, within the deadline.
const sqsEndpoint = process.env.SQS_TEST_ENDPOINT;
const QUEUE_VISIBILITY_S = 30;
const BACKOFF_SCALE = 0.1;
const DEADLINE_MS = 10_000;

describe.skipIf(!sqsEndpoint)('aws: SQS retry timing on ElasticMQ (D193)', () => {
  const sqs = new SQSClient({
    region: 'us-east-1',
    endpoint: sqsEndpoint,
    credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
  });
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function setup() {
    const suffix = crypto.randomUUID().slice(0, 8);
    const dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `vis-dlq-${suffix}` })))
      .QueueUrl as string;
    cleanup.push(() => sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })));
    const dlqArn = (
      await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))
    ).Attributes?.QueueArn as string;
    const queueUrl = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `vis-${suffix}`,
          Attributes: {
            VisibilityTimeout: String(QUEUE_VISIBILITY_S),
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: MAX_ATTEMPTS }),
          },
        }),
      )
    ).QueueUrl as string;
    cleanup.push(() => sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })));
    const message = JobMessage.parse({
      v: JOB_MESSAGE_VERSION,
      type: 'process_image',
      jobId: crypto.randomUUID(),
      fileId: crypto.randomUUID(),
      enqueuedAt: new Date().toISOString(),
    });
    await createSqsQueue(sqs, queueUrl).send(message);
    return { queueUrl, dlqUrl, message };
  }

  /** Runs the real handler with a job that always fails and records each attempt and its time. */
  function failEveryAttempt(queueUrl: string) {
    const attempts: Array<{ attempt: number; at: number }> = [];
    const mapping = startEventSourceMapping(sqs, queueUrl, (record) =>
      handleSqsEvent(
        { Records: [record] },
        {
          sqs,
          queueUrl,
          backoffScale: BACKOFF_SCALE,
          handler: async (_message, ctx) => {
            attempts.push({ attempt: ctx.attempt, at: Date.now() });
            throw new Error('always fails');
          },
        },
      ),
    );
    cleanup.push(() => mapping.stop());
    return attempts;
  }

  it('delivers attempt 2 after the D17 backoff, not after the queue visibility timeout', async () => {
    const { queueUrl } = await setup();
    const attempts = failEveryAttempt(queueUrl);
    const deadline = Date.now() + DEADLINE_MS;
    while (attempts.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(attempts.map((a) => a.attempt).slice(0, 2)).toEqual([1, 2]);
    const gapMs = (attempts[1]?.at ?? 0) - (attempts[0]?.at ?? 0);
    const backoffMs = Math.round((BACKOFF_SECONDS[0] ?? 0) * BACKOFF_SCALE) * 1000;
    // Not before the backoff (ElasticMQ rounds to the second), and far from the 30 s of the queue.
    expect(gapMs).toBeGreaterThanOrEqual(backoffMs - 250);
    expect(gapMs).toBeLessThan(DEADLINE_MS);
  });

  it('moves the message to the dead letter queue right after the last attempt', async () => {
    const { queueUrl, dlqUrl, message } = await setup();
    // Attempts 1 to 4 as plain receives that return the message at once, so the test does not wait for the backoff.
    for (let n = 1; n < MAX_ATTEMPTS; n++) {
      const res = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, VisibilityTimeout: 0, WaitTimeSeconds: 1 }),
      );
      expect(res.Messages, `receive ${n}`).toHaveLength(1);
    }
    const attempts = failEveryAttempt(queueUrl);
    const deadline = Date.now() + DEADLINE_MS;
    let deadLettered: JobMessage | undefined;
    while (!deadLettered && Date.now() < deadline) {
      const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 1 }));
      const body = res.Messages?.[0]?.Body;
      if (body) deadLettered = JSON.parse(body) as JobMessage;
    }
    expect(attempts.map((a) => a.attempt)).toEqual([MAX_ATTEMPTS]);
    expect(deadLettered?.jobId).toBe(message.jobId);
  });
});
