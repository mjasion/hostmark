import type { JobMessage } from '@hostmark/contract';
import { MAX_ATTEMPTS } from '@hostmark/contract';
import { describe, expect, it, vi } from 'vitest';
import { CrashSignal, consumeBatch, createCloudflareQueue } from '../src/queue';

const body = { jobId: 'job-1' } as unknown as JobMessage;

function batchOf(attempts: number) {
  const message = { body, attempts, ack: vi.fn(), retry: vi.fn() };
  return { message, batch: { messages: [message] } as unknown as MessageBatch<JobMessage> };
}

describe('consumeBatch', () => {
  it('lets chaos=crash out of the invocation and touches neither ack nor retry (Queues redelivers)', async () => {
    const { message, batch } = batchOf(1);
    const handler = vi.fn(async (_job: JobMessage, ctx: { crash(): Promise<never> }) => ctx.crash());
    await expect(consumeBatch(batch, { handler: handler as never })).rejects.toBeInstanceOf(CrashSignal);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('acks a message that was handled', async () => {
    const { message, batch } = batchOf(1);
    await consumeBatch(batch, { handler: async () => {} });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries a failure with the backoff of its attempt, also on the last attempt', async () => {
    const first = batchOf(1);
    await consumeBatch(first.batch, {
      handler: async () => {
        throw new Error('boom');
      },
    });
    expect(first.message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    const last = batchOf(MAX_ATTEMPTS);
    await consumeBatch(last.batch, {
      handler: async () => {
        throw new Error('boom');
      },
    });
    expect(last.message.retry).toHaveBeenCalledTimes(1);
    expect(last.message.ack).not.toHaveBeenCalled();
  });
});

// The success path runs against Miniflare's queue in the contract ("pings when it can", test/queue.test.ts); these
// are the failures, with a fake binding (D253).
describe('createCloudflareQueue ping', () => {
  const binding = (metrics: () => Promise<unknown>) =>
    ({ send: vi.fn(), sendBatch: vi.fn(), metrics }) as unknown as Parameters<
      typeof createCloudflareQueue
    >[0];

  it('asks the binding for metrics and sends nothing', async () => {
    const b = binding(async () => ({ backlogCount: 3, backlogBytes: 120 }));
    await expect(createCloudflareQueue(b).ping?.()).resolves.toBeUndefined();
    expect(b.send).not.toHaveBeenCalled();
    expect(b.sendBatch).not.toHaveBeenCalled();
  });

  it('rejects when the binding cannot reach the queue', async () => {
    const q = createCloudflareQueue(binding(async () => Promise.reject(new Error('Queue not found'))));
    await expect(q.ping?.()).rejects.toThrow('Queue not found');
  });

  it('rejects an answer without a backlog count', async () => {
    const q = createCloudflareQueue(binding(async () => ({})));
    await expect(q.ping?.()).rejects.toThrow(/backlog count/);
  });
});
