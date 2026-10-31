import { createJobHandler } from '@hostmark/core';
import { startConsumer } from './consumer';
import { loadEnv } from './env';
import { createRuntime, onTerminate } from './runtime';

const env = loadEnv();
const runtime = createRuntime('worker', env);

const consumer = startConsumer({
  redisUrl: env.REDIS_URL,
  handler: createJobHandler(runtime.deps),
  logger: runtime.telemetry.logger,
  concurrency: env.WORKER_CONCURRENCY,
  backoffScale: env.QUEUE_BACKOFF_SCALE,
});
runtime.telemetry.logger.info('worker started', {
  concurrency: env.WORKER_CONCURRENCY,
  backoffScale: env.QUEUE_BACKOFF_SCALE,
});

onTerminate(async () => {
  await consumer.close();
  await runtime.shutdown();
});
