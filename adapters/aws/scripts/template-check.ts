// Offline checks of template.yaml: no AWS API is called. cfn-lint was not available in this environment, so the checks
// below cover what has gone wrong in practice (dangling references, drift from the contract constants, missing
// settings) and nothing more: `aws cloudformation validate-template` and cfn-lint remain for the owner (README).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  BACKOFF_SECONDS,
  COMMON_SECURITY_HEADERS,
  HSTS_SECONDS,
  HTML_SECURITY_HEADERS,
  htmlCsp,
  MAX_ATTEMPTS,
  SCHEDULER_JOBS,
  SSE_MAX_DURATION_MS,
} from '@hostmark/contract';
import { STYLE_HASHES } from '@hostmark/pages/styles';
import { presignedOrigin } from '@hostmark/storage-s3';
import { type CollectionTag, parse, type ScalarTag } from 'yaml';
import { s3Endpoint, varsSchema } from '../src/env';

export const templatePath = fileURLToPath(new URL('../template.yaml', import.meta.url));
const coreAppPath = fileURLToPath(new URL('../../../packages/core/src/http/app.ts', import.meta.url));

/** The key `/api/health/deep` sends HEAD for. Read from the core source, which does not export it. */
export function healthProbeKey(source = readFileSync(coreAppPath, 'utf8')): string {
  const keys = [...source.matchAll(/storage\.head\('([^']+)'\)/g)].map((m) => m[1] as string);
  if (keys.length !== 1) throw new Error(`expected one storage.head('<key>') in core, found ${keys.length}`);
  return keys[0] as string;
}

/** Minimum worker memory in MB: D79 measured 3.0 to 3.2 GiB per process, and the other platforms give 4 GiB. */
export const WORKER_MEMORY_FLOOR_MB = 4096;

/** CloudFront's origin response timeout without a quota increase: 1 to 120 s. */
export const ORIGIN_READ_TIMEOUT_MAX_S = 120;

/**
 * A contract cron expression (`min hour * * *`, D19) in EventBridge Scheduler's form: six fields, `?` for the day of
 * the week, and an increment written with its start (`0/15`) as in the Scheduler documentation, not with an asterisk.
 */
export function schedulerCron(contractCron: string): string {
  const [min, hour] = contractCron.split(' ').map((f) => f.replace(/^\*\//, '0/'));
  return `cron(${min} ${hour} * * ? *)`;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = { [key: string]: Json };

const FUNCTIONS = [
  'Ref',
  'GetAtt',
  'Sub',
  'If',
  'Select',
  'Split',
  'Not',
  'Equals',
  'Join',
  'And',
  'Or',
  'Condition',
];
const fnKey = (name: string) => (name === 'Ref' || name === 'Condition' ? name : `Fn::${name}`);
const customTags: Array<ScalarTag | CollectionTag> = FUNCTIONS.flatMap((name) => [
  {
    tag: `!${name}`,
    resolve: (value: string) =>
      ({
        [fnKey(name)]:
          name === 'GetAtt'
            ? [value.slice(0, value.indexOf('.')), value.slice(value.indexOf('.') + 1)]
            : value,
      }) as never,
  } satisfies ScalarTag,
  {
    tag: `!${name}`,
    collection: 'seq',
    resolve: (seq: { toJSON(): unknown }) => ({ [fnKey(name)]: seq.toJSON() }) as never,
  } satisfies CollectionTag,
]);

export function loadTemplate(text = readFileSync(templatePath, 'utf8')): Node {
  return parse(text, { customTags }) as Node;
}

const PSEUDO = new Set(['AWS::StackName', 'AWS::Region', 'AWS::AccountId', 'AWS::Partition', 'AWS::NoValue']);

/** Every `Ref`, `GetAtt`, `Sub` placeholder and condition name that the template uses. */
function walk(node: Json, visit: (key: string, value: Json) => void): void {
  if (Array.isArray(node)) for (const n of node) walk(n, visit);
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      visit(k, v);
      walk(v, visit);
    }
}

export function checkTemplate(template = loadTemplate()): string[] {
  const problems: string[] = [];
  const params = (template.Parameters ?? {}) as Node;
  const resources = (template.Resources ?? {}) as Record<string, Node>;
  const conditions = (template.Conditions ?? {}) as Node;
  const known = (name: string) => name in params || name in resources || PSEUDO.has(name);
  const getAtt = (name: string) => resources[name] !== undefined;

  walk(template as Json, (key, value) => {
    if (key === 'Ref' && typeof value === 'string' && !known(value))
      problems.push(`Ref to unknown "${value}"`);
    if (key === 'Fn::GetAtt' && Array.isArray(value) && !getAtt(String(value[0])))
      problems.push(`GetAtt of unknown "${value[0]}"`);
    if (key === 'Fn::Sub' && typeof value === 'string')
      for (const m of value.matchAll(/\$\{([^}!]+)\}/g)) {
        const name = (m[1] as string).split('.')[0] as string;
        if (!known(name)) problems.push(`Sub placeholder of unknown "${name}"`);
      }
    if (key === 'Fn::If' && Array.isArray(value) && !(String(value[0]) in conditions))
      problems.push(`If of unknown condition "${value[0]}"`);
  });

  for (const [name, r] of Object.entries(resources)) {
    const needs = JSON.stringify(r.DependsOn ?? []);
    for (const dep of [r.DependsOn].flat().filter(Boolean) as string[])
      if (!resources[dep]) problems.push(`${name} depends on unknown "${dep}" ${needs}`);
  }

  // Secrets stay out of the template: the parameters that carry them are NoEcho.
  for (const p of ['DatabaseUrl', 'BetterAuthSecret', 'OriginSecret', 'OtlpHeaders'])
    if ((params[p] as Node | undefined)?.NoEcho !== true) problems.push(`Parameter ${p} must be NoEcho`);

  // Contract constants.
  const props = (name: string) => (resources[name]?.Properties ?? {}) as Node;
  // A template without these resources (the test fixture) reports the dangling references above and stops here.
  if (!resources.JobQueue || !resources.WorkerFunction) return problems;
  const redrive = props('JobQueue').RedrivePolicy as Node | undefined;
  if (redrive?.maxReceiveCount !== MAX_ATTEMPTS)
    problems.push(`maxReceiveCount must be ${MAX_ATTEMPTS} (D17)`);
  const workerTimeout = props('WorkerFunction').Timeout as number;
  if ((props('JobQueue').VisibilityTimeout as number) < 6 * workerTimeout)
    problems.push('Queue VisibilityTimeout must be at least 6 times the worker timeout');
  if (props('WorkerMapping').BatchSize !== 1)
    problems.push('The event source mapping needs BatchSize 1 (D17)');
  if (!JSON.stringify(props('WorkerMapping').FunctionResponseTypes).includes('ReportBatchItemFailures'))
    problems.push('The event source mapping needs ReportBatchItemFailures');
  if (BACKOFF_SECONDS.length + 1 !== MAX_ATTEMPTS)
    problems.push('BACKOFF_SECONDS no longer matches MAX_ATTEMPTS');

  // D79: the worker memory parameter cannot go below the measured peak plus the margin of the other platforms.
  const memory = params.WorkerMemory as Node | undefined;
  if (JSON.stringify(props('WorkerFunction').MemorySize) !== JSON.stringify({ Ref: 'WorkerMemory' }))
    problems.push('WorkerFunction MemorySize must be the WorkerMemory parameter');
  for (const key of ['Default', 'MinValue'])
    if (!(Number(memory?.[key]) >= WORKER_MEMORY_FLOOR_MB))
      problems.push(`WorkerMemory ${key} must be at least ${WORKER_MEMORY_FLOOR_MB} MB (D79)`);

  // /api/health/deep: the api role must be able to read the probe key, or the check answers 503 for ever.
  const probeResource = `\${Bucket.Arn}/${healthProbeKey()}`;
  const statementsOf = (role: string) =>
    ((props(role).Policies ?? []) as Node[]).flatMap(
      (p) => ((p.PolicyDocument as Node | undefined)?.Statement ?? []) as Node[],
    );
  const apiStatements = statementsOf('ApiRole');
  const readsProbe = apiStatements.some(
    (s) =>
      s.Effect === 'Allow' &&
      [s.Action].flat().includes('s3:GetObject') &&
      [s.Resource].flat().some((r) => JSON.stringify(r) === JSON.stringify({ 'Fn::Sub': probeResource })),
  );
  if (!readsProbe) problems.push(`ApiRole must allow s3:GetObject on ${probeResource}`);

  // Without s3:ListBucket a missing key answers 403, not 404: `complete` before the PUT would be 500, not 409. The
  // grant is on the bucket and unconditioned (an s3:prefix condition is evaluated on list requests only).
  for (const role of ['ApiRole', 'WorkerRole']) {
    const lists = statementsOf(role).some(
      (s) =>
        s.Effect === 'Allow' &&
        [s.Action].flat().includes('s3:ListBucket') &&
        JSON.stringify(s.Resource) === JSON.stringify({ 'Fn::GetAtt': ['Bucket', 'Arn'] }) &&
        s.Condition === undefined,
    );
    if (!lists) problems.push(`${role} must allow s3:ListBucket on the bucket, without a condition`);
  }

  // D74: originals/ and variants/ expire after 8 days.
  const rules = ((props('Bucket').LifecycleConfiguration as Node | undefined)?.Rules ??
    []) as unknown as Node[];
  for (const prefix of ['originals/', 'variants/']) {
    const rule = rules.find((r) => r.Prefix === prefix);
    if (rule?.Status !== 'Enabled' || rule.ExpirationInDays !== 8)
      problems.push(`No enabled 8 day lifecycle rule for ${prefix} (D74)`);
  }

  // D19: one schedule per job, with the contract's cron expression.
  const schedules = Object.values(resources).filter((r) => r.Type === 'AWS::Scheduler::Schedule');
  for (const [job, cron] of Object.entries(SCHEDULER_JOBS)) {
    const s = schedules.find(
      (r) => ((r.Properties as Node).Target as Node).Input === JSON.stringify({ job }),
    );
    const expected = schedulerCron(cron);
    if (!s) problems.push(`No schedule for ${job}`);
    else if ((s.Properties as Node).ScheduleExpression !== expected)
      problems.push(
        `Schedule of ${job} is ${(s.Properties as Node).ScheduleExpression}, expected ${expected}`,
      );
  }
  if (schedules.length !== Object.keys(SCHEDULER_JOBS).length)
    problems.push('Unexpected number of schedules');
  for (const s of schedules)
    if (
      ((s.Properties as Node).Target as Node).RetryPolicy === undefined ||
      (((s.Properties as Node).Target as Node).RetryPolicy as Node).MaximumRetryAttempts !== 0
    )
      problems.push('Every schedule needs RetryPolicy.MaximumRetryAttempts 0 (one run per tick, D19)');
  // The Scheduler invokes asynchronously and Lambda retries a failed asynchronous invocation twice by default.
  const invokeConfig = Object.values(resources).find(
    (r) =>
      r.Type === 'AWS::Lambda::EventInvokeConfig' &&
      JSON.stringify((r.Properties as Node).FunctionName) === JSON.stringify({ Ref: 'SchedulerFunction' }),
  );
  const invoke = invokeConfig?.Properties as Node | undefined;
  if (
    invoke?.MaximumRetryAttempts !== 0 ||
    invoke.MaximumEventAgeInSeconds !== 60 ||
    invoke.Qualifier !== '$LATEST'
  )
    problems.push(
      'SchedulerFunction needs an EventInvokeConfig on $LATEST with MaximumRetryAttempts 0 and MaximumEventAgeInSeconds 60',
    );

  // F1, "alert DLQ > 0": an alarm on the visible messages of the dead letter queue.
  const dlqAlarm = Object.values(resources).find((r) => {
    if (r.Type !== 'AWS::CloudWatch::Alarm') return false;
    const a = r.Properties as Node;
    return (
      a.Namespace === 'AWS/SQS' &&
      a.MetricName === 'ApproximateNumberOfMessagesVisible' &&
      JSON.stringify(a.Dimensions).includes(
        JSON.stringify({ 'Fn::GetAtt': ['DeadLetterQueue', 'QueueName'] }),
      ) &&
      a.Threshold === 0 &&
      a.ComparisonOperator === 'GreaterThanThreshold'
    );
  });
  if (!dlqAlarm)
    problems.push('No alarm on ApproximateNumberOfMessagesVisible > 0 of the DeadLetterQueue (F1)');

  // The api holds one database connection per environment: its concurrency is capped by a parameter.
  if (
    JSON.stringify(props('ApiFunction').ReservedConcurrentExecutions) !==
    JSON.stringify({ Ref: 'ApiReservedConcurrency' })
  )
    problems.push('ApiFunction ReservedConcurrentExecutions must be the ApiReservedConcurrency parameter');

  // Environment variables: every name is known to the app, and each function gets what its service requires.
  const names = new Set(Object.keys(varsSchema.shape));
  for (const [fn, service, required] of [
    [
      'ApiFunction',
      'api',
      [
        'PUBLIC_URL',
        'DATABASE_URL',
        'BETTER_AUTH_SECRET',
        'S3_BUCKET',
        'SQS_QUEUE_URL',
        'ORIGIN_SECRET',
        'CLOUDFRONT_DISTRIBUTION_ID',
      ],
    ],
    [
      'WorkerFunction',
      'worker',
      [
        'PUBLIC_URL',
        'DATABASE_URL',
        'BETTER_AUTH_SECRET',
        'S3_BUCKET',
        'SQS_QUEUE_URL',
        'CLOUDFRONT_DISTRIBUTION_ID',
      ],
    ],
    [
      'SchedulerFunction',
      'scheduler',
      [
        'PUBLIC_URL',
        'DATABASE_URL',
        'BETTER_AUTH_SECRET',
        'S3_BUCKET',
        'SQS_QUEUE_URL',
        'CLOUDFRONT_DISTRIBUTION_ID',
      ],
    ],
  ] as const) {
    const vars = Object.keys(((props(fn).Environment as Node | undefined)?.Variables ?? {}) as Node);
    for (const v of vars) if (!names.has(v)) problems.push(`${service}: ${v} is not a variable of the app`);
    for (const v of [...required, 'OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'])
      if (!vars.includes(v)) problems.push(`${service}: ${v} is missing`);
    if (props(fn).Runtime !== 'nodejs22.x') problems.push(`${fn}: runtime must be nodejs22.x`);
  }

  // Function URL: streaming (SSE) and the permission pair.
  if (props('ApiUrl').InvokeMode !== 'RESPONSE_STREAM') problems.push('ApiUrl must stream (SSE, D20)');
  const ssz = (props('Distribution').DistributionConfig as Node).CacheBehaviors as unknown as Node[];
  const patterns = ssz.map((b) => b.PathPattern);
  for (const p of ['/api/*', '/media/*', '/f/*'])
    if (!patterns.includes(p)) problems.push(`No behavior for ${p}`);
  const apiBehavior = ssz.find((b) => b.PathPattern === '/api/*');
  if (!JSON.stringify(apiBehavior?.FunctionAssociations).includes('ApiViewerFunction'))
    problems.push('/api/* must run the viewer function (client address D80, forwarded host D51)');
  if (apiBehavior?.Compress !== false) problems.push('/api/* must not compress (it would buffer SSE)');

  // CloudFront waits at most OriginReadTimeout between two packets of the api: longer than the SSE cap, within the
  // range that needs no quota increase.
  const config = props('Distribution').DistributionConfig as Node;
  const apiOrigin = (config.Origins as unknown as Node[]).find((o) => o.Id === 'api');
  const readTimeout = (apiOrigin?.CustomOriginConfig as Node | undefined)?.OriginReadTimeout as number;
  if (!(readTimeout > SSE_MAX_DURATION_MS / 1000 && readTimeout <= ORIGIN_READ_TIMEOUT_MAX_S))
    problems.push(
      `The api origin's OriginReadTimeout must be above ${SSE_MAX_DURATION_MS / 1000} s (SSE) and at most ${ORIGIN_READ_TIMEOUT_MAX_S} s`,
    );
  // A custom domain needs both the aliases and the certificate; without one, the distribution keeps its own.
  for (const key of ['Aliases', 'ViewerCertificate'])
    if (((config[key] as Node | undefined)?.['Fn::If'] as Json[] | undefined)?.[0] !== 'HasCustomDomain')
      problems.push(`Distribution ${key} must depend on the HasCustomDomain condition`);
  // CustomErrorResponses apply to every behavior and would rewrite the api's own statuses.
  if (config.CustomErrorResponses !== undefined)
    problems.push('No CustomErrorResponses: they would also rewrite the api responses');
  problems.push(...checkSecurityHeaders(template));
  return problems;
}

const webPublic = fileURLToPath(new URL('../../../apps/web/public', import.meta.url));

/**
 * The static files that are not HTML and are served from the root or `/assets/`: each needs a behavior with the common
 * headers only (D310), else the default behavior gives it the HTML set. `rum.js` is a build output (D85); the rest is
 * what Vite copies from apps/web/public.
 */
export function staticFilePatterns(publicDir = webPublic): string[] {
  return ['/assets/*', '/rum.js', ...readdirSync(publicDir).map((f) => `/${f}`)].sort();
}

/** `!Sub` text of the HTML policy with the region filled in, as CloudFront would see it in `region`. */
const subIn = (value: Json, region: string) =>
  String((value as Node | undefined)?.['Fn::Sub'] ?? '').replace(/\$\{AWS::Region\}/g, region);

/**
 * D310 against the contract: the HTML policy (its storage origin derived the way the functions presign, its style
 * hashes from packages/pages), the common set and HSTS without includeSubDomains or preload on every policy, the HTML
 * extras on the HTML policy only, and which behavior uses which policy.
 */
export function checkSecurityHeaders(template: Node, publicDir = webPublic): string[] {
  const problems: string[] = [];
  const resources = (template.Resources ?? {}) as Record<string, Node>;
  const policy = (name: string) =>
    ((resources[name]?.Properties as Node | undefined)?.ResponseHeadersPolicyConfig ?? {}) as Node;
  const security = (name: string) => (policy(name).SecurityHeadersConfig ?? {}) as Record<string, Node>;

  const region = 'eu-central-1';
  const storageOrigin = presignedOrigin({ endpoint: s3Endpoint({ AWS_REGION: region }), bucket: 'hostmark' });
  const csp = security('SiteHtmlHeadersPolicy').ContentSecurityPolicy;
  if (
    subIn(csp?.ContentSecurityPolicy ?? null, region) !==
    htmlCsp({ storageOrigin, styleHashes: STYLE_HASHES })
  )
    problems.push(
      'SiteHtmlHeadersPolicy: the Content-Security-Policy differs from htmlCsp of the contract (D310)',
    );
  for (const fn of ['ApiFunction', 'WorkerFunction', 'SchedulerFunction']) {
    const vars = ((resources[fn]?.Properties as Node | undefined)?.Environment as Node | undefined)
      ?.Variables as Node | undefined;
    if (vars && ('S3_ENDPOINT' in vars || 'S3_PUBLIC_ENDPOINT' in vars))
      problems.push(`${fn}: an S3 endpoint changes the presigned origin, which the HTML policy names (D310)`);
  }

  for (const [name, override] of [
    ['SiteHtmlHeadersPolicy', true],
    ['SiteHeadersPolicy', true],
    ['AppHeadersPolicy', false],
  ] as const) {
    const s = security(name);
    if (s.ContentTypeOptions?.Override !== override)
      problems.push(`${name}: X-Content-Type-Options with Override ${override}`);
    if (
      s.ReferrerPolicy?.ReferrerPolicy !== COMMON_SECURITY_HEADERS['referrer-policy'] ||
      s.ReferrerPolicy?.Override !== override
    )
      problems.push(
        `${name}: Referrer-Policy ${COMMON_SECURITY_HEADERS['referrer-policy']}, Override ${override}`,
      );
    const hsts = s.StrictTransportSecurity;
    if (
      hsts?.AccessControlMaxAgeSec !== HSTS_SECONDS ||
      hsts.IncludeSubdomains !== false ||
      hsts.Preload !== false ||
      hsts.Override !== override
    )
      problems.push(
        `${name}: HSTS max-age ${HSTS_SECONDS} without includeSubDomains or preload, Override ${override}`,
      );
    const html = name === 'SiteHtmlHeadersPolicy';
    if (!html && (s.ContentSecurityPolicy || s.FrameOptions || policy(name).CustomHeadersConfig))
      problems.push(`${name}: only the common headers (D310)`);
    if (html) {
      if (s.FrameOptions?.FrameOption !== HTML_SECURITY_HEADERS['x-frame-options'] || csp?.Override !== true)
        problems.push(`${name}: X-Frame-Options DENY and the policy, both with Override true`);
      const custom = (((policy(name).CustomHeadersConfig as Node | undefined)?.Items ?? []) as Node[]).map(
        (i) => [String(i.Header).toLowerCase(), i.Value, i.Override],
      );
      const want = Object.entries(HTML_SECURITY_HEADERS)
        .filter(([h]) => h !== 'x-frame-options')
        .map(([h, v]) => [h, v, true]);
      if (JSON.stringify(custom) !== JSON.stringify(want))
        problems.push(`${name}: custom headers must be exactly ${JSON.stringify(want)}`);
    }
  }

  const config = (resources.Distribution?.Properties as Node | undefined)?.DistributionConfig as
    | Node
    | undefined;
  const ref = (behavior: Node | undefined) => (behavior?.ResponseHeadersPolicyId as Node | undefined)?.Ref;
  const defaults = config?.DefaultCacheBehavior as Node | undefined;
  if (ref(defaults) !== 'SiteHtmlHeadersPolicy')
    problems.push('The default behavior (the HTML documents) must use SiteHtmlHeadersPolicy');
  const behaviors = (config?.CacheBehaviors ?? []) as Node[];
  for (const pattern of ['/api/*', '/media/*', '/f/*'])
    if (ref(behaviors.find((b) => b.PathPattern === pattern)) !== 'AppHeadersPolicy')
      problems.push(`${pattern} must use AppHeadersPolicy`);
  const staticBehaviors = behaviors.filter((b) => ref(b) === 'SiteHeadersPolicy');
  const patterns = staticBehaviors.map((b) => String(b.PathPattern)).sort();
  if (JSON.stringify(patterns) !== JSON.stringify(staticFilePatterns(publicDir)))
    problems.push(
      `SiteHeadersPolicy behaviors must be exactly ${staticFilePatterns(publicDir).join(', ')}, are ${patterns.join(', ')}`,
    );
  for (const b of staticBehaviors)
    for (const key of [
      'TargetOriginId',
      'CachePolicyId',
      'ViewerProtocolPolicy',
      'AllowedMethods',
      'Compress',
    ])
      if (JSON.stringify(b[key]) !== JSON.stringify(defaults?.[key]))
        problems.push(`${b.PathPattern}: ${key} must be the default behavior's`);
  return problems;
}

export interface FunctionResult {
  uri: string;
  headers: Record<string, { value: string }>;
}

/** Runs the inline CloudFront Function code of a resource the way CloudFront would, on a viewer request. */
export function runCloudFrontFunction(
  resource: 'SiteFunction' | 'ApiViewerFunction',
  request: { uri: string; headers?: Record<string, { value: string }> },
  viewerIp = '203.0.113.9',
  template = loadTemplate(),
): FunctionResult {
  const code = (((template.Resources as Record<string, Node>)[resource] as Node).Properties as Node)
    .FunctionCode as string;
  const context = vm.createContext({});
  vm.runInContext(code, context);
  const event = { request: { method: 'GET', headers: {}, ...request }, viewer: { ip: viewerIp } };
  return vm.runInContext('handler', context)(event) as FunctionResult;
}
