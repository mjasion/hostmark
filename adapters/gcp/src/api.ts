import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from '@hostmark/core';
import { onTerminate } from '@hostmark/node-runtime/runtime';
import { createStaticHandler } from '@hostmark/node-runtime/static';
import { createRuntime } from './runtime';

const runtime = createRuntime('api');
const { env } = runtime;
const app = createApp(() => runtime.deps);
// D88: the web build is served from this process; a static miss falls through to the app and its 404 handling.
const files = createStaticHandler({ root: env.WEB_DIST });
const fetch: typeof app.fetch = async (req, ...rest) => (await files(req)) ?? app.fetch(req, ...rest);

const server = serve({ fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  runtime.telemetry.logger.info('api listening', { port: info.port });
}) as Server;

onTerminate(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  await runtime.shutdown();
});
