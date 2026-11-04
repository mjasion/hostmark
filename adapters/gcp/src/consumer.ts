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

/**
 * Cloud Run sends SIGKILL 10 s after SIGTERM to a service instance, and the grace period cannot be configured (container
 * contract). Shutdown therefore has to finish well inside it: wait a little for running handlers, hand back what is
 * still held, close the clients. See `src/shutdown.ts` for the bound of the whole process.
 */
export const DEFAULT_CLOSE_GRACE_MS = 4_000;
/** Bounds the `ModifyAckDeadline(0)` that hands messages back on close, and the wait for the pull loop to stop. */
export const HAND_BACK_TIMEOUT_MS = 1_500;
/**
 * Deadline of one `Pull` while running (gRPC deadline, propagated to the server): an idle consumer waits this long for a
 * message in one call instead of ten. A response lost exactly at the deadline would come back after the ack deadline,
 * as after a lost lease; the longer deadline means ten times fewer deadlines, and the race is not measured on real
 * Pub/Sub.
 */
export const PULL_TIMEOUT_MS = 10_000;
/**
 * Deadline of a `Pull` that starts after `close` began; the pull in flight at that moment is cancelled instead (D220).
 * It bounds how long the loop runs after `close`, so a batch that arrives while closing is handed back on a client that
 * is still open.
 */
export const CLOSING_PULL_TIMEOUT_MS = 1_000;
/** gRPC status of a pull that found nothing before its deadline: an empty batch, not an error. */
const DEADLINE_EXCEEDED = 4;
/** gRPC status set on the pull that `close` cancels. */
const CANCELLED = 1;
/** The longest `close` takes with the default grace: grace, hand-back, the last pull and its hand-back. */
export const CLOSE_MAX_MS =
  DEFAULT_CLOSE_GRACE_MS + HAND_BACK_TIMEOUT_MS + CLOSING_PULL_TIMEOUT_MS + HAND_BACK_TIMEOUT_MS;

/** What the consumer needs of a grpc-js call: a way to cancel it. */
interface CancellableCall {
  cancelWithStatus(code: number, details: string): void;
}

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
  /**
   * `close` waits this long for running handlers, then hands what they hold back to Pub/Sub (ack deadline 0), so it is
   * redelivered at once to another instance instead of after the ack deadline.
   */
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

/** Waits for `work` at most `ms`; the work is not cancelled. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work, new Promise((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

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
  /** Messages handed back on close: their handler may still finish, but must not ack or delay them any more. */
  const handedBack = new Set<string>();

  async function client(): Promise<v1.SubscriberClient> {
    subscriber ??= new v1.SubscriberClient(
      (await pubsub.getClientConfig()) as ConstructorParameters<typeof v1.SubscriberClient>[0],
    );
    return subscriber;
  }

  async function setDeadline(ackIds: string[], seconds: number, timeoutMs?: number) {
    if (ackIds.length === 0) return;
    await (await client()).modifyAckDeadline(
      { subscription: subscriptionPath, ackIds, ackDeadlineSeconds: seconds },
      timeoutMs ? { timeout: timeoutMs, retry: null } : undefined,
    );
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
        if (handedBack.has(ackId)) return;
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
      // Handed back on close: Pub/Sub already redelivers it, and the client is closing.
      if (handedBack.has(ackId)) return;
      await (await client()).acknowledge({ subscription: subscriptionPath, ackIds: [ackId] });
    } catch (err) {
      // Unparseable message or a failed call to Pub/Sub: the deadline expires and the message comes back.
      held.delete(ackId);
      if (handedBack.has(ackId)) return;
      logger.error('message handling failed', { ackId, error: err });
    }
  }

  const renewer = setInterval(() => {
    const now = Date.now();
    for (const [id, h] of held) if (now - h.since > maxHold) held.delete(id);
    setDeadline([...held.keys()], lease).catch((error) => logger.warn('lease renewal failed', { error }));
  }, renewEvery);

  /**
   * The pull in flight, so that `close` can cancel it rather than wait up to `PULL_TIMEOUT_MS`. The generated client
   * returns a plain promise, so the call is caught by a grpc-js call interceptor; google-gax passes
   * `otherArgs.options` to grpc-js as the call options.
   */
  let inFlight: CancellableCall | undefined;
  const trackPull = (options: unknown, nextCall: (options: unknown) => CancellableCall) => {
    inFlight = nextCall(options);
    return inFlight;
  };

  const loop = (async () => {
    while (!closed) {
      const free = opts.concurrency - running.size;
      if (free <= 0) {
        await Promise.race([...running, sleep(500)]);
        continue;
      }
      try {
        const sub = await client();
        let res: v1.protos.google.pubsub.v1.IPullResponse;
        try {
          [res] = await sub.pull(
            { subscription: subscriptionPath, maxMessages: free },
            {
              timeout: closed ? CLOSING_PULL_TIMEOUT_MS : PULL_TIMEOUT_MS,
              retry: null,
              otherArgs: { options: { interceptors: [trackPull] } },
            },
          );
        } finally {
          inFlight = undefined;
        }
        const batch = res.receivedMessages ?? [];
        if (closed) {
          // Pulled while shutting down: give it straight back rather than start a job that SIGKILL would cut off.
          await handBack(batch.map((r) => r.ackId as string)).catch(() => {});
          break;
        }
        for (const received of batch) {
          const task = handle(received).finally(() => running.delete(task));
          running.add(task);
        }
        if (batch.length === 0) await sleep(idleMs);
      } catch (error) {
        if (closed) break;
        if ((error as { code?: number }).code === DEADLINE_EXCEEDED) continue;
        logger.error('queue pull failed', { subscription: subscriptionPath, error });
        await sleep(1000);
      }
    }
  })();

  /** Ack deadline 0: Pub/Sub redelivers now. The redelivery counts as an attempt, as a lost lease would. */
  async function handBack(ackIds: string[]) {
    if (ackIds.length === 0) return;
    for (const id of ackIds) handedBack.add(id);
    await setDeadline(ackIds, 0, HAND_BACK_TIMEOUT_MS);
    logger.warn('messages handed back on shutdown', { count: ackIds.length });
  }

  return {
    async close() {
      closed = true;
      // A pull cancelled before it answered should get nothing leased; a batch already on its way back is lost to the
      // ack deadline, the same race as at a deadline (the cancel is tested on the emulator only).
      inFlight?.cancelWithStatus(CANCELLED, 'consumer closing');
      // Leases are still renewed during the grace period, so a running job keeps its message until it ends or is handed back.
      const graceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
      await settleWithin(Promise.allSettled([...running]), graceMs);
      clearInterval(renewer);
      const unfinished = [...held.keys()];
      held.clear();
      await handBack(unfinished).catch((error) =>
        // The lease is no longer renewed, so the message still comes back, after the ack deadline at the latest.
        logger.error('handing messages back failed', { count: unfinished.length, error }),
      );
      // A pull that started after `close` ends by its short deadline; a batch it returns is handed back before the
      // client closes.
      await settleWithin(
        loop.catch(() => {}),
        CLOSING_PULL_TIMEOUT_MS + HAND_BACK_TIMEOUT_MS,
      );
      await subscriber?.close();
      if (!opts.client) await pubsub.close();
    },
  };
}

export { DLQ_NAME };
