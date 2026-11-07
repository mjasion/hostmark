import { files } from '@hostmark/db';
import { CSS_HASH } from '@hostmark/pages';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/http/app';
import { createTestDb, databaseUrl, KEYS, type TestDb } from './helpers/db';
import { fakeImage } from './helpers/fakes';
import { createHarness, type Harness, lastMessage } from './helpers/harness';

let testDb: TestDb;
beforeAll(async () => {
  if (databaseUrl) testDb = await createTestDb();
});
afterAll(async () => {
  await testDb?.close();
});

const PUBLIC_URL = 'https://hostmark.example';

describe.skipIf(!databaseUrl)('GET /f/:id', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness(testDb);
    h.deps.config = { ...h.deps.config, publicUrl: PUBLIC_URL };
  });

  async function readyFile(isPublic: boolean) {
    const id = await h.uploadAndComplete(KEYS.alice, fakeImage(800, 600));
    await h.deliver(lastMessage(h));
    if (isPublic)
      await h.request(`/api/files/${id}`, { method: 'PATCH', key: KEYS.alice, json: { isPublic: true } });
    return id;
  }

  it('renders a public ready file with the cache header of the spec and OG tags', async () => {
    const id = await readyFile(true);
    const res = await h.request(`/f/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('s-maxage=60, stale-while-revalidate=600');
    expect(res.headers.get('x-trace-id')).toBeTruthy();
    expect(res.headers.get('x-platform')).toBe('test-portable');
    expect(res.headers.get('x-version')).toBe('abc1234');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // D310: the inline style by its hash instead of 'unsafe-inline'; HSTS because the public URL is https.
    expect(res.headers.get('content-security-policy')).toBe(
      `default-src 'none'; style-src '${CSS_HASH}'; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(res.headers.get('x-frame-options')).toBeNull();
    // D300: out of search results, while the Open Graph tags below still serve link previews.
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Image 800 x 600"/>');
    expect(html).toContain('<meta property="og:type" content="website"/>');
    expect(html).toContain(`<meta property="og:image" content="${PUBLIC_URL}/media/${id}/1600.webp"/>`);
    expect(html).toContain(`<meta property="og:url" content="${PUBLIC_URL}/f/${id}"/>`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"/>');
    expect(html).toContain(`<img src="/media/${id}/1600.webp"`);
    expect(html).toContain(
      '<script type="module" src="/rum.js" data-rum="" data-platform="local" data-variant="portable" data-topology="single" data-region="local"></script>',
    );
  });

  it('answers HEAD without a body', async () => {
    const id = await readyFile(true);
    const res = await h.request(`/f/${id}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('takes the RUM attributes from the platform key and the config overrides', async () => {
    const id = await readyFile(true);
    h.deps.config = {
      ...h.deps.config,
      platform: 'cloudflare-idiomatic',
      rum: { topology: 'multi', region: 'frankfurt' },
    };
    const html = await (await h.request(`/f/${id}`)).text();
    expect(html).toContain(
      'data-platform="cloudflare" data-variant="idiomatic" data-topology="multi" data-region="frankfurt"',
    );
    h.deps.config = { ...h.deps.config, platform: 'x', rum: { region: 'mars' } };
    expect(await (await h.request(`/f/${id}`)).text()).toContain(
      'data-platform="local" data-variant="portable" data-topology="single" data-region="local"',
    );
  });

  describe.each([
    ['a private file', async () => readyFile(false)],
    ['a file that is not ready', async () => h.uploadAndComplete(KEYS.alice, fakeImage())],
    ['a missing file', async () => crypto.randomUUID()],
    ['a malformed id', async () => 'not-a-uuid'],
    [
      'a deleted file',
      async () => {
        const id = await readyFile(true);
        await h.request(`/api/files/${id}`, { method: 'DELETE', key: KEYS.alice });
        return id;
      },
    ],
  ])('for %s', (_name, make) => {
    it('answers an HTML 404 that no cache keeps, with the D9 headers', async () => {
      const id = await make();
      const res = await h.request(`/f/${id}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-trace-id')).toBeTruthy();
      expect(res.headers.get('x-platform')).toBe('test-portable');
      const html = await res.text();
      expect(html).toContain('Page not found');
      expect(html).not.toContain('og:image');
    });
  });

  it.each(['queued', 'processing', 'failed'] as const)(
    'answers 404 for a public file that is %s: public alone is not enough (D6)',
    async (status) => {
      const id = await readyFile(true);
      await testDb.db.update(files).set({ status }).where(eq(files.id, id));
      const res = await h.request(`/f/${id}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).not.toContain('og:image');
    },
  );

  it('sets the referrer policy and noindex on the HTML 404 as well', async () => {
    for (const path of [`/f/${crypto.randomUUID()}`, '/f/not-a-uuid', `/f/${crypto.randomUUID()}/extra`]) {
      const res = await h.request(path);
      expect(res.headers.get('referrer-policy'), path).toBe('same-origin');
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex');
    }
  });

  it('keeps only the origin of a public URL that has a path, query or fragment', async () => {
    const id = await readyFile(true);
    h.deps.config = { ...h.deps.config, publicUrl: `${PUBLIC_URL}/app/?x=1#top` };
    const html = await (await h.request(`/f/${id}`)).text();
    expect(html).toContain(`<meta property="og:url" content="${PUBLIC_URL}/f/${id}"/>`);
    expect(html).toContain(`<meta property="og:image" content="${PUBLIC_URL}/media/${id}/1600.webp"/>`);
    expect(html).not.toContain('/app/');
  });

  it('stops serving at the origin as soon as the file is unpublished', async () => {
    const id = await readyFile(true);
    expect((await h.request(`/f/${id}`)).status).toBe(200);
    await h.request(`/api/files/${id}`, { method: 'PATCH', key: KEYS.alice, json: { isPublic: false } });
    expect((await h.request(`/f/${id}`)).status).toBe(404);
  });

  it('answers HTML 404 with no-store for an unknown path below /f/', async () => {
    for (const path of ['/f/', `/f/${crypto.randomUUID()}/extra`]) {
      const res = await h.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('records the route pattern, not the id', async () => {
    await h.request(`/f/${crypto.randomUUID()}`);
    const routes = h.telemetry.of('httpRequestDuration').map((r) => r.attrs?.['http.route']);
    expect(routes).toContain('/f/:id');
  });

  describe('origin of the absolute URLs (D82)', () => {
    const hostile = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' };

    it('ignores Host and X-Forwarded-Host when a public URL is configured, so a cached page cannot be poisoned', async () => {
      const id = await readyFile(true);
      const clean = await (await h.request(`/f/${id}`)).text();
      const res = await h.request(`/f/${id}`, { headers: hostile });
      const html = await res.text();
      expect(html).toBe(clean);
      expect(html).not.toContain('evil.example');
      expect(res.headers.get('cache-control')).toBe('s-maxage=60, stale-while-revalidate=600');
    });

    it('without a public URL uses the first forwarded host but forbids caching', async () => {
      const id = await readyFile(true);
      h.deps.config = { ...h.deps.config, publicUrl: undefined };
      const res = await h.request(`/f/${id}`, {
        headers: {
          host: 'api.internal',
          'x-forwarded-host': 'App.Example.test, api.internal',
          'x-forwarded-proto': 'https, http',
        },
      });
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const html = await res.text();
      expect(html).toContain(`content="https://App.Example.test/media/${id}/1600.webp"`);
    });

    it.each([
      '"><script>alert(1)</script>',
      'a.test" onload="x',
      'a.test/../../x',
      'a b',
      "a.test'><img src=x>",
    ])('drops absolute URLs for the hostile host %j and never caches', async (value) => {
      const id = await readyFile(true);
      h.deps.config = { ...h.deps.config, publicUrl: undefined };
      const res = await h.request(`/f/${id}`, { headers: { 'x-forwarded-host': value } });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const html = await res.text();
      expect(html).not.toContain('og:image');
      expect(html).not.toContain('<img src=x');
      expect(html.match(/<script/g)).toHaveLength(1);
    });
  });

  describe('failures', () => {
    it('answers an HTML 500 without internals, never cached, and logs the cause', async () => {
      const boom = new Proxy(h.deps.db, {
        get: (target, prop, receiver) => {
          if (prop === 'select') throw new Error('connection refused to 10.0.0.5');
          return Reflect.get(target, prop, receiver);
        },
      });
      const app = createApp(() => ({ ...h.deps, db: boom }));
      const res = await app.request(`/f/${crypto.randomUUID()}`);
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-trace-id')).toBeTruthy();
      expect(await res.text()).not.toContain('10.0.0.5');
      expect(h.telemetry.logs.some((l) => l.level === 'error' && l.msg === 'unhandled error')).toBe(true);
    });

    it('does not cache the failure of dependency resolution', async () => {
      const app = createApp(() => {
        throw new Error('config missing');
      });
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await app.request(`/f/${crypto.randomUUID()}`);
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });
});
