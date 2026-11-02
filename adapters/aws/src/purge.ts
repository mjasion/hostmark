import { type CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import type { CachePurger } from '@hostmark/core/ports';

/** A request invalidates at most 3000 paths. */
export const INVALIDATION_PATH_LIMIT = 3000;

type Sender = Pick<CloudFrontClient, 'send'>;

/**
 * Invalidations are billed per path (the first 1000 a month are free), and a wildcard counts as one path however many
 * objects it covers. The three sizes of one file share a directory, so they become one `/media/<id>/*`.
 */
export function compactPaths(paths: string[]): string[] {
  const byDir = new Map<string, string[]>();
  for (const path of new Set(paths)) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
  }
  return [...byDir.entries()].flatMap(([dir, group]) =>
    group.length > 1 && dir.startsWith('/media/') ? [`${dir}/*`] : group,
  );
}

/**
 * D100 on CloudFront: `CreateInvalidation` for the paths of a file. It resolves once CloudFront accepted the request,
 * which is when the invalidation starts (status `InProgress`); it finishes on the edge locations within minutes, not
 * within the request. A paths with characters outside the URL-safe set would need encoding; file ids are UUIDs.
 */
export function createCloudFrontPurger(
  client: Sender,
  distributionId: string,
  reference: () => string = () => crypto.randomUUID(),
): CachePurger {
  return {
    async purge(paths) {
      const items = compactPaths(paths);
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
