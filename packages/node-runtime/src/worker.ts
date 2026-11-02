import { createJobHandler } from '@hostmark/core';
import { startConsumer } from './consumer';
import { loadPlatformEnv, type NodePlatform } from './platform';
import { createRuntime, onTerminate } from './runtime';

/** The worker process: one BullMQ consumer, until SIGTERM. */
export function runWorker(platform: NodePlatform): void {
  const env = loadPlatformEnv(platform);
  const runtime = createRuntime('worker', env, platform);

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
}
