// Entry of the cron function, bundled to dist/cron.mjs and exported by api/cron.js.
import { createCronHandler } from '../cron';
import { getRuntime } from '../state';

export const GET = createCronHandler(getRuntime);
