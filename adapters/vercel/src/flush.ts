// A Vercel function instance is suspended between invocations, so a batch of spans, metrics or logs waits until the
// next request, or is lost with the instance. Each handler therefore hands a flush to `waitUntil` of
// `@vercel/functions` when it has its response: the response is not delayed, and the platform keeps the invocation
// alive until the export ends (D274).

/** `waitUntil` of `@vercel/functions`: without a request context it does nothing, and the promise still runs. */
export type WaitUntil = (promise: Promise<unknown>) => void;

export function withTelemetryFlush<A extends unknown[]>(
  handler: (...args: A) => Response | Promise<Response>,
  flush: () => Promise<void>,
  waitUntil: WaitUntil,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } finally {
      // A failed export must not fail the request, which already has its answer.
      waitUntil(flush().catch(() => {}));
    }
  };
}
