import {
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { BACKOFF_SECONDS, JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import type { JobHandler, Queue } from '@hostmark/core/ports';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';

/** Messages per `SendMessageBatch` call. */
export const SQS_BATCH_LIMIT = 10;
/** SQS refuses a delay above 15 minutes; core's longest is 270 s (D17). */
export const SQS_MAX_DELAY_SECONDS = 900;

type Sender = Pick<SQSClient, 'send'>;

/** Producer side (D17 on SQS). Messages are JSON, far below the 256 KiB limit. */
export function createSqsQueue(client: Sender, queueUrl: string): Queue {
  return {
    async send(msg, opts) {
      const delay = opts?.delaySeconds ?? 0;
      if (delay > SQS_MAX_DELAY_SECONDS)
        throw new RangeError(`SQS delays a message by at most ${SQS_MAX_DELAY_SECONDS} s, got ${delay}`);
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(msg),
          ...(delay > 0 ? { DelaySeconds: Math.round(delay) } : {}),
        }),
      );
    },
    async sendBatch(msgs) {
      for (let i = 0; i < msgs.length; i += SQS_BATCH_LIMIT) {
        const chunk = msgs.slice(i, i + SQS_BATCH_LIMIT);
        const res = await client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((m, n) => ({ Id: String(n), MessageBody: JSON.stringify(m) })),
          }),
        );
        // A batch call succeeds as a whole even when single entries were refused.
        if (res.Failed?.length)
          throw new Error(
            `SQS refused ${res.Failed.length} of ${chunk.length} messages: ${res.Failed.map((f) => `${f.Code} ${f.Message}`).join('; ')}`,
          );
      }
    },
    async ping() {
      await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
    },
  };
}

/** Seconds a failed attempt waits (D17). `attempt` is the number of the attempt that just failed, 1-based. */
export function backoffSeconds(attempt: number, scale = 1): number {
  const seconds = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length) - 1] ?? 0;
  return Math.round(seconds * scale);
}

/** Thrown by `crash()`. It leaves the handler uncaught, so Lambda fails the invocation and nothing is acknowledged. */
export class CrashSignal extends Error {
  constructor() {
    super('chaos=crash: the invocation is abandoned without acknowledging');
  }
}

export interface ConsumeOptions {
  handler: JobHandler;
  sqs: Sender;
  queueUrl: string;
  /** Multiplies the retry delays; only tests set it below 1. */
  backoffScale?: number;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Consumer side (D17 on SQS through a Lambda event source mapping with `ReportBatchItemFailures`).
 * - `attempt` is `ApproximateReceiveCount`, which SQS increments on every delivery, including a redelivery after the
 *   visibility timeout expired (a crash or a timed out invocation).
 * - SQS has no per message backoff: a failed message is made invisible for the backoff of D17 with
 *   `ChangeMessageVisibility` and reported as a batch item failure, which tells Lambda not to delete it. The final
 *   attempt sets the timeout to 0, so the redrive policy (`maxReceiveCount` = MAX_ATTEMPTS) moves it to the dead
 *   letter queue at the next receive instead of after the last backoff.
 * - A body that is not a valid `JobMessage` fails the same way and ends in the dead letter queue.
 * - The visibility timeout of the queue (6 times the function timeout, template.yaml) is the safety net for an invocation
 *   that dies: Lambda cannot report on it, the message comes back when the timeout runs out.
 */
export async function handleSqsEvent(event: SQSEvent, options: ConsumeOptions): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    const attempt = Math.max(1, Number(record.attributes.ApproximateReceiveCount) || 1);
    try {
      const message = parseBody(record);
      await options.handler(message, {
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        receivedAt: new Date(),
        crash: async () => {
          throw new CrashSignal();
        },
      });
    } catch (err) {
      if (err instanceof CrashSignal) throw err;
      const delaySeconds = attempt >= MAX_ATTEMPTS ? 0 : backoffSeconds(attempt, options.backoffScale);
      options.log?.(attempt >= MAX_ATTEMPTS ? 'job failed for good' : 'job failed, retrying', {
        messageId: record.messageId,
        attempt,
        delaySeconds,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await options.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: options.queueUrl,
            ReceiptHandle: record.receiptHandle,
            VisibilityTimeout: delaySeconds,
          }),
        );
      } catch (visibilityError) {
        // The message then returns after the queue's own visibility timeout: later than D17 wants, never lost.
        options.log?.('could not set the retry delay', {
          messageId: record.messageId,
          error: visibilityError instanceof Error ? visibilityError.message : String(visibilityError),
        });
      }
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

function parseBody(record: SQSRecord): JobMessage {
  let json: unknown;
  try {
    json = JSON.parse(record.body);
  } catch {
    throw new Error('message body is not JSON');
  }
  const parsed = JobMessage.safeParse(json);
  if (!parsed.success) throw new Error(`message body is not a job message: ${parsed.error.message}`);
  return parsed.data;
}
