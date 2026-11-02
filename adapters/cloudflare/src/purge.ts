import type { CachePurger } from '@hostmark/core/ports';
import { ConfigError } from './env';

/** The result of `cache.purge()` of Workers Caching. It crosses an RPC boundary, so it is plain data. */
export interface PurgeResult {
  success: boolean;
  errors: { code: number; message: string }[];
}

/**
 * The `purge` method of the `Media` entrypoint of the api Worker (src/api.ts). Workers Caching scopes a purge to the
 * entrypoint that calls it: the Worker that fills the cache is the only one that can empty it, so the consumer and the
 * scheduler reach it through a service binding (D100).
 */
export interface PurgeTarget {
  purge(paths: string[]): Promise<PurgeResult>;
}

/**
 * D100 on Cloudflare: `/media` and `/f` are held by Workers Caching, and only the owning entrypoint empties it.
 * A missing `MEDIA` service binding (or one without the `purge` method) stops the start with `ConfigError`: without a
 * purge, unpublish and delete would leave public copies behind for a year. `scripts/check-config.ts` checks the same
 * wiring before a deploy.
 */
export function createWorkersCachePurger(target: PurgeTarget | undefined): CachePurger {
  if (typeof target?.purge !== 'function')
    throw new ConfigError(
      'The MEDIA service binding has no purge method, so nothing could empty the CDN cache (D100)',
    );
  return {
    async purge(paths) {
      if (paths.length === 0) return;
      const result = await target.purge(paths);
      if (!result.success) {
        const why = result.errors.map((e) => `${e.code} ${e.message}`).join('; ') || 'no reason given';
        throw new Error(`Cache purge was refused: ${why}`);
      }
    },
  };
}

/** The part of `CacheContext` (workers-types) that a purge needs. */
export interface CacheLike {
  purge?(options: { pathPrefixes: string[] }): Promise<PurgeResult>;
}

/**
 * Purges by path prefix. Rejects when the runtime has no Workers Caching: workerd as Miniflare runs it has none
 * (`ctx.cache` is undefined and `cache` from `cloudflare:workers` has no `purge`), and a purge that silently did
 * nothing would leave public copies behind (D100).
 */
export async function purgeCache(cache: CacheLike | undefined, paths: string[]): Promise<PurgeResult> {
  if (typeof cache?.purge !== 'function')
    throw new Error('Workers Caching is not available in this runtime, so nothing was purged');
  return cache.purge({ pathPrefixes: paths });
}
