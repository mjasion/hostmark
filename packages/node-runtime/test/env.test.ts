import { EXAMPLE_AUTH_SECRET } from '@hostmark/auth';
import { describe, expect, it, vi } from 'vitest';
import { envSchema, loadEnv } from '../src/env';

const base = {
  DATABASE_URL: 'postgres://u:p@h/db',
  REDIS_URL: 'redis://r:6379',
  S3_ENDPOINT: 'http://minio:9000',
  S3_BUCKET: 'hostmark',
  S3_ACCESS_KEY_ID: 'a',
  S3_SECRET_ACCESS_KEY: 'b',
};
const parse = (extra: Record<string, string>) => envSchema.safeParse({ ...base, ...extra });

describe('auth environment', () => {
  it('keeps signup off unless the deployment turns it on (D7, D335)', () => {
    const off = parse({});
    expect(off.success && off.data.AUTH_SIGNUP_ENABLED).toBe('false');
    const on = parse({ AUTH_SIGNUP_ENABLED: 'true' });
    expect(on.success && on.data.AUTH_SIGNUP_ENABLED).toBe('true');
  });

  it('accepts http and https public URLs, with or without a path (only the origin is used)', () => {
    for (const url of ['http://127.0.0.1:58080', 'https://hostmark.example/', 'http://h.test/app?x=1#f'])
      expect(parse({ PUBLIC_URL: url }).success, url).toBe(true);
  });

  it('refuses other schemes', () => {
    for (const url of ['foo:bar', 'mailto:a@b.test', 'ftp://h.test', 'javascript:alert(1)', 'not a url'])
      expect(parse({ PUBLIC_URL: url }).success, url).toBe(false);
  });

  it('refuses a short or blank secret and trims the rest', () => {
    expect(parse({ BETTER_AUTH_SECRET: 'x'.repeat(31) }).success).toBe(false);
    expect(parse({ BETTER_AUTH_SECRET: ' '.repeat(32) }).success).toBe(false);
    expect(parse({ BETTER_AUTH_SECRET: `${' '.repeat(10)}${'x'.repeat(22)}${' '.repeat(10)}` }).success).toBe(
      false,
    );
    const ok = parse({ BETTER_AUTH_SECRET: ` ${'x'.repeat(32)} ` });
    expect(ok.success && ok.data.BETTER_AUTH_SECRET).toBe('x'.repeat(32));
  });

  it('accepts the placeholder from .env.example, which the local stack runs on', () => {
    expect(
      parse({ BETTER_AUTH_SECRET: 'hm_local_auth_secret_replace_me_000000000000000000000000' }).success,
    ).toBe(true);
  });

  it('refuses the example secret at startup unless ENVIRONMENT is local (D104)', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const secret = { ...base, BETTER_AUTH_SECRET: EXAMPLE_AUTH_SECRET };
      expect(() => loadEnv(secret)).toThrow('exit 1');
      expect(() => loadEnv({ ...secret, ENVIRONMENT: 'production' })).toThrow('exit 1');
      expect(loadEnv({ ...secret, ENVIRONMENT: 'local' }).ENVIRONMENT).toBe('local');
      expect(loadEnv({ ...base, BETTER_AUTH_SECRET: 'x'.repeat(32) }).ENVIRONMENT).toBe('production');
      expect(loadEnv(base).BETTER_AUTH_SECRET).toBeUndefined();
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('leaves the client address header unset by default', () => {
    const r = parse({});
    expect(r.success && r.data.AUTH_CLIENT_IP_HEADER).toBeUndefined();
  });
});

describe('S3 addressing', () => {
  it('is path-style unless S3_VIRTUAL_HOST is true (D280)', () => {
    const def = parse({});
    expect(def.success && def.data.S3_VIRTUAL_HOST).toBe('false');
    const on = parse({ S3_VIRTUAL_HOST: 'true' });
    expect(on.success && on.data.S3_VIRTUAL_HOST).toBe('true');
    expect(parse({ S3_VIRTUAL_HOST: 'yes' }).success).toBe(false);
  });
});
