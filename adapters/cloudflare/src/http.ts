import { HEADER_TRACE_ID } from '@hostmark/contract';
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

const randomTraceId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * D9 on a cached path (D257). Workers Caching stores the whole response of the Media entrypoint, `x-trace-id`
 * included, and serves it again without running the Worker, so every hit would repeat the trace id of the request
 * that filled the entry. The gateway runs on every request (its own cache is off) and gives each response that may
 * have come from the cache a trace id of its own. A `no-store` response was produced for this request and is never
 * stored, so it keeps the id its problem body names.
 */
export function withOwnTraceId(response: Response): Response {
  if (/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) return response;
  const own = new Response(response.body, response);
  own.headers.set(HEADER_TRACE_ID, randomTraceId());
  return own;
}
