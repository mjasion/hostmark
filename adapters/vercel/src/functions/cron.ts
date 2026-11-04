// Entry of the cron function, bundled to dist/cron.mjs and exported by api/cron.js.
import { waitUntil } from '@vercel/functions';
import { createCronHandler } from '../cron';
import { withTelemetryFlush } from '../flush';
import { flushTelemetry, getRuntime } from '../state';

export const GET = withTelemetryFlush(
  createCronHandler(() => getRuntime('scheduler')),
  flushTelemetry,
  waitUntil,
);
