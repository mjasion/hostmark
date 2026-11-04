import type { StreamifyHandler } from 'aws-lambda';

/**
 * Runs a response streaming handler, then `flush`, before the invocation returns. Hono's `streamHandle` ends the
 * response stream in its own `finally`, so the client already has the whole response when the flush starts: the flush
 * costs function time, not response time. Lambda freezes the environment when the handler's promise settles and the
 * batch timers of the SDK do not run while it is frozen, so the flush has to be awaited here.
 */
export function flushAfterStream<TEvent>(
  inner: StreamifyHandler<TEvent, void>,
  flush: () => Promise<void>,
): StreamifyHandler<TEvent, void> {
  return async (event, responseStream, context) => {
    try {
      await inner(event, responseStream, context);
    } finally {
      await flush();
    }
  };
}
