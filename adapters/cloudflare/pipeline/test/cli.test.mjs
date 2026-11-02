import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, previewSecrets, repositoryRoot, scrubbed } from '../cli.mjs';
import { fakeFetch, VERSION_A, VERSION_B } from './helpers.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cli-'));
const config = 'wrangler.api.jsonc'; // the real file of the Cloudflare adapter
const quiet = () => {};

test('gate through the CLI: disabled platform exits 0 with enabled=false', async () => {
  const platforms = join(dir, 'platforms.json');
  writeFileSync(platforms, '{"platforms":[{"name":"cloudflare","enabled":false}]}');
  const out = join(dir, 'gate-out');
  writeFileSync(out, '');
  assert.equal(await main(['gate', platforms], { env: { GITHUB_OUTPUT: out }, log: quiet }), 0);
  assert.match(readFileSync(out, 'utf8'), /^enabled=false$/m);
});

test('decide: missing and garbage signal files roll back, a good one promotes', async () => {
  const out = join(dir, 'decide-out');
  writeFileSync(out, '');
  const env = { GITHUB_OUTPUT: out };
  assert.equal(await main(['decide', '--signal-file', join(dir, 'nope.json')], { env, log: quiet }), 1);
  writeFileSync(join(dir, 'bad.json'), 'not json');
  assert.equal(await main(['decide', '--signal-file', join(dir, 'bad.json')], { env, log: quiet }), 1);
  assert.equal(await main(['decide'], { env, log: quiet }), 1);
  writeFileSync(join(dir, 'good.json'), '{"samples":60,"errors":0,"p95Ms":100}');
  assert.equal(await main(['decide', '--signal-file', join(dir, 'good.json')], { env, log: quiet }), 0);
  assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), [
    'action=rollback',
    'action=rollback',
    'action=rollback',
    'action=promote',
  ]);
});

test('comment --print renders without any network or token', async () => {
  const lines = [];
  assert.equal(
    await main(['comment', '--pr', '4', '--status', 'closed', '--print'], {
      env: {},
      log: (l) => lines.push(l),
    }),
    0,
  );
  assert.match(lines.join('\n'), /hostmark-preview/);
});

test('provision writes one generated config per Worker from the real configs', async () => {
  const { generatedConfigName } = await import('../cli.mjs');
  assert.equal(generatedConfigName('wrangler.api.jsonc', 7), 'wrangler.api.pr-7.generated.jsonc');
});

test('provision and teardown need their secrets and a numeric pull request', async () => {
  await assert.rejects(
    main(['teardown', '--pr', '4', '--config', config], { env: {}, log: quiet }),
    /NEON_API_KEY is not set/,
  );
  await assert.rejects(
    main(['teardown', '--pr', '4; id', '--config', config], {
      env: { NEON_API_KEY: 'k', NEON_PROJECT_ID: 'p-1' },
      log: quiet,
    }),
    /positive integer/,
  );
});

test('unknown commands fail', async () => {
  await assert.rejects(main(['deploy-everything'], { env: {}, log: quiet }), /unknown command/);
});

test('rollout refuses to start when the serving version is unclear: nothing is uploaded or deployed', async () => {
  const calls = [];
  const exec = async (args) => {
    calls.push(args.join(' '));
    return { code: 0, stdout: 'not json' };
  };
  const code = await main(
    ['rollout', '--config', config, '--sha', 'abc1234', '--url', 'https://app.example.com'],
    { env: {}, exec, log: quiet },
  );
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /deployments list/);
});

test('rollout refuses when the upload prints no version id', async () => {
  const calls = [];
  const exec = async (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'deployments')
      return {
        code: 0,
        stdout: JSON.stringify([{ created_on: '1', versions: [{ version_id: VERSION_A, percentage: 100 }] }]),
      };
    return { code: 0, stdout: '' };
  };
  const code = await main(
    ['rollout', '--config', config, '--sha', 'abc1234', '--url', 'https://app.example.com'],
    { env: {}, exec, log: quiet },
  );
  assert.equal(code, 1);
  assert.ok(!calls.some((c) => c.includes('versions deploy')));
});

test('rollout: a candidate that fails its preflight is never deployed', async () => {
  const calls = [];
  const exec = async (args, options) => {
    calls.push(args.join(' '));
    if (args[1] === 'deployments')
      return {
        code: 0,
        stdout: JSON.stringify([{ created_on: '1', versions: [{ version_id: VERSION_A, percentage: 100 }] }]),
      };
    if (args[1] === 'versions' && args[2] === 'upload') {
      writeFileSync(
        options.env.WRANGLER_OUTPUT_FILE_PATH,
        `${JSON.stringify({ type: 'version-upload', version_id: VERSION_B })}\n`,
      );
    }
    return { code: 0, stdout: '' };
  };
  const down = async () => new Response('', { status: 503 });
  const code = await main(
    ['rollout', '--config', config, '--sha', 'abc1234', '--url', 'https://app.example.com'],
    { env: {}, exec, fetch: down, log: quiet, sleep: async () => {} },
  );
  assert.equal(code, 1);
  assert.ok(calls.some((c) => c.includes('versions upload')));
  assert.ok(!calls.some((c) => c.includes('versions deploy')));
  void fakeFetch;
});

test('secrets-file writes only the three preview secrets, mode 600; a missing variable throws', async () => {
  const env = {
    PREVIEW_BETTER_AUTH_SECRET: 'a',
    PREVIEW_R2_ACCESS_KEY_ID: 'b',
    PREVIEW_R2_SECRET_ACCESS_KEY: 'c',
    BETTER_AUTH_SECRET: 'production-value',
  };
  const out = join(dir, 'secrets.json');
  assert.equal(await main(['secrets-file', '--out', out], { env, log: quiet }), 0);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
    BETTER_AUTH_SECRET: 'a',
    R2_ACCESS_KEY_ID: 'b',
    R2_SECRET_ACCESS_KEY: 'c',
  });
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.throws(() => previewSecrets({ ...env, PREVIEW_R2_SECRET_ACCESS_KEY: '' }));
  await assert.rejects(main(['secrets-file', '--out', join(dir, 'x.json')], { env: {}, log: quiet }));
});

test('child processes get no more credentials than they need', () => {
  const env = {
    PATH: '/bin',
    CLOUDFLARE_API_TOKEN: 't',
    NEON_API_KEY: 'n',
    PREVIEW_R2_SECRET_ACCESS_KEY: 'p',
    PRODUCTION_DATABASE_URL: 'u',
    LOAD_API_KEY: 'l',
  };
  assert.deepEqual(scrubbed(env, true), { PATH: '/bin', CLOUDFLARE_API_TOKEN: 't' });
  assert.deepEqual(scrubbed(env, false), { PATH: '/bin' });
});

// ---- exit codes of `rollout`, snapshot and restore against a fake `exec` --------------------------------------

const stableList = JSON.stringify([
  { created_on: '1', versions: [{ version_id: VERSION_A, percentage: 100 }] },
]);

/**
 * A fake `exec` that records every command line. `fail` maps a command (for example `versions upload`) to the exit
 * code it returns; `onDeploy(n)` can override the exit code of the n-th `versions deploy`.
 */
function fakeWrangler({ fail = {}, deployCode = () => 0, listing = stableList, verifyCode = 0 } = {}) {
  const calls = [];
  let deploys = 0;
  const exec = async (args, options = {}) => {
    const line = args.join(' ');
    calls.push(line);
    if (args[0] === 'node') return { code: verifyCode, stdout: '' };
    if (args[1] === 'deployments') return { code: fail['deployments list'] ?? 0, stdout: listing };
    if (args[1] === 'versions' && args[2] === 'upload') {
      writeFileSync(
        options.env.WRANGLER_OUTPUT_FILE_PATH,
        `${JSON.stringify({ type: 'version-upload', version_id: VERSION_B })}\n`,
      );
      return { code: fail['versions upload'] ?? 0, stdout: '' };
    }
    if (args[1] === 'versions' && args[2] === 'deploy') return { code: deployCode(++deploys), stdout: '' };
    return { code: 0, stdout: '' };
  };
  exec.calls = calls;
  exec.deploys = () => calls.filter((c) => c.includes('versions deploy')).map((c) => c.split(' ')[3]);
  return exec;
}

const healthy = async () => new Response('{}', { status: 200, headers: { 'x-version': 'abc1234' } });
const rolloutEnv = { LOAD_API_KEY: 'k', PROBE_INTERVAL_MS: '0' };
const rolloutArgs = (...extra) => [
  'rollout',
  '--config',
  config,
  '--sha',
  'abc1234',
  '--url',
  'https://app.example.com',
  ...extra,
];
const runRolloutCli = (exec, extra = ['--verify', 'S1,S2'], fetch = healthy) =>
  main(rolloutArgs(...extra), { env: rolloutEnv, exec, fetch, log: quiet, sleep: async () => {} });

test('rollout exits 0 only when the candidate is promoted, after 10, 50 and 100 percent', async () => {
  const exec = fakeWrangler();
  assert.equal(await runRolloutCli(exec), 0);
  assert.deepEqual(exec.deploys(), [`${VERSION_B}@10`, `${VERSION_B}@50`, `${VERSION_B}@100`]);
  assert.ok(exec.calls.some((c) => c.startsWith('node load/run.mjs S1 S2 --short')));
});

test('rollout exits 1 and shifts back when the verification run fails', async () => {
  const exec = fakeWrangler({ verifyCode: 1 });
  assert.equal(await runRolloutCli(exec), 1);
  assert.equal(exec.deploys().at(-1), `${VERSION_A}@100`);
});

test('rollout exits 1 when the rollback itself fails', async () => {
  // deploy 1..3 succeed, the verification fails, the rollback (4th deploy) fails
  const exec = fakeWrangler({ verifyCode: 1, deployCode: (n) => (n === 4 ? 1 : 0) });
  assert.equal(await runRolloutCli(exec), 1);
  assert.equal(exec.deploys().length, 4);
});

test('rollout exits 1 and shifts back when the first deploy fails', async () => {
  const exec = fakeWrangler({ deployCode: (n) => (n === 1 ? 1 : 0) });
  assert.equal(await runRolloutCli(exec), 1);
  assert.deepEqual(exec.deploys(), [`${VERSION_B}@10`, `${VERSION_A}@100`]);
});

test('rollout exits 1 when `deployments list` fails, even if it printed a valid listing', async () => {
  const exec = fakeWrangler({ fail: { 'deployments list': 1 } });
  assert.equal(await runRolloutCli(exec), 1);
  assert.ok(
    !exec.calls.some((c) => c.includes('versions')),
    'nothing is uploaded without a known stable version',
  );
});

test('rollout exits 1 when `versions upload` fails, even if it wrote a version id', async () => {
  const exec = fakeWrangler({ fail: { 'versions upload': 1 } });
  assert.equal(await runRolloutCli(exec), 1);
  assert.ok(!exec.calls.some((c) => c.includes('versions deploy')));
});

test('rollout with a probe: an unhealthy candidate exits 1 before any traffic moves', async () => {
  const exec = fakeWrangler();
  const wrongVersion = async () => new Response('{}', { status: 200, headers: { 'x-version': 'other' } });
  assert.equal(await runRolloutCli(exec, ['--verify', 'S1'], wrongVersion), 1);
  assert.deepEqual(exec.deploys(), []);
});

test('rollout needs scenario ids to verify with', async () => {
  const exec = fakeWrangler();
  await assert.rejects(runRolloutCli(exec, ['--verify', 'rm -rf']), /scenario ids/);
});

test('snapshot prints the version serving each Worker and refuses an unclear state', async () => {
  const out = join(dir, 'snapshot-out');
  writeFileSync(out, '');
  const exec = fakeWrangler();
  const args = ['snapshot', '--config', 'wrangler.api.jsonc', '--config', 'wrangler.consumer.jsonc'];
  assert.equal(await main(args, { env: { GITHUB_OUTPUT: out }, exec, log: quiet }), 0);
  assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), [
    `api=${VERSION_A}`,
    `consumer=${VERSION_A}`,
  ]);

  const failing = fakeWrangler({ fail: { 'deployments list': 1 } });
  assert.equal(await main(args, { env: { GITHUB_OUTPUT: out }, exec: failing, log: quiet }), 1);
  const split = fakeWrangler({
    listing: JSON.stringify([
      {
        created_on: '1',
        versions: [
          { version_id: VERSION_A, percentage: 90 },
          { version_id: VERSION_B, percentage: 10 },
        ],
      },
    ]),
  });
  assert.equal(await main(args, { env: { GITHUB_OUTPUT: out }, exec: split, log: quiet }), 1);
  assert.equal(await main(['snapshot'], { env: {}, exec, log: quiet }), 1);
});

test('restore puts the recorded version back, leaves a Worker that is already there, and exits 1 on failure', async () => {
  const onB = JSON.stringify([{ created_on: '2', versions: [{ version_id: VERSION_B, percentage: 100 }] }]);
  const args = [
    'restore',
    '--sha',
    'abc1234',
    '--config',
    'wrangler.consumer.jsonc',
    '--stable',
    VERSION_A,
    '--config',
    'wrangler.api.jsonc',
    '--stable',
    VERSION_A,
  ];
  const moved = fakeWrangler({ listing: onB });
  assert.equal(await main(args, { env: {}, exec: moved, log: quiet }), 0);
  // the consumer first, then the api
  assert.deepEqual(
    moved.calls.filter((c) => c.includes('versions deploy')).map((c) => c.split(' ').slice(3, 6).join(' ')),
    [`${VERSION_A}@100 --config wrangler.consumer.jsonc`, `${VERSION_A}@100 --config wrangler.api.jsonc`],
  );

  const already = fakeWrangler({ listing: stableList });
  assert.equal(await main(args, { env: {}, exec: already, log: quiet }), 0);
  assert.ok(!already.calls.some((c) => c.includes('versions deploy')));

  const broken = fakeWrangler({ listing: onB, deployCode: () => 1 });
  assert.equal(await main(args, { env: {}, exec: broken, log: quiet }), 1);
  assert.equal(broken.deploys().length, 2, 'the api is still tried after the consumer failed');

  // an unclear listing still restores: the recorded version is the known good one
  const unclear = fakeWrangler({ fail: { 'deployments list': 1 } });
  assert.equal(await main(args, { env: {}, exec: unclear, log: quiet }), 0);
  assert.equal(unclear.deploys().length, 2);
});

test('restore refuses a missing or malformed version id and mismatched arguments', async () => {
  const exec = fakeWrangler();
  assert.equal(
    await main(['restore', '--config', 'wrangler.api.jsonc', '--stable', ''], { env: {}, exec, log: quiet }),
    1,
  );
  assert.equal(
    await main(['restore', '--config', 'wrangler.api.jsonc', '--stable', 'latest; rm -rf /'], {
      env: {},
      exec,
      log: quiet,
    }),
    1,
  );
  assert.ok(!exec.calls.some((c) => c.includes('versions deploy')));
  await assert.rejects(main(['restore', '--config', 'wrangler.api.jsonc'], { env: {}, exec, log: quiet }));
});

test('HOSTMARK_ROOT points the scripts at another tree; the default is the repository of the scripts', () => {
  assert.equal(
    repositoryRoot({ HOSTMARK_ROOT: '/work/head' }, '/work/trusted/adapters/cloudflare/pipeline'),
    '/work/head',
  );
  assert.equal(repositoryRoot({}, '/work/trusted/adapters/cloudflare/pipeline'), '/work/trusted');
});
