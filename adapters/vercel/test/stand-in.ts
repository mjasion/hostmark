import { type JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import { createMessageProcessor, deadLetterTopic, type QueueSdk, retryAfter } from '../src/queue';

interface Entry {
  payload: unknown;
  idempotencyKey?: string;
  dueAt: number;
  deliveryCount: number;
  id: string;
  inFlight: boolean;
}

/**
 * A model of Vercel Queues as the documentation describes it, not the service: topics, `delaySeconds`, an idempotency
 * key that drops a repeated publish, `deliveryCount` starting at 1, a consumer that throws (or does not return) is
 * redelivered after `retry(...).afterSeconds`, one that returns is acknowledged. Time is scaled by `delayScale`.
 * A message whose delivery number `maxDeliveries` failed is dropped (the trigger's `maxDeliveries`; what the service
 * does then is not documented, the model assumes it discards the message).
 * It proves the adapter's own logic (idempotent publish, attempt numbers, backoff table, dead letter topic).
 * It cannot prove delivery, ordering or visibility timeout behaviour of the real service.
 */
export class QueueStandIn implements QueueSdk {
  readonly topics = new Map<string, Entry[]>();
  readonly seenKeys = new Set<string>();
  readonly delays: number[] = [];
  readonly dropped: unknown[] = [];

  constructor(
    private readonly delayScale = 0.01,
    private readonly maxDeliveries = Number.POSITIVE_INFINITY,
  ) {}

  private topic(name: string) {
    const existing = this.topics.get(name);
    if (existing) return existing;
    const created: Entry[] = [];
    this.topics.set(name, created);
    return created;
  }

  async send(
    topic: string,
    payload: unknown,
    options: { idempotencyKey?: string; delaySeconds?: number } = {},
  ) {
    const key = options.idempotencyKey && `${topic}/${options.idempotencyKey}`;
    if (key && this.seenKeys.has(key)) return { messageId: key };
    if (key) this.seenKeys.add(key);
    this.topic(topic).push({
      payload,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      dueAt: Date.now() + (options.delaySeconds ?? 0) * 1000,
      deliveryCount: 0,
      id: crypto.randomUUID(),
      inFlight: false,
    });
    return { messageId: key ?? crypto.randomUUID() };
  }

  async sendBatch(
    topic: string,
    messages: { payload: unknown; idempotencyKey?: string; delaySeconds?: number }[],
  ) {
    if (messages.length > 100) throw new Error('batch above 100 messages');
    const results: { status: string }[] = [];
    for (const m of messages) {
      await this.send(topic, m.payload, m);
      results.push({ status: 'success' });
    }
    return results;
  }

  /** Takes the next due message and hands it out; `run` is what the consumer function does with it. */
  async deliver(
    topic: string,
    run: (payload: unknown, deliveryCount: number, messageId: string) => Promise<void>,
  ) {
    const entry = this.topic(topic).find((e) => !e.inFlight && e.dueAt <= Date.now());
    if (!entry) return false;
    entry.inFlight = true;
    entry.deliveryCount += 1;
    const remove = () =>
      this.topics.set(
        topic,
        this.topic(topic).filter((e) => e !== entry),
      );
    try {
      await run(entry.payload, entry.deliveryCount, entry.id);
      remove();
    } catch (error) {
      if (entry.deliveryCount >= this.maxDeliveries) {
        remove();
        this.dropped.push(entry.payload);
        return true;
      }
      const { afterSeconds } = retryAfter(error, { messageId: entry.id, deliveryCount: entry.deliveryCount });
      this.delays.push(afterSeconds);
      entry.dueAt = Date.now() + afterSeconds * 1000 * this.delayScale;
      entry.inFlight = false;
    }
    return true;
  }

  pending(topic: string) {
    return this.topic(topic).map((e) => e.payload as JobMessage);
  }
}

export { createMessageProcessor, deadLetterTopic, MAX_ATTEMPTS };
