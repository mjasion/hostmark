// Entry of the queue consumer function, bundled to dist/queue.mjs and exported by api/queue.js.
import { VISIBILITY_TIMEOUT_SECONDS } from '@hostmark/contract';
import { createJobHandler } from '@hostmark/core';
import { waitUntil } from '@vercel/functions';
import { handleCallback, send } from '@vercel/queue';
import { withTelemetryFlush } from '../flush';
import { createMessageProcessor, deadLetterTopic, retryAfter } from '../queue';
import { flushTelemetry, getRuntime } from '../state';
import { leaseApiOf, verifyPushedDeliveries } from '../verify';

const worker = () => getRuntime('worker');

const route = handleCallback(
  async (payload, metadata) => {
    const { deps, vars } = worker();
    await createMessageProcessor({
      handler: createJobHandler(deps),
      // One copy per message even when the send is retried after a lost answer.
      deadLetter: async (body, _reason, messageId) =>
        void (await send(deadLetterTopic(vars.QUEUE_TOPIC), body, { idempotencyKey: `dlq-${messageId}` })),
      log: (msg, fields) => deps.telemetry.logger.warn(msg, fields),
    })(payload, metadata);
  },
  // D17: the lease of a delivery is 60 s, which the SDK renews while the job runs (D275).
  { retry: retryAfter, visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS },
);

let leaseApi: ReturnType<typeof leaseApiOf> | undefined;

// D235: a pushed delivery runs only after the queue service accepted its receipt handle.
export const POST = withTelemetryFlush(
  verifyPushedDeliveries(route, {
    topic: () => worker().vars.QUEUE_TOPIC,
    api: () => {
      leaseApi ??= leaseApiOf();
      return leaseApi;
    },
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    log: (msg, fields) => worker().deps.telemetry.logger.warn(msg, fields),
  }),
  flushTelemetry,
  waitUntil,
);
