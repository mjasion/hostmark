import { BACKOFF_SECONDS, JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import type { JobHandler, Queue } from '@hostmark/core/ports';

/** The part of `@vercel/queue` this adapter uses; tests pass a fake. */
export interface QueueSdk {
  send(
    topic: string,
    payload: unknown,
    options?: { idempotencyKey?: string; delaySeconds?: number },
  ): Promise<unknown>;
  sendBatch(
    topic: string,
    messages: { payload: unknown; idempotencyKey?: string; delaySeconds?: number }[],
  ): Promise<{ status: string; error?: unknown }[]>;
}

export const deadLetterTopic = (topic: string) => `${topic}-dlq`;

/** Producer side. `idempotencyKey` makes a retried publish safe (the SDK documents it for batches; delivery stays at least once). */
export function createVercelQueue(sdk: QueueSdk, topic: string): Queue {
  return {
    async send(msg, opts) {
      await sdk.send(topic, msg, {
        idempotencyKey: msg.jobId,
        ...(opts?.delaySeconds ? { delaySeconds: Math.round(opts.delaySeconds) } : {}),
      });
    },
    async sendBatch(msgs) {
      for (let i = 0; i < msgs.length; i += 100) {
        const chunk = msgs.slice(i, i + 100);
        const results = await sdk.sendBatch(
          topic,
          chunk.map((m) => ({ payload: m, idempotencyKey: m.jobId })),
        );
        const failed = results.filter((r) => r.status === 'failed');
        // A batch call succeeds as a whole even when single entries were refused.
        if (failed.length)
          throw new Error(`Vercel Queues refused ${failed.length} of ${chunk.length} messages`);
      }
    },
  };
}

/** Seconds a failed attempt waits (D17); `attempt` is the number of the attempt that just failed, 1-based. */
export function backoffSeconds(attempt: number): number {
  return BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length) - 1] ?? 0;
}

/** Thrown by `crash()`: the delivery fails and the message comes back through the retry handler. */
export class CrashSignal extends Error {
  constructor() {
    super('chaos=crash: the delivery is abandoned without acknowledging');
  }
}

export interface Metadata {
  messageId: string;
  deliveryCount: number;
}

export interface ConsumeOptions {
  handler: JobHandler;
  /** Receives the raw message of a job that cannot succeed any more (Vercel Queues has no dead letter queue). */
  deadLetter: (payload: unknown, reason: string) => Promise<void>;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * `handleCallback` body (D17 on Vercel Queues). The platform has no dead letter queue and only an unbounded retry
 * (`maxDeliveries` defaults to unlimited), so the adapter does both itself:
 * - `attempt` is `deliveryCount`; a throw is retried after the D17 backoff by `retryAfter` (the `retry` option).
 * - On attempt `MAX_ATTEMPTS`, or for a body that is no job message, the payload is sent to `<topic>-dlq` first and the
 *   delivery then returns normally, which acknowledges it. If that send fails the delivery throws and is retried.
 */
export function createMessageProcessor(options: ConsumeOptions) {
  return async function process(payload: unknown, metadata: Metadata): Promise<void> {
    const attempt = Math.max(1, metadata.deliveryCount);
    const parsed = JobMessage.safeParse(payload);
    if (!parsed.success) {
      await options.deadLetter(payload, `not a job message: ${parsed.error.message}`);
      return;
    }
    try {
      await options.handler(parsed.data, {
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        receivedAt: new Date(),
        crash: async () => {
          throw new CrashSignal();
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (err instanceof CrashSignal || attempt < MAX_ATTEMPTS) {
        options.log?.('job failed, retrying', { messageId: metadata.messageId, attempt, error });
        throw err;
      }
      options.log?.('job failed for good', { messageId: metadata.messageId, attempt, error });
      await options.deadLetter(payload, error);
    }
  };
}

/** The `retry` option of `handleCallback`: backoff of D17, by the number of the delivery that failed. */
export const retryAfter = (_error: unknown, metadata: Metadata) => ({
  afterSeconds: backoffSeconds(metadata.deliveryCount),
});
