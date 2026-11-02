import { createApp } from '@hostmark/core';
import { Hono } from 'hono';
import { ConfigError } from './env';
import { tagOf } from './purge';
import type { Runtime } from './runtime';

const problem = (status: number, title: string) =>
  new Response(JSON.stringify({ type: 'about:blank', title, status }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });

/**
 * The core app plus what Vercel's CDN needs to cache and purge `/media` and `/f` (D100):
 * - `Vercel-CDN-Cache-Control` (a year, D6) because a function response is cached only with a `s-maxage`-style header;
 *   core's own `Cache-Control` stays what the browser sees.
 * - `Vercel-Cache-Tag: file-<id>`, which `dangerouslyDeleteByTag` addresses.
 * Only a 200 with a public `Cache-Control` is marked, so private files and errors are never cached at the edge.
 */
export function createApiApp(getRuntime: () => Pick<Runtime, 'deps'>): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    try {
      getRuntime();
    } catch (err) {
      if (err instanceof ConfigError) return problem(500, 'Internal Server Error');
      throw err;
    }
    await next();
    const tag = tagOf(new URL(c.req.url).pathname);
    if (tag && c.res.status === 200 && /\bpublic\b/.test(c.res.headers.get('cache-control') ?? '')) {
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set('vercel-cdn-cache-control', 'public, max-age=31536000, immutable');
      c.res.headers.set('vercel-cache-tag', tag);
    }
  });
  app.route(
    '/',
    createApp(() => getRuntime().deps),
  );
  return app;
}
