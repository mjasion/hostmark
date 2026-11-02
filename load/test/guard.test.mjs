// node --test load/test/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGuard, isLoopbackHost, parseBaseUrl, uploadUrlAllowed } from '../lib/guard.js';

const run = (baseUrl, scenario, env = {}) => checkGuard({ baseUrl, scenario, env });

test('loopback names pass without acknowledgement', () => {
  for (const url of [
    'http://127.0.0.1:58080',
    'http://localhost:8080',
    'http://[::1]:8080',
    'http://127.4.5.6',
  ]) {
    assert.deepEqual(run(url, 'S5').problems, [], url);
  }
});

test('lookalikes and other hosts are not loopback', () => {
  for (const host of [
    '127.0.0.1.example.com',
    'localhost.evil.test',
    '0.0.0.0',
    '127.1',
    'example.com',
    '10.0.0.5',
  ]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

const LABELS = { REGION: 'eu', VARIANT: 'example' };

test('a remote target needs an acknowledgement that names its host', () => {
  const problems = (env) => run('https://api.example.com', 'S1', { ...LABELS, ...env }).problems;
  assert.equal(problems({}).length, 1);
  assert.equal(problems({ LOAD_ACK_REMOTE: 'other.example.com' }).length, 1);
  assert.deepEqual(problems({ LOAD_ACK_REMOTE: 'api.example.com' }), []);
});

test('a remote target must name its region and variant', () => {
  const ack = { LOAD_ACK_REMOTE: 'api.example.com' };
  assert.equal(run('https://api.example.com', 'S1', ack).problems.length, 2);
  assert.equal(run('https://api.example.com', 'S1', { ...ack, REGION: 'eu' }).problems.length, 1);
  assert.deepEqual(run('https://api.example.com', 'S1', { ...ack, ...LABELS }).problems, []);
  // A loopback run needs neither.
  assert.deepEqual(run('http://127.0.0.1:58080', 'S1').problems, []);
});

test('octets above 255 are not loopback', () => {
  for (const host of ['127.999.999.999', '127.0.0.256', '127.256.0.1'])
    assert.equal(isLoopbackHost(host), false, host);
  assert.equal(isLoopbackHost('127.255.255.255'), true);
});

test('PURGE_URL is held to the same rule as the target', () => {
  const local = 'http://127.0.0.1:58080';
  const remote = 'https://api.example.com';
  const base = { LOAD_ACK_REMOTE: 'api.example.com', ...LABELS };
  // loopback target: the purge token must stay on this machine
  assert.deepEqual(run(local, 'S15', { PURGE_URL: 'http://127.0.0.1:59982/purge' }).problems, []);
  assert.equal(run(local, 'S15', { PURGE_URL: 'https://api.cloudflare.com/purge' }).problems.length, 1);
  assert.equal(run(local, 'S15', { PURGE_URL: '{base}/x' }).problems.length, 0);
  assert.equal(run(local, 'S15', { PURGE_URL: 'http://127.0.0.1.evil.test/purge' }).problems.length, 1);
  // remote target: its own host passes, any other host needs a named acknowledgement
  assert.deepEqual(
    run(remote, 'S15', { ...base, PURGE_URL: 'https://api.example.com/purge/{id}' }).problems,
    [],
  );
  assert.deepEqual(run(remote, 'S15', { ...base, PURGE_URL: '{base}/purge' }).problems, []);
  const other = { ...base, PURGE_URL: 'https://cdn.example.net/purge?token=x' };
  assert.equal(run(remote, 'S15', other).problems.length, 1);
  assert.deepEqual(run(remote, 'S15', { ...other, LOAD_ACK_PURGE_HOST: 'cdn.example.net' }).problems, []);
  assert.equal(run(remote, 'S15', { ...other, LOAD_ACK_PURGE_HOST: 'elsewhere.test' }).problems.length, 1);
  assert.equal(run(remote, 'S15', { ...base, PURGE_URL: 'not a url' }).problems.length, 1);
});

test('S5 and S6 also need the budget acknowledgement', () => {
  const env = { LOAD_ACK_REMOTE: 'api.example.com', ...LABELS };
  for (const id of ['S5', 'S6']) {
    assert.equal(run('https://api.example.com', id, env).problems.length, 1, id);
    assert.deepEqual(
      run('https://api.example.com', id, { ...env, LOAD_ACK_BUDGETS: 'yes' }).problems,
      [],
      id,
    );
    assert.equal(
      run('https://api.example.com', id, { ...env, LOAD_ACK_BUDGETS: '1' }).problems.length,
      1,
      id,
    );
  }
  assert.deepEqual(run('https://api.example.com', 'S4', env).problems, []);
});

test('unreadable and credentialed URLs are refused', () => {
  for (const url of ['', 'ftp://127.0.0.1', 'http://user:pw@127.0.0.1', '127.0.0.1:8080', 'http://']) {
    assert.ok(run(url, 'S1').problems.length > 0, url);
  }
  assert.throws(() => parseBaseUrl('http://a@b.example'));
});

test('a loopback target keeps its presigned URLs on loopback', () => {
  assert.equal(uploadUrlAllowed('http://127.0.0.1:59000/hostmark/x?X-Amz-Signature=abc', true), true);
  assert.equal(uploadUrlAllowed('https://bucket.s3.eu-central-1.amazonaws.com/x?sig=1', true), false);
  assert.equal(uploadUrlAllowed('https://bucket.s3.eu-central-1.amazonaws.com/x?sig=1', false), true);
});
