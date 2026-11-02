import { streamHandle } from 'hono/aws-lambda';
import { createApiApp } from './app';
import { ConfigError } from './env';
import { getImageProcessor } from './images';
import { createRuntime, type Runtime } from './runtime';

let runtime: Runtime | undefined;
let configError: ConfigError | undefined;

/** Built on the first request of an execution environment; a configuration error is remembered, not retried. */
function getRuntime(): Runtime {
  if (configError) throw configError;
  try {
    runtime ??= createRuntime(process.env, { service: 'api', images: getImageProcessor() });
  } catch (err) {
    if (err instanceof ConfigError) {
      configError = err;
      console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: err.message }));
    }
    throw err;
  }
  return runtime;
}

/** Function URL with `InvokeMode: RESPONSE_STREAM`: the SSE endpoint of the upload progress (D20) needs it. */
export const handler = streamHandle(createApiApp(getRuntime));
