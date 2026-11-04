import { readFileSync } from 'node:fs';
import { RUM_PLATFORMS } from '@hostmark/contract';
import { describe, expect, it } from 'vitest';
import { checkConfig, readInfra, resourceBlocks } from '../scripts/check-config';
import { loadGcpEnv } from '../src/env';
import { CLIENT_IP_HEADER, platform } from '../src/platform';
import { createPubSubQueue, MAX_DELAY_SECONDS } from '../src/queue';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('infra/', () => {
  it('matches the contract constants and the env schema', () => {
    expect(checkConfig()).toEqual([]);
  });

  it('notices a dead letter subscription that can expire', () => {
    const tf = readInfra();
    const dlq = resourceBlocks(tf, 'google_pubsub_subscription').get('dlq') ?? '';
    expect(dlq).toMatch(/expiration_policy/);
    const mutated = tf.replace(dlq, dlq.replace(/expiration_policy \{[^}]*\}/, ''));
    expect(mutated).not.toBe(tf);
    expect(checkConfig(mutated)).toEqual([
      'subscription dlq must never expire (expiration_policy { ttl = "" })',
    ]);
    expect(checkConfig(tf.replace(dlq, dlq.replace('ttl = ""', 'ttl = "2678400s"')))).toHaveLength(1);
  });

  it('notices a CDN TTL that the API refuses with USE_ORIGIN_HEADERS', () => {
    const tf = readInfra();
    const mutated = tf.replace(
      'cache_mode = "USE_ORIGIN_HEADERS"',
      'cache_mode = "USE_ORIGIN_HEADERS"\n    max_ttl    = 31622400',
    );
    expect(checkConfig(mutated)).toEqual(['max_ttl cannot be set with USE_ORIGIN_HEADERS']);
    expect(checkConfig(tf.replace('"USE_ORIGIN_HEADERS"', '"CACHE_ALL_STATIC"'))).toContain(
      'Cloud CDN must use the origin headers',
    );
  });

  it('notices a seed job without the seed keys', () => {
    const tf = readInfra();
    expect(checkConfig(tf.replace(/^\s*SEED_ADMIN_API_KEY\s*=.*$/m, ''))).toEqual([
      'the seed job must get SEED_ADMIN_API_KEY from Secret Manager',
    ]);
  });

  it('notices the review findings coming back', () => {
    const tf = readInfra();
    const services = resourceBlocks(tf, 'google_cloud_run_v2_service');
    const api = services.get('api') ?? '';
    const worker = services.get('worker') ?? '';
    const cases: [string, string][] = [
      [
        tf.replace('AUTH_SIGNUP_ENABLED = var.auth_signup_enabled', 'AUTH_SIGNUP_ENABLED = "true"'),
        'AUTH_SIGNUP_ENABLED must come from var.auth_signup_enabled, default "false" (D7)',
      ],
      [
        tf.replace(/^\s*OTLP_ENDPOINT = var\.otlp_endpoint\n/m, ''),
        'OTLP_ENDPOINT must come from var.otlp_endpoint, default "" (export off)',
      ],
      [
        tf.replace(api, api.replace('cpu_idle = false', 'cpu_idle = true')),
        'the api needs CPU outside requests (cpu_idle = false)',
      ],
      [
        tf.replace(api, api.replace('invoker_iam_disabled = true', '')),
        'the api must disable the invoker IAM check',
      ],
      [
        `${tf}\nresource "google_cloud_run_v2_service_iam_member" "public" {\n  member = "allUsers"\n}\n`,
        'no resource may be granted to allUsers',
      ],
      [
        tf.replace(
          worker,
          worker.replace('scaling_mode          = "MANUAL"', 'scaling_mode          = "AUTOMATIC"'),
        ),
        'the worker must scale manually to var.worker_instances',
      ],
      [
        tf.replace('retention_duration_seconds = 0', 'retention_duration_seconds = 604800'),
        'the bucket must keep no soft-deleted objects (retention_duration_seconds = 0)',
      ],
      [
        tf.replace('serve_while_stale = 600', 'serve_while_stale = 86400'),
        'Cloud CDN must serve stale content for at most 600 s',
      ],
      [
        tf.replace('https_redirect         = true', 'https_redirect         = false'),
        'the http url map must redirect to https',
      ],
      [
        tf.replace('"cloudresourcemanager.googleapis.com",', ''),
        'cloudresourcemanager.googleapis.com must be enabled',
      ],
      [
        tf.replace(
          '    S3_SECRET_ACCESS_KEY = google_secret_manager_secret.hmac_secret.secret_id\n',
          '    S3_SECRET_ACCESS_KEY = google_secret_manager_secret.hmac_secret.secret_id\n    SEED_API_KEY = google_secret_manager_secret.seed_api_key.secret_id\n',
        ),
        'api and worker must not get the seed keys',
      ],
      [
        tf.replace(/^ *S3_SECRET_ACCESS_KEY = "unused-by-the-scheduler"\n/m, ''),
        'environment of the scheduled jobs fails the schema: S3_SECRET_ACCESS_KEY',
      ],
    ];
    for (const [mutated, problem] of cases) {
      expect(mutated, problem).not.toBe(tf);
      expect(
        checkConfig(mutated).some((p) => p.startsWith(problem)),
        problem,
      ).toBe(true);
    }
  });

  it('holds no credentials', () => {
    expect(read('infra/main.tf')).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });
});

describe('platform', () => {
  it('is gcp-portable with a platform of the closed RUM list', () => {
    expect(platform.key).toBe('gcp-portable');
    expect(RUM_PLATFORMS).toContain(platform.key.split('-')[0]);
  });

  it('makes the api trust the header the load balancer sets (D80)', () => {
    expect(platform.env?.({}).AUTH_CLIENT_IP_HEADER).toBe(CLIENT_IP_HEADER);
    expect(read('infra/main.tf')).toContain(`${CLIENT_IP_HEADER}: {client_ip_address}`);
  });
});

describe('environment', () => {
  it('needs no Redis and defaults the queue names', () => {
    const env = loadGcpEnv({
      GCP_PROJECT: 'p',
      DATABASE_URL: 'postgres://x',
      S3_ENDPOINT: 'https://storage.googleapis.com',
      S3_BUCKET: 'bucket',
      S3_ACCESS_KEY_ID: 'a',
      S3_SECRET_ACCESS_KEY: 'b',
    });
    expect(env.PUBSUB_TOPIC).toBe('image-jobs');
    expect(env.PUBSUB_SUBSCRIPTION).toBe('image-jobs-worker');
    expect(env.CDN_URL_MAP).toBeUndefined();
  });
});

describe('queue', () => {
  it('refuses a delay that Pub/Sub cannot hold', async () => {
    const queue = createPubSubQueue({ project: 'p' });
    const msg = {
      v: 1,
      type: 'process_image',
      jobId: 'j',
      fileId: 'f',
      enqueuedAt: new Date().toISOString(),
      chaos: 'none',
    } as const;
    await expect(queue.send(msg, { delaySeconds: MAX_DELAY_SECONDS + 1 })).rejects.toThrow(RangeError);
  });
});
