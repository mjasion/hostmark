import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PubSub } from '@google-cloud/pubsub';
import type { JobMessage } from '@hostmark/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOSE_MAX_MS, CLOSING_PULL_TIMEOUT_MS, PULL_TIMEOUT_MS, startConsumer } from '../src/consumer';
import {
  API_DRAIN_MS,
  CLOUD_RUN_SIGTERM_GRACE_MS,
  closeServer,
  SHUTDOWN_DEADLINE_MS,
  withDeadline,
} from '../src/shutdown';

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

  it('leaves the api most of the budget for the database and telemetry after the drain', () => {
    expect(API_DRAIN_MS).toBeLessThanOrEqual(SHUTDOWN_DEADLINE_MS / 3);
  });

  it('pulls long while running and briefly while closing (D220)', () => {
    expect(PULL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(CLOSING_PULL_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
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

describe('api server close (D296)', () => {
  it('lets a short request finish, cuts a stream that outlives the drain, and resolves', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': open\n\n'); // a stream that never ends by itself, like an SSE status stream
        return;
      }
      setTimeout(() => res.end('done'), 200);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const get = (path: string) =>
      new Promise<{ status?: number; body: string; cut: boolean }>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body, cut: false }));
          res.on('aborted', () => resolve({ status: res.statusCode, body, cut: true }));
          res.on('error', () => resolve({ status: res.statusCode, body, cut: true }));
        });
        req.on('error', () => resolve({ body: '', cut: true }));
        req.end();
      });

    const stream = get('/events');
    await new Promise((r) => setTimeout(r, 100));
    const short = get('/short');
    await new Promise((r) => setTimeout(r, 20));

    const started = Date.now();
    await closeServer(server, 500);
    const took = Date.now() - started;

    expect(await short).toEqual({ status: 200, body: 'done', cut: false });
    const cut = await stream;
    expect(cut.cut).toBe(true);
    expect(cut.body).toContain(': open');
    expect(took).toBeGreaterThanOrEqual(450);
    expect(took).toBeLessThan(2_000);
  });

  it('resolves at once when nothing is open', async () => {
    const server = createServer((_req, res) => res.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const started = Date.now();
    await closeServer(server, 5_000);
    expect(Date.now() - started).toBeLessThan(500);
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

  it('cancels the long pull of an idle consumer on close, and the next consumer gets the next message at once', async () => {
    const IDLE = crypto.randomUUID();
    const a = consumer(async () => {}, 300);
    await new Promise((r) => setTimeout(r, 500)); // a pull is open
    const started = Date.now();
    await a.close();
    // Without the cancel, close would wait for the pull's own deadline or give up on it.
    expect(Date.now() - started).toBeLessThan(CLOSING_PULL_TIMEOUT_MS);

    await admin.topic(topicName).publishMessage({ data: Buffer.from(JSON.stringify(job(IDLE))) });
    const seen: { jobId: string; attempt: number }[] = [];
    const b = consumer(async (msg, ctx) => {
      seen.push({ jobId: msg.jobId, attempt: ctx.attempt });
    }, 300);
    // A message leased to the cancelled pull would come back only after the 60 s ack deadline.
    const got = await until(10_000, () => seen.find((s) => s.jobId === IDLE));
    await b.close();
    expect(got?.attempt).toBe(1);
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
