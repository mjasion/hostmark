// The cache purge call of S12 and S15. PURGE_URL is checked by the guard (guard.js): it must stay on the target host
// unless LOAD_ACK_PURGE_HOST names another one, because the call carries PURGE_TOKEN.
import http from 'k6/http';
import { BASE_URL } from './config.js';

/** `{id}` and `{base}` in PURGE_URL and PURGE_BODY are replaced; returns the status and whether it was 2xx. */
export function purge(fileId) {
  const fill = (text) => text.replaceAll('{id}', fileId).replaceAll('{base}', BASE_URL);
  const body = __ENV.PURGE_BODY ? fill(__ENV.PURGE_BODY) : null;
  const res = http.request(__ENV.PURGE_METHOD || 'POST', fill(__ENV.PURGE_URL), body, {
    headers: {
      'content-type': 'application/json',
      ...(__ENV.PURGE_TOKEN ? { Authorization: `Bearer ${__ENV.PURGE_TOKEN}` } : {}),
    },
    tags: { name: 'purge' },
    responseCallback: http.expectedStatuses({ min: 200, max: 299 }),
    redirects: 0,
  });
  return { status: res.status, ok: res.status >= 200 && res.status < 300 };
}
