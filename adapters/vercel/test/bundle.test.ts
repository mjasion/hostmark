import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_ATTEMPTS, VISIBILITY_TIMEOUT_SECONDS } from '@hostmark/contract';
import { beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONS, WASM } from '../scripts/build';

const adapter = fileURLToPath(new URL('..', import.meta.url));
const VERSION = 'bundle-test-0123';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

// The probe runs with only these variables: the bundles must not need anything from the build machine.
const env = {
  PATH: process.env.PATH ?? '',
  PUBLIC_URL: 'https://hostmark.example',
  // Never connected: no probed route reaches the database.
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'hostmark',
  S3_ACCESS_KEY_ID: 'a',
  S3_SECRET_ACCESS_KEY: 'b',
  CRON_SECRET: 'c'.repeat(32),
  // What the Vercel runtime sets; the OIDC token is an unsigned, unexpired stand-in (no request leaves the probe).
  VERCEL_REGION: 'fra1',
  VERCEL_DEPLOYMENT_ID: 'dpl_probe',
  VERCEL_OIDC_TOKEN: `${b64url({ alg: 'none' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600 })}.x`,
};

describe('bundled functions under plain Node', () => {
  let report: {
    exports: Record<string, string[]>;
    health: { status: number; version: string | null; body: unknown };
    notFoundPage: { status: number; region?: string; platform?: string };
    cron: { noSecret: number; unknownJob: number };
    queueMalformed: number;
    queueDelivery: {
      status: number;
      body: unknown;
      outgoing: { method: string; url: string; idempotencyKey: string | null; body?: string }[];
    };
    queueForged: { status: number; outgoing: { method: string; url: string }[] };
    wasm: Record<string, boolean>;
  };

  beforeAll(() => {
    const build = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build.ts', '--skip-web'], {
      cwd: adapter,
      encoding: 'utf8',
      env: { ...process.env, APP_VERSION: VERSION },
    });
    expect(build.status, build.stderr).toBe(0);
    const wasm = WASM.map(([, file]) => file.split('/').pop() as string);
    const probe = spawnSync(process.execPath, ['test/function-probe.mjs', ...wasm], {
      cwd: adapter,
      encoding: 'utf8',
      env,
    });
    expect(probe.status, probe.stderr).toBe(0);
    report = JSON.parse(probe.stdout.trim().split('\n').at(-1) as string);
  }, 120_000);

  it('builds one bundle per function, and each api file only re-exports its bundle', () => {
    for (const name of Object.keys(FUNCTIONS)) {
      const stub = readFileSync(new URL(`../api/${name}.js`, import.meta.url), 'utf8');
      expect(stub).toMatch(new RegExp(`from '\\.\\./dist/${name}\\.mjs';`));
      expect(stub.split('\n').filter((l) => l.startsWith('import') || l.startsWith('export'))).toHaveLength(
        1,
      );
    }
    expect(report.exports.index).toContain('GET');
    expect(report.exports.cron).toEqual(['GET']);
    expect(report.exports.queue).toEqual(['POST']);
  });

  it('answers the api with the version and region baked into the build', () => {
    expect(report.health).toEqual({ status: 200, version: VERSION, body: { status: 'ok' } });
    expect(report.notFoundPage).toEqual({ status: 404, region: 'frankfurt', platform: 'vercel' });
  });

  it('runs the cron handler', () => {
    expect(report.cron).toEqual({ noSecret: 401, unknownJob: 400 });
  });

  it('runs the queue consumer: dead-letters a delivery after the last attempt, then acknowledges', () => {
    expect(report.queueMalformed).toBe(400);
    expect(report.queueDelivery.status).toBe(200);
    expect(report.queueDelivery.body).toEqual({ status: 'success' });
    const [lease, dlq, ack, ...rest] = report.queueDelivery.outgoing;
    // D235: the receipt handle is checked with the service before anything else.
    expect(lease?.method).toBe('PATCH');
    expect(new URL(lease?.url ?? '').hostname).toBe('fra1.vercel-queue.com');
    expect(new URL(lease?.url ?? '').pathname).toMatch(/\/lease\/probe-receipt$/);
    // D275: the lease is D17's visibility timeout, the one the route's handleCallback renews.
    expect(JSON.parse(lease?.body ?? '{}')).toEqual({ visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS });
    expect(dlq).toMatchObject({ method: 'POST', idempotencyKey: 'dlq-probe-message' });
    expect(new URL(dlq?.url ?? '').pathname).toBe('/api/v3/topic/image-jobs-dlq');
    expect(JSON.parse(dlq?.body ?? '{}')).toMatchObject({ type: 'process_image' });
    expect(ack?.method).toBe('DELETE');
    expect(new URL(ack?.url ?? '').hostname).toBe('fra1.vercel-queue.com');
    expect(rest).toEqual([]);
    expect(MAX_ATTEMPTS).toBeLessThan(6);
  });

  it('refuses a forged delivery before any job code runs (D235)', () => {
    expect(report.queueForged.status).toBe(403);
    expect(report.queueForged.outgoing).toHaveLength(1);
    expect(report.queueForged.outgoing[0]?.method).toBe('PATCH');
    expect(new URL(report.queueForged.outgoing[0]?.url ?? '').pathname).toMatch(/\/lease\/forged-receipt$/);
  });

  it('ships every wasm codec next to the bundles', () => {
    expect(Object.values(report.wasm)).toEqual(WASM.map(() => true));
  });
});
