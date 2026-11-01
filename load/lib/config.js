// Inputs of every k6 scenario. Only BASE_URL and the keys differ between platforms; everything else is a label
// (REGION, TOPOLOGY, VARIANT) or a load parameter (see params.js). The scenarios name no platform.
import { checkGuard, isLoopbackHost, parseBaseUrl } from './guard.js';

export const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:58080').replace(/\/+$/, '');
/** True when the target is this machine; only then do the `meaning` strings and presigned-URL checks apply. */
export const LOOPBACK = isLoopbackHost(parseBaseUrl(BASE_URL).host);
export const API_KEY = __ENV.API_KEY || '';
export const ADMIN_API_KEY = __ENV.ADMIN_API_KEY || '';
export const SHORT = __ENV.SHORT === '1';

/** Free-text labels copied into the result. S10 to S15 run once per region, so the region is an input. */
export const LABELS = {
  region: __ENV.REGION || 'local',
  topology: __ENV.TOPOLOGY || 'single',
  variant: __ENV.VARIANT || '',
  note: __ENV.NOTE || '',
};

/** Fails the run at init, before a single request, when the target needs an acknowledgement that is missing. */
export function assertAllowed(scenario) {
  const verdict = checkGuard({ baseUrl: BASE_URL, scenario, env: __ENV });
  if (verdict.problems.length > 0)
    throw new Error(`refusing to run ${scenario}: ${verdict.problems.join('; ')}`);
  return verdict;
}

export function requireKey(admin = false) {
  const key = admin ? ADMIN_API_KEY : API_KEY;
  if (!key) throw new Error(`${admin ? 'ADMIN_API_KEY' : 'API_KEY'} is not set`);
  return key;
}
