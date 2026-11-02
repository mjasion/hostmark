import type { CachePurger } from '@hostmark/core/ports';

/** Where Cloud Run hands out access tokens of its service account; the only credential the adapter needs (no key file). */
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const COMPUTE = 'https://compute.googleapis.com/compute/v1';

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

/** Access token of the runtime service account from the metadata server, cached until a minute before it expires. */
export function metadataTokenProvider(doFetch: typeof fetch = fetch): () => Promise<string> {
  let cached: { token: string; expires: number } | undefined;
  return async () => {
    if (cached && cached.expires > Date.now()) return cached.token;
    const res = await doFetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw new Error(`metadata server refused the token request: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  };
}

/**
 * D100 on Cloud CDN: `urlMaps.invalidateCache` takes one path per call (exact, or a prefix ending in `*`), and answers
 * with a global operation once the request is accepted. Acceptance is the contract of `CachePurger.purge`; Google gives
 * no completion time, so the propagation delay stays unmeasured (README). The call needs `compute.urlMaps.invalidateCache`
 * (role `roles/compute.loadBalancerAdmin` or a custom role with only that permission).
 */
export function createCloudCdnPurger(options: CdnPurgerOptions): CachePurger {
  const doFetch = options.fetch ?? fetch;
  const getToken = options.getToken ?? metadataTokenProvider(doFetch);
  const url = `${COMPUTE}/projects/${encodeURIComponent(options.project)}/global/urlMaps/${encodeURIComponent(options.urlMap)}/invalidateCache`;

  return {
    async purge(paths) {
      if (paths.length === 0) return;
      const token = await getToken();
      const failures: string[] = [];
      for (const path of paths) {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ path, ...(options.host ? { host: options.host } : {}) }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
        if (!res.ok) failures.push(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
        else await res.body?.cancel();
      }
      if (failures.length > 0) throw new Error(`Cloud CDN refused the invalidation: ${failures.join('; ')}`);
    },
  };
}
