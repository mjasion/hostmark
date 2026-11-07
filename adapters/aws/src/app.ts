import { createApp, withSecurityHeaders } from '@hostmark/core';
import { Hono } from 'hono';
import { ConfigError, ORIGIN_SECRET_HEADER } from './env';
import type { Runtime } from './runtime';

const problem = (status: number, title: string) =>
  new Response(JSON.stringify({ type: 'about:blank', title, status }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });

/** Constant time comparison of two strings of any length. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * The core app behind the origin secret check. The function URL is public (AuthType NONE, template.yaml). CloudFront
 * adds `x-hostmark-origin-secret` to every origin request, so a request without it did not come through the
 * distribution and its client address header (`x-hostmark-client-ip`) cannot be trusted (D80). When `ORIGIN_SECRET`
 * is unset (ENVIRONMENT=local, tests) nothing is checked.
 */
export function createApiApp(getRuntime: () => Pick<Runtime, 'deps' | 'vars'>): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    let expected: string | undefined;
    try {
      expected = getRuntime().vars.ORIGIN_SECRET;
    } catch (err) {
      // D310: these answers are built before core, so they get its security headers here; HSTS follows the scheme.
      if (err instanceof ConfigError)
        return withSecurityHeaders(problem(500, 'Internal Server Error'), c.req.raw);
      throw err;
    }
    if (expected && !sameSecret(c.req.header(ORIGIN_SECRET_HEADER) ?? '', expected))
      return withSecurityHeaders(problem(403, 'Forbidden'), c.req.raw);
    await next();
  });
  app.route(
    '/',
    createApp(() => getRuntime().deps),
  );
  return app;
}
