// One upload from the client's side: create, PUT to the presigned URL, complete, then optionally wait for a terminal
// status. Used by S4, S5, S9 and the failure-mode checks. Metrics are created here (init context).
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { completeUpload, createUpload, getFile, putObject, waitTerminal } from './api.js';

import { contentTypeOf, unique } from './fixtures.js';

/** ready_at - queued_at as the API reports it: the number the spec calls upload_to_ready_ms. */
export const uploadToReady = new Trend('upload_to_ready_ms');
/** From the end of the complete response to the poll that saw a terminal status (includes the poll interval). */
export const readyWait = new Trend('ready_wait_ms');
/** From the start of create to the poll that saw `ready`. */
export const uploadTotal = new Trend('upload_total_ms');
export const uploadOk = new Rate('upload_ok');
export const uploadOutcome = new Counter('upload_outcome');
export const uploadBytes = new Counter('upload_bytes');

export const OUTCOMES = ['ready', 'failed', 'timeout', 'create', 'put', 'complete', 'blocked', 'complete_ok'];
export const outcomeThresholds = () =>
  Object.fromEntries(OUTCOMES.map((o) => [`upload_outcome{outcome:${o}}`, ['count>=0']]));

/**
 * @param {{ key: string, fixture: object, token: string, wait?: boolean, timeoutMs?: number, intervalS?: number, chaos?: string, tags?: object }} o
 */
export function uploadOnce({
  key,
  fixture,
  token,
  wait = true,
  timeoutMs = 60000,
  intervalS = 0.25,
  chaos,
  tags = {},
}) {
  const started = Date.now();
  const body = unique(fixture, token);
  const contentType = contentTypeOf(fixture);
  const result = { id: null, outcome: 'create', status: null, attempts: null };
  const finish = (outcome) => {
    result.outcome = outcome;
    uploadOutcome.add(1, { outcome, ...tags });
    uploadOk.add(outcome === 'ready' || (!wait && outcome === 'complete_ok'), tags);
    return result;
  };

  const created = createUpload(key, contentType, body.byteLength);
  if (!check(created, { 'create 201': (r) => r.status === 201 })) return finish('create');
  const info = created.json();
  result.id = info.fileId;
  const put = putObject(info.uploadUrl, info.uploadHeaders, body);
  if (put.blocked) return finish('blocked');
  if (!check(put, { 'PUT 200': (r) => r.status === 200 })) return finish('put');
  uploadBytes.add(body.byteLength, tags);
  const completed = completeUpload(key, info.fileId, chaos ? { headers: { 'x-chaos': chaos } } : {});
  if (!check(completed, { 'complete 200': (r) => r.status === 200 })) return finish('complete');
  const completedAt = Date.now();
  if (!wait) return finish('complete_ok');

  const { file } = waitTerminal(key, info.fileId, { timeoutMs, intervalS });
  result.status = file?.status ?? null;
  result.attempts = file?.attempts ?? null;
  readyWait.add(Date.now() - completedAt, tags);
  if (!file || (file.status !== 'ready' && file.status !== 'failed')) return finish('timeout');
  if (file.status === 'failed') return finish('failed');
  uploadTotal.add(Date.now() - started, tags);
  if (file.queuedAt && file.readyAt)
    uploadToReady.add(Date.parse(file.readyAt) - Date.parse(file.queuedAt), tags);
  return finish('ready');
}

/** Counter that is unique across all VUs of the test, for building upload tokens. */
export const iterationInTest = () => exec.scenario.iterationInTest;
export { getFile };
