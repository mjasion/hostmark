import { send, sendBatch } from '@vercel/queue';
import { withBuildDefaults } from './build-info';
import { ConfigError } from './env';
import { getImageProcessor } from './images';
import { createVercelPurger, deleteByTagInContext } from './purge';
import { createRuntime, type Runtime, type Service } from './runtime';

let runtime: Runtime | undefined;
let configError: ConfigError | undefined;

/**
 * Region and version of the build. `scripts/build.ts` replaces both expressions with literals (esbuild `define`);
 * unbundled they read the environment, which is unset.
 */
const BUILD = {
  region: process.env.HOSTMARK_BUILD_REGION,
  version: process.env.HOSTMARK_BUILD_VERSION,
};

/**
 * Built on the first request of an instance; a configuration error is remembered, not retried. Each function is its
 * own bundle and instance, so one module holds the runtime of one service: `api`, `worker` (the queue consumer) or
 * `scheduler` (the cron route), D274.
 */
export function getRuntime(service: Service): Runtime {
  if (configError) throw configError;
  try {
    runtime ??= createRuntime(withBuildDefaults(process.env, BUILD), {
      service,
      images: getImageProcessor(),
      queueSdk: { send, sendBatch } as never,
      purger: createVercelPurger(deleteByTagInContext),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      configError = err;
      console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: err.message, service }));
    }
    throw err;
  }
  return runtime;
}

/** Flushes the telemetry of the runtime if one was built; never builds one and never fails. */
export const flushTelemetry = (): Promise<void> =>
  runtime ? runtime.flush().catch(() => {}) : Promise.resolve();
