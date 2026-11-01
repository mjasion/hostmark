// Result file of the browser scenarios, in the shape of the k6 results (schema 1) so one reader handles both.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkGuard, isLoopbackHost, parseBaseUrl } from '../lib/guard.js';

const num = (name: string, full: number, short: number): number => {
  const raw = process.env[name];
  if (raw !== undefined && raw !== '') return Number(raw);
  return process.env.SHORT === '1' ? short : full;
};

export type Param = { value: number; spec: number; source: string };

/** Same contract as load/lib/params.js: an env variable overrides, --short lowers, deviations are listed. */
export function param(name: string, full: number, short: number): Param {
  const raw = process.env[name];
  const source = raw !== undefined && raw !== '' ? 'env' : process.env.SHORT === '1' ? 'short' : 'spec';
  return { value: num(name, full, short), spec: full, source };
}

export function assertAllowed(scenario: string) {
  const baseUrl = (process.env.BASE_URL ?? 'http://127.0.0.1:58080').replace(/\/+$/, '');
  const verdict = checkGuard({ baseUrl, scenario, env: process.env });
  if (verdict.problems.length > 0)
    throw new Error(`refusing to run ${scenario}: ${verdict.problems.join('; ')}`);
}

const round = (n: number) => Math.round(n * 100) / 100;

export function summarise(values: number[]) {
  const sorted = [...values].sort((x, y) => x - y);
  if (sorted.length === 0) return { count: 0 } as { count: number; p95?: number; max?: number };
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  const sum = sorted.reduce((x, y) => x + y, 0);
  return {
    count: sorted.length,
    min: round(sorted[0] ?? 0),
    avg: round(sum / sorted.length),
    med: round(at(0.5)),
    p90: round(at(0.9)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

export type Gate = { name: string; ok: boolean; detail: string };

export function writeResult(input: {
  id: string;
  title: string;
  startedAt: string;
  durationS: number;
  platform: string | null;
  version: string | null;
  params: Record<string, Param>;
  meaning: string;
  gates: Gate[];
  metrics: Record<string, unknown>;
  extra?: Record<string, unknown>;
}) {
  const baseUrl = (process.env.BASE_URL ?? 'http://127.0.0.1:58080').replace(/\/+$/, '');
  const deviations = Object.entries(input.params)
    .filter(([, p]) => p.value !== p.spec)
    .map(([name, p]) => ({ param: name, value: p.value, spec: p.spec, source: p.source }));
  const failed = input.gates.filter((g) => !g.ok).map((g) => `${g.name}: ${g.detail}`);
  const result = {
    schema: 1,
    scenario: input.id,
    title: input.title,
    date: new Date().toISOString(),
    startedAt: input.startedAt,
    durationS: round(input.durationS),
    commit: process.env.COMMIT_SHA || null,
    treeSha: process.env.TREE_SHA || null,
    dirty: process.env.COMMIT_DIRTY === '1',
    'x-platform': input.platform,
    'x-version': input.version,
    baseUrl,
    labels: {
      region: process.env.REGION || 'local',
      topology: process.env.TOPOLOGY || 'single',
      variant: process.env.VARIANT || '',
      note: process.env.NOTE || '',
    },
    short: process.env.SHORT === '1',
    load: { mode: deviations.length === 0 ? 'full' : 'reduced', deviations, params: input.params },
    status: failed.length === 0 ? 'passed' : 'failed',
    // Only a loopback run is explained by the local stack; a result for another target carries no such text.
    meaning: isLoopbackHost(parseBaseUrl(baseUrl).host) ? input.meaning : null,
    passed: failed.length === 0,
    failedThresholds: failed,
    thresholds: Object.fromEntries(input.gates.map((g) => [g.name, g.ok])),
    metrics: input.metrics,
    ...input.extra,
  };
  const file = process.env.RESULT_FILE ?? `/tmp/${input.id}-${Date.now()}.json`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`${input.id} ${input.title}: ${result.passed ? 'PASSED' : 'FAILED'} (${result.load.mode})`);
  for (const f of failed) console.log(`  threshold crossed: ${f}`);
  console.log(`  result: ${file}`);
  return result;
}

/** A gate on an upper bound; the bound is an input so a platform with a different budget can set its own. */
export function upper(name: string, value: number | undefined, bound: number): Gate {
  const ok = value !== undefined && value <= bound;
  return { name, ok, detail: `${value === undefined ? 'no data' : round(value)} > ${bound}` };
}
