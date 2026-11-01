// Compares a k6 result with an independent source: the request counters the api exports to Prometheus
// (http.server.request.duration, one series per route and status). Local stack only.
//
//   node load/tools/spotcheck.mjs load/results/S1-....json [--settle 80] [--route "/api/health 200" --expect 9001]
//
// `--route` names one series ("<route> <status>") and `--expect` the count the k6 numbers imply (iterations plus the
// warm-up requests of that route); the tool then reports whether the two agree. Other series, such as the
// container health check on /api/health/deep, are listed but not compared.
//
// The api exports metrics on an interval, so the second reading waits `settle` seconds after the run. The
// window is [startedAt, date] of the result; nothing else may send requests to the api meanwhile.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args[0]?.startsWith('--') ? undefined : args[0];
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const settle = Number(option('--settle', 80));
const routeKey = option('--route', null);
const expected = option('--expect', null);
if (!file) {
  console.error('usage: spotcheck.mjs <result.json> [--settle seconds]');
  process.exit(2);
}
const grafana = process.env.GRAFANA_URL ?? 'http://127.0.0.1:53000';
const auth = `Basic ${Buffer.from(process.env.GRAFANA_AUTH ?? 'admin:admin').toString('base64')}`;
const result = JSON.parse(readFileSync(file, 'utf8'));

async function counts(at) {
  const q = 'sum by (http_route, http_response_status_code) (http_server_request_duration_seconds_count)';
  const url = `${grafana}/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent(q)}&time=${at}`;
  const res = await fetch(url, { headers: { authorization: auth } });
  const body = await res.json();
  const out = {};
  for (const r of body.data.result)
    out[`${r.metric.http_route} ${r.metric.http_response_status_code}`] = Number(r.value[1]);
  return out;
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const start = Date.parse(result.startedAt) / 1000 - 2;
const end = Date.parse(result.date) / 1000;
const waitUntil = end + settle;
const remaining = waitUntil - Date.now() / 1000;
if (remaining > 0) await sleep(remaining);
const before = await counts(start);
const after = await counts(waitUntil);
await sleep(20);
const later = await counts(waitUntil + 20);
const delta = (a, b) => {
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[key] ?? 0) - (a[key] ?? 0);
    if (d !== 0) out[key] = d;
  }
  return out;
};
const seen = delta(before, after);
const stableOn = (key) => (seen[key] ?? 0) === (delta(before, later)[key] ?? 0);
const k6Requests = result.metrics?.http_reqs?.count;
const k6Iterations = result.metrics?.iterations?.count;
const report = {
  scenario: result.scenario,
  window: { from: new Date(start * 1000).toISOString(), to: result.date },
  prometheus: seen,
  k6: { http_reqs: k6Requests, iterations: k6Iterations },
};
if (routeKey) {
  report.compared = {
    series: routeKey,
    prometheus: seen[routeKey] ?? 0,
    expectedFromK6: Number(expected),
    agree: (seen[routeKey] ?? 0) === Number(expected),
    stable: stableOn(routeKey),
  };
}
console.log(JSON.stringify(report, null, 2));
