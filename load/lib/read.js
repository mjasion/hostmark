// The authenticated read of S2 and S11: GET /api/files/:id at a fixed arrival rate.
import { check } from 'k6';
import { getFile } from './api.js';
import { API_KEY, requireKey } from './config.js';
import { recordCacheHeaders } from './headers.js';
import { param, seconds } from './params.js';
import { baseOptions, errorGates, latencyBound, makeHandleSummary, scoped, setupCommon } from './scenario.js';
import { seedReadyFile } from './seed.js';

export function readScenario({ id, title, rps, duration, local }) {
  const rate = param('RPS', rps[0], rps[1]);
  const length = param('DURATION', duration[0], duration[1]);
  const p95 = latencyBound('P95_MS', 750);
  return {
    options: baseOptions({
      scenarios: {
        read: {
          executor: 'constant-arrival-rate',
          rate,
          timeUnit: '1s',
          duration: length,
          preAllocatedVUs: 20,
          maxVUs: 300,
        },
      },
      thresholds: {
        ...errorGates({ scenario: 'read', expectedIterations: rate * seconds(length) }),
        [scoped('http_req_duration', 'read')]: [`p(95)<${p95}`],
      },
    }),
    setup() {
      const key = requireKey();
      const data = setupCommon(id, { key });
      data.fileId = seedReadyFile(key, data.runId);
      data.warmup.push({ route: '/api/files/:id', status: getFile(key, data.fileId).status });
      return data;
    },
    run(data) {
      const res = getFile(API_KEY, data.fileId);
      recordCacheHeaders(res);
      check(res, {
        'status 200': (r) => r.status === 200,
        'has variants': (r) => r.json('variants').length === 3,
      });
    },
    handleSummary: makeHandleSummary({ id, title, local, scope: 'read' }),
  };
}
