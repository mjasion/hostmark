import type { JobMessage } from '@hostmark/contract';
import { consumeBatch } from '../../src/queue';

interface Env {
  /** Node function service binding of the test: parks the delivery until the test acknowledges or fails it. */
  HARNESS: Fetcher;
  BACKOFF_SCALE: string;
}

// The production consumeBatch with a handler that hands every delivery to the test.
export default {
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    await consumeBatch(batch, {
      backoffScale: Number(env.BACKOFF_SCALE),
      handler: async (message, ctx) => {
        const answer = await env.HARNESS.fetch('http://harness/job', {
          method: 'POST',
          body: JSON.stringify({ message, attempt: ctx.attempt }),
        });
        if (!answer.ok) throw new Error(`the test failed the delivery (${answer.status})`);
      },
    });
  },
} satisfies ExportedHandler<Env, JobMessage>;
