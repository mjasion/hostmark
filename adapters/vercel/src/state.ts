import { dangerouslyDeleteByTag } from '@vercel/functions';
import { send, sendBatch } from '@vercel/queue';
import { ConfigError } from './env';
import { getImageProcessor } from './images';
import { createVercelPurger } from './purge';
import { createRuntime, type Runtime } from './runtime';

let runtime: Runtime | undefined;
let configError: ConfigError | undefined;

/** Built on the first request of an instance; a configuration error is remembered, not retried. */
export function getRuntime(): Runtime {
  if (configError) throw configError;
  try {
    runtime ??= createRuntime(process.env, {
      images: getImageProcessor(),
      queueSdk: { send, sendBatch } as never,
      purger: createVercelPurger((tags) => dangerouslyDeleteByTag(tags)),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      configError = err;
      console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: err.message }));
    }
    throw err;
  }
  return runtime;
}
