import { afterEach, describe, expect, it, vi } from 'vitest';
import { initBucket } from '../src/init-bucket';
import type { NodePlatform } from '../src/platform';

const env = {
  DATABASE_URL: 'postgres://u:p@h/db',
  REDIS_URL: 'redis://r:6379',
  S3_ENDPOINT: 'https://fly.storage.tigris.dev',
  S3_BUCKET: 'hostmark-bucket',
  S3_REGION: 'auto',
  S3_ACCESS_KEY_ID: 'a',
  S3_SECRET_ACCESS_KEY: 'b',
};
const platform = (extra: Record<string, string>): NodePlatform => ({
  key: 'test-portable',
  env: () => ({ ...env, ...extra }),
});

/** Runs initBucket against a stubbed fetch that answers 200 to everything and records method and URL. */
async function calls(extra: Record<string, string>): Promise<string[]> {
  const seen: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const req = input as Request;
    seen.push(`${req.method} ${req.url}`);
    return new Response(null, { status: 200 });
  });
  await initBucket(platform(extra));
  return seen;
}

describe('initBucket URLs (stubbed fetch)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the virtual host when S3_VIRTUAL_HOST is true (Tigris, D280)', async () => {
    expect(await calls({ S3_VIRTUAL_HOST: 'true' })).toEqual([
      'HEAD https://hostmark-bucket.fly.storage.tigris.dev/',
      'PUT https://hostmark-bucket.fly.storage.tigris.dev/?lifecycle',
      'PUT https://hostmark-bucket.fly.storage.tigris.dev/?cors',
    ]);
  });

  it('stays path-style by default (MinIO)', async () => {
    expect(await calls({ S3_ENDPOINT: 'http://minio:9000/' })).toEqual([
      'HEAD http://minio:9000/hostmark-bucket',
      'PUT http://minio:9000/hostmark-bucket?lifecycle',
      'PUT http://minio:9000/hostmark-bucket?cors',
    ]);
  });
});

const endpoint = process.env.S3_TEST_ENDPOINT;
describe.skipIf(!endpoint)('initBucket against MinIO (S3_TEST_ENDPOINT)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a bucket with path-style URLs and keeps it on a second run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const real = platform({
      S3_ENDPOINT: endpoint ?? '',
      S3_BUCKET: `hm-init-${Date.now().toString(36)}`,
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: process.env.S3_TEST_ACCESS_KEY ?? 'hostmark',
      S3_SECRET_ACCESS_KEY: process.env.S3_TEST_SECRET_KEY ?? 'hostmark-local-secret',
    });
    await initBucket(real);
    await initBucket(real);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith('bucket '))).toEqual([
      expect.stringMatching(/: created$/),
      expect.stringMatching(/: exists$/),
    ]);
    expect(lines).toContain('lifecycle: originals/ and variants/ expire after 8 days');
  });
});
