import { cache, WorkerEntrypoint } from 'cloudflare:workers';
import { createApp } from '@hostmark/core';
import type { Bindings } from './env';
import { closeAfter, startupFailure } from './http';
import { getImageProcessor } from './images';
import { LICENSES_PATH, licensesResponse } from './licenses';
import { createWorkersCachePurger, type PurgeResult, type PurgeTarget, purgeCache } from './purge';
import { createScope, type Scope } from './runtime';

/** Routes of the single page app: they all serve the same shell (see apps/web, D88). */
const isShellRoute = (path: string) => {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return p === '/login' || p === '/signup' || p === '/app' || p.startsWith('/app/');
};

/** Paths a CDN may hold for a year (D6, D82). Only these go through the cached entrypoint. */
const isCacheable = (method: string, path: string) =>
  (method === 'GET' || method === 'HEAD') && (path.startsWith('/media/') || path.startsWith('/f/'));

interface RequestEnv extends Record<string, unknown> {
  scope: Scope;
}

// The scope is per request (see createScope); the app and its routes are built once per isolate.
const app = createApp((c) => (c.env as RequestEnv).scope.deps);

async function handle(
  request: Request,
  env: Bindings,
  ctx: ExecutionContext,
  purgeTarget: PurgeTarget,
): Promise<Response> {
  let scope: Scope;
  try {
    scope = createScope(env, {
      service: 'api',
      images: getImageProcessor(),
      purger: createWorkersCachePurger(purgeTarget),
    });
  } catch (err) {
    return startupFailure(err);
  }
  try {
    const response = await app.fetch(request, { ...env, scope } satisfies RequestEnv, ctx);
    return closeAfter(response, scope, (p) => ctx.waitUntil(p));
  } catch (err) {
    ctx.waitUntil(scope.close());
    throw err;
  }
}

/**
 * The entrypoint whose responses Workers Caching stores (`exports.Media.cache` in wrangler.api.jsonc). A purge only
 * reaches the entries of the entrypoint that calls it, so `purge` lives here, next to the `fetch` that fills them.
 */
export class Media extends WorkerEntrypoint<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    return handle(request, this.env, this.ctx, this);
  }

  /** Deletes what the cache holds for each path or path prefix. Called by name from the other Workers. */
  async purge(paths: string[]): Promise<PurgeResult> {
    return purgeCache(this.ctx.cache ?? cache, paths);
  }
}

type Exports = { Media: Fetcher & PurgeTarget };

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const { Media: media } = ctx.exports as unknown as Exports;
    const url = new URL(request.url);
    if (url.pathname === LICENSES_PATH && request.method === 'GET') return licensesResponse();
    if (isCacheable(request.method, url.pathname)) return media.fetch(request);
    if (env.ASSETS && (request.method === 'GET' || request.method === 'HEAD') && isShellRoute(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL('/app/', url), request));
    }
    return handle(request, env, ctx, media);
  },
} satisfies ExportedHandler<Bindings>;
