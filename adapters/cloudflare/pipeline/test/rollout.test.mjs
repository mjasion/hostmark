import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combine, percentile, runProbe } from '../probe.mjs';
import {
  activeVersionId,
  DEFAULT_POLICY,
  decide,
  decideSafe,
  deployArgs,
  parseOutputFile,
  restoreStable,
  runRollout,
  servingVersion,
  uploadedVersionId,
} from '../rollout.mjs';
import { fakeFetch, VERSION_A, VERSION_B } from './helpers.mjs';

const CFG = 'wrangler.api.jsonc';
const good = { samples: 60, errors: 0, p95Ms: 200 };

test('decide promotes a healthy signal', () => {
  assert.equal(decide(good).action, 'promote');
  assert.equal(decide({ samples: 100, errors: 1, p95Ms: 1500 }).action, 'promote');
});

test('decide: every threshold is inclusive on the healthy side and exclusive one step beyond it', () => {
  // [signal, expected action]; the policy is samples >= 20, error rate <= 1%, p95 <= 1500 ms
  const cases = [
    [{ samples: 20, errors: 0, p95Ms: 100 }, 'promote'],
    [{ samples: 19, errors: 0, p95Ms: 100 }, 'rollback'],
    [{ samples: 100, errors: 1, p95Ms: 100 }, 'promote'],
    [{ samples: 100, errors: 2, p95Ms: 100 }, 'rollback'],
    [{ samples: 200, errors: 2, p95Ms: 100 }, 'promote'],
    [{ samples: 200, errors: 3, p95Ms: 100 }, 'rollback'],
    [{ samples: 60, errors: 0, p95Ms: 1500 }, 'promote'],
    [{ samples: 60, errors: 0, p95Ms: 1500.4 }, 'rollback'],
    [{ samples: 60, errors: 0, p95Ms: 1501 }, 'rollback'],
    [{ samples: 60, errors: 0, p95Ms: 8999 }, 'rollback'],
    [{ samples: 60, errors: 0, p95Ms: 0 }, 'promote'],
  ];
  for (const [signal, action] of cases) assert.equal(decide(signal).action, action, JSON.stringify(signal));
});

test('decide rolls back on errors, latency and too few samples, each with its own reason', () => {
  const high = decide({ samples: 100, errors: 2, p95Ms: 100 });
  assert.equal(high.action, 'rollback');
  assert.match(high.reason, /error rate/);
  const slow = decide({ samples: 60, errors: 0, p95Ms: 1501 });
  assert.equal(slow.action, 'rollback');
  assert.match(slow.reason, /p95 1501 ms above 1500 ms/);
  const few = decide({ samples: 3, errors: 0, p95Ms: 10 });
  assert.equal(few.action, 'rollback');
  assert.match(few.reason, /only 3 samples/);
});

test('a missing or malformed health signal means rollback (fail safe)', () => {
  const cases = [
    undefined,
    null,
    'ok',
    1,
    [],
    {},
    { samples: 60 },
    { samples: 60, errors: 0 },
    { samples: '60', errors: 0, p95Ms: 1 },
    { samples: 60, errors: 0, p95Ms: Number.NaN },
    { samples: 60, errors: 0, p95Ms: Number.POSITIVE_INFINITY },
    { samples: 60, errors: 61, p95Ms: 1 },
    { samples: -1, errors: 0, p95Ms: 1 },
    { samples: 1.5, errors: 0, p95Ms: 1 },
    { samples: 60, errors: 0, p95Ms: -5 },
  ];
  for (const signal of cases) assert.equal(decideSafe(signal).action, 'rollback', JSON.stringify(signal));
});

test('decideSafe turns a throwing policy into a rollback', () => {
  const policy = {
    get minSamples() {
      throw new Error('boom');
    },
  };
  assert.equal(decideSafe(good, policy).action, 'rollback');
});

test('wrangler output file: bad lines are skipped, the last upload wins', () => {
  const text = [
    `{"type":"version-upload","version_id":"${VERSION_A}"}`,
    '{"type":"deploy"',
    'garbage',
    '',
    `{"type":"version-upload","version_id":"${VERSION_B}"}`,
  ].join('\n');
  assert.equal(uploadedVersionId(parseOutputFile(text)), VERSION_B);
  assert.equal(uploadedVersionId(parseOutputFile('')), null);
  assert.equal(
    uploadedVersionId(parseOutputFile('{"type":"version-upload","version_id":"not-a-uuid"}')),
    null,
  );
});

test('active version: exactly one version at 100% in the newest deployment', () => {
  const dep = (created_on, versions) => ({ created_on, versions });
  assert.equal(
    activeVersionId([
      dep('2026-01-01', [{ version_id: VERSION_B, percentage: 100 }]),
      dep('2026-02-01', [{ version_id: VERSION_A, percentage: 100 }]),
    ]),
    VERSION_A,
  );
  assert.equal(
    activeVersionId({ deployments: [dep('2026-01-01', [{ version_id: VERSION_A, percentage: 100 }])] }),
    VERSION_A,
  );
  // a half-finished rollout leaves no single stable version: refuse
  assert.equal(
    activeVersionId([
      dep('1', [
        { version_id: VERSION_A, percentage: 50 },
        { version_id: VERSION_B, percentage: 50 },
      ]),
    ]),
    null,
  );
  for (const bad of [
    null,
    [],
    {},
    'x',
    [{ versions: [] }],
    [{ versions: [{ version_id: 'x', percentage: 100 }] }],
  ])
    assert.equal(activeVersionId(bad), null);
});

test('deploy arguments are a complete wrangler command line (exec runs them as given)', () => {
  const args = deployArgs({
    candidate: VERSION_B,
    stable: VERSION_A,
    percent: 50,
    message: 'm',
    config: CFG,
  });
  assert.deepEqual(args.slice(0, 3), ['wrangler', 'versions', 'deploy']);
  assert.deepEqual(args.slice(5), ['--config', CFG, '--yes', '--message', 'm']);
});

test('deploy arguments split traffic and validate input', () => {
  assert.deepEqual(
    deployArgs({ candidate: VERSION_B, stable: VERSION_A, percent: 10, message: 'm', config: CFG }).slice(
      3,
      5,
    ),
    [`${VERSION_B}@10`, `${VERSION_A}@90`],
  );
  assert.deepEqual(
    deployArgs({ candidate: VERSION_B, stable: VERSION_A, percent: 100, message: 'm', config: CFG }).slice(
      3,
      4,
    ),
    [`${VERSION_B}@100`],
  );
  assert.deepEqual(
    deployArgs({ candidate: VERSION_B, stable: VERSION_A, percent: 0, message: 'm', config: CFG }).slice(
      3,
      4,
    ),
    [`${VERSION_A}@100`],
  );
  assert.throws(() =>
    deployArgs({ candidate: 'x', stable: VERSION_A, percent: 10, message: 'm', config: CFG }),
  );
  assert.throws(() =>
    deployArgs({ candidate: VERSION_B, stable: VERSION_A, percent: 101, message: 'm', config: CFG }),
  );
});

function harness({ signals, execFail = () => false, verify }) {
  const execs = [];
  const sleeps = [];
  let probes = 0;
  return {
    execs,
    sleeps,
    run: () =>
      runRollout({
        candidate: VERSION_B,
        stable: VERSION_A,
        sha: 'abc1234',
        config: CFG,
        exec: async (args) => {
          execs.push(args);
          return { code: execFail(args, execs.length) ? 1 : 0, stdout: '' };
        },
        probe: async () => {
          const next = signals[Math.min(probes++, signals.length - 1)];
          if (next instanceof Error) throw next;
          return next;
        },
        verify,
        sleep: async (ms) => void sleeps.push(ms),
      }),
  };
}
const percents = (execs) => execs.map((a) => a[3]);

test('deploy arguments name the config and refuse odd config names', () => {
  assert.ok(
    deployArgs({ candidate: VERSION_B, stable: VERSION_A, percent: 10, message: 'm', config: CFG })
      .join(' ')
      .includes('--config wrangler.api.jsonc'),
  );
  assert.throws(
    () =>
      deployArgs({
        candidate: VERSION_B,
        stable: VERSION_A,
        percent: 10,
        message: 'm',
        config: '../x.jsonc',
      }),
    /wrangler/,
  );
});

test('rollout: healthy at every step reaches 100% and is promoted', async () => {
  const h = harness({ signals: [good], verify: async () => ({ ok: true }) });
  const result = await h.run();
  assert.equal(result.outcome, 'promoted');
  assert.deepEqual(percents(h.execs), [`${VERSION_B}@10`, `${VERSION_B}@50`, `${VERSION_B}@100`]);
  assert.equal(h.sleeps.length, 3);
});

test('rollout: an unhealthy first step shifts back to the stable version and stops', async () => {
  const h = harness({ signals: [{ samples: 60, errors: 30, p95Ms: 100 }] });
  const result = await h.run();
  assert.equal(result.outcome, 'rolled-back');
  assert.deepEqual(percents(h.execs), [`${VERSION_B}@10`, `${VERSION_A}@100`]);
});

test('rollout: unhealthy at 50% rolls back after reaching 50', async () => {
  const h = harness({ signals: [good, { samples: 60, errors: 0, p95Ms: 9000 }] });
  const result = await h.run();
  assert.equal(result.outcome, 'rolled-back');
  assert.equal(result.reached, 50);
  assert.equal(h.execs.at(-1)[3], `${VERSION_A}@100`);
});

test('rollout: a missing signal, a throwing probe and a failed verification all roll back', async () => {
  for (const options of [
    { signals: [undefined] },
    { signals: [new Error('network')] },
    { signals: [good], verify: async () => ({ ok: false, detail: 'S1 failed' }) },
    { signals: [good], verify: async () => undefined },
    {
      signals: [good],
      verify: async () => {
        throw new Error('k6 missing');
      },
    },
  ]) {
    const h = harness(options);
    assert.equal((await h.run()).outcome, 'rolled-back', JSON.stringify(Object.keys(options)));
    assert.equal(h.execs.at(-1)[3], `${VERSION_A}@100`);
  }
});

test('rollout: a failing deploy command rolls back; a failing rollback is reported loudly', async () => {
  const failFirst = harness({ signals: [good], execFail: (_, n) => n === 1 });
  assert.equal((await failFirst.run()).outcome, 'rolled-back');
  const failAll = harness({ signals: [good], execFail: () => true });
  const result = await failAll.run();
  assert.equal(result.outcome, 'rollback-failed');
  assert.match(result.reason, /rollback itself failed/);
});

test('rollout without a probe (queue consumer) is gated by verification alone', async () => {
  const run = (verify) =>
    runRollout({
      candidate: VERSION_B,
      stable: VERSION_A,
      sha: 'abc1234',
      config: 'wrangler.consumer.jsonc',
      exec: async () => ({ code: 0, stdout: '' }),
      sleep: async () => {},
      verify,
    });
  assert.equal((await run(async () => ({ ok: true }))).outcome, 'promoted');
  assert.equal((await run(async () => ({ ok: false, detail: 'S4 failed' }))).outcome, 'rolled-back');
  await assert.rejects(run(undefined), /refusing to promote blind/);
});

test('the default policy is exactly the one D142 documents, and cannot be changed at run time', () => {
  assert.deepEqual(
    { ...DEFAULT_POLICY },
    { steps: [10, 50, 100], soakMs: 120_000, minSamples: 20, maxErrorRate: 0.01, maxP95Ms: 1500 },
  );
  assert.ok(Object.isFrozen(DEFAULT_POLICY));
});

test('rollout: unhealthy at 100% rolls back after reaching 100', async () => {
  const h = harness({ signals: [good, good, { samples: 60, errors: 30, p95Ms: 100 }] });
  const result = await h.run();
  assert.equal(result.outcome, 'rolled-back');
  assert.equal(result.reached, 100);
  assert.deepEqual(percents(h.execs), [
    `${VERSION_B}@10`,
    `${VERSION_B}@50`,
    `${VERSION_B}@100`,
    `${VERSION_A}@100`,
  ]);
});

test('rollout: every step soaks for the policy time, and the verification runs only after 100%', async () => {
  const order = [];
  const h = harness({
    signals: [good],
    verify: async () => {
      order.push('verify');
      return { ok: true };
    },
  });
  await h.run();
  assert.deepEqual(h.sleeps, [DEFAULT_POLICY.soakMs, DEFAULT_POLICY.soakMs, DEFAULT_POLICY.soakMs]);
  assert.deepEqual(order, ['verify']);
  assert.equal(h.execs.length, 3);
});

test('rollout: the verification is skipped, not trusted, when an earlier step already rolled back', async () => {
  let verified = false;
  const h = harness({
    signals: [{ samples: 60, errors: 30, p95Ms: 100 }],
    verify: async () => {
      verified = true;
      return { ok: true };
    },
  });
  assert.equal((await h.run()).outcome, 'rolled-back');
  assert.equal(verified, false);
});

test('servingVersion and restoreStable', async () => {
  const listing = (id) =>
    JSON.stringify([{ created_on: '1', versions: [{ version_id: id, percentage: 100 }] }]);
  const exec = (current, deployCode = 0) => {
    const calls = [];
    const fn = async (args) => {
      calls.push(args);
      return args[1] === 'deployments'
        ? { code: 0, stdout: `Deployments:\n${listing(current)}` }
        : { code: deployCode, stdout: '' };
    };
    fn.calls = calls;
    return fn;
  };
  assert.equal(await servingVersion(exec(VERSION_B), CFG), VERSION_B);
  assert.equal(await servingVersion(async () => ({ code: 1, stdout: listing(VERSION_B) }), CFG), null);
  assert.equal(await servingVersion(async () => ({ code: 0, stdout: 'no json' }), CFG), null);
  assert.equal(
    await servingVersion(async () => {
      throw new Error('spawn');
    }, CFG),
    null,
  );

  const base = { config: CFG, stable: VERSION_A, message: 'm' };
  const moved = exec(VERSION_B);
  assert.deepEqual(await restoreStable({ ...base, exec: moved }), { outcome: 'restored' });
  assert.equal(moved.calls.at(-1)[3], `${VERSION_A}@100`);
  const same = exec(VERSION_A);
  assert.deepEqual(await restoreStable({ ...base, exec: same }), { outcome: 'already-stable' });
  assert.equal(same.calls.length, 1);
  assert.equal((await restoreStable({ ...base, exec: exec(VERSION_B, 1) })).outcome, 'failed');
  assert.equal((await restoreStable({ ...base, stable: 'oops', exec: exec(VERSION_B) })).outcome, 'failed');
  assert.equal(
    (await restoreStable({ ...base, stable: undefined, exec: exec(VERSION_B) })).outcome,
    'failed',
  );
});

test('percentile and combine', () => {
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
  assert.ok(Number.isNaN(percentile([], 95)));
  assert.equal(combine(undefined, good), undefined);
  assert.deepEqual(combine({ samples: 1, errors: 1, p95Ms: 5 }, { samples: 2, errors: 0, p95Ms: 7 }), {
    samples: 3,
    errors: 1,
    p95Ms: 7,
  });
});

const instant = { sleep: async () => {} };

test('probe: counts non-200, wrong version and network errors; sends the override header', async () => {
  const fetch = fakeFetch([
    { method: 'GET', match: '/api/health', json: {}, headers: { 'x-version': 'abc' } },
    { method: 'GET', match: '/api/health', status: 500, json: {}, headers: { 'x-version': 'abc' } },
    { method: 'GET', match: '/api/health', json: {}, headers: { 'x-version': 'old' } },
    { method: 'GET', match: '/api/health', throws: 'reset' },
  ]);
  const r = await runProbe({
    baseUrl: 'https://app.example.com',
    count: 4,
    workerName: 'hostmark',
    override: VERSION_B,
    expectVersion: 'abc',
    fetch,
    ...instant,
  });
  assert.equal(r.samples, 4);
  assert.equal(r.errors, 3);
  assert.equal(fetch.calls[0].headers['cloudflare-workers-version-overrides'], `hostmark="${VERSION_B}"`);
});

test('probe: refuses a non-https target and an override without a worker name', async () => {
  await assert.rejects(runProbe({ baseUrl: 'http://app.example.com', count: 1, ...instant }), /https origin/);
  await assert.rejects(
    runProbe({ baseUrl: 'https://app.example.com', count: 1, override: VERSION_B, ...instant }),
    /workerName/,
  );
});

test('probe: a total outage still yields a signal that decides rollback', async () => {
  const fetch = async () => {
    throw new Error('down');
  };
  const r = await runProbe({ baseUrl: 'https://app.example.com', count: 30, fetch, ...instant });
  assert.equal(decideSafe(r).action, 'rollback');
});
