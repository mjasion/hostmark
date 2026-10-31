import { HEADER_TRACE_ID, PROBLEM_CONTENT_TYPE, type Problem } from '@hostmark/contract';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { HttpEnv } from './context';

export const randomTraceId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

export function problemResponse(
  c: Context<HttpEnv>,
  status: number,
  title: string,
  detail?: string,
  errors?: Problem['errors'],
): Response {
  // Absent only when failing before the observe middleware ran.
  const traceId = c.get('traceId') ?? randomTraceId();
  const body: Problem = {
    type: 'about:blank',
    title,
    status,
    ...(detail ? { detail } : {}),
    traceId,
    ...(errors?.length ? { errors } : {}),
  };
  return new Response(JSON.stringify(body), {
    status: status as ContentfulStatusCode,
    headers: {
      'content-type': PROBLEM_CONTENT_TYPE,
      [HEADER_TRACE_ID]: traceId,
      // RFC 9110 requires a challenge on every 401.
      ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    },
  });
}
