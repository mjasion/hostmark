import type { StreamifyHandler } from 'aws-lambda';
import { streamHandle } from 'hono/aws-lambda';
import { createApiApp } from './app';
import { ConfigError } from './env';
import { getImageProcessor } from './images';
import { createRuntime, type Runtime } from './runtime';
import { flushAfterStream } from './stream';

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

/**
 * Function URL with `InvokeMode: RESPONSE_STREAM`: the SSE endpoint of the upload progress (D20) needs it. Hono's
 * `streamHandle` returns what `awslambda.streamifyResponse` returned for its handler. In the Lambda Node.js runtime
 * that is the same function, only marked for streaming (`UserFunction.js` of aws-lambda-nodejs-runtime-interface-client;
 * not stated in the AWS documentation), so it can be called from our own streaming handler, which flushes the telemetry
 * after the response has ended and before the invocation returns.
 */
const honoHandler = streamHandle(createApiApp(getRuntime)) as unknown as StreamifyHandler<unknown, void>;
export const handler = awslambda.streamifyResponse(
  flushAfterStream(honoHandler, () => runtime?.flush() ?? Promise.resolve()),
);
