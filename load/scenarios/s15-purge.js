// S15: cache purge. A public page is read every POLL_MS; at PURGE_AT seconds the purge API named by PURGE_URL is
// called, and the result is the time until a response is a positive cache miss (the cache header says so). The run
// fails when the page was never a cache hit before the purge (nothing was cached, so a "miss" proves nothing), when
// the purge call does not answer 2xx, and when no miss is seen. Without PURGE_URL nothing can be purged: the run is
// recorded as skipped, not as passed.
import { sleep } from 'k6';
import { Gauge, Rate } from 'k6/metrics';
import { publicPage } from '../lib/api.js';
import { assertAllowed, requireKey } from '../lib/config.js';
import { cacheState, recordCacheHeaders } from '../lib/headers.js';
import { param, seconds } from '../lib/params.js';
import { purge } from '../lib/purge.js';
import { baseOptions, makeHandleSummary, setupCommon } from '../lib/scenario.js';
import { seedPublicFile } from '../lib/seed.js';

assertAllowed('S15');
const purgeUrl = __ENV.PURGE_URL || '';
const duration = param('DURATION', '2m', '30s');
const pollMs = param('POLL_MS', 1000, 1000);
const purgeAt = param('PURGE_AT', 10, 5);
const hitBefore = new Rate('hit_before_purge');
const purgeOk = new Rate('purge_ok');
const missSeen = new Rate('miss_after_purge');
const toMiss = new Gauge('time_to_miss_s');

export const options = baseOptions({
  scenarios: purgeUrl
    ? {
        purge: {
          executor: 'per-vu-iterations',
          vus: 1,
          iterations: 1,
          maxDuration: `${seconds(duration) + 120}s`,
        },
      }
    : { skipped: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '30s' } },
  thresholds: purgeUrl
    ? {
        hit_before_purge: ['rate==1'],
        purge_ok: ['rate==1'],
        miss_after_purge: ['rate==1'],
        http_req_failed: ['rate<0.05'],
      }
    : {},
});

export function setup() {
  if (!purgeUrl) return setupCommon('S15', {});
  const key = requireKey();
  const data = setupCommon('S15', { key });
  data.fileId = seedPublicFile(key, data.runId);
  return data;
}

const event = (payload) => console.log(`HM_EVENT ${JSON.stringify(payload)}`);

export default function (data) {
  if (!purgeUrl) return;
  const startedAt = Date.now();
  const total = seconds(duration) * 1000;
  let purgedAt = null;
  let hits = 0;
  let sawMiss = false;
  while (Date.now() - startedAt < total) {
    const tick = Date.now();
    if (purgedAt === null && tick - startedAt >= purgeAt * 1000) {
      // The page must have been served from the cache before the purge, or the purge has nothing to remove.
      hitBefore.add(hits > 0);
      if (hits === 0) {
        event({
          type: 'aborted',
          reason: 'the page was never a cache hit before the purge',
          hitsBeforePurge: 0,
        });
        missSeen.add(false);
        return;
      }
      const sent = purge(data.fileId);
      purgeOk.add(sent.ok);
      purgedAt = Date.now();
      event({
        type: 'purge',
        t: (purgedAt - startedAt) / 1000,
        status: sent.status,
        ok: sent.ok,
        hitsBeforePurge: hits,
      });
      if (!sent.ok) {
        missSeen.add(false);
        return;
      }
    }
    const res = publicPage(data.fileId);
    const state = cacheState(recordCacheHeaders(res));
    if (purgedAt === null) {
      if (state === 'hit') hits++;
    } else if (!sawMiss && (state === 'miss' || state === 'dynamic')) {
      sawMiss = true;
      toMiss.add((Date.now() - purgedAt) / 1000);
      event({ type: 'miss', afterPurgeS: (Date.now() - purgedAt) / 1000, state });
    }
    const wait = pollMs - (Date.now() - tick);
    if (wait > 0) sleep(wait / 1000);
  }
  missSeen.add(sawMiss);
}

export const handleSummary = makeHandleSummary({
  id: 'S15',
  title: 'Cache purge',
  local:
    'Cannot run locally: there is no CDN and no purge API. The run is recorded as skipped and measures nothing. Without a cache header a hit cannot be told from a miss even if a purge were available.',
  extra: () => ({
    skipped: purgeUrl
      ? null
      : { reason: 'PURGE_URL is not set: the local stack has no CDN and no purge API' },
  }),
});
