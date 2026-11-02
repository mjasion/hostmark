import type { CachePurger } from '@hostmark/core/ports';

const FILE_PATH = /^\/(?:media|f)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** One cache tag per file: the response of `/media/:id/*` and `/f/:id` carries it (`Vercel-Cache-Tag`). */
export const cacheTag = (fileId: string) => `file-${fileId.toLowerCase()}`;

export const tagOf = (path: string): string | undefined => {
  const id = FILE_PATH.exec(path)?.[1];
  return id ? cacheTag(id) : undefined;
};

type DeleteByTag = (tag: string[]) => Promise<void>;

/**
 * D100 on Vercel: `dangerouslyDeleteByTag` with the default deadline of 0, which deletes the entries at once.
 * `invalidateByTag` is not used: it marks entries stale and serves the stale copy once while it revalidates, which for
 * an unpublished file is one more public response. The SDK documents the delete as "dangerous" because the next
 * request pays a cache miss; for a file that must disappear that is the intended effect.
 */
export function createVercelPurger(deleteByTag: DeleteByTag): CachePurger {
  return {
    async purge(paths) {
      const tags = [...new Set(paths.map(tagOf).filter((t): t is string => t !== undefined))];
      if (tags.length) await deleteByTag(tags);
    },
  };
}
