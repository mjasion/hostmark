import { isReservedEmail, RESERVED_EMAILS, user } from '@hostmark/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, databaseUrl, type TestDb } from '../../core/test/helpers/db';
import { createHarness, type Harness } from '../../core/test/helpers/harness';
import { createAuth } from '../src';

const ORIGIN = 'http://hostmark.test';
const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const PASSWORD = 'correct horse battery staple';

/** A cookie jar of one: enough to carry a session. */
class Browser {
  cookies = new Map<string, string>();

  constructor(
    private readonly h: Harness,
    private readonly origin: string | null = ORIGIN,
  ) {}

  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async fetch(
    path: string,
    init: RequestInit & { json?: unknown; origin?: string | null } = {},
  ): Promise<Response> {
    const { json, origin = this.origin, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (this.cookies.size > 0) headers.set('cookie', this.cookieHeader);
    if (origin) headers.set('origin', origin);
    let body = rest.body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      headers.set('content-type', 'application/json');
    }
    const res = await this.h.app.request(`${ORIGIN}${path}`, { ...rest, headers, body });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [name, ...value] = (pair as string).split('=');
      if (/max-age=0/i.test(line) || value.join('=') === '') this.cookies.delete(name as string);
      else this.cookies.set(name as string, value.join('='));
    }
    return res;
  }

  signUp(email: string, name = 'Test') {
    return this.fetch('/api/auth/sign-up/email', {
      method: 'POST',
      json: { email, password: PASSWORD, name },
    });
  }
  signIn(email: string) {
    return this.fetch('/api/auth/sign-in/email', { method: 'POST', json: { email, password: PASSWORD } });
  }
}

describe.skipIf(!databaseUrl)('session auth against Postgres', () => {
  let testDb: TestDb;
  let h: Harness;

  const build = async (signupEnabled = true, baseUrl = ORIGIN) => {
    h = await createHarness(testDb, {
      auth: createAuth({ db: testDb.db, secret: SECRET, baseUrl, signupEnabled }),
    });
    return h;
  };

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(async () => {
    await testDb.close();
  });
  beforeEach(async () => {
    await build();
  });

  describe('signup, login, logout', () => {
    it('signs up, sets the session cookie and resolves the session to that user', async () => {
      const b = new Browser(h);
      const res = await b.signUp('ada@example.test');
      expect(res.status).toBe(200);
      const created = (await testDb.db.select().from(user)).find((u) => u.email === 'ada@example.test');
      expect(created?.emailVerified).toBe(false);
      expect(await h.deps.auth?.getSession(new Headers({ cookie: b.cookieHeader }))).toEqual({
        userId: created?.id,
      });
      expect((await b.fetch('/api/files')).status).toBe(200);
    });

    it('sets an HttpOnly, SameSite=Lax cookie, Secure only for an https base URL', async () => {
      const plain = (await new Browser(h).signUp('plain@example.test')).headers.getSetCookie().join('\n');
      expect(plain).toMatch(/better-auth\.session_token=/);
      expect(plain).toMatch(/HttpOnly/i);
      expect(plain).toMatch(/SameSite=Lax/i);
      expect(plain).not.toMatch(/Secure/i);

      await build(true, 'https://hostmark.test');
      const res = await h.app.request('https://hostmark.test/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://hostmark.test' },
        body: JSON.stringify({ email: 'tls@example.test', password: PASSWORD, name: 'Tls' }),
      });
      const secure = res.headers.getSetCookie().join('\n');
      expect(secure).toMatch(/__Secure-better-auth\.session_token=/);
      expect(secure).toMatch(/Secure/i);
      expect(secure).toMatch(/HttpOnly/i);
      expect(secure).toMatch(/SameSite=Lax/i);
    });

    it('logs in with the right password only', async () => {
      await new Browser(h).signUp('login@example.test');
      const b = new Browser(h);
      expect(
        (
          await b.fetch('/api/auth/sign-in/email', {
            method: 'POST',
            json: { email: 'login@example.test', password: 'wrong-password-123' },
          })
        ).status,
      ).toBe(401);
      expect(b.cookies.size).toBe(0);
      expect((await b.signIn('login@example.test')).status).toBe(200);
      expect((await b.fetch('/api/files')).status).toBe(200);
    });

    it('ends the session on logout', async () => {
      const b = new Browser(h);
      await b.signUp('bye@example.test');
      const old = b.cookieHeader;
      expect((await b.fetch('/api/auth/sign-out', { method: 'POST', json: {} })).status).toBe(200);
      const after = await h.app.request(`${ORIGIN}/api/files`, { headers: { cookie: old } });
      expect(after.status).toBe(401);
    });

    it('answers 401 without a cookie and for a forged one', async () => {
      expect((await h.app.request(`${ORIGIN}/api/files`)).status).toBe(401);
      const forged = await h.app.request(`${ORIGIN}/api/files`, {
        headers: { cookie: 'better-auth.session_token=forged.signature' },
      });
      expect(forged.status).toBe(401);
    });
  });

  describe('registration', () => {
    it('is refused when signup is disabled, and nothing is written', async () => {
      await build(false);
      const b = new Browser(h);
      const res = await b.signUp('late@example.test');
      expect(res.ok).toBe(false);
      expect(b.cookies.size).toBe(0);
      expect((await testDb.db.select().from(user)).filter((u) => u.email === 'late@example.test')).toEqual(
        [],
      );
    });

    it('still lets an existing account log in when signup is disabled', async () => {
      await new Browser(h).signUp('old@example.test');
      // Same database, new configuration: `build` would reset the tables.
      h.deps.auth = createAuth({ db: testDb.db, secret: SECRET, baseUrl: ORIGIN, signupEnabled: false });
      expect((await new Browser(h).signIn('old@example.test')).status).toBe(200);
    });

    it.each([
      'seed@hostmark.test',
      'admin@hostmark.test',
      'SEED@HOSTMARK.TEST',
      'Admin@HostMark.Test',
      ' seed@hostmark.test',
      'admin@hostmark.test ',
      '\tAdmin@hostmark.test\n',
    ])('refuses the reserved email %j', async (email) => {
      const b = new Browser(h);
      const res = await b.signUp(email);
      expect(res.ok).toBe(false);
      expect(b.cookies.size).toBe(0);
      const rows = await testDb.db.select({ email: user.email }).from(user);
      expect(rows.filter((r) => isReservedEmail(r.email))).toEqual([]);
    });

    it('refuses the reserved emails even when the hook is the only gate (direct creation)', async () => {
      // A path that skips the sign-up route still goes through the database hook.
      const ctx = await h.deps.auth?.handler(
        new Request(`${ORIGIN}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ email: 'ADMIN@hostmark.test', password: PASSWORD, name: 'x' }),
        }),
      );
      expect(ctx?.ok).toBe(false);
      expect((await testDb.db.select().from(user)).filter((u) => RESERVED_EMAILS.includes(u.email))).toEqual(
        [],
      );
    });

    it('accepts a lookalike that is not reserved', async () => {
      expect((await new Browser(h).signUp('seed@hostmark.test.example')).status).toBe(200);
      expect(isReservedEmail('seed@hostmark.test.example')).toBe(false);
    });
  });
});
