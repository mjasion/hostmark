import type { JobMessage } from '@hostmark/contract';
import { MAX_ATTEMPTS } from '@hostmark/contract';
import { describe, expect, it, vi } from 'vitest';
import { CrashSignal, consumeBatch } from '../src/queue';

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
