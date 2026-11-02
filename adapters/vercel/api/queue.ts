import { createJobHandler } from '@hostmark/core';
import { handleCallback, send } from '@vercel/queue';
import { createMessageProcessor, deadLetterTopic, retryAfter } from '../src/queue';
import { getRuntime } from '../src/state';

export const POST = handleCallback(
  async (payload, metadata) => {
    const { deps, vars } = getRuntime();
    await createMessageProcessor({
      handler: createJobHandler(deps),
      deadLetter: async (body) => void (await send(deadLetterTopic(vars.QUEUE_TOPIC), body)),
      log: (msg, fields) => deps.telemetry.logger.warn(msg, fields),
    })(payload, metadata);
  },
  { retry: retryAfter },
);
