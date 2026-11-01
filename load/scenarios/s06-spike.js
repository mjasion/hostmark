// S6: traffic spike on the S2 read: the arrival rate goes from 0 to PEAK_RPS in RAMP and stays there for HOLD.
// Every request carries a time bucket so the result shows when latency and errors settled.
import { check } from 'k6';
import { getFile } from '../lib/api.js';
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
import { seedReadyFile } from '../lib/seed.js';
import { bucketTag, bucketThresholds, stabilisation } from '../lib/timeline.js';

assertAllowed('S6');
const peak = param('PEAK_RPS', 500, 100);
const ramp = param('RAMP', '10s', '5s');
const hold = param('HOLD', '2m', '20s');
const bound = latencyBound('P95_MS', 750);
const BUCKET_S = 5;
const totalS = seconds(ramp) + seconds(hold);

export const options = baseOptions({
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 300,
      maxVUs: 3000,
      stages: [
        { duration: ramp, target: peak },
        { duration: hold, target: peak },
      ],
    },
  },
  thresholds: {
    ...errorGates({ scenario: 'spike', maxFailed: 0.01 }),
    dropped_iterations: [`count<${Math.ceil(peak * totalS * 0.0025)}`],
    [scoped('http_req_duration', 'spike')]: [`p(95)<${bound * 2}`],
    ...bucketThresholds(totalS, BUCKET_S),
  },
});

export function setup() {
  const key = requireKey();
  const data = setupCommon('S6', { key });
  data.fileId = seedReadyFile(key, data.runId);
  return data;
}

export default function (data) {
  const res = getFile(API_KEY, data.fileId, { tags: { bucket: bucketTag(BUCKET_S) } });
  recordCacheHeaders(res);
  check(res, { 'status 200': (r) => r.status === 200 });
}

export const handleSummary = makeHandleSummary({
  id: 'S6',
  scope: 'spike',
  title: 'Traffic spike on S2',
  local:
    'One API process and one Postgres connection pool take the whole spike with no autoscaling or cold instances, so this is the saturation point of a single Node process on this machine plus the load generator, not stabilisation time of a platform. Load generator and forwarder share the same CPU as the API.',
  extra: (data) => ({ spike: stabilisation(data.metrics, totalS, BUCKET_S, bound) }),
});
