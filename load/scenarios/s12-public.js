// S12: the public page /f/:id. The first request is sent before anything else touches the route (the specification
// wants it right after a cache purge: PURGE_URL does that when set), then the page is read at RPS for DURATION and
// the cache header values are counted. Cache-Control is recorded as received: it depends on PUBLIC_URL (D82).
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { publicPage } from '../lib/api.js';
import { assertAllowed, requireKey } from '../lib/config.js';
import { cacheState, headerOf, recordCacheHeaders } from '../lib/headers.js';
import { param, seconds } from '../lib/params.js';
import { purge } from '../lib/purge.js';
import { baseOptions, errorGates, latencyBound, makeHandleSummary, setupCommon } from '../lib/scenario.js';
import { seedPublicFile } from '../lib/seed.js';

assertAllowed('S12');
const rate = param('RPS', 50, 10);
const duration = param('DURATION', '2m', '15s');
const p95 = latencyBound('P95_MS', 500);
const states = new Counter('page_cache_state');
const purgeOk = new Rate('purge_ok');

export const options = baseOptions({
  scenarios: {
    first: { executor: 'per-vu-iterations', vus: 1, iterations: 1, exec: 'first', maxDuration: '2m' },
    warm: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration,
      startTime: '5s',
      preAllocatedVUs: 20,
      maxVUs: 200,
      exec: 'warm',
    },
  },
  thresholds: {
    ...errorGates({ scenario: 'warm', expectedIterations: rate * seconds(duration) }),
    'checks{scenario:first}': ['rate==1'],
    ...(__ENV.PURGE_URL ? { purge_ok: ['rate==1'] } : {}),
    'http_req_duration{scenario:first}': ['avg>=0'],
    'http_req_duration{scenario:warm}': [`p(95)<${p95}`],
    ...Object.fromEntries(
      ['hit', 'miss', 'dynamic', 'stale', 'bypass', 'none'].map((s) => [
        `page_cache_state{state:${s}}`,
        ['count>=0'],
      ]),
    ),
  },
});

export function setup() {
  const key = requireKey();
  const data = setupCommon('S12', { key });
  data.fileId = seedPublicFile(key, data.runId);
  data.purge = null;
  if (__ENV.PURGE_URL) {
    data.purge = purge(data.fileId);
    purgeOk.add(data.purge.ok);
  }
  return data;
}

function read(data, scenario) {
  const res = publicPage(data.fileId);
  const found = recordCacheHeaders(res);
  states.add(1, { state: cacheState(found), scenario });
  check(res, {
    'status 200': (r) => r.status === 200,
    html: (r) => (headerOf(r, 'content-type') ?? '').includes('text/html'),
  });
  return res;
}

export function first(data) {
  const res = read(data, 'first');
  console.log(
    `HM_EVENT ${JSON.stringify({ type: 'first', status: res.status, ms: Math.round(res.timings.duration), ttfbMs: Math.round(res.timings.waiting), cacheControl: headerOf(res, 'cache-control') ?? null, bytes: res.body.length })}`,
  );
}

export function warm(data) {
  read(data, 'warm');
}

export const handleSummary = makeHandleSummary({
  id: 'S12',
  scope: 'warm',
  title: '/f/:id first request and warm cache',
  local:
    'There is no CDN in front of the local stack, so every request is rendered by the API and no cache status header exists: hit ratio is not measurable (page_cache_state is all "none") and MISS versus HIT cannot be compared. The numbers are the render cost of the page with a database read. Cache-Control as received is listed under events (with PUBLIC_URL set it asks a CDN to cache for 60 s, D82). The purge before the first request is not performed (no PURGE_URL).',
  extra: (_d, setup) => ({ purge: setup.purge ?? { performed: false, reason: 'PURGE_URL is not set' } }),
});
