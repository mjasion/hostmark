import type { Database } from '@hostmark/db';
import { describe, expect, it } from 'vitest';
import { createAuth, EXAMPLE_AUTH_SECRET, refuseExampleSecret } from '../src';

// Startup validation needs no database: the throw happens before Better Auth is configured.
const base = {
  db: {} as Database,
  secret: 'test-secret-test-secret-test-secret-0123456789',
  baseUrl: 'http://hostmark.test',
  signupEnabled: true,
};

describe('clientIpHeader validation at startup', () => {
  it.each(['bad header', 'x:y', 'cf\nip', 'ünï', 'a(b)'])('refuses %j', (clientIpHeader) => {
    expect(() => createAuth({ ...base, clientIpHeader })).toThrow(
      /clientIpHeader[\s\S]*not a valid HTTP header name/,
    );
  });

  it.each(['cf-connecting-ip', 'CF-Connecting-IP', ' x-real-ip ', 'fly-client-ip'])(
    'accepts %j',
    (clientIpHeader) => {
      expect(() => createAuth({ ...base, clientIpHeader })).not.toThrow();
    },
  );

  it('treats an empty value as unset', () => {
    expect(() => createAuth({ ...base, clientIpHeader: '  ' })).not.toThrow();
  });
});

describe('refuseExampleSecret', () => {
  it('refuses the .env.example value outside local only', () => {
    expect(() => refuseExampleSecret(EXAMPLE_AUTH_SECRET, 'production')).toThrow(/example value/);
    expect(() => refuseExampleSecret(`  ${EXAMPLE_AUTH_SECRET}\n`, 'staging')).toThrow(/example value/);
    expect(() => refuseExampleSecret(EXAMPLE_AUTH_SECRET, 'local')).not.toThrow();
    expect(() => refuseExampleSecret('another-secret-another-secret-12345678', 'production')).not.toThrow();
  });
});
