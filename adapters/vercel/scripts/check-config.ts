// `pnpm check`: validates vercel.json offline against a subset of the published schema
// (https://openapi.vercel.sh/vercel.json, kept in vercel.schema.subset.json) and against the contract.
import { existsSync, readFileSync } from 'node:fs';
import { SCHEDULER_JOBS } from '@hostmark/contract';
import { rumRegionOf } from '../src/build-info';
import { MAX_DELIVERIES } from '../src/queue';
import { FUNCTIONS } from './build';

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
  const c = config as {
    buildCommand?: string;
    regions?: unknown;
    crons?: { path: string; schedule: string }[];
    functions?: Record<
      string,
      { includeFiles?: string; experimentalTriggers?: { topic: string; maxDeliveries?: number }[] }
    >;
  };
  // Every scheduler job of the contract must be a cron that calls api/cron with the job name, with the same schedule.
  for (const [job, schedule] of Object.entries(SCHEDULER_JOBS)) {
    const cron = c.crons?.find((x) => x.path === `/api/cron?job=${job}`);
    if (!cron) problems.push(`crons: no entry for ${job}`);
    else if (cron.schedule !== schedule)
      problems.push(`crons: ${job} must run "${schedule}", has "${cron.schedule}"`);
  }
  for (const cron of c.crons ?? []) {
    const job = new URL(cron.path, 'https://x').searchParams.get('job') ?? '';
    if (!Object.hasOwn(SCHEDULER_JOBS, job)) problems.push(`crons: ${cron.path} names no scheduler job`);
  }
  const triggers = Object.values(c.functions ?? {}).flatMap((f) => f.experimentalTriggers ?? []);
  const topics = triggers.map((t) => t.topic);
  if (!topics.includes('image-jobs')) problems.push('functions: no queue trigger for the topic image-jobs');
  if (topics.some((t) => t.endsWith('-dlq')))
    problems.push('functions: the dead letter topic must have no consumer');
  // Without a bound a killer job is redelivered until its retention ends (the default is unlimited, D198).
  for (const t of triggers.filter((x) => x.topic === 'image-jobs'))
    if (t.maxDeliveries !== MAX_DELIVERIES)
      problems.push(`functions: the image-jobs trigger must set maxDeliveries ${MAX_DELIVERIES}`);
  problems.push(...checkLayout(c));
  return problems;
}

/** The functions are the bundles of scripts/build.ts, and the build knows the region of the deployment. */
function checkLayout(c: {
  buildCommand?: string;
  regions?: unknown;
  functions?: Record<string, { includeFiles?: string }>;
}): string[] {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkConfig();
  if (problems.length) {
    for (const p of problems) console.error(`vercel.json: ${p}`);
    process.exit(1);
  }
  console.log(
    'vercel.json: ok (validated against a subset of the published schema; the vercel CLI was not run)',
  );
}
