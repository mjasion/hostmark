import {
  BACKOFF_SECONDS,
  DLQ_NAME,
  type JobMessage,
  MAX_ATTEMPTS,
  QUEUE_NAME,
  VISIBILITY_TIMEOUT_SECONDS,
} from '@hostmark/contract';
import type { JobHandler } from '@hostmark/core/ports';
import type { Telemetry } from '@hostmark/telemetry';
import { UnrecoverableError, Worker } from 'bullmq';
import { createDlq, redisConnection } from './queue';

export interface ConsumerOptions {
  redisUrl: string;
  handler: JobHandler;
  logger: Telemetry['logger'];
  concurrency: number;
  backoffScale: number;
  /** Defaults to the production queue; the contract tests use their own. */
  queueName?: string;
  /** Test hooks: the stall tests need lock timings of seconds, not of the production minute. */
  lockDurationMs?: number;
  stalledIntervalMs?: number;
}

/**
 * BullMQ counts `attemptsMade` only for failed attempts, so a stalled job (its worker died, the lock expired) keeps
 * the same count. `attemptsStarted` counts every start, so it is the attempt number (D17, D63, D64):
 * - `maxStartedAttempts` ends a job that keeps killing its worker, however it died;
 * - `maxStalledCount` is raised to match, so that the stall check re-queues it instead of failing it with
 *   `attemptsMade` still low;
 * - the last attempt always fails for good (`UnrecoverableError`), even if earlier starts were stalls.
 * A terminal failure always sets `finishedOn`; that, not `attemptsMade`, decides about the dead letter copy.
 */
export function startConsumer(opts: ConsumerOptions): { close(): Promise<void> } {
  const { logger } = opts;
  const dlq = createDlq(opts.redisUrl, logger);
  const pending = new Set<Promise<unknown>>();

  const worker = new Worker<JobMessage>(
    opts.queueName ?? QUEUE_NAME,
    async (job) => {
      const maxAttempts = job.opts.attempts ?? MAX_ATTEMPTS;
      const attempt = Math.max(job.attemptsStarted, job.attemptsMade + 1);
      try {
        await opts.handler(job.data, {
          attempt,
          maxAttempts,
          receivedAt: new Date(),
          // Exit without touching the job: the lock expires and the stalled check hands it to a worker again.
          crash: async () => process.exit(1),
        });
      } catch (err) {
        if (attempt < maxAttempts || err instanceof UnrecoverableError) throw err;
        throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
      }
    },
    {
      connection: redisConnection(opts.redisUrl),
      concurrency: opts.concurrency,
      // The lock is the visibility timeout: BullMQ renews it while the handler runs.
      lockDuration: opts.lockDurationMs ?? VISIBILITY_TIMEOUT_SECONDS * 1000,
      ...(opts.stalledIntervalMs ? { stalledInterval: opts.stalledIntervalMs } : {}),
      maxStartedAttempts: MAX_ATTEMPTS,
      maxStalledCount: MAX_ATTEMPTS,
      settings: {
        // `attemptsMade` is the number of failures so far, 1-based: the first failure waits BACKOFF_SECONDS[0].
        backoffStrategy: (attemptsMade) => {
          const seconds = BACKOFF_SECONDS[Math.min(attemptsMade, BACKOFF_SECONDS.length) - 1] ?? 0;
          return Math.round(seconds * 1000 * opts.backoffScale);
        },
      },
    },
  );

  worker.on('error', (err) => logger.error('queue worker error', { error: err }));
  // BullMQ has no dead letter queue: copy a message to our own once it failed for good (not while it will be retried).
  worker.on('failed', (job, err) => {
    if (!job?.finishedOn) return;
    const write = dlq
      .add(job.data.type, job.data, { removeOnComplete: false, removeOnFail: false })
      .then(() =>
        logger.error('message moved to dead letter queue', {
          queue: DLQ_NAME,
          jobId: job.data.jobId,
          error: err,
        }),
      )
      .catch((e) => logger.error('dead letter write failed', { jobId: job.data.jobId, error: e }))
      .finally(() => pending.delete(write));
    pending.add(write);
  });

  return {
    async close() {
      await worker.close();
      await Promise.allSettled(pending);
      await dlq.close();
    },
  };
}
