import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { DeployError, privateDir, requireEnv, run, scrubber } from './exec.mjs';

test('requireEnv names every missing or empty variable and exits 2', () => {
  assert.deepEqual(requireEnv(['A'], { A: '1' }), { A: '1' });
  assert.throws(
    () => requireEnv(['A', 'B', 'C'], { A: '1', B: '' }),
    (e) => e instanceof DeployError && e.code === 2 && e.message === 'missing environment variables: B, C',
  );
});

test('scrubber masks whole values and each line of a multi-line one, but not short fragments', () => {
  const scrub = scrubber(['token-0123456789', 'line-one-abcdef\nline-two-ghijkl\nend', undefined, '']);
  assert.equal(scrub('a token-0123456789 b'), 'a *** b');
  assert.equal(scrub('only line-two-ghijkl here'), 'only *** here');
  assert.equal(scrub('the end'), 'the end');
});

test('run scrubs a secret that the child writes across two chunks, and captures stdout', async () => {
  const child = `process.stdout.write('se'); setTimeout(() => process.stdout.write('cret-0123456789\\n'), 50);`;
  const out = await run(process.execPath, ['-e', child], {
    scrub: scrubber(['secret-0123456789']),
    capture: true,
  });
  assert.equal(out, '***\n');
});

test('run rejects with the exit code of the child', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'process.exit(5)'], {}),
    (e) => e instanceof DeployError && e.code === 5,
  );
  await assert.rejects(
    run('hostmark-no-such-command', [], {}),
    (e) => e instanceof DeployError && e.code === 1,
  );
});

test('privateDir writes 0600 files in a 0700 directory and removes them', () => {
  const dir = privateDir('hostmark-exec-test-');
  const file = dir.write('key', 'x');
  assert.equal(statSync(dir.path).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  dir.remove();
  assert.equal(existsSync(dir.path), false);
});
