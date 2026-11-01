import { user } from '@hostmark/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, databaseUrl, type TestDb } from '../../core/test/helpers/db';
import { createHarness, type Harness } from '../../core/test/helpers/harness';
import type { AuthOptions } from '../src';

// Better Auth reads NODE_ENV (and the TEST flag Vitest sets) once, when it loads: the origin check is skipped under `test` and the limiter's address
// falls back to localhost. Vitest runs each file in its own process, so set it before the first import of the library.
process.env.NODE_ENV = 'production';
delete process.env.TEST;
const { createAuth } = await import('../src');

const ORIGIN = 'http://hostmark.test';
const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!databaseUrl)('auth limits against Postgres', () => {
  let testDb: TestDb;
  let h: Harness;

  const build = async (extra: Partial<AuthOptions> = {}) => {
    h = await createHarness(testDb, {
      auth: createAuth({ db: testDb.db, secret: SECRET, baseUrl: ORIGIN, signupEnabled: true, ...extra }),
    });
    return h;
  };

  const post = (path: string, json: unknown, headers: Record<string, string> = {}, origin = ORIGIN) =>
    h.app.request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: JSON.stringify(json),
    });
  const wrongSignIn = (headers: Record<string, string> = {}) =>
    post('/api/auth/sign-in/email', { email: 'nobody@example.test', password: PASSWORD }, headers);
  const burst = async (n: number, headers: Record<string, string> = {}) => {
    const statuses: number[] = [];
    for (let i = 0; i < n; i++) statuses.push((await wrongSignIn(headers)).status);
    return statuses;
  };

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(async () => {
    await testDb.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rate limit (D80)', () => {
    it('is off without clientIpHeader: no 429, no shared lockout, no startup warning', async () => {
      const warn = vi.spyOn(console, 'warn');
      await build();
      expect(await burst(8)).toEqual(Array(8).fill(401));
      // A forged x-forwarded-for neither limits nor escapes anything.
      expect(await burst(8, { 'x-forwarded-for': '203.0.113.9' })).toEqual(Array(8).fill(401));
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/rate limit/i);
    });

    it('with clientIpHeader, limits per address and gives each address its own bucket', async () => {
      await build({ clientIpHeader: 'CF-Connecting-IP' });
      const a = { 'cf-connecting-ip': '198.51.100.10' };
      const b = { 'cf-connecting-ip': '198.51.100.11' };
      expect(await burst(5, a)).toEqual([401, 401, 401, 429, 429]);
      // A second client is not locked out by the first, and can still sign in properly.
      expect(await burst(3, b)).toEqual([401, 401, 401]);
      expect((await wrongSignIn(b)).status).toBe(429);
    });

    it('does not let a client change its bucket with x-forwarded-for', async () => {
      await build({ clientIpHeader: 'cf-connecting-ip' });
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++)
        statuses.push(
          (
            await wrongSignIn({
              'cf-connecting-ip': '198.51.100.20',
              'x-forwarded-for': `203.0.113.${i + 1}`,
            })
          ).status,
        );
      expect(statuses).toEqual([401, 401, 401, 429, 429, 429, 429, 429]);
    });

    it('does not let a client lock out a victim by sending the victim address in x-forwarded-for', async () => {
      await build({ clientIpHeader: 'cf-connecting-ip' });
      await burst(6, { 'cf-connecting-ip': '198.51.100.30', 'x-forwarded-for': '198.51.100.31' });
      expect(await burst(1, { 'cf-connecting-ip': '198.51.100.31' })).toEqual([401]);
    });

    it('refuses auth requests without a single valid address instead of pooling them in one bucket', async () => {
      await build({ clientIpHeader: 'cf-connecting-ip' });
      for (const value of [
        undefined,
        '',
        'not-an-ip',
        '198.51.100.40, 198.51.100.41',
        '999.1.1.1',
        '[::1]',
      ]) {
        const res = await wrongSignIn(value === undefined ? {} : { 'cf-connecting-ip': value });
        expect(res.status, String(value)).toBe(400);
      }
      // IPv6 is a valid address and gets its own bucket.
      expect(await burst(4, { 'cf-connecting-ip': '2001:db8::1' })).toEqual([401, 401, 401, 429]);
      expect(await burst(1, { 'cf-connecting-ip': '2001:db8:0:1::1' })).toEqual([401]);
    });
  });

  describe('body limit', () => {
    it('refuses a 30 MiB name with 413 and stores nothing', async () => {
      await build();
      const res = await post('/api/auth/sign-up/email', {
        email: 'big@example.test',
        password: PASSWORD,
        name: 'x'.repeat(30 * 1024 * 1024),
      });
      expect(res.status).toBe(413);
      expect(((await res.json()) as { title: string }).title).toBe('Payload Too Large');
      expect((await testDb.db.select().from(user)).some((u) => u.email === 'big@example.test')).toBe(false);
    });

    it('refuses a body without content-length that grows past the limit', async () => {
      await build();
      const chunk = new TextEncoder().encode(`${'x'.repeat(1024)}`);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"name":"'));
          for (let i = 0; i < 128; i++) controller.enqueue(chunk);
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      });
      const res = await h.app.request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body,
        // @ts-expect-error Node's fetch requires this for a streaming body.
        duplex: 'half',
      });
      expect(res.status).toBe(413);
    });

    it('still accepts a normal sign-up', async () => {
      await build();
      const res = await post('/api/auth/sign-up/email', {
        email: 'normal@example.test',
        password: PASSWORD,
        name: 'N'.repeat(200),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('trustedOrigins', () => {
    const signUpFrom = (origin: string, email: string) =>
      // Better Auth checks the origin of any request that carries a cookie, `Origin` or `Referer`; a request with
      // none of them passes.
      post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'T' }, {}, origin);

    it('accepts a configured origin, spelled with or without a trailing slash, and no other', async () => {
      for (const configured of ['http://spa.test', 'http://spa.test/', 'http://spa.test/some/path']) {
        await build({ trustedOrigins: [configured] });
        expect((await signUpFrom('http://spa.test', 'spa@example.test')).status, configured).toBe(200);
        expect((await signUpFrom('http://other.test', 'other@example.test')).status, configured).toBe(403);
      }
    });

    it('rejects every foreign origin when none is configured', async () => {
      await build();
      expect((await signUpFrom('http://spa.test', 'spa2@example.test')).status).toBe(403);
    });

    it('throws at startup for an entry that is not an http(s) URL', () => {
      for (const bad of ['spa.test', 'spa.test:8080', '', 'ftp://spa.test', '//spa.test']) {
        expect(
          () =>
            createAuth({
              db: testDb.db,
              secret: SECRET,
              baseUrl: ORIGIN,
              signupEnabled: true,
              trustedOrigins: [bad],
            }),
          bad,
        ).toThrow(/trustedOrigins/);
      }
    });
  });
});
