import { createJobHandler } from '@hostmark/core';
import type { SQSEvent } from 'aws-lambda';
import { getImageProcessor } from './images';
import { handleSqsEvent } from './queue';
import { createRuntime, type Runtime, withFlush } from './runtime';

let runtime: Runtime | undefined;

/** The telemetry of the job is flushed before the invocation returns, also when `crash()` throws out of it. */
export async function handler(event: SQSEvent) {
  return withFlush(
    () => runtime,
    async () => {
      runtime ??= createRuntime(process.env, { service: 'worker', images: getImageProcessor() });
      const rt = runtime;
      return handleSqsEvent(event, {
        handler: createJobHandler(rt.deps),
        sqs: rt.sqs,
        queueUrl: rt.queueUrl,
        backoffScale: rt.vars.QUEUE_BACKOFF_SCALE,
        log: (msg, fields) => rt.deps.telemetry.logger.warn(msg, fields),
      });
    },
  );
}
