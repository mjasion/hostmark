// Entry of the api function, bundled to dist/index.mjs and exported by api/index.js. Vercel's Node runtime calls
// `fetch` of the default export for every method, as it does for a Hono app (`@vercel/node` 29.0.1).
import { waitUntil } from '@vercel/functions';
import { createApiApp } from '../app';
import { withTelemetryFlush } from '../flush';
import { flushTelemetry, getRuntime } from '../state';

const app = createApiApp(() => getRuntime('api'));

export default { fetch: withTelemetryFlush(app.fetch, flushTelemetry, waitUntil) };
