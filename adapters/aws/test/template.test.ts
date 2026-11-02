import { describe, expect, it } from 'vitest';
import { checkTemplate, loadTemplate, runCloudFrontFunction } from '../scripts/template-check';

describe('template.yaml', () => {
  it('passes the offline checks', () => {
    expect(checkTemplate()).toEqual([]);
  });

  it('notices a dangling reference and a drifted contract value', () => {
    const t = loadTemplate(
      'Resources:\n  A:\n    Type: AWS::SQS::Queue\n    Properties: { Q: !Ref Missing }\n',
    );
    expect(checkTemplate(t).join('\n')).toContain('Ref to unknown "Missing"');
  });
});

describe('CloudFront static function', () => {
  const uri = (u: string) => runCloudFrontFunction('SiteFunction', { uri: u }).uri;
  it('serves the shell for the single page app routes', () => {
    for (const u of ['/login', '/signup', '/app', '/app/', '/app/files/123'])
      expect(uri(u)).toBe('/app/index.html');
  });
  it('maps pages to their index file and leaves files alone', () => {
    expect(uri('/')).toBe('/index.html');
    expect(uri('/pricing')).toBe('/pricing/index.html');
    expect(uri('/pricing/')).toBe('/pricing/index.html');
    expect(uri('/assets/app-abc.js')).toBe('/assets/app-abc.js');
    expect(uri('/rum.js')).toBe('/rum.js');
  });
});

describe('CloudFront client address function', () => {
  it('sets the header from the viewer address', () => {
    const r = runCloudFrontFunction('ClientIpFunction', { uri: '/api/health' }, '198.51.100.7');
    expect(r.headers['x-hostmark-client-ip']).toEqual({ value: '198.51.100.7' });
  });
  it('overwrites a value sent by the client', () => {
    const r = runCloudFrontFunction(
      'ClientIpFunction',
      { uri: '/api/health', headers: { 'x-hostmark-client-ip': { value: '1.1.1.1' } } },
      '198.51.100.7',
    );
    expect(r.headers['x-hostmark-client-ip']?.value).toBe('198.51.100.7');
  });
  it('handles an IPv6 viewer', () => {
    const r = runCloudFrontFunction('ClientIpFunction', { uri: '/' }, '2001:db8::1');
    expect(r.headers['x-hostmark-client-ip']?.value).toBe('2001:db8::1');
  });
});
