// S8: POST /api/debug/cpu with 100, 500, 1000 and 5000 ms of CPU. One request at a time, ITERATIONS per level.
// Whether the request passes is the result: platforms with a CPU limit will refuse the longer ones.
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { postJson } from '../lib/api.js';
import { ADMIN_API_KEY, assertAllowed, requireKey } from '../lib/config.js';
import { param } from '../lib/params.js';
import { baseOptions, latencyBound, makeHandleSummary, setupCommon } from '../lib/scenario.js';

assertAllowed('S8');
const levels = param('LEVELS', '100,500,1000,5000', '100,500').split(',').map(Number);
const iterations = param('ITERATIONS', 5, 2);
const maxFailed = latencyBound('MAX_FAILED', 0);
const burned = new Trend('cpu_elapsed_ms');
const hashes = new Trend('cpu_iterations');
const passed = new Counter('cpu_passed');

export const options = baseOptions({
  scenarios: {
    cpu: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: levels.length * iterations,
      maxDuration: '15m',
    },
  },
  thresholds: {
    ...Object.fromEntries(
      levels.flatMap((ms) => [
        [`http_req_duration{ms:${ms}}`, ['avg>=0']],
        [`cpu_elapsed_ms{ms:${ms}}`, ['avg>=0']],
        [`cpu_iterations{ms:${ms}}`, ['avg>=0']],
        [`cpu_passed{ms:${ms}}`, ['count>=0']],
        [`http_req_failed{ms:${ms}}`, ['rate>=0']],
      ]),
    ),
    http_req_failed: [`rate<=${maxFailed}`],
    checks: [`rate>=${1 - maxFailed}`],
  },
});

export function setup() {
  const data = setupCommon('S8', { key: requireKey(true) });
  return data;
}

export default function () {
  const ms = levels[Math.floor(exec.scenario.iterationInTest / iterations)];
  const res = postJson(
    `/api/debug/cpu?ms=${ms}`,
    ADMIN_API_KEY,
    {},
    { name: 'POST /api/debug/cpu', tags: { ms: String(ms) }, timeout: '60s' },
  );
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'ran at least ms': (r) => r.status === 200 && r.json('elapsedMs') >= ms - 1,
  });
  if (res.status === 200) {
    burned.add(res.json('elapsedMs'), { ms: String(ms) });
    hashes.add(res.json('iterations'), { ms: String(ms) });
  }
  if (ok) passed.add(1, { ms: String(ms) });
}

export const handleSummary = makeHandleSummary({
  id: 'S8',
  title: 'CPU limit POST /api/debug/cpu',
  local:
    'No CPU limit applies to a long-running container, so every level passes and the request takes about the requested time. cpu_iterations (SHA-256 blocks per call) shows how much work the process got done in that time on this machine; it is the figure to compare between platforms. Not a statement about any platform limit.',
  extra: () => ({ levelsMs: levels, iterationsPerLevel: iterations }),
});
