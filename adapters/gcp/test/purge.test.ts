import { publicPaths } from '@hostmark/core';
import { describe, expect, it } from 'vitest';
import { createCloudCdnPurger, metadataTokenProvider } from '../src/purge';

function recorder(statuses: number[] = []) {
  const calls: { url: string; headers: Headers; body: { path: string; host?: string } }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const status = statuses[calls.length - 1] ?? 200;
    return new Response(status === 200 ? '{}' : 'denied', { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('Cloud CDN purger (D100)', () => {
  it('invalidates every public path of a file on the URL map, one call per path', async () => {
    const { calls, fetchFn } = recorder();
    const purger = createCloudCdnPurger({
      project: 'p1',
      urlMap: 'hostmark',
      host: 'bench.example.test',
      getToken: async () => 'token-1',
      fetch: fetchFn,
    });
    const paths = publicPaths('0d0e0c6e-1111-4222-8333-444455556666');
    await purger.purge(paths);
    expect(calls.map((c) => c.body.path)).toEqual(paths);
    expect(calls[0]?.url).toBe(
      'https://compute.googleapis.com/compute/v1/projects/p1/global/urlMaps/hostmark/invalidateCache',
    );
    expect(calls[0]?.body.host).toBe('bench.example.test');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer token-1');
  });

  it('does nothing for no paths, and asks for no token', async () => {
    const { calls, fetchFn } = recorder();
    const purger = createCloudCdnPurger({
      project: 'p1',
      urlMap: 'm',
      getToken: async () => {
        throw new Error('token requested');
      },
      fetch: fetchFn,
    });
    await purger.purge([]);
    expect(calls).toHaveLength(0);
  });

  it('rejects when the API refuses a path, after trying all of them, so the caller can retry', async () => {
    const { calls, fetchFn } = recorder([200, 403]);
    const purger = createCloudCdnPurger({
      project: 'p1',
      urlMap: 'm',
      getToken: async () => 't',
      fetch: fetchFn,
    });
    await expect(purger.purge(['/media/a/128.webp', '/media/a/256.webp', '/f/a'])).rejects.toThrow(
      /\/media\/a\/256\.webp: 403/,
    );
    expect(calls).toHaveLength(3);
  });

  it('reads and caches the token of the metadata server', async () => {
    let n = 0;
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      n++;
      expect(new Headers(init?.headers).get('Metadata-Flavor')).toBe('Google');
      return Response.json({ access_token: 'abc', expires_in: 3600 });
    }) as typeof fetch;
    const token = metadataTokenProvider(fetchFn);
    expect(await token()).toBe('abc');
    expect(await token()).toBe('abc');
    expect(n).toBe(1);
  });
});
