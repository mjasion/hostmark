// Pure helper, kept apart from headers.js (which imports k6) so node --test can load it.

/**
 * hit, miss, dynamic, stale, bypass or none, from whichever cache header the response carries. `miss` and
 * `dynamic` are positive statements of the cache; `none` means no header was present.
 */
export function cacheState(found) {
  const values = Object.values(found);
  if (values.length === 0) return 'none';
  const text = values.join(' ').toLowerCase();
  if (/\bmiss|expired|revalidated|updating|prerender/.test(text)) return 'miss';
  if (/dynamic/.test(text)) return 'dynamic';
  if (/stale/.test(text)) return 'stale';
  if (/hit/.test(text)) return 'hit';
  return 'bypass';
}
