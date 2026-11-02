import { createCronHandler } from '../src/cron';
import { getRuntime } from '../src/state';

export const GET = createCronHandler(getRuntime);
