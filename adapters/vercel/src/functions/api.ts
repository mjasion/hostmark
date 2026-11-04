// Entry of the api function (Hono `export default app`), bundled to dist/index.mjs and exported by api/index.js.
import { createApiApp } from '../app';
import { getRuntime } from '../state';

export default createApiApp(getRuntime);
