// `pnpm check`: validates vercel.json offline against a subset of the published schema
// (https://openapi.vercel.sh/vercel.json, kept in vercel.schema.subset.json) and against the contract.
import { existsSync, readFileSync } from 'node:fs';
import {
  COMMON_SECURITY_HEADERS,
  HSTS,
  HTML_SECURITY_HEADERS,
  htmlCsp,
  SCHEDULER_JOBS,
  SSE_MAX_DURATION_MS,
} from '@hostmark/contract';
import { STYLE_HASHES } from '@hostmark/pages/styles';
import { pathToRegexp } from 'path-to-regexp';
import { rumRegionOf } from '../src/build-info';
import { MAX_DELIVERIES } from '../src/queue';
import { FUNCTIONS } from './build';
import { withContentSecurityPolicy } from './security-headers';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

const here = new URL('.', import.meta.url);
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, here), 'utf8')) as Json;

/** A validator for the draft-04 keywords the Vercel schema uses (plus numeric `exclusiveMinimum`). */
export function validate(value: Json | undefined, schema: Schema, path = '$'): string[] {
  const out: string[] = [];
  const s = schema;
  const fail = (msg: string) => out.push(`${path}: ${msg}`);
  if (value === undefined) return out;
  if (Array.isArray(s.oneOf)) {
    const options = s.oneOf as Schema[];
    if (options.filter((o) => validate(value, o, path).length === 0).length !== 1)
      fail('does not match exactly one of the allowed shapes');
  }
  if (Array.isArray(s.anyOf)) {
    if (!(s.anyOf as Schema[]).some((o) => validate(value, o, path).length === 0))
      fail('does not match any of the allowed shapes');
  }
  if ('const' in s && value !== s.const) fail(`must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(value)) fail(`must be one of ${JSON.stringify(s.enum)}`);
  const type = s.type;
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (typeof type === 'string' && type !== actual && !(type === 'integer' && actual === 'number'))
    return [...out, `${path}: expected ${type}, got ${actual}`];
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) fail(`below ${s.minimum}`);
    if (typeof s.maximum === 'number' && value > s.maximum) fail(`above ${s.maximum}`);
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum)
      fail(`must exceed ${s.exclusiveMinimum}`);
  }
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) fail(`shorter than ${s.minLength}`);
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) fail(`longer than ${s.maxLength}`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value))
      fail(`does not match ${s.pattern}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) fail(`fewer than ${s.minItems} items`);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) fail(`more than ${s.maxItems} items`);
    if (s.items && !Array.isArray(s.items))
      for (const [i, item] of value.entries())
        out.push(...validate(item, s.items as Schema, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    const props = (s.properties ?? {}) as Record<string, Schema>;
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, Schema>);
    const keys = Object.keys(value);
    for (const key of (s.required ?? []) as string[]) if (!keys.includes(key)) fail(`missing "${key}"`);
    if (typeof s.minProperties === 'number' && keys.length < s.minProperties) fail('too few properties');
    if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) fail('too many properties');
    for (const key of keys) {
      const sub = props[key] ?? patterns.find(([re]) => new RegExp(re).test(key))?.[1];
      if (sub) out.push(...validate(value[key], sub, `${path}.${key}`));
      else if (s.additionalProperties === false) fail(`unknown property "${key}"`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object')
        out.push(...validate(value[key], s.additionalProperties as Schema, `${path}.${key}`));
    }
  }
  return out;
}

export function checkConfig(
  config: Json = read('../vercel.json'),
  schema = read('./vercel.schema.subset.json'),
) {
  const problems = validate(config, schema as Schema);
  const c = config as VercelConfig;
  // Every scheduler job of the contract must be a cron that calls /api/cron/<job>, with the same schedule (D272).
  for (const [job, schedule] of Object.entries(SCHEDULER_JOBS)) {
    const cron = c.crons?.find((x) => x.path === `/api/cron/${job}`);
    if (!cron) problems.push(`crons: no entry for ${job}`);
    else if (cron.schedule !== schedule)
      problems.push(`crons: ${job} must run "${schedule}", has "${cron.schedule}"`);
  }
  for (const cron of c.crons ?? []) {
    const job = /^\/api\/cron\/([^/?]+)$/.exec(cron.path)?.[1] ?? '';
    if (!Object.hasOwn(SCHEDULER_JOBS, job)) problems.push(`crons: ${cron.path} names no scheduler job`);
  }
  const cronRewrite = c.rewrites?.[0];
  if (cronRewrite?.source !== '/api/cron/:job' || cronRewrite.destination !== '/api/cron?job=:job')
    problems.push('rewrites: the first must send /api/cron/:job to /api/cron?job=:job');
  const triggers = Object.values(c.functions ?? {}).flatMap((f) => f.experimentalTriggers ?? []);
  const topics = triggers.map((t) => t.topic);
  if (!topics.includes('image-jobs')) problems.push('functions: no queue trigger for the topic image-jobs');
  if (topics.some((t) => t.endsWith('-dlq')))
    problems.push('functions: the dead letter topic must have no consumer');
  // Without a bound a killer job is redelivered until its retention ends (the default is unlimited, D198).
  for (const t of triggers.filter((x) => x.topic === 'image-jobs'))
    if (t.maxDeliveries !== MAX_DELIVERIES)
      problems.push(`functions: the image-jobs trigger must set maxDeliveries ${MAX_DELIVERIES}`);
  problems.push(...checkLayout(c), ...checkLimits(c), ...checkCacheHeaders(c), ...checkSecurityHeaders(c));
  return problems;
}

type VercelConfig = {
  buildCommand?: string;
  installCommand?: string;
  regions?: unknown;
  crons?: { path: string; schedule: string }[];
  rewrites?: { source: string; destination: string }[];
  headers?: { source: string; headers: { key: string; value: string }[] }[];
  functions?: Record<
    string,
    {
      includeFiles?: string;
      maxDuration?: number | string;
      maxConcurrency?: number;
      experimentalTriggers?: { topic: string; maxDeliveries?: number }[];
    }
  >;
};

/**
 * The api function outlives the longest event stream (D20) with room for the close, and the image consumer runs one
 * job per instance, as a 4 GiB worker does elsewhere (D213, D271).
 */
function checkLimits(c: VercelConfig): string[] {
  const problems: string[] = [];
  const api = c.functions?.['api/index.js']?.maxDuration;
  if (typeof api !== 'number' || api < SSE_MAX_DURATION_MS / 1000 + 30)
    problems.push(
      `functions: api/index.js needs a maxDuration of at least ${SSE_MAX_DURATION_MS / 1000 + 30} s`,
    );
  if (c.functions?.['api/queue.js']?.maxConcurrency !== 1)
    problems.push('functions: api/queue.js must set maxConcurrency 1 (one image job per instance)');
  if (c.installCommand !== 'cd ../.. && npx --yes pnpm@12.15.0 install --frozen-lockfile')
    problems.push('installCommand: must install with pnpm 12.15.0 from the repository root (D273)');
  return problems;
}

/** Cache-Control the CDN must send for a path the static output serves (D88), or `undefined` for none of ours. */
export const CACHE_HEADERS: Record<string, string | undefined> = {
  '/assets/app-1a2b3c.js': 'public, max-age=31536000, immutable',
  '/': 'public, max-age=300',
  '/index.html': 'public, max-age=300',
  '/pricing': 'public, max-age=300',
  '/pricing/': 'public, max-age=300',
  '/pricing/index.html': 'public, max-age=300',
  '/login': 'public, max-age=300',
  '/signup/': 'public, max-age=300',
  '/app': 'public, max-age=300',
  '/app/index.html': 'public, max-age=300',
  '/app/files/0b9e3a52-5f5c-4d0e-9a51-2a3c8f0e1d42': 'public, max-age=300',
  '/rum.js': 'public, max-age=300',
  '/api/health': undefined,
  '/api/cron/daily-stats': undefined,
  '/media/0b9e3a52-5f5c-4d0e-9a51-2a3c8f0e1d42/128.webp': undefined,
  '/f/0b9e3a52-5f5c-4d0e-9a51-2a3c8f0e1d42': undefined,
  '/nope': undefined,
};

/**
 * The `Cache-Control` of `headers` for a request path, as `@vercel/routing-utils` applies them: each source compiled
 * with path-to-regexp 6 (`strict`, `sensitive`, delimiter `/`) against the path as requested, before the filesystem
 * and the rewrites; a later match overrides an earlier one.
 */
export function cacheControlFor(c: VercelConfig, path: string): string | undefined {
  let value: string | undefined;
  for (const h of c.headers ?? []) {
    if (!pathToRegexp(h.source, [], { strict: true, sensitive: true, delimiter: '/' }).test(path)) continue;
    value = h.headers.find((x) => x.key.toLowerCase() === 'cache-control')?.value ?? value;
  }
  return value;
}

/**
 * Every header `headers` gives a request path (lowercase names), as `@vercel/routing-utils` applies them: each source
 * against the path as requested, a later match overriding an earlier one for the same name.
 */
export function headersFor(c: VercelConfig, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of c.headers ?? []) {
    if (!pathToRegexp(h.source, [], { strict: true, sensitive: true, delimiter: '/' }).test(path)) continue;
    for (const { key, value } of h.headers) out[key.toLowerCase()] = value;
  }
  return out;
}

/** What the static output serves at a path, for the security headers of D310; `function` answers get core's. */
export const SECURITY_PATHS: Record<string, 'html' | 'other' | 'function'> = {
  '/': 'html',
  '/index.html': 'html',
  '/pricing': 'html',
  '/pricing/': 'html',
  '/pricing/index.html': 'html',
  '/login': 'html',
  '/signup/': 'html',
  '/app': 'html',
  '/app/index.html': 'html',
  '/app/files/0b9e3a52-5f5c-4d0e-9a51-2a3c8f0e1d42': 'html',
  '/assets/app-1a2b3c.js': 'other',
  '/assets/app-1a2b3c.css': 'other',
  '/rum.js': 'other',
  '/robots.txt': 'other',
  '/favicon.svg': 'other',
  '/nope': 'other',
  '/f': 'other',
  '/media': 'other',
  '/api': 'function',
  '/api/health': 'function',
  '/api/cron/daily-stats': 'function',
  '/api/queue': 'function',
  '/media/0b9e3a52-5f5c-4d0e-9a51-2a3c8f0e1d42/128.webp': 'function',
  '/f/0b9e3a52-5f5c-4d0e-9a51-2a3c8f0e1d42': 'function',
};

const SECURITY_NAMES = [
  ...Object.keys(COMMON_SECURITY_HEADERS),
  'strict-transport-security',
  'content-security-policy',
  ...Object.keys(HTML_SECURITY_HEADERS),
];

/**
 * D310 with the values of the contract: the common set and HSTS (Vercel serves only HTTPS) on every file, the HTML set
 * on the HTML paths only, nothing on a function path (core sets them there, and two sources could disagree). The
 * policy itself is not in vercel.json: the deploy adds it to the HTML rules (`withContentSecurityPolicy`).
 */
export function checkSecurityHeaders(
  c: VercelConfig,
  storageOrigin = 'https://acct.r2.cloudflarestorage.com',
): string[] {
  const problems: string[] = [];
  let deployed: VercelConfig;
  try {
    deployed = withContentSecurityPolicy(c, storageOrigin);
  } catch (err) {
    return [`headers: ${(err as Error).message}`];
  }
  const common = { ...COMMON_SECURITY_HEADERS, 'strict-transport-security': HSTS };
  const html = { ...common, ...HTML_SECURITY_HEADERS };
  const csp = htmlCsp({ storageOrigin, styleHashes: STYLE_HASHES });
  for (const [path, kind] of Object.entries(SECURITY_PATHS)) {
    const expected: Record<string, string> = kind === 'function' ? {} : kind === 'html' ? html : common;
    for (const [config, extra] of [
      [c, {}],
      [deployed, kind === 'html' ? { 'content-security-policy': csp } : {}],
    ] as const) {
      const want: Record<string, string> = { ...expected, ...extra };
      const got = headersFor(config, path);
      for (const name of SECURITY_NAMES)
        if (got[name] !== want[name])
          problems.push(
            `headers: ${path} must get ${name} ${want[name] ?? '(none)'}${config === deployed ? ' after the deploy adds the policy' : ''}, has ${got[name] ?? '(none)'}`,
          );
    }
  }
  return problems;
}

function checkCacheHeaders(c: VercelConfig): string[] {
  return Object.entries(CACHE_HEADERS)
    .filter(([path, expected]) => cacheControlFor(c, path) !== expected)
    .map(([path, expected]) => `headers: ${path} must get Cache-Control ${expected ?? '(none)'}`);
}

/** The functions are the bundles of scripts/build.ts, and the build knows the region of the deployment. */
function checkLayout(c: VercelConfig): string[] {
  const problems: string[] = [];
  if (c.buildCommand !== 'node --import tsx scripts/build.ts')
    problems.push('buildCommand: must be "node --import tsx scripts/build.ts", which bundles the functions');
  try {
    rumRegionOf(c);
  } catch (err) {
    problems.push(`regions: ${(err as Error).message}`);
  }
  const expected = Object.keys(FUNCTIONS).map((name) => `api/${name}.js`);
  const actual = Object.keys(c.functions ?? {});
  for (const key of actual)
    if (!expected.includes(key))
      problems.push(`functions: "${key}" is not a bundled function (${expected.join(', ')})`);
  for (const [name, f] of Object.entries(FUNCTIONS)) {
    const key = `api/${name}.js`;
    if (!actual.includes(key)) problems.push(`functions: no entry for ${key}`);
    else if (!existsSync(new URL(`../${key}`, here))) problems.push(`functions: ${key} does not exist`);
    if (f.images && c.functions?.[key]?.includeFiles !== 'dist/wasm/*.wasm')
      problems.push(`functions: ${key} must ship the codecs with includeFiles "dist/wasm/*.wasm"`);
  }
  return problems;
}

/**
 * Vercel takes the Node major of the functions and the build from `engines.node` of the Root Directory's
 * package.json, else from the project setting; pinning it keeps the runtime on the Node line the repository tests with
 * (D279).
 */
export function checkPackage(pkg: Json = read('../package.json')): string[] {
  const engines = (pkg as { engines?: { node?: string } }).engines;
  return engines?.node === '22.x' ? [] : ['package.json: engines.node must be "22.x"'];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = [...checkConfig(), ...checkPackage()];
  if (problems.length) {
    for (const p of problems) console.error(`vercel.json: ${p}`);
    process.exit(1);
  }
  console.log(
    'vercel.json: ok (validated against a subset of the published schema; the vercel CLI was not run)',
  );
}
