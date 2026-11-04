import { beforeEach, describe, expect, it, vi } from 'vitest';
import { envSchema } from '../src/env';
import type { RuntimeQueue } from '../src/platform';
import { createRuntime } from '../src/runtime';

// The wiring of `createRuntime` into the auth (D80, D88): what the api passes to `createAuth` and to core's config.
// Auth, telemetry and the database client are replaced, so nothing connects anywhere.
const auth = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('@hostmark/auth', () => ({
  createAuth: (options: Record<string, unknown>) => {
    auth.calls.push(options);
    return { handler: () => new Response(null), getSession: async () => null };
  },
}));
vi.mock('@hostmark/telemetry/node', () => ({
  startNodeTelemetry: () => ({ write: () => {}, shutdown: async () => {} }),
}));
vi.mock('@hostmark/db/node', () => ({
  createNodeDb: () => ({ db: {}, close: async () => {} }),
}));

const queue: RuntimeQueue = {
  send: async () => {},
  sendBatch: async () => {},
  ping: async () => {},
  close: async () => {},
} as unknown as RuntimeQueue;
const platform = { key: 'local-portable', queue: () => queue };

const env = (extra: Record<string, string>) =>
  envSchema.parse({
    DATABASE_URL: 'postgres://u:p@h/db',
    REDIS_URL: 'redis://r:6379',
    S3_ENDPOINT: 'http://minio:9000',
    S3_BUCKET: 'hostmark',
    S3_ACCESS_KEY_ID: 'a',
    S3_SECRET_ACCESS_KEY: 'b',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    ...extra,
  });

const api = (extra: Record<string, string>) => {
  auth.calls = [];
  const runtime = createRuntime('api', env(extra), platform);
  expect(auth.calls).toHaveLength(1);
  return { runtime, options: auth.calls[0] as Record<string, unknown> };
};

beforeEach(() => {
  auth.calls = [];
});

describe('createRuntime wiring', () => {
  it('passes only the origin of PUBLIC_URL, to the auth and to the public pages', async () => {
    const { runtime, options } = api({ PUBLIC_URL: 'https://hm.example:8443/app/?x=1#top' });
    expect(options.baseUrl).toBe('https://hm.example:8443');
    expect(runtime.deps.config.publicUrl).toBe('https://hm.example:8443');
    await runtime.shutdown();
  });

  it('passes AUTH_CLIENT_IP_HEADER through, trimmed, and leaves the limiter off when it is unset or blank', async () => {
    for (const [value, expected] of [
      [undefined, undefined],
      ['', undefined],
      ['   ', undefined],
      ['x-real-ip', 'x-real-ip'],
      [' cf-connecting-ip ', 'cf-connecting-ip'],
    ] as const) {
      const extra: Record<string, string> = { PUBLIC_URL: 'http://127.0.0.1:58080' };
      if (value !== undefined) extra.AUTH_CLIENT_IP_HEADER = value;
      const { runtime, options } = api(extra);
      expect(options.clientIpHeader, JSON.stringify(value)).toBe(expected);
      await runtime.shutdown();
    }
  });

  it('passes the trusted origins as a list and the signup switch as a boolean', async () => {
    const { runtime, options } = api({
      PUBLIC_URL: 'http://127.0.0.1:58080',
      AUTH_TRUSTED_ORIGINS: ' http://a.test , ,http://b.test/',
      AUTH_SIGNUP_ENABLED: 'false',
    });
    expect(options.trustedOrigins).toEqual(['http://a.test', 'http://b.test/']);
    expect(options.signupEnabled).toBe(false);
    expect(options.secret).toBe('x'.repeat(32));
    await runtime.shutdown();
  });

  it('builds no auth for the worker and the scheduler', async () => {
    for (const service of ['worker', 'scheduler'] as const) {
      const runtime = createRuntime(service, env({ PUBLIC_URL: 'http://127.0.0.1:58080' }), platform);
      expect(runtime.deps.auth).toBeUndefined();
      await runtime.shutdown();
    }
    expect(auth.calls).toHaveLength(0);
  });
});
