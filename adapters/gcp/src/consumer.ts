import { PubSub, v1 } from '@google-cloud/pubsub';
import {
  BACKOFF_SECONDS,
  DLQ_NAME,
  JobMessage,
  MAX_ATTEMPTS,
  QUEUE_NAME,
  VISIBILITY_TIMEOUT_SECONDS,
} from '@hostmark/contract';
import type { JobHandler } from '@hostmark/core/ports';
import type { Telemetry } from '@hostmark/telemetry';
import { MAX_DELAY_SECONDS, NOT_BEFORE_ATTRIBUTE } from './queue';

export interface ConsumerOptions {
  project: string;
  /** Short name of the subscription; its dead letter policy is part of the topology (infra/ and `topology.ts`). */
  subscription?: string;
  handler: JobHandler;
  logger: Telemetry['logger'];
  concurrency: number;
  /** Multiplies the backoff. Pub/Sub deadlines are whole seconds, so the product is rounded. */
  backoffScale: number;
  /** Ack deadline set on every renewal; the subscription's own is the same value (D17: 60 s). */
  leaseSeconds?: number;
  /** How often leases are renewed. */
  renewEverySeconds?: number;
  /** A handler may keep a message this long; then renewal stops and Pub/Sub hands it to another consumer. */
  maxHoldSeconds?: number;
  /** `close` waits this long for running handlers, then gives up on them; Pub/Sub redelivers what they held. */
  closeGraceMs?: number;
  /** Sleep between pulls that returned nothing. */
  idleMs?: number;
  client?: PubSub;
}

interface Held {
  ackId: string;
  since: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A pull consumer over the unary Pull, Acknowledge and ModifyAckDeadline calls, which keeps the visibility rules of D17
 * in our hands instead of the client library's lease manager:
 * - the ack deadline is the visibility timeout (60 s). A timer renews it while a handler runs, so a long job is not
 *   handed out twice, and a dead process stops renewing, so its messages come back after at most 60 s (D65);
 * - a failed attempt sets the ack deadline to the backoff of D17 and stops renewing. The message is redelivered when it
 *   runs out, which is exactly BACKOFF_SECONDS[attempt - 1];
 * - the last failed attempt is a nack (deadline 0). The subscription's dead letter policy (`maxDeliveryAttempts` =
 *   MAX_ATTEMPTS) then forwards the message to the dead letter topic;
 * - `deliveryAttempt` is the attempt number. Pub/Sub reports it only on a subscription with a dead letter policy.
 */
export function startConsumer(opts: ConsumerOptions): { close(): Promise<void> } {
  const { logger } = opts;
  const lease = opts.leaseSeconds ?? VISIBILITY_TIMEOUT_SECONDS;
  const renewEvery = (opts.renewEverySeconds ?? Math.max(1, Math.floor(lease / 3))) * 1000;
  const maxHold = (opts.maxHoldSeconds ?? 600) * 1000;
  const idleMs = opts.idleMs ?? 100;
  const pubsub = opts.client ?? new PubSub({ projectId: opts.project });
  const subscriptionPath = `projects/${opts.project}/subscriptions/${opts.subscription ?? `${QUEUE_NAME}-worker`}`;

  let closed = false;
  let subscriber: v1.SubscriberClient | undefined;
  const held = new Map<string, Held>();
  const running = new Set<Promise<void>>();

  async function client(): Promise<v1.SubscriberClient> {
    subscriber ??= new v1.SubscriberClient(
      (await pubsub.getClientConfig()) as ConstructorParameters<typeof v1.SubscriberClient>[0],
    );
    return subscriber;
  }

  async function setDeadline(ackIds: string[], seconds: number) {
    if (ackIds.length === 0) return;
    await (await client()).modifyAckDeadline({
      subscription: subscriptionPath,
      ackIds,
      ackDeadlineSeconds: seconds,
    });
  }

  async function handle(
    received: NonNullable<v1.protos.google.pubsub.v1.IPullResponse['receivedMessages']>[number],
  ) {
    const ackId = received.ackId as string;
    const body = received.message;
    const deliveryAttempt = received.deliveryAttempt ?? 1;
    try {
      const notBefore = Number(body?.attributes?.[NOT_BEFORE_ATTRIBUTE] ?? 0);
      const remainingMs = notBefore - Date.now();
      if (remainingMs > 0) {
        // Held back, not handled: wait on the ack deadline. The hold is a delivery that Pub/Sub counts (see `attempt`).
        await setDeadline([ackId], Math.min(MAX_DELAY_SECONDS, Math.ceil(remainingMs / 1000)));
        return;
      }
      held.set(ackId, { ackId, since: Date.now() });
      const text = Buffer.from(body?.data ?? new Uint8Array()).toString('utf8');
      const message = JobMessage.parse(JSON.parse(text));
      // A delayed message was delivered once to be held; that delivery was not an attempt.
      const attempt = Math.max(
        1,
        Number(deliveryAttempt) - (body?.attributes?.[NOT_BEFORE_ATTRIBUTE] ? 1 : 0),
      );
      try {
        await opts.handler(message, {
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          receivedAt: new Date(),
          // Stop everything: nothing renews the lease and Pub/Sub redelivers after the ack deadline.
          crash: async () => process.exit(1),
        });
      } catch (err) {
        held.delete(ackId);
        const final = attempt >= MAX_ATTEMPTS;
        logger.warn(
          final ? 'message failed for good, left to the dead letter policy' : 'message failed, retrying',
          {
            jobId: message.jobId,
            attempt,
            error: err,
          },
        );
        const seconds = final ? 0 : Math.round((BACKOFF_SECONDS[attempt - 1] ?? 0) * opts.backoffScale);
        await setDeadline([ackId], seconds);
        return;
      }
      held.delete(ackId);
      await (await client()).acknowledge({ subscription: subscriptionPath, ackIds: [ackId] });
    } catch (err) {
      // Unparseable message or a failed call to Pub/Sub: the deadline expires and the message comes back.
      held.delete(ackId);
      logger.error('message handling failed', { ackId, error: err });
    }
  }

  const renewer = setInterval(() => {
    const now = Date.now();
    for (const [id, h] of held) if (now - h.since > maxHold) held.delete(id);
    setDeadline([...held.keys()], lease).catch((error) => logger.warn('lease renewal failed', { error }));
  }, renewEvery);

  const loop = (async () => {
    while (!closed) {
      const free = opts.concurrency - running.size;
      if (free <= 0) {
        await Promise.race([...running, sleep(500)]);
        continue;
      }
      try {
        const [res] = await (await client()).pull({ subscription: subscriptionPath, maxMessages: free });
        const batch = res.receivedMessages ?? [];
        for (const received of batch) {
          const task = handle(received).finally(() => running.delete(task));
          running.add(task);
        }
        if (batch.length === 0) await sleep(idleMs);
      } catch (error) {
        if (closed) break;
        logger.error('queue pull failed', { subscription: subscriptionPath, error });
        await sleep(1000);
      }
    }
  })();

  return {
    async close() {
      closed = true;
      clearInterval(renewer);
      // Leases stop being renewed from here on, so what is still running comes back after the ack deadline at the latest.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...running]),
        new Promise((r) => {
          timer = setTimeout(r, opts.closeGraceMs ?? 55_000);
        }),
      ]);
      clearTimeout(timer);
      await subscriber?.close();
      await loop.catch(() => {});
      if (!opts.client) await pubsub.close();
    },
  };
}

export { DLQ_NAME };
