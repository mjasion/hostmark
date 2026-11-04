import { createServer } from 'node:http';
import { createJobHandler } from '@hostmark/core';
import { onTerminate } from '@hostmark/node-runtime/runtime';
import { startConsumer } from './consumer';
import { createRuntime } from './runtime';
import { exitAfterDeadline, SHUTDOWN_DEADLINE_MS, withDeadline } from './shutdown';

// A Cloud Run service must listen on PORT; the worker answers a health check there and nothing else. The service
// runs with instance-based billing and a fixed instance count (manual scaling, D293), so the CPU stays allocated
// between messages.
const runtime = createRuntime('worker');
const { env } = runtime;

const health = createServer((req, res) => {
  if (req.url === '/healthz') {
    runtime.queue.ping().then(
      () => res.writeHead(200).end('ok'),
      () => res.writeHead(503).end('queue unreachable'),
    );
    return;
  }
  res.writeHead(404).end();
});
health.listen(env.PORT, env.HOST);

const consumer = startConsumer({
  project: env.GCP_PROJECT,
  subscription: env.PUBSUB_SUBSCRIPTION,
  handler: createJobHandler(runtime.deps),
  logger: runtime.telemetry.logger,
  concurrency: env.WORKER_CONCURRENCY,
  backoffScale: env.QUEUE_BACKOFF_SCALE,
  maxHoldSeconds: env.LEASE_MAX_SECONDS,
});
runtime.telemetry.logger.info('worker started', {
  concurrency: env.WORKER_CONCURRENCY,
  subscription: env.PUBSUB_SUBSCRIPTION,
});

// Cloud Run kills the instance 10 s after SIGTERM. The consumer waits briefly for a running job, hands back what is
// still held so that another instance gets it at once, and the process exits before the kill.
onTerminate(
  withDeadline(
    async () => {
      await consumer.close();
      health.close();
      await runtime.shutdown();
    },
    SHUTDOWN_DEADLINE_MS,
    exitAfterDeadline,
  ),
);
