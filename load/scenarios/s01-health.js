// S1: baseline GET /api/health, no dependencies behind it. The platform overhead and nothing else.
import { check } from 'k6';
import { health } from '../lib/api.js';
import { assertAllowed } from '../lib/config.js';
import { recordCacheHeaders } from '../lib/headers.js';
import { param, seconds } from '../lib/params.js';
import {
  baseOptions,
  errorGates,
  latencyBound,
  makeHandleSummary,
  scoped,
  setupCommon,
} from '../lib/scenario.js';

assertAllowed('S1');
const rate = param('RPS', 50, 10);
const duration = param('DURATION', '3m', '15s');
const p95 = latencyBound('P95_MS', 500);

export const options = baseOptions({
  scenarios: {
    health: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
  },
  thresholds: {
    ...errorGates({ scenario: 'health', expectedIterations: rate * seconds(duration) }),
    [scoped('http_req_duration', 'health')]: [`p(95)<${p95}`],
  },
});

export function setup() {
  return setupCommon('S1', { routes: ['/api/health'] });
}

export default function () {
  const res = health();
  recordCacheHeaders(res);
  check(res, { 'status 200': (r) => r.status === 200, 'body ok': (r) => r.body.includes('"ok"') });
}

export const handleSummary = makeHandleSummary({
  id: 'S1',
  scope: 'health',
  title: 'Baseline GET /api/health',
  local:
    'One Node process on loopback behind a TCP forwarder: this is the floor of the load generator and the framework, not a hosting platform. No TLS, no CDN, no cold start.',
});
