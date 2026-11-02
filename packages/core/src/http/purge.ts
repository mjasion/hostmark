import { VARIANT_SIZES } from '@hostmark/contract';

/** D100: every cacheable public URL path of a file, which is what unpublishing or deleting it must purge. */
export function publicPaths(fileId: string): string[] {
  return [...VARIANT_SIZES.map((size) => `/media/${fileId}/${size}.webp`), `/f/${fileId}`];
}
