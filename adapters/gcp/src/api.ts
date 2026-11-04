import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from '@hostmark/core';
import { onTerminate, staticSecurity } from '@hostmark/node-runtime/runtime';
import { createStaticHandler } from '@hostmark/node-runtime/static';
import { createRuntime } from './runtime';
import { closeServer, exitAfterDeadline, SHUTDOWN_DEADLINE_MS, withDeadline } from './shutdown';

const runtime = createRuntime('api');
const { env } = runtime;
const app = createApp(() => runtime.deps);
// D88: the web build is served from this process; a static miss falls through to the app and its 404 handling.
const files = createStaticHandler({ root: env.WEB_DIST, security: staticSecurity(env) });
const fetch: typeof app.fetch = async (req, ...rest) => (await files(req)) ?? app.fetch(req, ...rest);

const server = serve({ fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  runtime.telemetry.logger.info('api listening', { port: info.port });
}) as Server;

// Cloud Run kills the instance 10 s after SIGTERM. Requests in flight get a few seconds, then the SSE streams that are
// still open are cut (their clients reconnect elsewhere), telemetry is flushed, and the process exits before the kill.
onTerminate(
  withDeadline(
    async () => {
      await closeServer(server);
      await runtime.shutdown();
    },
    SHUTDOWN_DEADLINE_MS,
    exitAfterDeadline,
  ),
);
