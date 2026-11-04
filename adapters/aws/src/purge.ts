import { type CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import type { CachePurger } from '@hostmark/core/ports';

/** A request invalidates at most 3000 paths. */
export const INVALIDATION_PATH_LIMIT = 3000;

type Sender = Pick<CloudFrontClient, 'send'>;

/**
 * The exact paths to invalidate, deduplicated. CloudFront allows 3000 individual paths in progress per distribution
 * but only 15 wildcard paths, so one wildcard per file made a burst of 15 unpublishes or deletes within the
 * propagation time fail with `TooManyInvalidationsInProgress`. Core hands over every path that `/media` and `/f`
 * cache (`publicPaths`: the three `/media/<id>/<size>.webp` and `/f/<id>`; other spellings are 404 with `no-store`, and
 * the cache key has no query string), so no wildcard is needed. A path with a `*` is refused rather than sent.
 */
export function invalidationPaths(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  const wildcard = unique.find((p) => p.includes('*'));
  if (wildcard) throw new Error(`refusing the wildcard invalidation path ${wildcard}: exact paths only`);
  return unique;
}

/**
 * D100 on CloudFront: `CreateInvalidation` for the paths of a file. It resolves once CloudFront accepted the request,
 * which is when the invalidation starts (status `InProgress`); it finishes on the edge locations within minutes, not
 * within the request. Any error, `TooManyInvalidationsInProgress` included, is thrown: `PATCH` answers 503 and the
 * `delete_file` job retries with the D17 backoff. A path with characters outside the URL-safe set would need encoding;
 * file ids are UUIDs.
 */
export function createCloudFrontPurger(
  client: Sender,
  distributionId: string,
  reference: () => string = () => crypto.randomUUID(),
): CachePurger {
  return {
    async purge(paths) {
      const items = invalidationPaths(paths);
      for (let i = 0; i < items.length; i += INVALIDATION_PATH_LIMIT) {
        const chunk = items.slice(i, i + INVALIDATION_PATH_LIMIT);
        await client.send(
          new CreateInvalidationCommand({
            DistributionId: distributionId,
            InvalidationBatch: {
              CallerReference: reference(),
              Paths: { Quantity: chunk.length, Items: chunk },
            },
          }),
        );
      }
    },
  };
}
