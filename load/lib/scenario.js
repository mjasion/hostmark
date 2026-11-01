// Shared scaffolding: options, setup() and the result file.
import { sleep } from 'k6';
import { deepHealth, get, getFile, health, listFiles } from './api.js';
import { ADMIN_API_KEY, API_KEY, assertAllowed, BASE_URL, LABELS, LOOPBACK, SHORT } from './config.js';
import { cacheHeaderThresholds, headerOf } from './headers.js';
import { describeLoad, latencyBound, seconds } from './params.js';

const TREND_STATS = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];

/** Options every scenario shares. Redirects are never followed: a loopback target must not send k6 elsewhere. */
export function baseOptions(options) {
  return {
    summaryTrendStats: TREND_STATS,
    discardResponseBodies: false,
    noConnectionReuse: false,
    // setup() waits for seed files to be processed (up to 120 s), and k6 ends it after 60 s by default.
    setupTimeout: '300s',
    ...options,
    thresholds: { ...cacheHeaderThresholds(), ...options.thresholds },
  };
}

/** Sub-metric of one k6 scenario: setup() and warm-up requests belong to no scenario and stay out of it. */
export const scoped = (metric, scenario) => `${metric}{scenario:${scenario}}`;

/**
 * Error gate every steady scenario carries: failed requests and failed checks fail the run. `dropped_iterations`
 * is a gate too: a load generator that cannot keep the arrival rate has not delivered the load. With `scenario`
 * the gate reads that scenario's requests only, so the warm-up of setup() is not part of the verdict.
 */
export function errorGates({ scenario, maxFailed = 0.01, expectedIterations = 0 } = {}) {
  const gates = {
    [scenario ? scoped('http_req_failed', scenario) : 'http_req_failed']: [`rate<${maxFailed}`],
    [scenario ? scoped('checks', scenario) : 'checks']: ['rate>0.99'],
  };
  if (expectedIterations > 0)
    gates.dropped_iterations = [`count<${Math.max(1, Math.ceil(expectedIterations * 0.01))}`];
  return gates;
}

/** Always-true thresholds that make the summary carry a sub-metric for each tag value. */
export function observe(metric, tag, values, stat = 'count>=0') {
  const out = {};
  for (const value of values) out[`${metric}{${tag}:${value}}`] = [stat];
  return out;
}

function warm(path, key) {
  const res = get(path, key, { name: `warmup ${path.replace(/[0-9a-f-]{36}/, ':id')}` });
  return {
    route: path.replace(/[0-9a-f-]{36}/, ':id'),
    status: res.status,
    ms: Math.round(res.timings.duration),
  };
}

/**
 * setup(): wake the database with /api/health/deep (retried, it must answer 200), then one warm-up request per
 * route the scenario uses. `routes` are paths, `key` authenticates them. Returns what the result records.
 */
export function setupCommon(scenario, { routes = [], key = API_KEY, cold = false } = {}) {
  assertAllowed(scenario);
  const out = {
    scenario,
    startedAt: new Date().toISOString(),
    runId: Date.now().toString(36).slice(-6),
    warmup: [],
  };
  if (cold) return out;
  let deep;
  for (let attempt = 0; attempt < 5; attempt++) {
    deep = deepHealth();
    if (deep.status === 200) break;
    sleep(2);
  }
  if (deep.status !== 200)
    throw new Error(`/api/health/deep answered ${deep.status}: the target is not ready`);
  out.platform = headerOf(deep, 'x-platform') ?? null;
  out.version = headerOf(deep, 'x-version') ?? null;
  out.deepHealthMs = Math.round(deep.timings.duration);
  out.warmup.push({ route: '/api/health/deep', status: deep.status, ms: out.deepHealthMs });
  for (const path of routes) out.warmup.push(warm(path, key));
  return out;
}

/** Reads the platform headers once, for scenarios whose setup is cold. */
export function identify() {
  const res = health();
  return { platform: headerOf(res, 'x-platform') ?? null, version: headerOf(res, 'x-version') ?? null };
}

/** Newest file of the key, as a boundary: files created after it belong to the run. */
export function newestFile(key) {
  const res = listFiles(key, 'limit=1', { name: 'GET /api/files (boundary)' });
  const items = res.status === 200 ? res.json().items : [];
  return items[0] ? { id: items[0].id, createdAt: items[0].createdAt } : null;
}

/** Makes sure the key owns a ready file to read, and returns its id. Uses the supplied upload function. */
export function findReadyFile(key) {
  const res = listFiles(key, 'limit=100', { name: 'GET /api/files (find)' });
  if (res.status !== 200) return null;
  const hit = res.json().items.find((f) => f.status === 'ready' && f.variants.length > 0);
  if (!hit) return null;
  return getFile(key, hit.id, { name: 'GET /api/files/:id (find)' }).status === 200 ? hit.id : null;
}

/** Header values seen, by header: from the cache_header_seen counter's sub-metrics. */
function cacheSummary(metrics) {
  const out = {};
  for (const [name, metric] of Object.entries(metrics)) {
    const m = /^cache_header_seen\{header:([^,]+),value:(.+)\}$/.exec(name);
    if (m && metric.values.count) {
      out[m[1]] ??= {};
      out[m[1]][m[2]] = metric.values.count;
    }
  }
  return out;
}

const round = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);
const HIDDEN = new Set([
  'http_req_blocked',
  'http_req_connecting',
  'http_req_tls_handshaking',
  'http_req_sending',
  'http_req_receiving',
  'iteration_duration',
  'vus',
]);

function compactMetric(metric) {
  const v = metric.values;
  if (metric.type === 'trend') {
    return {
      count: undefined,
      avg: round(v.avg),
      min: round(v.min),
      p50: round(v.med),
      p90: round(v['p(90)']),
      p95: round(v['p(95)']),
      p99: round(v['p(99)']),
      max: round(v.max),
    };
  }
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = round(val);
  return out;
}

/**
 * `upload_to_ready_ms` has a sample only for files that were terminal within the wait timeout, so a slow run reads
 * better than it was. This puts the files that missed the timeout next to it.
 */
export function readyCoverage(data, phase) {
  const tag = phase ? `{phase:${phase}}` : '';
  const count = (name) => data.metrics[name]?.values.count ?? 0;
  const trend = data.metrics[`upload_to_ready_ms${tag}`];
  return {
    measured: trend ? count('upload_outcome{outcome:ready}') : 0,
    timedOut: count('upload_outcome{outcome:timeout}'),
    failed: count('upload_outcome{outcome:failed}'),
    note: 'upload_to_ready_ms covers only files that were terminal within the wait timeout; the database window in local.db covers every file of the run',
  };
}

/** Requests, failure rate and latency of one k6 scenario, without the warm-up requests of setup(). */
function headlineOf(metrics, scenario) {
  const d = metrics[scoped('http_req_duration', scenario)];
  const f = metrics[scoped('http_req_failed', scenario)];
  if (!d || !f) return null;
  return {
    scenario,
    requests: f.values.passes + f.values.fails,
    failed: f.values.passes,
    failedRate: round(f.values.rate),
    p50: round(d.values.med),
    p95: round(d.values['p(95)']),
    p99: round(d.values['p(99)']),
    max: round(d.values.max),
  };
}

/**
 * Builds the file. `extra(data)` adds scenario fields (timeline, derived numbers). The summary is a few KB: only
 * metrics, never samples.
 */
export function makeHandleSummary({ id, title, local, extra, scope }) {
  return (data) => {
    const load = describeLoad();
    const metrics = {};
    const failed = [];
    const gates = {};
    for (const [name, metric] of Object.entries(data.metrics)) {
      for (const [expr, t] of Object.entries(metric.thresholds ?? {})) {
        if (/>=0$/.test(expr)) continue;
        gates[`${name}: ${expr}`] = t.ok;
        if (!t.ok) failed.push(`${name}: ${expr}`);
      }
      if (HIDDEN.has(name)) continue;
      if (name.includes('{') && metric.type === 'counter' && !metric.values.count) continue;
      metrics[name] = compactMetric(metric);
    }
    const setup = data.setup_data ?? {};
    if (!data.setup_data) failed.push('setup() did not complete');
    const headline = scope ? headlineOf(data.metrics, scope) : undefined;
    const { failures = [], ...extras } = extra ? extra(data, setup) : {};
    // Checks a scenario makes on its own numbers (sent versus observed) fail the run like a threshold does.
    for (const f of failures) {
      failed.push(f);
      gates[f] = false;
    }
    const skipped = Boolean(extras.skipped);
    const result = {
      schema: 1,
      scenario: id,
      title,
      date: new Date().toISOString(),
      startedAt: setup.startedAt ?? null,
      durationS: round((data.state?.testRunDurationMs ?? 0) / 1000),
      commit: __ENV.COMMIT_SHA || null,
      // The tree of the working copy that was tested (committed or not): identifies the code, unlike `commit`.
      treeSha: __ENV.TREE_SHA || null,
      dirty: __ENV.COMMIT_DIRTY === '1',
      'x-platform': setup.platform ?? null,
      'x-version': setup.version ?? null,
      baseUrl: BASE_URL,
      labels: LABELS,
      short: SHORT,
      status: skipped ? 'skipped' : failed.length === 0 ? 'passed' : 'failed',
      load: { mode: skipped ? 'skipped' : load.mode, deviations: load.deviations, params: load.params },
      // Only a loopback run is explained by the local stack; a result for another target carries no such text.
      meaning: LOOPBACK ? (local ?? null) : null,
      passed: skipped ? null : failed.length === 0,
      failedThresholds: failed,
      thresholds: gates,
      setup: { warmup: setup.warmup ?? [], deepHealthMs: setup.deepHealthMs ?? null },
      cache: cacheSummary(data.metrics),
      ...(headline ? { headline } : {}),
      metrics,
      ...extras,
    };
    const dir = __ENV.RESULT_DIR || '/results';
    const file = __ENV.RESULT_FILE || `${dir}/${id}-${LABELS.region}-${Date.now()}.json`;
    const lines = [
      `${id} ${title}: ${result.status.toUpperCase()} (${result.load.mode}) ${result.durationS}s`,
      ...failed.map((f) => `  threshold crossed: ${f}`),
      ...(headline ? [`  ${scope}: ${JSON.stringify(headline)}`] : []),
      ...Object.entries(metrics)
        .filter(
          ([n]) =>
            /^(http_req_duration|http_req_failed|checks|dropped_iterations)/.test(n) && !n.includes('{'),
        )
        .map(([n, m]) => `  ${n}: ${JSON.stringify(m)}`),
      `  result: ${file}`,
      '',
    ];
    return { [file]: JSON.stringify(result, null, 2), stdout: lines.join('\n') };
  };
}

export { ADMIN_API_KEY, API_KEY, latencyBound, seconds };
