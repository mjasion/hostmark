// Response headers a CDN adds. They are recorded unchanged: counted by value for the values that are known (a
// threshold on each creates the sub-metric the summary needs), and every distinct raw value is also logged once per VU.
import { Counter } from 'k6/metrics';
import { cacheState } from './cache-state.js';

export const CACHE_HEADERS = ['cf-cache-status', 'x-vercel-cache', 'x-cache'];

const KNOWN = {
  'cf-cache-status': ['HIT', 'MISS', 'EXPIRED', 'STALE', 'BYPASS', 'DYNAMIC', 'REVALIDATED', 'UPDATING'],
  'x-vercel-cache': ['HIT', 'MISS', 'STALE', 'PRERENDER', 'REVALIDATED', 'BYPASS'],
  'x-cache': [
    'HIT',
    'MISS',
    'Hit from cloudfront',
    'Miss from cloudfront',
    'RefreshHit from cloudfront',
    'Error from cloudfront',
  ],
};

const seen = new Counter('cache_header_seen');
const loggedValues = {};

/** Thresholds that make the per-value sub-metrics appear in the summary; always true, so they gate nothing. */
export function cacheHeaderThresholds() {
  const out = { 'cache_header_seen{value:other}': ['count>=0'] };
  for (const header of CACHE_HEADERS) {
    for (const value of KNOWN[header])
      out[`cache_header_seen{header:${header},value:${value}}`] = ['count>=0'];
  }
  return out;
}

export function headerOf(res, name) {
  for (const key of Object.keys(res.headers)) if (key.toLowerCase() === name) return res.headers[key];
  return undefined;
}

/** Returns the raw values of the cache headers present in a response. */
export function recordCacheHeaders(res) {
  const found = {};
  for (const header of CACHE_HEADERS) {
    const value = headerOf(res, header);
    if (value === undefined) continue;
    found[header] = value;
    const known = KNOWN[header].includes(value);
    seen.add(1, known ? { header, value } : { header, value: 'other' });
    const id = `${header}\n${value}`;
    if (!loggedValues[id]) {
      loggedValues[id] = true;
      console.log(`HM_EVENT ${JSON.stringify({ type: 'header', header, value })}`);
    }
  }
  for (const header of ['cache-control', 'age']) {
    const value = headerOf(res, header);
    if (value === undefined) continue;
    const id = `${header}\n${value}`;
    if (!loggedValues[id]) {
      loggedValues[id] = true;
      console.log(`HM_EVENT ${JSON.stringify({ type: 'header', header, value })}`);
    }
  }
  return found;
}

export { cacheState };
