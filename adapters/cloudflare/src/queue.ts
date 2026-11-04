import { BACKOFF_SECONDS, type JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import type { JobHandler, Queue } from '@hostmark/core/ports';

/** Messages per `sendBatch` call on Cloudflare Queues. */
const BATCH_LIMIT = 100;

/**
 * Producer side: a thin wrapper of the Queues binding. Messages are JSON, well below the 128 KB limit.
 *
 * `ping` asks the binding for the queue's realtime backlog (`metrics()`), which needs the queue to exist and be
 * reachable and sends nothing (D253). The numbers are not used: `/api/health/deep` only reports up or down.
 */
export function createCloudflareQueue(
  binding: Pick<globalThis.Queue<JobMessage>, 'send' | 'sendBatch' | 'metrics'>,
): Queue {
  return {
    async ping() {
      const metrics = await binding.metrics();
      if (typeof metrics?.backlogCount !== 'number')
        throw new Error('queue.metrics() answered without a backlog count');
    },
    async send(msg, opts) {
      await binding.send(msg, {
        contentType: 'json',
        ...(opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : {}),
      });
    },
    async sendBatch(msgs) {
      for (let i = 0; i < msgs.length; i += BATCH_LIMIT) {
        const chunk = msgs.slice(i, i + BATCH_LIMIT);
        await binding.sendBatch(chunk.map((body) => ({ body, contentType: 'json' as const })));
      }
    },
  };
}

/** Seconds a failed attempt waits (D17). `attempt` is the number of the attempt that just failed, 1-based. */
export function backoffSeconds(attempt: number, scale = 1): number {
  const seconds = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length) - 1] ?? 0;
  return Math.round(seconds * scale);
}

export interface ConsumeOptions {
  handler: JobHandler;
  /** Multiplies the retry delays; only tests set it below 1. */
  backoffScale?: number;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/** Thrown by `crash()`. The batch handler lets it through without touching the message, see `consumeBatch`. */
export class CrashSignal extends Error {
  constructor() {
    super('chaos=crash: the invocation is abandoned without acknowledging');
  }
}

/**
 * Consumer side (D17 on Cloudflare Queues). Messages of a batch run one after the other: the image work is CPU bound
 * on one isolate, so concurrency inside an invocation would only add latency. The platform's batch size is 1 in the
 * wrangler config anyway, and this loop keeps the same behaviour if someone raises it.
 *
 * - `attempt` is `message.attempts`, which the platform increments on every delivery.
 * - A failure becomes `retry({ delaySeconds })` with the backoff of D17. Once `max_retries` (MAX_ATTEMPTS - 1) is
 *   used up the platform moves the message to the dead letter queue by itself.
 * - `crash` throws out of the whole invocation: Queues then treats every message of the batch that was not
 *   acknowledged as failed and redelivers it, with the queue's default delay.
 * - The visibility timeout of D17 does not exist for push consumers. A handler that exceeds the 15 minute wall clock
 *   of a queue invocation is cancelled and its messages are retried, which is the nearest equivalent (D101).
 */
export async function consumeBatch(batch: MessageBatch<JobMessage>, options: ConsumeOptions): Promise<void> {
  for (const message of batch.messages) {
    const attempt = message.attempts;
    try {
      await options.handler(message.body, {
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        receivedAt: new Date(),
        crash: async () => {
          throw new CrashSignal();
        },
      });
      message.ack();
    } catch (err) {
      if (err instanceof CrashSignal) throw err;
      const delaySeconds = backoffSeconds(attempt, options.backoffScale);
      options.log?.(attempt >= MAX_ATTEMPTS ? 'job failed for good' : 'job failed, retrying', {
        jobId: message.body.jobId,
        attempt,
        delaySeconds,
        error: err instanceof Error ? err.message : String(err),
      });
      message.retry({ delaySeconds });
    }
  }
}
