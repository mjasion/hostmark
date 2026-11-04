import type { CachePurger } from '@hostmark/core/ports';
import type { PurgeApi } from '@vercel/functions';

const FILE_PATH = /^\/(?:media|f)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** One cache tag per file: the response of `/media/:id/*` and `/f/:id` carries it (`Vercel-Cache-Tag`). */
export const cacheTag = (fileId: string) => `file-${fileId.toLowerCase()}`;

export const tagOf = (path: string): string | undefined => {
  const id = FILE_PATH.exec(path)?.[1];
  return id ? cacheTag(id) : undefined;
};

type DeleteByTag = (tag: string[]) => Promise<void>;

/**
 * The request context the Vercel runtime installs for an invocation, read the way `getContext()` of
 * `@vercel/functions` 3.10.5 reads it (that function is not exported). `test/units.test.ts` checks that both agree.
 */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

export function contextPurgeApi(): PurgeApi | undefined {
  const holder = (globalThis as Record<symbol, { get?: () => { purge?: PurgeApi } | undefined } | undefined>)[
    REQUEST_CONTEXT
  ];
  return holder?.get?.()?.purge;
}

export class PurgeUnavailableError extends Error {
  constructor() {
    super('no Vercel request context with a purge API: the cache was not purged');
  }
}

/**
 * `dangerouslyDeleteByTag` of `@vercel/functions` resolves without doing anything when the invocation has no request
 * context. A purge that did not happen must fail instead (D100): `PATCH` answers 503 and `delete_file` is retried.
 */
export const deleteByTagInContext: DeleteByTag = async (tags) => {
  const api = contextPurgeApi();
  if (!api) throw new PurgeUnavailableError();
  await api.dangerouslyDeleteByTag(tags);
};

/**
 * D100 on Vercel: `dangerouslyDeleteByTag` with the default deadline of 0, which deletes the entries at once.
 * `invalidateByTag` is not used: it marks entries stale and serves the stale copy once while it revalidates, which for
 * an unpublished file is one more public response. The SDK documents the delete as "dangerous" because the next
 * request pays a cache miss; for a file that must disappear that is the intended effect.
 */
export function createVercelPurger(deleteByTag: DeleteByTag = deleteByTagInContext): CachePurger {
  return {
    async purge(paths) {
      const tags = [...new Set(paths.map(tagOf).filter((t): t is string => t !== undefined))];
      if (tags.length) await deleteByTag(tags);
    },
  };
}
