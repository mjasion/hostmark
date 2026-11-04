import { RUM_PLATFORMS } from '@hostmark/contract';
import { describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADER, platform } from '../src/platform';

const tigris = {
  AWS_ENDPOINT_URL_S3: 'https://fly.storage.tigris.dev',
  AWS_ACCESS_KEY_ID: 'tid_key',
  AWS_SECRET_ACCESS_KEY: 'tsec_secret',
  AWS_REGION: 'auto',
  BUCKET_NAME: 'hostmark-bucket',
};

describe('platform', () => {
  it('is fly-portable and starts with a platform of the closed RUM list', () => {
    expect(platform.key).toBe('fly-portable');
    expect(RUM_PLATFORMS).toContain(platform.key.split('-')[0]);
  });

  it('reads the Tigris secrets of `fly storage create` as the S3 settings', () => {
    const env = platform.env?.(tigris);
    expect(env).toMatchObject({
      S3_ENDPOINT: 'https://fly.storage.tigris.dev',
      S3_BUCKET: 'hostmark-bucket',
      S3_ACCESS_KEY_ID: 'tid_key',
      S3_SECRET_ACCESS_KEY: 'tsec_secret',
      S3_REGION: 'auto',
      S3_VIRTUAL_HOST: 'true',
    });
  });

  it('uses virtual-hosted-style S3 URLs, which Tigris requires, unless set otherwise (D280)', () => {
    expect(platform.env?.(tigris)?.S3_VIRTUAL_HOST).toBe('true');
    expect(platform.env?.({ ...tigris, S3_VIRTUAL_HOST: 'false' })?.S3_VIRTUAL_HOST).toBe('false');
  });

  it('lets explicit S3 settings win, and ignores empty ones', () => {
    const env = platform.env?.({ ...tigris, S3_BUCKET: 'explicit', S3_REGION: '' });
    expect(env?.S3_BUCKET).toBe('explicit');
    expect(env?.S3_REGION).toBe('auto');
  });

  it('defaults the region to auto without AWS_REGION', () => {
    expect(platform.env?.({})?.S3_REGION).toBe('auto');
  });

  it('sets the client address header, whatever the environment says', () => {
    expect(platform.env?.({ AUTH_CLIENT_IP_HEADER: 'X-Forwarded-For' })?.AUTH_CLIENT_IP_HEADER).toBe(
      CLIENT_IP_HEADER,
    );
    expect(CLIENT_IP_HEADER).toBe('Fly-Client-IP');
  });
});
