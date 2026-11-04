import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkTemplate,
  healthProbeKey,
  loadTemplate,
  runCloudFrontFunction,
  schedulerCron,
  staticFilePatterns,
  templatePath,
} from '../scripts/template-check';

describe('template.yaml', () => {
  it('passes the offline checks', () => {
    expect(checkTemplate()).toEqual([]);
  });

  it('pins the security headers of D310 to the contract and to each behavior', () => {
    const text = readFileSync(templatePath, 'utf8');
    const problems = (from: string | RegExp, to: string) => {
      const changed = text.replace(from, to);
      expect(changed).not.toBe(text);
      return checkTemplate(loadTemplate(changed)).join('\n');
    };
    expect(staticFilePatterns()).toEqual(['/assets/*', '/favicon.svg', '/robots.txt', '/rum.js']);
    // The policy: unsafe-inline instead of the hash, another storage origin, a missing directive.
    expect(problems(/'sha256-[^']+'/, "'unsafe-inline'")).toContain('differs from htmlCsp');
    expect(problems('data: https://s3.', 'data: https://')).toContain('differs from htmlCsp');
    expect(problems(" object-src 'none';", '')).toContain('differs from htmlCsp');
    // HSTS stays for one host.
    expect(problems('IncludeSubdomains: false', 'IncludeSubdomains: true')).toContain(
      'SiteHtmlHeadersPolicy: HSTS max-age 31536000 without includeSubDomains or preload',
    );
    expect(problems(/Preload: false\n(\s+)Override: false/, 'Preload: true\n$1Override: false')).toContain(
      'AppHeadersPolicy: HSTS',
    );
    // The app's own values win under /api, /media and /f.
    expect(
      problems('ContentTypeOptions: { Override: false }', 'ContentTypeOptions: { Override: true }'),
    ).toContain('AppHeadersPolicy: X-Content-Type-Options with Override false');
    // A non-HTML file left to the default behavior would get the HTML set.
    expect(problems(/ {10}- PathPattern: \/robots\.txt\n(?: {12}.*\n)+?(?= {10}- )/, '')).toContain(
      'SiteHeadersPolicy behaviors must be exactly',
    );
    expect(
      problems(
        'ResponseHeadersPolicyId: !Ref SiteHtmlHeadersPolicy',
        'ResponseHeadersPolicyId: !Ref SiteHeadersPolicy',
      ),
    ).toContain('The default behavior (the HTML documents) must use SiteHtmlHeadersPolicy');
    expect(problems('Value: same-origin, Override: true', 'Value: unsafe-none, Override: true')).toContain(
      'custom headers must be exactly',
    );
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

  it('refuses the review findings coming back', () => {
    const text = readFileSync(templatePath, 'utf8');
    const problems = (from: string | RegExp, to: string) => {
      const changed = text.replace(from, to);
      expect(changed).not.toBe(text);
      return checkTemplate(loadTemplate(changed)).join('\n');
    };
    // s3:ListBucket, so that a missing key reads as 404 (both roles), and without a condition.
    expect(problems(/Action: "s3:ListBucket"/g, 'Action: "s3:GetBucketLocation"')).toMatch(
      /ApiRole must allow s3:ListBucket[\s\S]*WorkerRole must allow s3:ListBucket/,
    );
    expect(
      problems(
        /(Action: "s3:ListBucket"\n(\s+)Resource: !GetAtt Bucket.Arn)/,
        '$1\n$2Condition: { StringLike: { "s3:prefix": ["originals/*"] } }',
      ),
    ).toContain('ApiRole must allow s3:ListBucket on the bucket, without a condition');
    // One run per tick: no Lambda retry of the asynchronous scheduler invocation.
    expect(problems('MaximumEventAgeInSeconds: 60', 'MaximumEventAgeInSeconds: 21600')).toContain(
      'SchedulerFunction needs an EventInvokeConfig',
    );
    expect(
      problems(/MaximumRetryAttempts: 0\n\s+MaximumEventAgeInSeconds/, 'MaximumEventAgeInSeconds'),
    ).toContain('SchedulerFunction needs an EventInvokeConfig');
    // The documented cron form, and the contract value.
    expect(problems('cron(0/15 * * * ? *)', 'cron(*/15 * * * ? *)')).toContain('Schedule of cleanup-expired');
    // The origin response timeout: above the SSE cap, within the range without a quota request.
    expect(problems('OriginReadTimeout: 90', 'OriginReadTimeout: 60')).toContain('OriginReadTimeout');
    expect(problems('OriginReadTimeout: 90', 'OriginReadTimeout: 180')).toContain('OriginReadTimeout');
    // The alarm on the dead letter queue (F1).
    expect(problems('Threshold: 0', 'Threshold: 5')).toContain('DeadLetterQueue');
    // The api's connection cap.
    expect(problems('ReservedConcurrentExecutions: !Ref ApiReservedConcurrency', 'Description: x')).toContain(
      'ApiReservedConcurrency',
    );
    // A distribution-wide error mapping would rewrite the api's 403s.
    expect(
      problems(
        '        Origins:\n',
        '        CustomErrorResponses: [{ ErrorCode: 403, ResponseCode: 404, ResponsePagePath: /404.html }]\n        Origins:\n',
      ),
    ).toContain('No CustomErrorResponses');
    // The custom domain is optional and needs both parameters.
    expect(problems('Aliases: !If [HasCustomDomain', 'Aliases: !If [HasOtlp')).toContain(
      'Distribution Aliases must depend on the HasCustomDomain condition',
    );
  });

  it('writes the contract crons in the Scheduler form', () => {
    expect(schedulerCron('*/15 * * * *')).toBe('cron(0/15 * * * ? *)');
    expect(schedulerCron('*/5 * * * *')).toBe('cron(0/5 * * * ? *)');
    expect(schedulerCron('5 0 * * *')).toBe('cron(5 0 * * ? *)');
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
