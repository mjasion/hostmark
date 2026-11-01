import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gapRecorder } from '../tools/pause-watch.mjs';

const watcher = fileURLToPath(new URL('../tools/pause-watch.mjs', import.meta.url));

test('ticks one second apart record nothing', () => {
  const r = gapRecorder(5, 0);
  for (let t = 1000; t <= 10000; t += 1000) r.tick(t);
  assert.deepEqual(r.pauses, []);
});

test('a late tick records where the pause began and how long it lasted', () => {
  const r = gapRecorder(5, 0);
  r.tick(1000);
  r.tick(2000);
  r.tick(62000);
  r.tick(63000);
  assert.deepEqual(r.pauses, [{ atS: 2, gapS: 60 }]);
});

test('a gap of exactly the threshold is not a pause, one above it is', () => {
  const r = gapRecorder(5, 0);
  r.tick(5000);
  assert.deepEqual(r.pauses, []);
  r.tick(10001);
  assert.equal(r.pauses.length, 1);
});

test('a blocking call in the parent does not stop the watcher', async () => {
  const child = spawn(process.execPath, [watcher], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  await new Promise((r) => setTimeout(r, 500));
  spawnSync('sleep', ['7']); // the event loop of this process is blocked for longer than the threshold
  child.stdin.end();
  await once(child, 'close');
  assert.deepEqual(JSON.parse(out).pauses, []);
});

test('a stopped watcher reports the pause after it continues', async () => {
  const child = spawn(process.execPath, [watcher], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  await new Promise((r) => setTimeout(r, 1500));
  child.kill('SIGSTOP');
  await new Promise((r) => setTimeout(r, 7000));
  child.kill('SIGCONT');
  await new Promise((r) => setTimeout(r, 1500));
  child.stdin.end();
  await once(child, 'close');
  const { pauses } = JSON.parse(out);
  assert.equal(pauses.length, 1);
  assert.ok(pauses[0].gapS >= 6.5 && pauses[0].gapS < 9, JSON.stringify(pauses));
});
