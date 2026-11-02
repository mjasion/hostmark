// Offline checks of template.yaml: no AWS API is called. cfn-lint was not available in this environment, so the checks
// below cover what has gone wrong in practice (dangling references, drift from the contract constants, missing
// settings) and nothing more: `aws cloudformation validate-template` and cfn-lint remain for the owner (README).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { BACKOFF_SECONDS, MAX_ATTEMPTS, SCHEDULER_JOBS } from '@hostmark/contract';
import { type CollectionTag, parse, type ScalarTag } from 'yaml';
import { varsSchema } from '../src/env';

export const templatePath = fileURLToPath(new URL('../template.yaml', import.meta.url));

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

  // Secrets stay out of the template: the three parameters that carry them are NoEcho.
  for (const p of ['DatabaseUrl', 'BetterAuthSecret', 'OriginSecret'])
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

  // D74: originals/ and variants/ expire after 8 days.
  const rules = ((props('Bucket').LifecycleConfiguration as Node | undefined)?.Rules ??
    []) as unknown as Node[];
  for (const prefix of ['originals/', 'variants/']) {
    const rule = rules.find((r) => r.Prefix === prefix);
    if (!rule || rule.Status !== 'Enabled' || rule.ExpirationInDays !== 8)
      problems.push(`No enabled 8 day lifecycle rule for ${prefix} (D74)`);
  }

  // D19: one schedule per job, with the contract's cron expression.
  const schedules = Object.values(resources).filter((r) => r.Type === 'AWS::Scheduler::Schedule');
  for (const [job, cron] of Object.entries(SCHEDULER_JOBS)) {
    const s = schedules.find(
      (r) => ((r.Properties as Node).Target as Node).Input === JSON.stringify({ job }),
    );
    const [min, hour] = cron.split(' ');
    const expected = `cron(${min} ${hour} * * ? *)`;
    if (!s) problems.push(`No schedule for ${job}`);
    else if ((s.Properties as Node).ScheduleExpression !== expected)
      problems.push(
        `Schedule of ${job} is ${(s.Properties as Node).ScheduleExpression}, expected ${expected}`,
      );
  }
  if (schedules.length !== Object.keys(SCHEDULER_JOBS).length)
    problems.push('Unexpected number of schedules');

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
    for (const v of required) if (!vars.includes(v)) problems.push(`${service}: ${v} is missing`);
    if (props(fn).Runtime !== 'nodejs22.x') problems.push(`${fn}: runtime must be nodejs22.x`);
  }

  // Function URL: streaming (SSE) and the permission pair.
  if (props('ApiUrl').InvokeMode !== 'RESPONSE_STREAM') problems.push('ApiUrl must stream (SSE, D20)');
  const ssz = (props('Distribution').DistributionConfig as Node).CacheBehaviors as unknown as Node[];
  const patterns = ssz.map((b) => b.PathPattern);
  for (const p of ['/api/*', '/media/*', '/f/*'])
    if (!patterns.includes(p)) problems.push(`No behavior for ${p}`);
  const apiBehavior = ssz.find((b) => b.PathPattern === '/api/*');
  if (!JSON.stringify(apiBehavior?.FunctionAssociations).includes('ClientIpFunction'))
    problems.push('/api/* must run the client address function (D80)');
  if (apiBehavior?.Compress !== false) problems.push('/api/* must not compress (it would buffer SSE)');
  return problems;
}

export interface FunctionResult {
  uri: string;
  headers: Record<string, { value: string }>;
}

/** Runs the inline CloudFront Function code of a resource the way CloudFront would, on a viewer request. */
export function runCloudFrontFunction(
  resource: 'SiteFunction' | 'ClientIpFunction',
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
