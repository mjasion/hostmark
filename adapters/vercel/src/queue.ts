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

/**
 * Deliveries after the last attempt (D17) that only send the message to the dead letter topic. `vercel.json` sets the
 * trigger's `maxDeliveries` to `MAX_DELIVERIES` (checked by `pnpm check`), so a message whose every delivery dies
 * (a killer job: out of memory, `maxDuration`, a crash of the instance) or whose dead letter send keeps failing is not
 * redelivered without end; the platform default is unlimited.
 */
export const DEAD_LETTER_DELIVERIES = 3;
export const MAX_DELIVERIES = MAX_ATTEMPTS + DEAD_LETTER_DELIVERIES;

export interface ConsumeOptions {
  handler: JobHandler;
  /**
   * Sends the raw message of a job that cannot succeed any more to the dead letter topic (Vercel Queues has none).
   * Must throw when the send fails. `messageId` is the same on every delivery of a message (an idempotency key).
   */
  deadLetter: (payload: unknown, reason: string, messageId: string) => Promise<void>;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * `handleCallback` body (D17 on Vercel Queues, D198). The platform has no dead letter queue, so the adapter keeps one:
 * - `attempt` is `deliveryCount`; a throw is retried after the D17 backoff by `retryAfter` (the `retry` option).
 * - On attempt `MAX_ATTEMPTS`, or for a body that is no job message, the payload is sent to `<topic>-dlq` first and the
 *   delivery then returns normally, which acknowledges it. If that send fails the delivery throws and is retried.
 * - A delivery after `MAX_ATTEMPTS` never runs the job again, it only dead-letters: the attempt before it either died
 *   before it could (a killer job) or failed to send the copy. Running the job again would lose the copy, because core
 *   has marked the file failed, so the job finds nothing to claim and returns, which acknowledges.
 * - Only the last delivery (`MAX_DELIVERIES`) loses the copy, when its send fails too; that is logged with the payload.
 */
export function createMessageProcessor(options: ConsumeOptions) {
  return async function process(payload: unknown, metadata: Metadata): Promise<void> {
    const attempt = Math.max(1, metadata.deliveryCount);
    const deadLetter = async (reason: string) => {
      try {
        await options.deadLetter(payload, reason, metadata.messageId);
      } catch (err) {
        options.log?.(
          attempt >= MAX_DELIVERIES
            ? 'dead letter send failed on the last delivery, the copy is lost'
            : 'dead letter send failed, retrying',
          {
            messageId: metadata.messageId,
            attempt,
            reason,
            error: err instanceof Error ? err.message : String(err),
            payload,
          },
        );
        throw err;
      }
    };
    const parsed = JobMessage.safeParse(payload);
    if (!parsed.success) return deadLetter(`not a job message: ${parsed.error.message}`);
    if (attempt > MAX_ATTEMPTS)
      return deadLetter(`delivery ${attempt} after ${MAX_ATTEMPTS} attempts: the job is not run again`);
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
      await deadLetter(error);
    }
  };
}

/** The `retry` option of `handleCallback`: backoff of D17, by the number of the delivery that failed. */
export const retryAfter = (_error: unknown, metadata: Metadata) => ({
  afterSeconds: backoffSeconds(metadata.deliveryCount),
});
