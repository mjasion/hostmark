// S5: upload burst. UPLOADS files of 1 MB in BURST_SECONDS, every one created, PUT and completed without waiting
// for the result; a second scenario then watches the gallery until every file of the run is terminal. The drain time
// is measured from the start of the burst.

import { sleep } from 'k6';
import exec from 'k6/execution';
import { Gauge, Rate, Trend } from 'k6/metrics';
import { assertAllowed, requireKey } from '../lib/config.js';
import { loadFixture, tokenOf } from '../lib/fixtures.js';
import { param, seconds } from '../lib/params.js';
import { baseOptions, errorGates, makeHandleSummary, newestFile, setupCommon } from '../lib/scenario.js';
import { outcomeThresholds, uploadOnce } from '../lib/upload.js';
import { windowSnapshot } from '../lib/window.js';

assertAllowed('S5');
const uploads = param('UPLOADS', 1000, 60);
const burstSeconds = param('BURST_SECONDS', 60, 10);
const drainLimit = param('DRAIN_TIMEOUT', '20m', '3m');
const pollSeconds = param('POLL_S', 5, 2);
const photo = loadFixture('jpeg-1mb.jpg');
const drainSecondsGauge = new Gauge('drain_seconds');
// One sample when the drain loop ends: true when every file of the run was terminal, false when it gave up. A gauge
// that was never set passes its threshold, so the verdict cannot depend on `drain_seconds`.
const drained = new Rate('drained');
const drainLagTrend = new Trend('drain_poll_ms');
const sentCounter = new Gauge('burst_window_files');

export const options = baseOptions({
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: uploads,
      timeUnit: `${burstSeconds}s`,
      duration: `${burstSeconds}s`,
      preAllocatedVUs: 60,
      maxVUs: 400,
      exec: 'burst',
      gracefulStop: '60s',
    },
    drain: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      startTime: `${burstSeconds + 2}s`,
      // The loop gives up by itself at DRAIN_TIMEOUT after the start of the burst; this only stops a stuck request.
      maxDuration: `${seconds(drainLimit) + 120}s`,
      exec: 'drain',
    },
  },
  thresholds: {
    ...errorGates({ scenario: 'burst', expectedIterations: uploads }),
    ...outcomeThresholds(),
    'upload_ok{scenario:burst}': ['rate>0.99'],
    drained: ['rate==1'],
  },
});

export function setup() {
  const key = requireKey();
  const data = setupCommon('S5', { key });
  data.boundary = newestFile(key)?.id ?? null;
  data.t0Ms = Date.now();
  return data;
}

export function burst(data) {
  uploadOnce({
    key: requireKey(),
    fixture: photo,
    token: tokenOf(data.runId, 's5', exec.scenario.iterationInTest),
    wait: false,
  });
}

export function drain(data) {
  const key = requireKey();
  let clean = 0;
  let firstClean = null;
  let last = {};
  for (;;) {
    if ((Date.now() - data.t0Ms) / 1000 > seconds(drainLimit)) {
      drained.add(false);
      console.log(
        `HM_EVENT ${JSON.stringify({ type: 'drain-timeout', limitS: seconds(drainLimit), ...last })}`,
      );
      return;
    }
    const t0 = Date.now();
    const snap = windowSnapshot(key, data.boundary);
    drainLagTrend.add(Date.now() - t0);
    if (snap) {
      const elapsed = (Date.now() - data.t0Ms) / 1000;
      console.log(`HM_EVENT ${JSON.stringify({ type: 'timeline', t: Math.round(elapsed), ...snap })}`);
      last = snap;
      sentCounter.add(snap.total);
      clean = snap.nonTerminal === 0 && snap.total > 0 ? clean + 1 : 0;
      if (clean === 1) firstClean = elapsed;
      if (clean >= 2) {
        drainSecondsGauge.add(Math.round(firstClean));
        // drained means every file is ready; a file that ended failed or deleted does not count as a pass
        drained.add((snap.byStatus.ready ?? 0) === snap.total);
        console.log(`HM_EVENT ${JSON.stringify({ type: 'drained', seconds: Math.round(elapsed), ...snap })}`);
        return;
      }
    }
    sleep(pollSeconds);
  }
}

export const handleSummary = makeHandleSummary({
  id: 'S5',
  title: 'Upload burst',
  scope: 'burst',
  local:
    'The local worker is replicated by process (2 replicas, one job at a time each, D97) and has a fixed size: there is no autoscaling, so drain time is queue length divided by the throughput of those processes (about 1.3 files/s of 12 MP per process; the WASM codecs run on one JS thread). Uploads go to MinIO on the same host. The burst itself (create, PUT, complete) is limited by the single Node API process, not by a platform autoscaler.',
  extra: (data) => {
    const sent = data.metrics['upload_outcome{outcome:complete_ok}']?.values.count ?? 0;
    const seen = data.metrics.burst_window_files?.values.value;
    const failures = [];
    // The window the drain loop watched must hold exactly the files the burst completed.
    if (seen !== sent) failures.push(`window held ${seen ?? 'no'} files, ${sent} were completed`);
    return { failures, sent };
  },
});
