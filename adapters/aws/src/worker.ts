import { createJobHandler } from '@hostmark/core';
import type { SQSEvent } from 'aws-lambda';
import { getImageProcessor } from './images';
import { handleSqsEvent } from './queue';
import { createRuntime, type Runtime } from './runtime';

let runtime: Runtime | undefined;

export async function handler(event: SQSEvent) {
  runtime ??= createRuntime(process.env, { service: 'worker', images: getImageProcessor() });
  const rt = runtime;
  return handleSqsEvent(event, {
    handler: createJobHandler(rt.deps),
    sqs: rt.sqs,
    queueUrl: rt.queueUrl,
    backoffScale: rt.vars.QUEUE_BACKOFF_SCALE,
    log: (msg, fields) => rt.deps.telemetry.logger.warn(msg, fields),
  });
}
