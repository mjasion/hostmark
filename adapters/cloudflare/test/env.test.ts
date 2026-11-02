import { EXAMPLE_AUTH_SECRET } from '@hostmark/auth';
import { describe, expect, it, vi } from 'vitest';
import { CLIENT_IP_HEADER, ConfigError, parseVars } from '../src/env';
import { createWorkersCachePurger, type PurgeTarget, purgeCache } from '../src/purge';
import { createScope, noImages } from '../src/runtime';

const vars = {
  PUBLIC_URL: 'https://hostmark.example.com',
  BETTER_AUTH_SECRET: 'a-long-random-secret-for-the-tests-0123456789',
  R2_ACCOUNT_ID: 'acc',
  R2_BUCKET_NAME: 'hostmark-files',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
};

const bindings = {
  HYPERDRIVE: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
  BUCKET: {},
  QUEUE: {},
  MEDIA: { purge: async () => ({ success: true, errors: [] }) },
};

describe('parseVars', () => {
  it('defaults ENVIRONMENT to production, so a forgotten variable keeps the checks on', () => {
    expect(parseVars(vars).ENVIRONMENT).toBe('production');
  });

  it('refuses the .env.example BETTER_AUTH_SECRET unless ENVIRONMENT is local', () => {
    const example = { ...vars, BETTER_AUTH_SECRET: EXAMPLE_AUTH_SECRET };
    expect(() => parseVars(example)).toThrow(ConfigError);
    expect(() => parseVars({ ...example, ENVIRONMENT: 'staging' })).toThrow(/example value/);
    expect(parseVars({ ...example, ENVIRONMENT: 'local' }).ENVIRONMENT).toBe('local');
  });

  it('lists every problem at once', () => {
    expect(() => parseVars({})).toThrow(/PUBLIC_URL[\s\S]*BETTER_AUTH_SECRET[\s\S]*R2_ACCOUNT_ID/);
  });

  it('uses the header Cloudflare overwrites', () => {
    expect(CLIENT_IP_HEADER).toBe('cf-connecting-ip');
  });
});

describe('createScope', () => {
  it('starts the api with auth and the purger it was given', async () => {
    const purger = createWorkersCachePurger(bindings.MEDIA);
    const scope = createScope({ ...vars, ENVIRONMENT: 'local', ...bindings } as never, {
      service: 'api',
      images: noImages,
      purger,
    });
    expect(scope.deps.purger).toBe(purger);
    expect(scope.deps.auth).toBeDefined();
    await scope.close();
  });

  it('gives the worker and the scheduler no auth', async () => {
    const purger = createWorkersCachePurger(bindings.MEDIA);
    const scope = createScope({ ...vars, ...bindings } as never, {
      service: 'worker',
      images: noImages,
      purger,
    });
    expect(scope.deps.auth).toBeUndefined();
    expect(scope.deps.purger).toBe(purger);
    await scope.close();
  });

  it('refuses the example secret before it builds anything', () => {
    expect(() =>
      createScope({ ...vars, BETTER_AUTH_SECRET: EXAMPLE_AUTH_SECRET, ...bindings } as never, {
        service: 'api',
        images: noImages,
        purger: createWorkersCachePurger(bindings.MEDIA),
      }),
    ).toThrow(/example value/);
  });
});

describe('createWorkersCachePurger', () => {
  it('refuses a missing MEDIA binding, so a Worker without a purge does not start (D100)', () => {
    expect(() => createWorkersCachePurger(undefined)).toThrow(ConfigError);
    expect(() => createWorkersCachePurger({} as never)).toThrow(/no purge method/);
  });

  it('passes the paths on and resolves when the purge succeeded', async () => {
    const purge = vi.fn<PurgeTarget['purge']>(async () => ({ success: true, errors: [] }));
    await createWorkersCachePurger({ purge }).purge(['/media/a/128.webp', '/f/a']);
    expect(purge).toHaveBeenCalledWith(['/media/a/128.webp', '/f/a']);
  });

  it('rejects with the reason when the purge was refused, so the caller can retry', async () => {
    const purger = createWorkersCachePurger({
      purge: async () => ({ success: false, errors: [{ code: 1001, message: 'rate limited' }] }),
    });
    await expect(purger.purge(['/f/a'])).rejects.toThrow(/1001 rate limited/);
  });

  it('does not call the CDN for an empty list', async () => {
    const purge = vi.fn<PurgeTarget['purge']>(async () => ({ success: true, errors: [] }));
    await createWorkersCachePurger({ purge }).purge([]);
    expect(purge).not.toHaveBeenCalled();
  });
});

describe('purgeCache', () => {
  it('purges by path prefix', async () => {
    const purge = vi.fn(async () => ({ success: true, errors: [] }));
    await purgeCache({ purge }, ['/f/a']);
    expect(purge).toHaveBeenCalledWith({ pathPrefixes: ['/f/a'] });
  });

  it('rejects where the runtime has no Workers Caching, instead of doing nothing', async () => {
    await expect(purgeCache(undefined, ['/f/a'])).rejects.toThrow(/not available/);
    await expect(purgeCache({}, ['/f/a'])).rejects.toThrow(/not available/);
  });
});
