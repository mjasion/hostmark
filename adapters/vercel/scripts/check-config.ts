// `pnpm check`: validates vercel.json offline against a subset of the published schema
// (https://openapi.vercel.sh/vercel.json, kept in vercel.schema.subset.json) and against the contract.
import { readFileSync } from 'node:fs';
import { SCHEDULER_JOBS } from '@hostmark/contract';

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
    crons?: { path: string; schedule: string }[];
    functions?: Record<string, { experimentalTriggers?: { topic: string }[] }>;
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
  const topics = Object.values(c.functions ?? {}).flatMap(
    (f) => f.experimentalTriggers?.map((t) => t.topic) ?? [],
  );
  if (!topics.includes('image-jobs')) problems.push('functions: no queue trigger for the topic image-jobs');
  if (topics.some((t) => t.endsWith('-dlq')))
    problems.push('functions: the dead letter topic must have no consumer');
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
