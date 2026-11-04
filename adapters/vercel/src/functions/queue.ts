// Entry of the queue consumer function, bundled to dist/queue.mjs and exported by api/queue.js.
import { createJobHandler } from '@hostmark/core';
import { handleCallback, send } from '@vercel/queue';
import { createMessageProcessor, deadLetterTopic, retryAfter } from '../queue';
import { getRuntime } from '../state';

export const POST = handleCallback(
  async (payload, metadata) => {
    const { deps, vars } = getRuntime();
    await createMessageProcessor({
      handler: createJobHandler(deps),
      // One copy per message even when the send is retried after a lost answer.
      deadLetter: async (body, _reason, messageId) =>
        void (await send(deadLetterTopic(vars.QUEUE_TOPIC), body, { idempotencyKey: `dlq-${messageId}` })),
      log: (msg, fields) => deps.telemetry.logger.warn(msg, fields),
    })(payload, metadata);
  },
  { retry: retryAfter },
);
