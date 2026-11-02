import { RUM_PLATFORMS } from '@hostmark/contract';
import { describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADER, platform } from '../src/platform';

describe('platform', () => {
  it('is railway-portable and starts with a platform of the closed RUM list', () => {
    expect(platform.key).toBe('railway-portable');
    expect(RUM_PLATFORMS).toContain(platform.key.split('-')[0]);
  });

  it('sets the client address header, whatever the environment says', () => {
    const env = platform.env?.({ AUTH_CLIENT_IP_HEADER: 'X-Forwarded-For', S3_BUCKET: 'b' });
    expect(env?.AUTH_CLIENT_IP_HEADER).toBe(CLIENT_IP_HEADER);
    expect(CLIENT_IP_HEADER).toBe('X-Real-IP');
    expect(env?.S3_BUCKET).toBe('b');
  });
});
