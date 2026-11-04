import { cache, WorkerEntrypoint } from 'cloudflare:workers';
import { createApp, htmlSecurityHeaders, isHttps, withSecurityHeaders } from '@hostmark/core';
import { type Bindings, varsSchema } from './env';
import { closeAfter, startupFailure, withOwnTraceId } from './http';
import { getImageProcessor } from './images';
import { LICENSES_PATH, licensesResponse } from './licenses';
import { createWorkersCachePurger, type PurgeResult, type PurgeTarget, purgeCache } from './purge';
import { createScope, type Scope } from './runtime';
import { r2PresignedOrigin } from './storage';

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

/** The vars the shell's headers need; a full parse would also demand the secrets, which the shell does not use. */
const shellVars = varsSchema.pick({
  PUBLIC_URL: true,
  R2_ACCOUNT_ID: true,
  R2_BUCKET_NAME: true,
  R2_PUBLIC_ENDPOINT: true,
});

/**
 * The panel shell with the HTML headers of D310. The asset server adds the common set from `_headers` (`/*`); the
 * policy is set here because it names the origin of the presigned URLs, which only the Worker's vars know exactly
 * (a preview build has no account id, D241). `_headers` has no rule for `/app/`, so nothing is joined twice (D251).
 */
async function shell(request: Request, env: Bindings, assets: Fetcher): Promise<Response> {
  const vars = shellVars.safeParse(env);
  if (!vars.success)
    return startupFailure(
      new Error(`shell: invalid ${vars.error.issues.map((i) => i.path.join('.')).join(', ')}`),
    );
  const headers = htmlSecurityHeaders({
    https: isHttps(request, vars.data.PUBLIC_URL),
    storageOrigin: r2PresignedOrigin({
      accountId: vars.data.R2_ACCOUNT_ID,
      bucketName: vars.data.R2_BUCKET_NAME,
      publicEndpoint: vars.data.R2_PUBLIC_ENDPOINT,
    }),
  });
  const asset = await assets.fetch(new Request(new URL('/app/', request.url), request));
  const response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const { Media: media } = ctx.exports as unknown as Exports;
    const url = new URL(request.url);
    // D310: answers built here get the common set as well; core's own answers already carry it.
    const secured = (response: Response) =>
      withSecurityHeaders(response, request, typeof env.PUBLIC_URL === 'string' ? env.PUBLIC_URL : undefined);
    if (url.pathname === LICENSES_PATH && request.method === 'GET') return secured(licensesResponse());
    if (isCacheable(request.method, url.pathname)) return withOwnTraceId(await media.fetch(request));
    if (env.ASSETS && (request.method === 'GET' || request.method === 'HEAD') && isShellRoute(url.pathname)) {
      return secured(await shell(request, env, env.ASSETS));
    }
    return secured(await handle(request, env, ctx, media));
  },
} satisfies ExportedHandler<Bindings>;
