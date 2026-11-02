import { PubSub, type Topic } from '@google-cloud/pubsub';
import { type JobMessage, QUEUE_NAME } from '@hostmark/contract';
import type { Queue } from '@hostmark/core/ports';
import type { Telemetry } from '@hostmark/telemetry';

/**
 * Pub/Sub has no delayed delivery. A delayed message carries this attribute (epoch milliseconds) and the consumer holds
 * it back by extending its ack deadline, which Pub/Sub caps at 600 seconds, so that is the longest delay.
 */
export const NOT_BEFORE_ATTRIBUTE = 'notBefore';
export const MAX_DELAY_SECONDS = 600;

/** The API answers 503 and returns the file to `pending_upload` (D52), so a down Pub/Sub must fail the call quickly. */
export const SEND_TIMEOUT_MS = 5000;
/** Pub/Sub accepts 1000 messages per publish; the client library batches, this only bounds one call's fan-out. */
const BATCH = 100;

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

export interface PubSubQueueHandle extends Queue {
  ping(): Promise<void>;
  close(): Promise<void>;
}

type Logger = Telemetry['logger'];

export interface PubSubQueueOptions {
  project: string;
  topic?: string;
  logger?: Logger;
  /** Shared client; closed by the caller. A queue creates and closes its own otherwise. */
  client?: PubSub;
}

export function createPubSubQueue(options: PubSubQueueOptions): PubSubQueueHandle {
  const client = options.client ?? new PubSub({ projectId: options.project });
  const topic: Topic = client.topic(options.topic ?? QUEUE_NAME);

  const publish = (msg: JobMessage, delaySeconds?: number) => {
    if (delaySeconds !== undefined && (delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS)) {
      throw new RangeError(`delaySeconds must be 0..${MAX_DELAY_SECONDS} on Pub/Sub, got ${delaySeconds}`);
    }
    return topic.publishMessage({
      data: Buffer.from(JSON.stringify(msg)),
      attributes: {
        type: msg.type,
        ...(delaySeconds ? { [NOT_BEFORE_ATTRIBUTE]: String(Date.now() + delaySeconds * 1000) } : {}),
      },
    });
  };

  return {
    async send(msg, opts) {
      await withTimeout(publish(msg, opts?.delaySeconds), 'queue.send');
    },
    async sendBatch(msgs) {
      for (let i = 0; i < msgs.length; i += BATCH) {
        await withTimeout(Promise.all(msgs.slice(i, i + BATCH).map((m) => publish(m))), 'queue.sendBatch');
      }
    },
    async ping() {
      await withTimeout(topic.getMetadata(), 'queue.ping');
    },
    async close() {
      await topic.flush();
      if (!options.client) await client.close();
    },
  };
}
