// S3: GET /api/files?limit=50, a heavier read: 50 rows, each with three presigned URLs.
import { check } from 'k6';
import { listFiles } from '../lib/api.js';
import { API_KEY, assertAllowed, requireKey } from '../lib/config.js';
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
import { seedListFiles } from '../lib/seed.js';

assertAllowed('S3');
const rate = param('RPS', 20, 5);
const duration = param('DURATION', '3m', '15s');
const p95 = latencyBound('P95_MS', 1000);

export const options = baseOptions({
  scenarios: {
    list: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
  },
  thresholds: {
    ...errorGates({ scenario: 'list', expectedIterations: rate * seconds(duration) }),
    [scoped('http_req_duration', 'list')]: [`p(95)<${p95}`],
  },
});

export function setup() {
  const key = requireKey();
  const data = setupCommon('S3', { key });
  data.seeded = seedListFiles(key, data.runId, 50);
  const page = listFiles(key, 'limit=50');
  data.warmup.push({ route: '/api/files', status: page.status });
  data.pageItems = page.status === 200 ? page.json().items.length : 0;
  if (data.pageItems < 50) throw new Error(`the key has ${data.pageItems} files, S3 needs a full page of 50`);
  return data;
}

export default function () {
  const res = listFiles(API_KEY, 'limit=50');
  recordCacheHeaders(res);
  check(res, { 'status 200': (r) => r.status === 200, 'full page': (r) => r.json('items').length === 50 });
}

export const handleSummary = makeHandleSummary({
  id: 'S3',
  scope: 'list',
  title: 'List GET /api/files?limit=50',
  local:
    'One indexed query for 50 rows and 150 local presign computations per request, on a database in the same network. Page size depends on how many files the seed user owns: setup tops it up to 50, and the result records it.',
  extra: (_data, setup) => ({ dataset: { pageItems: setup.pageItems, seeded: setup.seeded } }),
});
