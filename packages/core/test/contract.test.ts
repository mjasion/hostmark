import type { JobMessage } from '@hostmark/contract';
import { describe, expect, it } from 'vitest';
import {
  describeObjectStorageContract,
  describeQueueContract,
  type QueueConsumeHarness,
  webpDimensions,
} from './contract';
import { MemoryQueue, serveMemoryStorage } from './helpers/fakes';

// The suites are tested against the in-memory fakes, so a bug in a suite shows up here before it blames an adapter.
describeObjectStorageContract('memory over http', async () => {
  const served = await serveMemoryStorage();
  return {
    storage: served.storage,
    close: served.close,
    capabilities: { rejectsWrongLength: true, rejectsWrongContentType: true, expiresUrls: true },
  };
});

class DelayingQueue extends MemoryQueue {
  private cursor = 0;
  private readonly ready = new Map<JobMessage, number>();
  override async send(msg: JobMessage, opts?: { delaySeconds?: number }): Promise<void> {
    await super.send(msg, opts);
    this.ready.set(msg, Date.now() + (opts?.delaySeconds ?? 0) * 1000);
  }
  override async sendBatch(msgs: JobMessage[]): Promise<void> {
    for (const m of msgs) await this.send(m);
  }
  async take(max: number, waitMs: number): Promise<JobMessage[]> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const due = this.sent.slice(this.cursor).filter((s) => (this.ready.get(s.msg) ?? 0) <= Date.now());
      const first = due.slice(0, max);
      if (first.length > 0 || Date.now() >= deadline) {
        this.cursor += first.length;
        return first.map((s) => s.msg);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

const MAX_ATTEMPTS = 3;

describeQueueContract('memory', async () => {
  const queue = new DelayingQueue();
  const attempts = new Map<string, number>();
  const redeliver: JobMessage[] = [];
  const dead: JobMessage[] = [];
  const consume: QueueConsumeHarness = {
    maxAttempts: MAX_ATTEMPTS,
    async next(waitMs) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const message = redeliver.shift() ?? (await queue.take(1, 20))[0];
        if (message) {
          const attempt = (attempts.get(message.jobId) ?? 0) + 1;
          attempts.set(message.jobId, attempt);
          return {
            message,
            attempt,
            ack: async () => {},
            fail: async () => {
              if (attempt >= MAX_ATTEMPTS) dead.push(message);
              else redeliver.push(message);
            },
          };
        }
        if (Date.now() >= deadline) return null;
      }
    },
    async deadLettered(count, waitMs) {
      const deadline = Date.now() + waitMs;
      while (dead.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      return [...dead];
    },
  };
  return { queue, consume, receive: (max, waitMs) => queue.take(max, waitMs) };
});

describe('webpDimensions', () => {
  it('reads a lossless WebP header', () => {
    const b64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
    expect(webpDimensions(Uint8Array.from(Buffer.from(b64, 'base64')))).toEqual({ width: 1, height: 1 });
  });
  it('rejects other data', () => {
    expect(webpDimensions(new TextEncoder().encode('not a webp file at all, really not one'))).toBeNull();
  });
});
