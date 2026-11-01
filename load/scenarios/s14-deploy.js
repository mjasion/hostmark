// S14: deploy propagation. One VU polls GET /api/health once per POLL_MS and watches x-version; the deploy is
// triggered from outside (a pipeline, `git push`, or the local helper in run.mjs) right after this starts. Every
// change of x-version is logged with its time. With EXPECT_VERSION set the run fails if that version never appears.
// `t` in the events is seconds since the first poll. DEPLOY_STARTED_AT (ISO time) names the moment the deploy was
// started, so `time_to_expected_version_s` counts from the deploy and not from the first poll; without it the
// number is only "seconds since the poll started" and the result says so.

import { sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';
import { assertAllowed, BASE_URL } from '../lib/config.js';
import { headerOf } from '../lib/headers.js';
import { param, seconds } from '../lib/params.js';
import { baseOptions, latencyBound, makeHandleSummary, setupCommon } from '../lib/scenario.js';

assertAllowed('S14');
const duration = param('DURATION', '10m', '45s');
const pollMs = param('POLL_MS', 1000, 1000);
const expected = __ENV.EXPECT_VERSION || '';
const deployStartedMs = __ENV.DEPLOY_STARTED_AT ? Date.parse(__ENV.DEPLOY_STARTED_AT) : null;
if (__ENV.DEPLOY_STARTED_AT && !Number.isFinite(deployStartedMs))
  throw new Error('DEPLOY_STARTED_AT must be an ISO time');
const maxFailed = latencyBound('MAX_FAILED', 0.2);
const changes = new Counter('version_changes');
const polls = new Trend('poll_ms');
const seenExpected = new Rate('expected_version_seen');
const timeToExpected = new Gauge('time_to_expected_version_s');
const errors = new Counter('poll_errors');

export const options = baseOptions({
  scenarios: {
    poll: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: `${seconds(duration) + 60}s` },
  },
  thresholds: {
    http_req_failed: [`rate<${maxFailed}`],
    ...(expected ? { expected_version_seen: ['rate==1'] } : {}),
  },
});

export function setup() {
  return setupCommon('S14', { routes: ['/api/health'] });
}

export default function () {
  const startedAt = Date.now();
  const total = seconds(duration) * 1000;
  let version = null;
  let seen = false;
  while (Date.now() - startedAt < total) {
    const tick = Date.now();
    const res = http.get(`${BASE_URL}/api/health`, {
      tags: { name: 'GET /api/health' },
      redirects: 0,
      timeout: '5s',
    });
    polls.add(res.timings.duration);
    const v = res.status === 200 ? (headerOf(res, 'x-version') ?? null) : undefined;
    const t = Math.round((tick - startedAt) / 100) / 10;
    if (res.status !== 200) {
      errors.add(1);
      console.log(
        `HM_EVENT ${JSON.stringify({ type: 'poll-error', t, status: res.status, error: res.error || undefined })}`,
      );
    } else if (v !== version) {
      if (version !== null) changes.add(1);
      console.log(`HM_EVENT ${JSON.stringify({ type: 'version', t, at: tick, from: version, to: v })}`);
      version = v;
      if (expected && v === expected && !seen) {
        seen = true;
        timeToExpected.add(deployStartedMs === null ? t : Math.round((tick - deployStartedMs) / 100) / 10);
      }
    }
    const wait = pollMs - (Date.now() - tick);
    if (wait > 0) sleep(wait / 1000);
  }
  if (expected) seenExpected.add(seen);
  console.log(
    `HM_EVENT ${JSON.stringify({ type: 'version-final', version, expected: expected || null, seen: expected ? seen : null, seconds: seconds(duration), vu: exec.vu.idInTest })}`,
  );
}

export const handleSummary = makeHandleSummary({
  id: 'S14',
  title: 'Deploy propagation',
  local:
    'Without a deploy, x-version never changes and the run only proves the header is served. With HM_LOCAL_DEPLOY=1, run.mjs rebuilds the image with a new APP_VERSION and recreates the api container after 10 s: the result then shows how long the single local container was unreachable and when the new version first answered. That is a restart of one process, not propagation to edge locations, and only one polling location exists.',
  extra: () => ({
    expectedVersion: expected || null,
    pollMs,
    deployStartedAt: __ENV.DEPLOY_STARTED_AT || null,
    timeToExpectedFrom:
      deployStartedMs === null ? 'first poll (no deploy start was given)' : 'DEPLOY_STARTED_AT',
  }),
});
