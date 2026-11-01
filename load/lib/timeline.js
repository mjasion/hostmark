// Time buckets for scenarios that care about "when": every request carries a `bucket` tag (seconds since the scenario
// started, divided by the bucket size), and thresholds that never fail make k6 report each bucket in the summary.
import exec from 'k6/execution';

export const bucketTag = (bucketS) =>
  String(Math.floor((Date.now() - exec.scenario.startTime) / 1000 / bucketS));

export function bucketThresholds(totalS, bucketS) {
  const out = {};
  for (let b = 0; b <= Math.ceil(totalS / bucketS); b++) {
    out[`http_req_duration{bucket:${b}}`] = ['avg>=0'];
    out[`http_req_failed{bucket:${b}}`] = ['rate>=0'];
  }
  return out;
}

/**
 * First bucket from which every later bucket has p95 within `bound` ms and no failed request. Returns seconds from
 * the start of the scenario, or null when the last bucket is not stable.
 */
export function stabilisation(metrics, totalS, bucketS, bound) {
  const rows = [];
  for (let b = 0; b <= Math.ceil(totalS / bucketS); b++) {
    const d = metrics[`http_req_duration{bucket:${b}}`];
    const f = metrics[`http_req_failed{bucket:${b}}`];
    if (!d || !f || f.values.passes + f.values.fails === 0) continue;
    rows.push({
      fromS: b * bucketS,
      requests: f.values.passes + f.values.fails,
      failedPct: Math.round(f.values.rate * 10000) / 100,
      p50: Math.round(d.values.med * 10) / 10,
      p95: Math.round(d.values['p(95)'] * 10) / 10,
      max: Math.round(d.values.max * 10) / 10,
    });
  }
  let stable = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].p95 <= bound && rows[i].failedPct === 0) stable = rows[i].fromS;
    else break;
  }
  return { buckets: rows, stableFromS: stable };
}
