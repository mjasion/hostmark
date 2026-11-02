import { RUM_PLATFORMS, RUM_REGIONS } from '@hostmark/contract';
import { describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADER, platform } from '../src/platform';

describe('platform', () => {
  it('is vps-portable and starts with a platform of the closed RUM list', () => {
    expect(platform.key).toBe('vps-portable');
    expect(RUM_PLATFORMS).toContain(platform.key.split('-')[0]);
  });

  it('sets the client address header, whatever the environment says', () => {
    const mapped = platform.env?.({ AUTH_CLIENT_IP_HEADER: 'X-Forwarded-For', S3_BUCKET: 'b' });
    expect(mapped?.AUTH_CLIENT_IP_HEADER).toBe(CLIENT_IP_HEADER);
    expect(mapped?.S3_BUCKET).toBe('b');
  });
});

describe('Dockerfile defaults', () => {
  it('use values of the closed RUM lists', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(text).toContain('ARG HOSTMARK_PLATFORM=vps\n');
    const region = /^ARG HOSTMARK_REGION=(.*)$/m.exec(text)?.[1];
    expect(RUM_REGIONS).toContain(region);
  });
});
