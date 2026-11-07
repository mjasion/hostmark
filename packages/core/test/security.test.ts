import { API_CSP, HSTS, shareCsp } from '@hostmark/contract';
import { CSS_HASH, STYLE_HASHES } from '@hostmark/pages/styles';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/http/app';
import { htmlSecurityHeaders, isHttps, withSecurityHeaders } from '../src/http/security';
import { createTestDb, databaseUrl, KEYS, type TestDb } from './helpers/db';
import { fakeImage } from './helpers/fakes';
import { createHarness, type Harness, lastMessage } from './helpers/harness';

const COMMON = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };

describe('isHttps (D310)', () => {
  const req = (url: string, proto?: string) =>
    new Request(url, proto ? { headers: { 'x-forwarded-proto': proto } } : {});

  it('follows the configured public URL first, whatever the request says', () => {
    expect(isHttps(req('http://api:8080/x', 'http'), 'https://hostmark.example')).toBe(true);
    expect(isHttps(req('https://h.example/x', 'https'), 'http://127.0.0.1:58080')).toBe(false);
  });

  it('otherwise reads the first x-forwarded-proto entry, then the URL scheme', () => {
    expect(isHttps(req('http://api:8080/x', 'https, http'))).toBe(true);
    expect(isHttps(req('https://h.example/x', 'http'))).toBe(false);
    expect(isHttps(req('https://h.example/x', 'gopher'))).toBe(true);
    expect(isHttps(req('http://h.example/x'))).toBe(false);
  });
});

describe('withSecurityHeaders (D310)', () => {
  it('adds the common set everywhere and the API policy under /api', () => {
    const plain = withSecurityHeaders(new Response('x'), new Request('http://h/robots.txt'));
    expect(Object.fromEntries(plain.headers)).toMatchObject(COMMON);
    expect(plain.headers.get('content-security-policy')).toBeNull();
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    const api = withSecurityHeaders(new Response('x'), new Request('https://h/api/x'));
    expect(api.headers.get('content-security-policy')).toBe(API_CSP);
    expect(api.headers.get('strict-transport-security')).toBe(HSTS);
  });

  it('keeps a value the response chose and copies a response whose headers are immutable', async () => {
    const chosen = new Response('x', { headers: { 'referrer-policy': 'same-origin' } });
    expect(withSecurityHeaders(chosen, new Request('http://h/f/x')).headers.get('referrer-policy')).toBe(
      'same-origin',
    );
    const frozen = Response.redirect('http://h/elsewhere', 302);
    expect(() => frozen.headers.set('x', 'y')).toThrow();
    const out = withSecurityHeaders(frozen, new Request('http://h/x'));
    expect(out.status).toBe(302);
    expect(out.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('gives HTML documents the full set with the style hashes of the pages', () => {
    const headers = htmlSecurityHeaders({ https: true, storageOrigin: 'https://s3.example' });
    expect(STYLE_HASHES).toEqual([CSS_HASH]);
    expect(headers['content-security-policy']).toContain(`style-src 'self' '${CSS_HASH}'`);
    expect(headers['content-security-policy']).toContain("connect-src 'self' https://s3.example");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toBe(HSTS);
  });

  it('is on the 500 of a failed dependency resolution, with HSTS from the request scheme', async () => {
    const app = createApp(() => {
      throw new Error('config missing');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.request('https://h.example/api/health');
      expect(res.status).toBe(500);
      expect(Object.fromEntries(res.headers)).toMatchObject({
        ...COMMON,
        'content-security-policy': API_CSP,
        'strict-transport-security': HSTS,
      });
      const page = await app.request('http://h.example/f/x');
      expect(Object.fromEntries(page.headers)).toMatchObject(COMMON);
      expect(page.headers.get('strict-transport-security')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

let testDb: TestDb;
beforeAll(async () => {
  if (databaseUrl) testDb = await createTestDb();
});
afterAll(async () => {
  await testDb?.close();
});

describe.skipIf(!databaseUrl)('security headers on every response of the app (D310)', () => {
  let h: Harness;
  let id: string;
  beforeEach(async () => {
    h = await createHarness(testDb);
    id = await h.uploadAndComplete(KEYS.alice, fakeImage(800, 600));
    await h.deliver(lastMessage(h));
    await h.request(`/api/files/${id}`, { method: 'PATCH', key: KEYS.alice, json: { isPublic: true } });
  });

  const paths = () => ({
    api: ['/api/health', '/api/nope', `/api/files/${id}`, '/api/stats'],
    other: [`/media/${id}/128.webp`, `/media/${crypto.randomUUID()}/128.webp`, '/nope', '/robots.txt'],
    share: [`/f/${id}`, `/f/${crypto.randomUUID()}`, '/f/not-a-uuid'],
  });

  it('sends the set of each kind, and no HSTS over plain HTTP', async () => {
    h.deps.config = { ...h.deps.config, publicUrl: 'http://127.0.0.1:58080' };
    const { api, other, share } = paths();
    for (const path of [...api, ...other, ...share]) {
      // A client cannot switch HSTS on when the deployment is plain HTTP.
      const res = await h.request(path, { headers: { 'x-forwarded-proto': 'https' } });
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('strict-transport-security'), path).toBeNull();
      expect(res.headers.get('x-frame-options'), path).toBeNull();
    }
    for (const path of api) {
      const res = await h.request(path);
      expect(res.headers.get('content-security-policy'), path).toBe(API_CSP);
      expect(res.headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
    }
    for (const path of other) {
      const res = await h.request(path);
      expect(res.headers.get('content-security-policy'), path).toBeNull();
      expect(res.headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
    }
    expect((await h.request(`/media/${id}/128.webp`)).status).toBe(200);
    for (const path of share) {
      const res = await h.request(path);
      expect(res.headers.get('content-security-policy'), path).toBe(shareCsp([CSS_HASH]));
      expect(res.headers.get('referrer-policy'), path).toBe('same-origin');
    }
  });

  it('sends HSTS on every response when the deployment is HTTPS', async () => {
    h.deps.config = { ...h.deps.config, publicUrl: 'https://hostmark.example' };
    const { api, other, share } = paths();
    for (const path of [...api, ...other, ...share]) {
      const res = await h.request(path);
      expect(res.headers.get('strict-transport-security'), path).toBe(HSTS);
    }
    const events = await h.request(`/api/files/${id}/events`, { method: 'HEAD', key: KEYS.alice });
    expect(events.headers.get('strict-transport-security')).toBe(HSTS);
    expect(events.headers.get('content-security-policy')).toBe(API_CSP);
  });

  it('follows the request scheme without a configured public URL', async () => {
    h.deps.config = { ...h.deps.config, publicUrl: undefined };
    expect((await h.request('/api/health')).headers.get('strict-transport-security')).toBeNull();
    const behindTls = await h.request('/api/health', { headers: { 'x-forwarded-proto': 'https' } });
    expect(behindTls.headers.get('strict-transport-security')).toBe(HSTS);
  });
});
