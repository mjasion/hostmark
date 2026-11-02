import type { JobMessage } from '@hostmark/contract';

interface Env {
  SINK: Fetcher;
}

// Consumer of the dead letter queue: forwards what arrives to the test, like an operator reading the DLQ.
export default {
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await env.SINK.fetch('http://sink/dead', { method: 'POST', body: JSON.stringify(message.body) });
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;
