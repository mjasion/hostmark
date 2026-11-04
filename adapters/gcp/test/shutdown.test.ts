import { PubSub } from '@google-cloud/pubsub';
import type { JobMessage } from '@hostmark/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOSE_MAX_MS, startConsumer } from '../src/consumer';
import { CLOUD_RUN_SIGTERM_GRACE_MS, SHUTDOWN_DEADLINE_MS, withDeadline } from '../src/shutdown';

const emulator = process.env.PUBSUB_EMULATOR_HOST;
const quiet = () => {};
const project = 'hostmark-shutdown';

const LONG = crypto.randomUUID();
const SHORT = crypto.randomUUID();
const job = (jobId: string): JobMessage => ({
  v: 1,
  type: 'process_image',
  jobId,
  fileId: crypto.randomUUID(),
  enqueuedAt: new Date().toISOString(),
  chaos: 'none',
});

async function until<T>(waitMs: number, fn: () => T | undefined): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const v = fn();
    if (v !== undefined || Date.now() >= deadline) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('shutdown budget (Cloud Run SIGKILLs 10 s after SIGTERM)', () => {
  it('fits the consumer close and the process exit inside the grace period', () => {
    expect(CLOSE_MAX_MS).toBeLessThan(SHUTDOWN_DEADLINE_MS);
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(CLOUD_RUN_SIGTERM_GRACE_MS);
  });

  it('gives up on a shutdown that does not settle by the deadline', async () => {
    let timedOut = false;
    const stop = withDeadline(
      () => new Promise<void>((r) => setTimeout(r, 300)),
      50,
      () => {
        timedOut = true;
      },
    );
    await stop();
    expect(timedOut).toBe(true);
    let early = false;
    await withDeadline(
      async () => {},
      50,
      () => {
        early = true;
      },
    )();
    await new Promise((r) => setTimeout(r, 100));
    expect(early).toBe(false);
  });
});

(emulator ? describe : describe.skip)('consumer close against the Pub/Sub emulator', () => {
  // The ack deadline of the subscription is long on purpose: a message that is not handed back would stay away for 60 s.
  let admin: PubSub;
  let topicName: string;
  let subName: string;

  beforeAll(async () => {
    const id = crypto.randomUUID().slice(0, 8);
    topicName = `shutdown-${id}`;
    subName = `shutdown-${id}-worker`;
    const dlq = `shutdown-${id}-dlq`;
    admin = new PubSub({ projectId: project });
    await admin.createTopic(topicName);
    await admin.createTopic(dlq);
    await admin.topic(topicName).createSubscription(subName, {
      ackDeadlineSeconds: 60,
      deadLetterPolicy: { deadLetterTopic: `projects/${project}/topics/${dlq}`, maxDeliveryAttempts: 5 },
    });
  });

  afterAll(async () => {
    await admin?.close();
  });

  const consumer = (handler: Parameters<typeof startConsumer>[0]['handler'], closeGraceMs: number) =>
    startConsumer({
      project,
      subscription: subName,
      logger: { info: quiet, warn: quiet, error: quiet, debug: quiet } as never,
      concurrency: 1,
      backoffScale: 0.1,
      closeGraceMs,
      handler,
    });

  it('hands a job that outlives the grace back at once, and the next consumer gets it with the next attempt', async () => {
    const seen: { jobId: string; attempt: number }[] = [];
    const a = consumer(async (msg, ctx) => {
      seen.push({ jobId: msg.jobId, attempt: ctx.attempt });
      await new Promise(() => {}); // a long job: never ends on its own
    }, 300);
    await admin.topic(topicName).publishMessage({ data: Buffer.from(JSON.stringify(job(LONG))) });
    expect(await until(10_000, () => seen.find((s) => s.jobId === LONG))).toBeDefined();

    const started = Date.now();
    await a.close();
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_DEADLINE_MS);

    const redelivered: { jobId: string; attempt: number }[] = [];
    const b = consumer(async (msg, ctx) => {
      redelivered.push({ jobId: msg.jobId, attempt: ctx.attempt });
    }, 300);
    // Without the hand-back it would come back after the 60 s ack deadline.
    const got = await until(10_000, () => redelivered.find((s) => s.jobId === LONG));
    await b.close();
    expect(got?.attempt).toBe(2);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 40_000);

  it('lets a job that ends within the grace finish and acks it instead of handing it back', async () => {
    const started: string[] = [];
    const done: string[] = [];
    const a = consumer(async (msg) => {
      started.push(msg.jobId);
      await new Promise((r) => setTimeout(r, 500));
      done.push(msg.jobId);
    }, 5_000);
    await admin.topic(topicName).publishMessage({ data: Buffer.from(JSON.stringify(job(SHORT))) });
    expect(await until(10_000, () => started.find((id) => id === SHORT))).toBeDefined();
    await a.close();
    expect(done).toContain(SHORT);

    // A handed-back message would be redelivered at once; an acked one never.
    const again: string[] = [];
    const b = consumer(async (msg) => {
      again.push(msg.jobId);
    }, 300);
    await new Promise((r) => setTimeout(r, 3_000));
    await b.close();
    expect(again).not.toContain(SHORT);
  }, 40_000);
});
