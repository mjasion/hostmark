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
