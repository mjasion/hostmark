import { createApp, withSecurityHeaders } from '@hostmark/core';
import { Hono } from 'hono';
import { ConfigError } from './env';
import { tagOf } from './purge';
import type { Runtime } from './runtime';

const problem = (status: number, title: string) =>
  new Response(JSON.stringify({ type: 'about:blank', title, status }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });

/** `/media` is immutable for a year (D6): the CDN keeps it as long, the purge (D100) ends it. */
const MEDIA_CDN = 'public, max-age=31536000, immutable';

/**
 * What Vercel's CDN may keep of a `200` from core, or nothing. Core marks a shared cache answer in its own
 * `Cache-Control`: `/media` with `public, ..., immutable`, the `/f` page with `s-maxage=60, stale-while-revalidate=600`
 * and no `public` (D21, D82). The CDN keeps each as core asks; the browser keeps seeing core's header.
 */
export function cdnCacheControl(path: string, cacheControl: string | null): string | undefined {
  const cc = cacheControl ?? '';
  if (/\b(?:private|no-store|no-cache)\b/.test(cc)) return undefined;
  if (path.startsWith('/media/')) return /\bpublic\b/.test(cc) ? MEDIA_CDN : undefined;
  const sMaxAge = /\bs-maxage=(\d+)/.exec(cc)?.[1];
  if (!sMaxAge) return undefined;
  const swr = /\bstale-while-revalidate=(\d+)/.exec(cc)?.[1];
  return `max-age=${sMaxAge}${swr ? `, stale-while-revalidate=${swr}` : ''}`;
}

/**
 * The core app plus what Vercel's CDN needs to cache and purge `/media` and `/f` (D100, D199):
 * - `Vercel-CDN-Cache-Control`, which only Vercel's CDN reads, from `cdnCacheControl`.
 * - `Vercel-Cache-Tag: file-<id>`, which `dangerouslyDeleteByTag` addresses. Every answer the CDN may keep carries
 *   it: an untagged `/f` page would stay public until its own TTL ran out, purge or not.
 * Only a 200 is marked, so private files and errors are never cached at the edge.
 */
export function createApiApp(getRuntime: () => Pick<Runtime, 'deps'>): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    try {
      getRuntime();
    } catch (err) {
      // D310: no configuration, so HSTS follows the request's scheme.
      if (err instanceof ConfigError)
        return withSecurityHeaders(problem(500, 'Internal Server Error'), c.req.raw);
      throw err;
    }
    await next();
    const path = new URL(c.req.url).pathname;
    const tag = tagOf(path);
    const cdn =
      tag && c.res.status === 200 ? cdnCacheControl(path, c.res.headers.get('cache-control')) : undefined;
    if (tag && cdn) {
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set('vercel-cdn-cache-control', cdn);
      c.res.headers.set('vercel-cache-tag', tag);
    }
  });
  app.route(
    '/',
    createApp(() => getRuntime().deps),
  );
  return app;
}
