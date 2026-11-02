import { DLQ_NAME, type JobMessage, MAX_ATTEMPTS, QUEUE_NAME } from '@hostmark/contract';
import type { Queue } from '@hostmark/core/ports';
import type { Telemetry } from '@hostmark/telemetry';
import { Queue as BullQueue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

/** BullMQ wants `maxRetriesPerRequest: null` on connections it uses for blocking commands. */
export function redisConnection(url: string): ConnectionOptions {
  return { url, maxRetriesPerRequest: null };
}

// Retries are the worker's concern (custom backoff in consumer.ts); here only the budget is set.
// No `jobId`: a requeue sends a new message for the same file and must not be deduplicated.
const jobOptions = (delaySeconds?: number): JobsOptions => ({
  attempts: MAX_ATTEMPTS,
  backoff: { type: 'custom' },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 86_400, count: 1000 },
  ...(delaySeconds ? { delay: delaySeconds * 1000 } : {}),
});

/** The API answers 503 and returns the file to `pending_upload` (D52), so a down Redis must fail the call quickly. */
export const SEND_TIMEOUT_MS = 5000;

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${SEND_TIMEOUT_MS} ms`)),
      SEND_TIMEOUT_MS,
    );
  });
  // A late result of the abandoned call is harmless: the claim only accepts queued and processing files.
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export interface BullQueueHandle extends Queue {
  ping(): Promise<void>;
  close(): Promise<void>;
}

type Logger = Telemetry['logger'];

export function createBullQueue(
  redisUrl: string,
  name: string = QUEUE_NAME,
  logger?: Logger,
): BullQueueHandle {
  // The producer must not wait for Redis the way the worker does: no offline queue, one retry per command.
  const queue = new BullQueue<JobMessage>(name, {
    connection: { url: redisUrl, maxRetriesPerRequest: 1, enableOfflineQueue: false },
  });
  queue.on('error', (error) => logger?.error('queue error', { queue: name, error }));
  // A separate light connection: ping must not queue behind blocking commands and should fail fast.
  const pinger = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  pinger.on('error', () => {});

  return {
    async send(msg, opts) {
      await withTimeout(queue.add(msg.type, msg, jobOptions(opts?.delaySeconds)), 'queue.send');
    },
    async sendBatch(msgs) {
      if (msgs.length === 0) return;
      for (let i = 0; i < msgs.length; i += 100) {
        await withTimeout(
          queue.addBulk(
            msgs.slice(i, i + 100).map((msg) => ({ name: msg.type, data: msg, opts: jobOptions() })),
          ),
          'queue.sendBatch',
        );
      }
    },
    async ping() {
      if (pinger.status === 'wait') await pinger.connect();
      await pinger.ping();
    },
    async close() {
      pinger.disconnect();
      await queue.close();
    },
  };
}

export function createDlq(redisUrl: string, logger?: Logger) {
  const dlq = new BullQueue<JobMessage>(DLQ_NAME, { connection: redisConnection(redisUrl) });
  dlq.on('error', (error) => logger?.error('queue error', { queue: DLQ_NAME, error }));
  return dlq;
}
