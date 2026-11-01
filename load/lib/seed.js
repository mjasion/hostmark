// Files a scenario needs before it starts, created in setup() through the public API.
import { listFiles, setPublic, uploadFile, waitTerminal } from './api.js';
import { contentTypeOf, loadFixture, tokenOf, unique } from './fixtures.js';

const tiny = loadFixture('jpeg-tiny.jpg');
const photo = loadFixture('jpeg-1mb.jpg');

/**
 * Seeding must not hang on one lost request: S4 lost two POSTs and one S6 setup lost a PUT to the 60 s default timeout,
 * with the api answering everything else in milliseconds. Each request gets 15 s and an upload that fails is tried again
 * (as a new upload, so a hung one leaves at most a `pending_upload` row behind).
 */
function seedUpload(key, fixture, runId, kind) {
  let up;
  for (let attempt = 0; attempt < 3; attempt++) {
    up = uploadFile(key, contentTypeOf(fixture), unique(fixture, tokenOf(runId, kind, attempt)), {
      timeout: '15s',
    });
    if (up.completeStatus === 200) return up;
  }
  throw new Error(`seed upload failed: ${JSON.stringify(up)}`);
}

function readyFile(key, fixture, runId, kind, isPublic) {
  const up = seedUpload(key, fixture, runId, kind);
  const { file } = waitTerminal(key, up.id, { timeoutMs: 120000 });
  if (file?.status !== 'ready') throw new Error(`seed file ${up.id} ended as ${file?.status}`);
  if (isPublic) {
    const res = setPublic(key, up.id, true);
    if (res.status !== 200) throw new Error(`publish of seed file answered ${res.status}`);
  }
  return up.id;
}

/** A fresh ready file with variants (a small image). */
export const seedReadyFile = (key, runId) => readyFile(key, tiny, runId, 'sd', false);

/** A fresh ready file of the S4 size (a 1 MB, 12 MP photo), published, for the /f/:id scenarios. */
export const seedPublicFile = (key, runId) => readyFile(key, photo, runId, 'pb', true);

/** Tops the key's account up to `count` ready files so that `GET /api/files?limit=50` returns a full page. */
export function seedListFiles(key, runId, count) {
  const res = listFiles(key, `limit=${Math.min(count, 100)}`);
  const have = res.status === 200 ? res.json().items.filter((f) => f.status === 'ready').length : 0;
  const ids = [];
  for (let i = 0; i < count - have; i++) {
    const up = uploadFile(key, 'image/jpeg', unique(tiny, tokenOf(runId, 'ls', i)));
    if (up.completeStatus === 200) ids.push(up.id);
  }
  for (const id of ids) waitTerminal(key, id, { timeoutMs: 120000 });
  return { had: have, added: ids.length };
}
