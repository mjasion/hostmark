// Entry of the queue consumer function, bundled to dist/queue.mjs and exported by api/queue.js.
import { createJobHandler } from '@hostmark/core';
import { handleCallback, send } from '@vercel/queue';
import { createMessageProcessor, deadLetterTopic, retryAfter } from '../queue';
import { getRuntime } from '../state';
import { leaseApiOf, verifyPushedDeliveries } from '../verify';

const route = handleCallback(
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

let leaseApi: ReturnType<typeof leaseApiOf> | undefined;

// D235: a pushed delivery runs only after the queue service accepted its receipt handle.
export const POST = verifyPushedDeliveries(route, {
  topic: () => getRuntime().vars.QUEUE_TOPIC,
  api: () => {
    leaseApi ??= leaseApiOf();
    return leaseApi;
  },
  log: (msg, fields) => getRuntime().deps.telemetry.logger.warn(msg, fields),
});
