import { describe, expect, it } from 'vitest';
import {
  API_CSP,
  checkOrigin,
  HSTS,
  HTML_SECURITY_HEADERS,
  htmlCsp,
  securityHeaders,
  shareCsp,
} from '../src/security';

const HASH = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';

describe('security headers (D310)', () => {
  it('is the approved HTML policy, with the storage origin and the style hashes', () => {
    expect(htmlCsp({ storageOrigin: 'https://bucket.example.net', styleHashes: [HASH] })).toBe(
      `default-src 'self'; script-src 'self'; style-src 'self' '${HASH}'; img-src 'self' data: https://bucket.example.net; connect-src 'self' https://bucket.example.net; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    );
    expect(htmlCsp({ styleHashes: [] })).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  it('keeps the /f policy of D82 with a hash instead of unsafe-inline', () => {
    const csp = shareCsp([HASH]);
    expect(csp).toBe(
      `default-src 'none'; style-src '${HASH}'; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(csp).not.toContain('unsafe');
  });

  it('refuses anything but an origin and a hash source, so nothing else can enter a policy', () => {
    for (const bad of [
      'https://a.example/x',
      'https://a.example; script-src *',
      'ftp://a.example',
      'a.example',
      '',
    ])
      expect(() => htmlCsp({ storageOrigin: bad || 'x', styleHashes: [] }), bad).toThrow();
    expect(() => htmlCsp({ styleHashes: ["sha256-x'; script-src *"] })).toThrow();
    expect(checkOrigin('http://127.0.0.1:59000')).toBe('http://127.0.0.1:59000');
  });

  it('builds the set per kind, HSTS only over HTTPS and without includeSubDomains or preload', () => {
    expect(securityHeaders('other', { https: false })).toEqual({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    expect(HSTS).toBe('max-age=31536000');
    expect(securityHeaders('other', { https: true })['strict-transport-security']).toBe(HSTS);
    expect(securityHeaders('api', { https: false })['content-security-policy']).toBe(API_CSP);
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
    const share = securityHeaders('share', { https: true, styleHashes: [HASH] });
    expect(share['referrer-policy']).toBe('same-origin');
    expect(share['content-security-policy']).toBe(shareCsp([HASH]));
    expect(share['x-frame-options']).toBeUndefined();
    const html = securityHeaders('html', {
      https: true,
      storageOrigin: 'https://s.example',
      styleHashes: [HASH],
    });
    expect(html).toEqual({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'strict-transport-security': HSTS,
      'content-security-policy': htmlCsp({ storageOrigin: 'https://s.example', styleHashes: [HASH] }),
      ...HTML_SECURITY_HEADERS,
    });
    expect(HTML_SECURITY_HEADERS).toEqual({
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    });
  });
});
