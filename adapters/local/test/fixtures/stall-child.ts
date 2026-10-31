// Runs a consumer in its own process, so that a test can kill it the way a crash would (see stall.test.ts).
import { startConsumer } from '../../src/consumer';

const log = (message: string, fields?: Record<string, unknown>) => {
  if (message === 'handler') console.log(JSON.stringify({ message, ...fields }));
};
const quiet = () => {};
const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet } as never;
const mode = process.env.MODE;

startConsumer({
  redisUrl: process.env.REDIS_URL as string,
  queueName: process.env.QUEUE as string,
  logger,
  concurrency: 1,
  backoffScale: 0.001,
  lockDurationMs: 1500,
  stalledIntervalMs: 500,
  handler: async (_msg, ctx) => {
    log('handler', { attempt: ctx.attempt });
    // `die`: every start kills the process. `die-twice`: the first two starts do, then the handler fails normally.
    if (mode === 'die' || (mode === 'die-twice' && ctx.attempt <= 2)) await ctx.crash();
    throw new Error('boom');
  },
});
