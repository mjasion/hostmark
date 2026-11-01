import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from '@hostmark/core';
import { loadEnv } from './env';
import { createRuntime, onTerminate } from './runtime';
import { createStaticHandler } from './static';

const env = loadEnv();
const runtime = createRuntime('api', env);
const app = createApp(() => runtime.deps);
// D88: the web build is served from this process; a static miss falls through to the app and its 404 handling.
const files = createStaticHandler({ root: env.WEB_DIST });
const fetch: typeof app.fetch = async (req, ...rest) => (await files(req)) ?? app.fetch(req, ...rest);

// Plain HTTP/1.1, so the server is a node:http Server although the type is a union.
const server = serve({ fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  runtime.telemetry.logger.info('api listening', { port: info.port });
}) as Server;

onTerminate(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Keep-alive connections would hold close() open.
    server.closeIdleConnections();
  });
  await runtime.shutdown();
});
