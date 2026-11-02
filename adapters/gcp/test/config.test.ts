import { readFileSync } from 'node:fs';
import { RUM_PLATFORMS } from '@hostmark/contract';
import { describe, expect, it } from 'vitest';
import { checkConfig } from '../scripts/check-config';
import { loadGcpEnv } from '../src/env';
import { CLIENT_IP_HEADER, platform } from '../src/platform';
import { createPubSubQueue, MAX_DELAY_SECONDS } from '../src/queue';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('infra/', () => {
  it('matches the contract constants and the env schema', () => {
    expect(checkConfig()).toEqual([]);
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
