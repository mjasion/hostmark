import type { CachePurger } from '@hostmark/core/ports';

/** Where Cloud Run hands out access tokens of its service account; the only credential the adapter needs (no key file). */
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const COMPUTE = 'https://compute.googleapis.com/compute/v1';
/** Bounds one invalidation call, so a hung call makes the caller answer 503 instead of waiting. */
export const PURGE_TIMEOUT_MS = 10_000;
/** Bounds the token request. The metadata server is local to the instance and answers in milliseconds. */
export const METADATA_TIMEOUT_MS = 3_000;

export interface CdnPurgerOptions {
  project: string;
  /** Name of the URL map of the load balancer that has Cloud CDN enabled on the backend serving `/media` and `/f`. */
  urlMap: string;
  /** Host header to invalidate. Omitted: all hosts of the URL map. */
  host?: string;
  /** Overridable for tests; the default reads the metadata server. */
  getToken?: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Access token of the runtime service account from the metadata server, cached until a minute before it expires.
 * The request has its own timeout: a hung request would otherwise hold the purge, and the request that waits on it, forever.
 */
export function metadataTokenProvider(
  doFetch: typeof fetch = fetch,
  timeoutMs = METADATA_TIMEOUT_MS,
): () => Promise<string> {
  let cached: { token: string; expires: number } | undefined;
  return async () => {
    if (cached && cached.expires > Date.now()) return cached.token;
    const res = await doFetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`metadata server refused the token request: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  };
}

/**
 * The paths to send: several paths in one directory under `/media/` become one prefix (`/media/<id>/*`), which covers
 * every variant of the file and nothing else (the id is a fixed-length UUID followed by `/`). Everything else is exact.
 * Fewer calls per file is what raises the number of files a minute under the API's request rate.
 */
export function invalidationPaths(paths: string[]): string[] {
  const byDir = new Map<string, string[]>();
  const out: string[] = [];
  for (const path of paths) {
    const dir = path.startsWith('/media/') ? path.slice(0, path.lastIndexOf('/') + 1) : undefined;
    if (!dir || dir === '/media/') {
      out.push(path);
      continue;
    }
    const group = byDir.get(dir);
    if (group) group.push(path);
    else byDir.set(dir, [path]);
  }
  for (const [dir, group] of byDir) out.push(...(group.length > 1 ? [`${dir}*`] : group));
  return [...new Set(out)];
}

/**
 * D100 on Cloud CDN: `urlMaps.invalidateCache` takes one path per call (exact, or a prefix ending in `*`), and answers
 * with a global operation once the request is accepted. Acceptance is the contract of `CachePurger.purge`; Google gives
 * no completion time, so the propagation delay stays unmeasured (README). The call needs `compute.urlMaps.invalidateCache`
 * (role `roles/compute.loadBalancerAdmin` or a custom role with only that permission).
 *
 * The calls of one purge run concurrently. `purge` settles after all of them and rejects when any was refused, failed
 * or timed out, so core answers 503 or retries the job (D100).
 */
export function createCloudCdnPurger(options: CdnPurgerOptions): CachePurger {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PURGE_TIMEOUT_MS;
  const getToken = options.getToken ?? metadataTokenProvider(doFetch);
  const url = `${COMPUTE}/projects/${encodeURIComponent(options.project)}/global/urlMaps/${encodeURIComponent(options.urlMap)}/invalidateCache`;

  const invalidate = async (path: string, token: string): Promise<string | undefined> => {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path, ...(options.host ? { host: options.host } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return `${path}: ${res.status} ${(await res.text()).slice(0, 200)}`;
      await res.body?.cancel();
      return undefined;
    } catch (err) {
      return `${path}: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return {
    async purge(paths) {
      if (paths.length === 0) return;
      const token = await getToken();
      const results = await Promise.all(invalidationPaths(paths).map((path) => invalidate(path, token)));
      const failures = results.filter((r): r is string => r !== undefined);
      if (failures.length > 0) throw new Error(`Cloud CDN refused the invalidation: ${failures.join('; ')}`);
    },
  };
}
