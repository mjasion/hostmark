import type { Scope } from './runtime';

/** Closes the scope once the body has been read to the end or abandoned; a stream (SSE) keeps its database client. */
export function closeAfter(
  response: Response,
  scope: Scope,
  waitUntil: (p: Promise<unknown>) => void,
): Response {
  if (!response.body) {
    waitUntil(scope.close());
    return response;
  }
  const done = () => waitUntil(scope.close());
  const body = response.body.pipeThrough(
    new TransformStream({
      flush: done,
      // `cancel` of the readable side reaches the transformer through the writable side's abort.
    }),
  );
  const reader = body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      const { done: end, value } = await reader.read();
      if (end) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
      done();
    },
  });
  return new Response(stream, response);
}

/** Configuration errors go to the log with their text; the caller of the API gets nothing to learn from. */
export function startupFailure(err: unknown): Response {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'startup failed',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  return new Response(JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500 }), {
    status: 500,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });
}
