import { type JobMessage, MAX_ATTEMPTS } from '@hostmark/contract';
import { describeImageProcessorContract, describeQueueContract } from '@hostmark/core/test/contract';
import { createWasmImageProcessor } from '@hostmark/image';
import { nodeLoader } from '@hostmark/image/node';
import { makeJpeg } from '@hostmark/node-runtime/testing/fixtures';
import { createMessageProcessor, createVercelQueue, deadLetterTopic } from '../src/queue';
import { QueueStandIn } from './stand-in';

const TOPIC = 'image-jobs';

describeImageProcessorContract('vercel: wasm + node loader', async () => ({
  processor: createWasmImageProcessor(nodeLoader),
  fixtures: {
    large: await makeJpeg(2400, 1800),
    small: await makeJpeg(64, 48),
    withMetadata: await makeJpeg(800, 600, 6),
    rotated: { body: await makeJpeg(800, 600, 6), width: 800, height: 600, orientation: 6 },
  },
}));

async function until<T>(waitMs: number, fn: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Runs on the in-memory model of Vercel Queues (test/stand-in.ts): the service has no local stand-in without an account
// (`vercel dev` is documented to run queues locally, not verified here). Delays are scaled to 1 % of D17.
describeQueueContract('vercel: adapter logic on a model of Vercel Queues', async () => {
  const platform = new QueueStandIn(0.01);
  const queue = createVercelQueue(platform, TOPIC);
  return {
    queue,
    async receive(max, waitMs) {
      const got: JobMessage[] = [];
      await until(waitMs, async () => {
        while (
          got.length < max &&
          (await platform.deliver(TOPIC, async (p) => void got.push(p as JobMessage)))
        ) {}
        return got.length ? got : undefined;
      });
      return got;
    },
    consume: {
      maxAttempts: MAX_ATTEMPTS,
      async next(waitMs) {
        const deadline = Date.now() + waitMs;
        do {
          let taken: [unknown, number] | undefined;
          let release: (verdict: 'ack' | 'fail') => void = () => {};
          const verdict = new Promise<'ack' | 'fail'>((resolve) => {
            release = resolve;
          });
          // `deliver` reaches the consumer synchronously when a message is due, so `taken` is set right after the call.
          const running = platform.deliver(TOPIC, async (payload, deliveryCount, messageId) => {
            taken = [payload, deliveryCount];
            const outcome = await verdict;
            // The consumer function runs the real processor; the harness decides what the job handler does.
            await createMessageProcessor({
              handler: async () => {
                if (outcome === 'fail') throw new Error('job failed');
              },
              deadLetter: async (body) => void (await platform.send(deadLetterTopic(TOPIC), body)),
            })(payload, { messageId, deliveryCount });
          });
          if (taken) {
            const [payload, attempt] = taken;
            return {
              message: payload as JobMessage,
              attempt,
              async ack() {
                release('ack');
                await running;
              },
              async fail() {
                release('fail');
                await running;
              },
            };
          }
          await running;
          await new Promise((r) => setTimeout(r, 10));
        } while (Date.now() < deadline);
        return null;
      },
      async deadLettered(count, waitMs) {
        await until(waitMs, async () =>
          platform.pending(deadLetterTopic(TOPIC)).length >= count ? true : undefined,
        );
        return platform.pending(deadLetterTopic(TOPIC));
      },
    },
  };
});
