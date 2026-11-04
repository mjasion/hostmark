// k6 provides __ENV and the metrics modules; params.js and cache-state.js need only the former.
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.__ENV = {};
const { describeLoad, latencyBound, param, seconds } = await import('../lib/params.js');
const { cacheState } = await import('../lib/cache-state.js');

test('a threshold bound moved through the environment makes the run reduced', () => {
  assert.equal(latencyBound('BOUND_A', 500), 500);
  assert.equal(describeLoad().mode, 'full');
  __ENV.BOUND_A = '100000';
  assert.equal(latencyBound('BOUND_A', 500), 100000);
  const load = describeLoad();
  assert.equal(load.mode, 'reduced');
  assert.deepEqual(load.deviations, [{ param: 'BOUND_A', value: 100000, spec: 500, source: 'env' }]);
  delete __ENV.BOUND_A;
  assert.equal(latencyBound('BOUND_A', 500), 500);
  assert.equal(describeLoad().mode, 'full');
});

test('a load parameter other than the specified value is listed', () => {
  __ENV.RPS_X = '1';
  assert.equal(param('RPS_X', 2, 1), 1);
  assert.equal(describeLoad().deviations[0].param, 'RPS_X');
  delete __ENV.RPS_X;
  assert.equal(param('RPS_X', 2, 1), 2);
  assert.equal(seconds('3m'), 180);
});

test('cacheState tells a miss and a dynamic response from a missing header', () => {
  assert.equal(cacheState({}), 'none');
  assert.equal(cacheState({ 'cf-cache-status': 'HIT' }), 'hit');
  assert.equal(cacheState({ 'cf-cache-status': 'MISS' }), 'miss');
  assert.equal(cacheState({ 'cf-cache-status': 'EXPIRED' }), 'miss');
  assert.equal(cacheState({ 'cf-cache-status': 'DYNAMIC' }), 'dynamic');
  assert.equal(cacheState({ 'cf-cache-status': 'STALE' }), 'stale');
  assert.equal(cacheState({ 'x-cache': 'something else' }), 'bypass');
});

test('every parameter a scenario reads is passed to the k6 container by run.mjs', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../', import.meta.url);
  const runText = readFileSync(new URL('run.mjs', dir), 'utf8');
  const listed = new Set(
    /const PARAM_NAMES = \[([^\]]*)\]/
      .exec(runText)[1]
      .match(/'[A-Z0-9_]+'/g)
      .map((s) => s.slice(1, -1)),
  );
  const sources = [
    ...readdirSync(new URL('scenarios/', dir)).map((f) => new URL(`scenarios/${f}`, dir)),
    ...readdirSync(new URL('lib/', dir)).map((f) => new URL(`lib/${f}`, dir)),
  ];
  const used = new Set();
  for (const file of sources)
    for (const m of readFileSync(file, 'utf8').matchAll(/\b(?:param|latencyBound)\('([A-Z0-9_]+)'/g))
      used.add(m[1]);
  assert.ok(used.has('UPLOAD_FIXTURE'), 'S4 reads UPLOAD_FIXTURE (D250)');
  for (const name of used) assert.ok(listed.has(name), `${name} is read by a scenario but not passed to k6`);
});
