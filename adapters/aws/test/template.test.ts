import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkTemplate,
  healthProbeKey,
  loadTemplate,
  runCloudFrontFunction,
  templatePath,
} from '../scripts/template-check';

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

  it('refuses a worker below the D79 memory and an api role that cannot read the health probe key', () => {
    const text = readFileSync(templatePath, 'utf8');
    expect(healthProbeKey()).toBe('healthcheck/probe');
    const low = loadTemplate(text.replace('Default: 4096', 'Default: 3008'));
    expect(checkTemplate(low).join('\n')).toContain('WorkerMemory Default must be at least 4096 MB');
    const noProbe = loadTemplate(text.replace('.Arn}/healthcheck/probe', '.Arn}/originals/x'));
    expect(checkTemplate(noProbe).join('\n')).toContain('ApiRole must allow s3:GetObject');
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

describe('CloudFront api viewer function', () => {
  it('sets the header from the viewer address', () => {
    const r = runCloudFrontFunction('ApiViewerFunction', { uri: '/api/health' }, '198.51.100.7');
    expect(r.headers['x-hostmark-client-ip']).toEqual({ value: '198.51.100.7' });
  });
  it('overwrites a value sent by the client', () => {
    const r = runCloudFrontFunction(
      'ApiViewerFunction',
      { uri: '/api/health', headers: { 'x-hostmark-client-ip': { value: '1.1.1.1' } } },
      '198.51.100.7',
    );
    expect(r.headers['x-hostmark-client-ip']?.value).toBe('198.51.100.7');
  });
  it('handles an IPv6 viewer', () => {
    const r = runCloudFrontFunction('ApiViewerFunction', { uri: '/' }, '2001:db8::1');
    expect(r.headers['x-hostmark-client-ip']?.value).toBe('2001:db8::1');
  });

  it('forwards the host the viewer used, so the origin check of D51 sees the public host', () => {
    const r = runCloudFrontFunction('ApiViewerFunction', {
      uri: '/api/uploads',
      headers: { host: { value: 'd111.cloudfront.net' } },
    });
    expect(r.headers['x-forwarded-host']).toEqual({ value: 'd111.cloudfront.net' });
  });
  it('overwrites a forwarded host sent by the client, and drops it without a Host', () => {
    const r = runCloudFrontFunction('ApiViewerFunction', {
      uri: '/api/uploads',
      headers: { host: { value: 'd111.cloudfront.net' }, 'x-forwarded-host': { value: 'evil.example' } },
    });
    expect(r.headers['x-forwarded-host']?.value).toBe('d111.cloudfront.net');
    const bare = runCloudFrontFunction('ApiViewerFunction', {
      uri: '/api/uploads',
      headers: { 'x-forwarded-host': { value: 'evil.example' } },
    });
    expect(bare.headers['x-forwarded-host']).toBeUndefined();
  });
});
