// S4: end-to-end upload of a 1 MB JPEG (12 MP): create, PUT to the presigned URL, complete, wait for `ready`.
// UPLOAD_FIXTURE replaces the image for a deployment check on a variant that refuses 12 MP (D103, D250); like every
// other parameter it makes the run "reduced", so such a run is never a benchmark result.
import { assertAllowed, requireKey } from '../lib/config.js';
import { loadFixture, tokenOf } from '../lib/fixtures.js';
import { param, seconds } from '../lib/params.js';
import {
  baseOptions,
  errorGates,
  latencyBound,
  makeHandleSummary,
  readyCoverage,
  setupCommon,
} from '../lib/scenario.js';
import { iterationInTest, outcomeThresholds, uploadOnce } from '../lib/upload.js';

assertAllowed('S4');
const rate = param('RPS', 2, 1);
const duration = param('DURATION', '5m', '30s');
const readyP95 = latencyBound('READY_P95_MS', 20000);
const photo = loadFixture(param('UPLOAD_FIXTURE', 'jpeg-1mb.jpg', 'jpeg-1mb.jpg'));

export const options = baseOptions({
  scenarios: {
    upload: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: 20,
      maxVUs: 150,
      gracefulStop: '90s',
    },
  },
  thresholds: {
    ...errorGates({ scenario: 'upload', expectedIterations: rate * seconds(duration) }),
    ...outcomeThresholds(),
    upload_ok: ['rate>0.99'],
    upload_to_ready_ms: [`p(95)<${readyP95}`],
    'http_req_duration{name:POST /api/uploads}': ['p(95)<1000'],
    'http_req_duration{name:PUT presigned URL}': ['p(95)<3000'],
    'http_req_duration{name:POST /api/uploads/:id/complete}': ['p(95)<1500'],
  },
});

export function setup() {
  const key = requireKey();
  const data = setupCommon('S4', { key });
  return data;
}

export default function (data) {
  uploadOnce({
    key: requireKey(),
    fixture: photo,
    token: tokenOf(data.runId, 's4', iterationInTest()),
  });
}

export const handleSummary = makeHandleSummary({
  id: 'S4',
  scope: 'upload',
  title: 'End-to-end upload, 1 MB JPEG',
  local:
    'MinIO on the same host and two worker processes, each running one job at a time (D97): the PUT is a loopback copy and processing is the only real cost. upload_to_ready_ms is the API own ready_at - queued_at; ready_wait_ms is what the client observed with a 250 ms poll. The fixture is 4000x3000 (12 MP). The WASM codecs run on one JS thread per process, so one process drains about 1.3 of them per second whatever the concurrency setting, and the two local processes about 2.5 per second: the specified 2 rps is at the edge of that capacity, so a queue and a growing upload_to_ready_ms are possible; at 1 rps queue time is near zero.',
  extra: (data) => ({ readyCoverage: readyCoverage(data) }),
});
