import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createNeonClient,
  deletePreviewBranch,
  ensurePreviewBranch,
  NeonError,
  previewBranchName,
} from '../neon.mjs';
import { BRANCH, ENDPOINT, fakeFetch, PARENT, URI_DIRECT, URI_POOLED } from './helpers.mjs';

const client = (fetch) => createNeonClient({ apiKey: 'k', projectId: 'proj-1', fetch });
const input = {
  pr: 7,
  parentId: PARENT,
  database: 'hostmark',
  role: 'app',
  now: new Date('2026-11-01T00:00:00Z'),
};
const uris = [
  { method: 'GET', match: 'connection_uri', json: { uri: URI_DIRECT } },
  { method: 'GET', match: 'connection_uri', json: { uri: URI_POOLED } },
];

test('branch name only accepts positive integers', () => {
  assert.equal(previewBranchName(7), 'preview/pr-7');
  assert.equal(previewBranchName('12'), 'preview/pr-12');
  for (const bad of [0, -1, 1.5, '1; rm -rf', '../x', '', null, undefined, '1e3'])
    assert.throws(() => previewBranchName(bad), /positive integer/);
});

test('client refuses an empty key or a malformed project id', () => {
  assert.throws(() => createNeonClient({ apiKey: '', projectId: 'p-1' }));
  assert.throws(() => createNeonClient({ apiKey: 'k', projectId: '../x' }));
});

test('ensure creates the branch with a TTL when none exists', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: 'branches?search=preview%2Fpr-7', json: { branches: [] } },
    { method: 'POST', match: '/branches', json: { branch: { id: BRANCH }, endpoints: [{ id: ENDPOINT }] } },
    ...uris,
  ]);
  const result = await ensurePreviewBranch(client(fetch), input);
  assert.equal(result.created, true);
  assert.equal(result.direct, URI_DIRECT);
  assert.equal(result.pooled, URI_POOLED);
  const create = fetch.calls.find((c) => c.method === 'POST');
  assert.equal(create.body.branch.parent_id, PARENT);
  assert.equal(create.body.branch.name, 'preview/pr-7');
  assert.equal(create.body.branch.expires_at, '2026-11-08T00:00:00.000Z');
  assert.equal(create.headers.authorization, 'Bearer k');
  assert.deepEqual(fetch.remaining(), []);
});

test('ensure reuses an existing branch instead of creating another', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: 'branches?search', json: { branches: [{ id: BRANCH, name: 'preview/pr-7' }] } },
    { method: 'GET', match: `${BRANCH}/endpoints`, json: { endpoints: [{ id: ENDPOINT }] } },
    ...uris,
  ]);
  const result = await ensurePreviewBranch(client(fetch), input);
  assert.equal(result.created, false);
  assert.ok(!fetch.calls.some((c) => c.method === 'POST'));
});

test('search is by exact name: pr-7 does not match pr-70', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: 'search', json: { branches: [{ id: 'br-other-1', name: 'preview/pr-70' }] } },
  ]);
  assert.equal(await client(fetch).findBranch('preview/pr-7'), null);
});

test('two branches with one name are refused, not guessed', async () => {
  const fetch = fakeFetch([
    {
      method: 'GET',
      match: 'search',
      json: {
        branches: [
          { id: 'br-a-1', name: 'preview/pr-7' },
          { id: 'br-b-2', name: 'preview/pr-7' },
        ],
      },
    },
  ]);
  await assert.rejects(client(fetch).findBranch('preview/pr-7'), /refusing to pick/);
});

test('a failed create surfaces the API message and creates no connection URI', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: 'search', json: { branches: [] } },
    { method: 'POST', match: '/branches', status: 422, json: { message: 'branch limit exceeded' } },
  ]);
  await assert.rejects(
    ensurePreviewBranch(client(fetch), input),
    (e) => e instanceof NeonError && e.status === 422 && /branch limit exceeded/.test(e.message),
  );
});

test('a partial create (branch without endpoint) is deleted again and reported', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: 'search', json: { branches: [] } },
    { method: 'POST', match: '/branches', json: { branch: { id: BRANCH }, endpoints: [] } },
    { method: 'DELETE', match: `/branches/${BRANCH}`, json: {} },
  ]);
  await assert.rejects(ensurePreviewBranch(client(fetch), input), /without an endpoint id/);
  assert.deepEqual(fetch.remaining(), []);
});

test('a partial create whose cleanup also fails says so', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: 'search', json: { branches: [] } },
    { method: 'POST', match: '/branches', json: { branch: { id: BRANCH } } },
    { method: 'DELETE', match: BRANCH, status: 500, json: {} },
  ]);
  await assert.rejects(ensurePreviewBranch(client(fetch), input), /removing it failed/);
});

test('a create answer without a branch id is an error', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: 'search', json: { branches: [] } },
    { method: 'POST', match: '/branches', json: {} },
  ]);
  await assert.rejects(ensurePreviewBranch(client(fetch), input), /without a branch id/);
});

test('an existing branch without an endpoint is an error', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: 'search', json: { branches: [{ id: BRANCH, name: 'preview/pr-7' }] } },
    { method: 'GET', match: 'endpoints', json: { endpoints: [] } },
  ]);
  await assert.rejects(ensurePreviewBranch(client(fetch), input), /without an endpoint/);
});

test('malformed answers: html body, missing array, odd connection uri, network error', async () => {
  await assert.rejects(
    client(fakeFetch([{ method: 'GET', match: 'search', raw: '<html>' }])).findBranch('x'),
    /"branches" array/,
  );
  await assert.rejects(
    client(fakeFetch([{ method: 'GET', match: 'search', status: 502, raw: 'Bad gateway' }])).findBranch('x'),
    /answered 502/,
  );
  await assert.rejects(
    client(fakeFetch([{ method: 'GET', match: 'search', throws: 'ECONNRESET' }])).findBranch('x'),
    /before a response: ECONNRESET/,
  );
  await assert.rejects(
    client(fakeFetch([{ method: 'GET', match: 'connection_uri', json: { uri: 'mysql://x' } }])).connectionUri(
      { branchId: BRANCH, endpointId: ENDPOINT, database: 'd', role: 'r', pooled: false },
    ),
    /usable "uri"/,
  );
});

test('a parent that is not a branch id is refused before any call', async () => {
  const fetch = fakeFetch([]);
  await assert.rejects(ensurePreviewBranch(client(fetch), { ...input, parentId: '' }), /PARENT_BRANCH_ID/);
  assert.equal(fetch.calls.length, 0);
});

test('delete: removes, treats absent as success, and surfaces other failures', async () => {
  const found = {
    method: 'GET',
    match: 'search',
    json: { branches: [{ id: BRANCH, name: 'preview/pr-7' }] },
  };
  assert.equal(
    (
      await deletePreviewBranch(client(fakeFetch([found, { method: 'DELETE', match: BRANCH, json: {} }])), {
        pr: 7,
      })
    ).reason,
    'deleted',
  );
  assert.equal(
    (
      await deletePreviewBranch(
        client(fakeFetch([{ method: 'GET', match: 'search', json: { branches: [] } }])),
        { pr: 7 },
      )
    ).reason,
    'absent',
  );
  assert.equal(
    (
      await deletePreviewBranch(
        client(fakeFetch([found, { method: 'DELETE', match: BRANCH, status: 404, json: {} }])),
        { pr: 7 },
      )
    ).reason,
    'absent',
  );
  await assert.rejects(
    deletePreviewBranch(
      client(
        fakeFetch([
          found,
          { method: 'DELETE', match: BRANCH, status: 409, json: { message: 'has children' } },
        ]),
      ),
      { pr: 7 },
    ),
    /has children/,
  );
  await assert.rejects(deletePreviewBranch(client(fakeFetch([])), { pr: 'x' }), /positive integer/);
});
