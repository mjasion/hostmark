// S7: cold start. One request after each silence: first a route with no dependencies, then immediately the first
// one that touches the database, then a repeat of that one. Nothing is sent in setup(): a warm-up would defeat it.
// The specification (3 gaps of 5, 15 and 60 minutes, 10 repeats) takes about 13 hours; GAPS and REPEATS shorten it
// and the result says so.

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Trend } from 'k6/metrics';
import { assertAllowed, BASE_URL } from '../lib/config.js';
import { headerOf } from '../lib/headers.js';
import { param } from '../lib/params.js';
import { baseOptions, makeHandleSummary, setupCommon } from '../lib/scenario.js';

assertAllowed('S7');
const gaps = param('GAPS', '300,900,3600', '2,4,8').split(',').map(Number);
const repeats = param('REPEATS', 10, 2);
const first = new Trend('cold_first_request_ms', true);
const firstDb = new Trend('cold_first_db_request_ms', true);
const warmDb = new Trend('warm_db_request_ms', true);
const total = gaps.reduce((a, g) => a + g * repeats, 0);

export const options = baseOptions({
  scenarios: {
    cold: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: gaps.length * repeats,
      maxDuration: `${Math.ceil(total * 1.1 + 300)}s`,
    },
  },
  thresholds: {
    ...Object.fromEntries(
      gaps.flatMap((g) => [
        [`cold_first_request_ms{gap:${g}}`, ['avg>=0']],
        [`cold_first_db_request_ms{gap:${g}}`, ['avg>=0']],
        [`warm_db_request_ms{gap:${g}}`, ['avg>=0']],
      ]),
    ),
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    cold_first_request_ms: ['p(95)<10000'],
    cold_first_db_request_ms: ['p(95)<15000'],
  },
});

export function setup() {
  return setupCommon('S7', { cold: true });
}

let identified = false;
function timed(path) {
  const res = http.get(`${BASE_URL}${path}`, { tags: { name: `GET ${path}` }, redirects: 0 });
  if (!identified) {
    identified = true;
    console.log(
      `HM_EVENT ${JSON.stringify({ type: 'identity', platform: headerOf(res, 'x-platform') ?? null, version: headerOf(res, 'x-version') ?? null })}`,
    );
  }
  return res;
}

export default function () {
  const gap = gaps[Math.floor(exec.scenario.iterationInTest / repeats)];
  sleep(gap);
  const a = timed('/api/health');
  const b = timed('/api/health/deep');
  const c = timed('/api/health/deep');
  const tags = { gap: String(gap) };
  first.add(a.timings.duration, tags);
  firstDb.add(b.timings.duration, tags);
  warmDb.add(c.timings.duration, tags);
  for (const r of [a, b, c]) check(r, { 'status 200': (x) => x.status === 200 });
  if (a.status !== 200 || b.status !== 200 || c.status !== 200)
    console.log(
      `HM_EVENT ${JSON.stringify({ type: 'error', what: 'cold cycle', status: [a.status, b.status, c.status] })}`,
    );
}

export const handleSummary = makeHandleSummary({
  id: 'S7',
  title: 'Cold start',
  local:
    'Not meaningful locally. The API is a long-running Node process that is never frozen, scaled to zero or evicted, and Postgres stays up, so after any gap the first request costs about the same as a warm one (plus a fresh TCP connection). The numbers show only that there is no cold-start penalty on this variant. A reduced run shortens the gaps; it is not the 13 hour scenario.',
  extra: () => ({ gapsSeconds: gaps, repeats, totalSilenceSeconds: total }),
});
