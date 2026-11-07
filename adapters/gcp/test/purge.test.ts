import { publicPaths } from '@hostmark/core';
import { describe, expect, it, vi } from 'vitest';
import { platform } from '../src/platform';
import { createCloudCdnPurger, invalidationPaths, metadataTokenProvider } from '../src/purge';

const ID = '0d0e0c6e-1111-4222-8333-444455556666';

function recorder(statusFor: (path: string) => number = () => 200) {
  const calls: { url: string; headers: Headers; body: { path: string; host?: string } }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), headers: new Headers(init?.headers), body });
    const status = statusFor(body.path);
    return new Response(status === 200 ? '{}' : 'denied', { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** A fetch that never answers on its own and rejects when its signal aborts, like a hung connection. */
const hangingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  })) as typeof fetch;

describe('invalidation paths', () => {
  it('turns the variants of a file into one prefix and keeps the share page exact', () => {
    expect(invalidationPaths(publicPaths(ID))).toEqual([`/f/${ID}`, `/media/${ID}/*`]);
  });

  it('keeps a single path exact and never widens to /media/*', () => {
    expect(invalidationPaths([`/media/${ID}/128.webp`])).toEqual([`/media/${ID}/128.webp`]);
    expect(invalidationPaths(['/media/a.webp', '/media/b.webp'])).toEqual(['/media/a.webp', '/media/b.webp']);
  });
});

describe('Cloud CDN purger (D100)', () => {
  it('is built without a host on the deployment, so copies cached under any Host are invalidated (D333)', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('http://metadata.google.internal/'))
        return Response.json({ access_token: 't', expires_in: 3600 });
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ name: 'operation-1' });
    });
    try {
      const env = { GCP_PROJECT: 'p1', CDN_URL_MAP: 'hostmark', PUBLIC_URL: 'https://bench.example.test' };
      const purger = platform.purger?.(env as Parameters<NonNullable<typeof platform.purger>>[0]);
      await purger?.purge(publicPaths(ID));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).not.toHaveProperty('host');
  });

  it('invalidates every public path of a file on the URL map in two calls', async () => {
    const { calls, fetchFn } = recorder();
    const purger = createCloudCdnPurger({
      project: 'p1',
      urlMap: 'hostmark',
      host: 'bench.example.test',
      getToken: async () => 'token-1',
      fetch: fetchFn,
    });
    await purger.purge(publicPaths(ID));
    expect(calls.map((c) => c.body.path).sort()).toEqual([`/f/${ID}`, `/media/${ID}/*`]);
    expect(calls[0]?.url).toBe(
      'https://compute.googleapis.com/compute/v1/projects/p1/global/urlMaps/hostmark/invalidateCache',
    );
    expect(calls.every((c) => c.body.host === 'bench.example.test')).toBe(true);
    expect(calls.every((c) => c.headers.get('authorization') === 'Bearer token-1')).toBe(true);
  });

  it('sends the calls of one purge concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
      return new Response('{}');
    }) as typeof fetch;
    const purger = createCloudCdnPurger({
      project: 'p',
      urlMap: 'm',
      getToken: async () => 't',
      fetch: fetchFn,
    });
    await purger.purge(['/f/a', '/f/b', '/f/c']);
    expect(peak).toBe(3);
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

  it('rejects when the API refuses a path, after all calls settled, so the caller can retry', async () => {
    const { calls, fetchFn } = recorder((path) => (path === '/f/b' ? 403 : 200));
    const purger = createCloudCdnPurger({
      project: 'p1',
      urlMap: 'm',
      getToken: async () => 't',
      fetch: fetchFn,
    });
    await expect(purger.purge(['/f/a', '/f/b', '/f/c'])).rejects.toThrow(/\/f\/b: 403/);
    expect(calls).toHaveLength(3);
  });

  it('rejects when a call hangs past the timeout', async () => {
    const purger = createCloudCdnPurger({
      project: 'p1',
      urlMap: 'm',
      getToken: async () => 't',
      fetch: hangingFetch,
      timeoutMs: 50,
    });
    await expect(purger.purge(['/f/a'])).rejects.toThrow(/\/f\/a: .*(timed out|abort)/i);
  });

  it('rejects when the metadata server does not answer, instead of waiting forever', async () => {
    const purger = createCloudCdnPurger({ project: 'p1', urlMap: 'm', fetch: hangingFetch });
    const started = Date.now();
    const token = metadataTokenProvider(hangingFetch, 50);
    await expect(token()).rejects.toThrow(/timed out|abort/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    // The purger's own provider has the same bound (3 s by default).
    await expect(purger.purge(['/f/a'])).rejects.toThrow(/timed out|abort/i);
  });

  it('reads and caches the token of the metadata server', async () => {
    let n = 0;
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      n++;
      expect(new Headers(init?.headers).get('Metadata-Flavor')).toBe('Google');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ access_token: 'abc', expires_in: 3600 });
    }) as typeof fetch;
    const token = metadataTokenProvider(fetchFn);
    expect(await token()).toBe('abc');
    expect(await token()).toBe('abc');
    expect(n).toBe(1);
  });
});
