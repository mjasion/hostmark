// Calls to the hostmark API. Routes are the canonical paths of D5. Request names are tagged so the summary groups
// them (presigned URLs and file ids would otherwise make one series per request).
import { check, sleep } from 'k6';
import http from 'k6/http';
import { BASE_URL, LOOPBACK } from './config.js';
import { uploadUrlAllowed } from './guard.js';
import { headerOf } from './headers.js';

const failuresLogged = { n: 0 };

export const bearer = (key) => ({ Authorization: `Bearer ${key}` });

/** Logs the status and trace id of a failed request, at most 5 per VU, so a failure can be found in the API logs. */
export function noteFailure(res, what) {
  if (failuresLogged.n >= 5) return;
  failuresLogged.n++;
  console.log(
    `HM_EVENT ${JSON.stringify({
      type: 'error',
      what,
      status: res.status,
      traceId: headerOf(res, 'x-trace-id') ?? null,
      error: res.error || undefined,
    })}`,
  );
}

function request(method, path, key, { body, name, expect = 200, headers = {}, tags = {}, timeout } = {}) {
  const expected = [].concat(expect);
  const params = {
    headers: { ...(key ? bearer(key) : {}), ...headers },
    tags: { name: name ?? `${method} ${path}`, ...tags },
    responseCallback: http.expectedStatuses(...expected),
    redirects: 0,
    ...(timeout ? { timeout } : {}),
  };
  const res = http.request(method, `${BASE_URL}${path}`, body, params);
  if (!expected.includes(res.status)) noteFailure(res, params.tags.name);
  return res;
}

export const get = (path, key, opts) => request('GET', path, key, opts);
export const postJson = (path, key, payload, opts = {}) =>
  request('POST', path, key, {
    ...opts,
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', ...opts.headers },
  });

export const health = (opts) => get('/api/health', null, { name: 'GET /api/health', ...opts });
export const deepHealth = (opts) => get('/api/health/deep', null, { name: 'GET /api/health/deep', ...opts });
export const getFile = (key, id, opts) =>
  get(`/api/files/${id}`, key, { name: 'GET /api/files/:id', ...opts });
export const listFiles = (key, query = 'limit=50', opts) =>
  get(`/api/files?${query}`, key, { name: 'GET /api/files', ...opts });
export const publicPage = (id, opts) => get(`/f/${id}`, null, { name: 'GET /f/:id', ...opts });

export function createUpload(key, contentType, bytes, opts) {
  return postJson(
    '/api/uploads',
    key,
    { contentType, bytes },
    { name: 'POST /api/uploads', expect: 201, ...opts },
  );
}

export function completeUpload(key, id, opts = {}) {
  return request('POST', `/api/uploads/${id}/complete`, key, {
    name: 'POST /api/uploads/:id/complete',
    ...opts,
  });
}

export function setPublic(key, id, isPublic) {
  return request('PATCH', `/api/files/${id}`, key, {
    name: 'PATCH /api/files/:id',
    body: JSON.stringify({ isPublic }),
    headers: { 'content-type': 'application/json' },
  });
}

/** PUT to the presigned URL, with exactly the headers the API returned and nothing else (D10). */
export function putObject(uploadUrl, uploadHeaders, body, { timeout } = {}) {
  // Every upload path ends here, so this is the one place that keeps a loopback run from PUTting elsewhere.
  if (!uploadUrlAllowed(uploadUrl, LOOPBACK)) {
    const blocked = { status: 0, headers: {}, error: 'upload URL left loopback', blocked: true };
    noteFailure(blocked, 'presigned URL blocked');
    return blocked;
  }
  const res = http.put(uploadUrl, body, {
    headers: uploadHeaders,
    tags: { name: 'PUT presigned URL' },
    ...(timeout ? { timeout } : {}),
    responseCallback: http.expectedStatuses(200),
    redirects: 0,
  });
  if (res.status !== 200) noteFailure(res, 'PUT presigned URL');
  return res;
}

/** Polls `GET /api/files/:id` until the file leaves queued and processing, or the timeout passes. */
export function waitTerminal(key, id, { timeoutMs = 60000, intervalS = 0.5 } = {}) {
  const started = Date.now();
  let last = null;
  for (;;) {
    const res = getFile(key, id, { name: 'GET /api/files/:id (poll)' });
    if (res.status === 200) {
      last = res.json();
      if (last.status === 'ready' || last.status === 'failed' || last.status === 'deleted') break;
    }
    if (Date.now() - started > timeoutMs) break;
    sleep(intervalS);
  }
  return { file: last, waitedMs: Date.now() - started };
}

/** Creates, uploads and completes one file. Returns the ids and the status of each step. */
export function uploadFile(key, contentType, body, { timeout, ...opts } = {}) {
  const requestOpts = timeout ? { timeout } : {};
  const created = createUpload(key, contentType, body.byteLength, requestOpts);
  const out = { createStatus: created.status, id: null, putStatus: null, completeStatus: null };
  if (created.status !== 201) return out;
  const info = created.json();
  out.id = info.fileId;
  const put = putObject(info.uploadUrl, info.uploadHeaders, body, requestOpts);
  out.putStatus = put.status;
  if (put.status !== 200) return out;
  const complete = completeUpload(key, info.fileId, { ...requestOpts, ...opts });
  out.completeStatus = complete.status;
  return out;
}

export const okStatus = (res, status = 200) =>
  check(res, { [`status ${status}`]: (r) => r.status === status });
