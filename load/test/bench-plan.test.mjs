// node --test load/test/*.test.mjs
// The gate of the benchmark workflow (D170 to D179): where load may go, and what stops it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildPlan,
  checkEntry,
  checkTarget,
  EXPLICIT_ONLY,
  eligiblePlatforms,
  parsePlatforms,
  parseRegions,
  SCENARIO_IDS,
  STANDARD_SCENARIOS,
} from '../tools/bench-lib.mjs';
import { runEntry } from '../tools/bench-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const REGIONS = parseRegions(readFileSync(join(here, '..', 'regions.json'), 'utf8'));
const file = (...platforms) =>
  JSON.stringify({
    platforms: platforms.map(([name, enabled, status = 'deployed']) => ({ name, enabled, status })),
  });
const PLATFORMS = parsePlatforms(
  file(
    ['local', true, 'emulated'],
    ['cloudflare', true],
    ['fly', true],
    ['aws', false],
    ['gcp', true, 'emulated'],
  ),
);
const plan = (input, platforms = PLATFORMS) =>
  buildPlan({ platforms, regions: REGIONS, input: { runnerMode: 'regional', ...input } });

test('nothing enabled: an empty plan, even with no runner mode and no other input', () => {
  const none = parsePlatforms(file(['local', false, 'emulated'], ['cloudflare', false], ['fly', false]));
  const p = buildPlan({ platforms: none, regions: REGIONS, input: {} });
  assert.equal(p.count, 0);
  assert.deepEqual(p.core.include, []);
  assert.deepEqual(p.reach.include, []);
  assert.deepEqual(p.expected, []);
  assert.equal(p.refusedPlatforms.length, 3);
});

test('the real platforms.json yields an empty plan while nothing is enabled and deployed', () => {
  const real = parsePlatforms(readFileSync(join(repo, 'platforms.json'), 'utf8'));
  const { eligible } = eligiblePlatforms(real);
  const p = buildPlan({ platforms: real, regions: REGIONS, input: { runnerMode: 'regional' } });
  assert.deepEqual(
    p.platforms.map((x) => x.name),
    eligible,
  );
  // This is the committed state: when it changes on purpose, a platform was enabled and the benchmark is live.
  assert.equal(p.count, 0, `platforms.json enables ${eligible.join(', ')}: the benchmark is no longer off`);
});

test('only enabled, deployed, non-local platforms are eligible', () => {
  const { eligible, refused } = eligiblePlatforms(PLATFORMS);
  assert.deepEqual(eligible, ['cloudflare', 'fly']);
  const why = Object.fromEntries(refused.map((r) => [r.platform, r.reason]));
  assert.match(why.local, /not reachable/);
  assert.match(why.aws, /disabled/);
  assert.match(why.gcp, /status is "emulated"/);
});

test('platforms.json is read strictly: a string "true", a missing status and duplicates are refused', () => {
  const bad = [
    '{',
    '[]',
    '{"platforms":[]}',
    '{"platforms":[{"name":"x","enabled":"true","status":"deployed"}]}',
    '{"platforms":[{"name":"x","enabled":1,"status":"deployed"}]}',
    '{"platforms":[{"name":"x","enabled":true}]}',
    '{"platforms":[{"name":"x","enabled":true,"status":"live"}]}',
    '{"platforms":[{"name":"X y","enabled":false,"status":"emulated"}]}',
    file(['a', false], ['a', false]),
  ];
  for (const text of bad) assert.throws(() => parsePlatforms(text), undefined, text);
});

test('"all" and an empty list mean every eligible platform and no other', () => {
  for (const platforms of ['all', '', undefined]) {
    assert.deepEqual(
      plan({ platforms }).platforms.map((p) => p.name),
      ['cloudflare', 'fly'],
    );
  }
});

test('a named platform that is disabled, emulated, local or unknown is an error, not a skip', () => {
  for (const name of ['aws', 'gcp', 'local', 'vercel']) {
    assert.throws(() => plan({ platforms: name }), /not in platforms.json|may not receive load/, name);
    assert.throws(() => plan({ platforms: `fly,${name}` }), undefined, name);
  }
  assert.deepEqual(
    plan({ platforms: 'fly' }).platforms.map((p) => p.name),
    ['fly'],
  );
  assert.throws(() => plan({ platforms: 'fly;rm' }), /comma separated list/);
});

test('the runner mode is never defaulted when something would run', () => {
  for (const runnerMode of [undefined, '', 'Regional', 'self-hosted', 'all']) {
    assert.throws(
      () => buildPlan({ platforms: PLATFORMS, regions: REGIONS, input: { platforms: 'fly', runnerMode } }),
      /runner mode/,
      String(runnerMode),
    );
  }
});

test('regional mode: S1 to S9 from the primary region, S10 to S15 from all three', () => {
  const p = plan({ platforms: 'fly', confirmBudgets: 'fly', scenarios: 'S1,S5,S11,S12' });
  assert.equal(p.mode, 'regional');
  assert.deepEqual(
    p.core.include.map((e) => [e.region, e.scenarios]),
    [['eu', 'S1 S5']],
  );
  assert.deepEqual(
    p.reach.include.map((e) => [e.region, e.scenarios]),
    [
      ['eu', 'S11 S12'],
      ['us-east', 'S11 S12'],
      ['ap-southeast', 'S11 S12'],
    ],
  );
  assert.deepEqual(JSON.parse(p.core.include[0].runs_on), ['self-hosted', 'hostmark-bench', 'hostmark-eu']);
  assert.deepEqual(JSON.parse(p.reach.include[1].runs_on), [
    'self-hosted',
    'hostmark-bench',
    'hostmark-us-east',
  ]);
  assert.equal(p.count, 4);
  assert.equal(p.expected.length, 2 + 6);
});

test('github-hosted mode: one vantage point, ubuntu-latest, and it says so', () => {
  const p = plan({ platforms: 'fly', runnerMode: 'github-hosted', scenarios: 'S1,S11' });
  assert.deepEqual(p.regions, ['github-hosted']);
  assert.deepEqual(JSON.parse(p.core.include[0].runs_on), ['ubuntu-latest']);
  assert.equal(p.reach.include.length, 1);
  assert.ok(p.notes.some((n) => /one vantage point/.test(n)));
});

test('S5 and S6 need a per-platform budget confirmation; there is no default and no "all"', () => {
  const has = (p, platform, s) => p.expected.some((e) => e.platform === platform && e.scenario === s);
  const unconfirmed = plan({ scenarios: 'S1,S5,S6' });
  for (const platform of ['cloudflare', 'fly']) {
    assert.ok(has(unconfirmed, platform, 'S1'));
    assert.ok(!has(unconfirmed, platform, 'S5'));
    assert.ok(!has(unconfirmed, platform, 'S6'));
  }
  assert.equal(unconfirmed.skipped.filter((s) => /not confirmed/.test(s.reason)).length, 4);
  assert.ok(unconfirmed.core.include.every((e) => e.budgets === false));

  const one = plan({ scenarios: 'S1,S5,S6', confirmBudgets: 'fly' });
  assert.ok(has(one, 'fly', 'S5') && has(one, 'fly', 'S6'));
  assert.ok(!has(one, 'cloudflare', 'S5'));

  assert.throws(() => plan({ scenarios: 'S5', confirmBudgets: 'all' }), /not in platforms.json/);
  assert.throws(() => plan({ scenarios: 'S5', confirmBudgets: 'nowhere' }), /not in platforms.json/);
  assert.throws(() => plan({ scenarios: 'S5', confirmBudgets: 'fly!' }), /comma separated list/);
});

test('S7 and S14 run only when named; S7 is refused on a GitHub-hosted runner', () => {
  assert.deepEqual(Object.keys(EXPLICIT_ONLY).sort(), ['S14', 'S7']);
  for (const s of Object.keys(EXPLICIT_ONLY)) assert.ok(!STANDARD_SCENARIOS.includes(s), s);
  const std = plan({ platforms: 'fly' });
  assert.ok(!std.scenarios.includes('S7') && !std.scenarios.includes('S14'));
  assert.ok(std.skipped.some((s) => s.scenario === 'S7' && /13 hours/.test(s.reason)));
  assert.ok(std.skipped.some((s) => s.scenario === 'S5' && /not confirmed/.test(s.reason)));

  const named = plan({ platforms: 'fly', scenarios: 'S7,S14' });
  assert.deepEqual(named.scenarios, ['S7', 'S14']);
  assert.equal(named.core.include[0].timeout, 960);
  assert.equal(named.reach.include[0].timeout, 150);
  assert.equal(std.core.include[0].timeout, 150);

  assert.throws(() => plan({ platforms: 'fly', scenarios: 'S7', runnerMode: 'github-hosted' }), /6 hours/);
});

test('scenario lists are validated', () => {
  for (const bad of ['S0', 'S16', 'S1;S2', 's1', 'S1,', 'all']) {
    assert.throws(() => plan({ platforms: 'fly', scenarios: bad }), /comma separated list/, bad);
  }
  assert.deepEqual(plan({ platforms: 'fly', scenarios: ' S3 , S1 ,S3' }).scenarios, ['S1', 'S3']);
  assert.equal(SCENARIO_IDS.length, 15);
});

test('every id the plan knows is a scenario of run.mjs, and the other way round', () => {
  const src = readFileSync(join(here, '..', 'run.mjs'), 'utf8');
  const block = src.slice(src.indexOf('const SCENARIOS'));
  const ids = [...block.slice(0, block.indexOf('};')).matchAll(/^\s*(S\d+)\s*:/gm)].map((m) => m[1]);
  assert.deepEqual([...ids].sort(), [...SCENARIO_IDS].sort());
});

test('checkEntry is the second gate: it re-reads platforms.json and the confirmation', () => {
  const entry = { platform: 'fly', region: 'eu', scenarios: 'S1 S5', budgets: true };
  assert.equal(checkEntry({ entry, platforms: PLATFORMS, input: { confirmBudgets: 'fly' } }).ok, true);
  const off = parsePlatforms(file(['fly', false]));
  assert.match(
    checkEntry({ entry, platforms: off, input: { confirmBudgets: 'fly' } }).problems.join(),
    /disabled/,
  );
  const emulated = parsePlatforms(file(['fly', true, 'emulated']));
  assert.equal(checkEntry({ entry, platforms: emulated, input: { confirmBudgets: 'fly' } }).ok, false);
  assert.equal(
    checkEntry({ entry: { ...entry, platform: 'nowhere' }, platforms: PLATFORMS, input: {} }).ok,
    false,
  );
  assert.equal(
    checkEntry({ entry: { ...entry, platform: 'local' }, platforms: PLATFORMS, input: {} }).ok,
    false,
  );
  // An entry that claims budgets the variable does not confirm, or the reverse.
  assert.equal(checkEntry({ entry, platforms: PLATFORMS, input: { confirmBudgets: '' } }).ok, false);
  assert.equal(
    checkEntry({
      entry: { ...entry, budgets: false },
      platforms: PLATFORMS,
      input: { confirmBudgets: 'fly' },
    }).ok,
    false,
  );
  // S5 without confirmation is refused even when the entry is consistent about it.
  const bare = { ...entry, budgets: false };
  assert.match(
    checkEntry({ entry: bare, platforms: PLATFORMS, input: {} }).problems.join(),
    /S5 needs the budgets/,
  );
  assert.equal(
    checkEntry({
      entry: { ...entry, scenarios: 'S1 S99' },
      platforms: PLATFORMS,
      input: { confirmBudgets: 'fly' },
    }).ok,
    false,
  );
  assert.equal(
    checkEntry({ entry: { ...entry, scenarios: '' }, platforms: PLATFORMS, input: { confirmBudgets: 'fly' } })
      .ok,
    false,
  );
});

test('checkTarget accepts a public https origin only', () => {
  assert.deepEqual(checkTarget('https://hostmark.example.com/'), {
    baseUrl: 'https://hostmark.example.com',
    host: 'hostmark.example.com',
  });
  assert.equal(
    checkTarget('https://hostmark.example.com:8443/app/').baseUrl,
    'https://hostmark.example.com:8443/app',
  );
  for (const bad of [
    '',
    'hostmark.example.com',
    'http://hostmark.example.com',
    'https://user:pw@hostmark.example.com',
    'https://hostmark.example.com/?x=1',
    'https://hostmark.example.com/#x',
    'https://localhost',
    'https://127.0.0.1:8080',
    'https://app.localhost',
    'https://0.0.0.0',
    'https://[::1]',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => checkTarget(bad), undefined, bad);
  }
});

const ENV = {
  PATH: process.env.PATH,
  HOME: '/home/runner',
  GITHUB_TOKEN: 'ghs_must_not_reach_k6',
  HOSTMARK_BASE_URL: 'https://hostmark.example.com',
  HOSTMARK_API_KEY: 'key-1',
  HOSTMARK_ADMIN_API_KEY: 'admin-1',
  CONFIRM_BUDGETS: 'fly',
  GITHUB_RUN_ID: '42',
};
const entryOf = (o = {}) =>
  JSON.stringify({
    name: 'core fly eu',
    phase: 'core',
    platform: 'fly',
    region: 'eu',
    scenarios: 'S1 S5 S8',
    budgets: true,
    ...o,
  });

function run(env, platformsText = file(['fly', true]), dir = mkdtempSync(join(tmpdir(), 'bench-run-'))) {
  const calls = [];
  const code = runEntry({
    env: { ...ENV, BENCH_ENTRY: entryOf(), ...env },
    platformsText,
    resultsDir: dir,
    exec: (s, e, region) => {
      calls.push({ s, e, region });
      return 0;
    },
  });
  return { code, calls, dir };
}

test('runEntry reaches the executor only for an enabled, deployed platform', () => {
  const ok = run({});
  assert.equal(ok.code, 0);
  assert.deepEqual(
    ok.calls.map((c) => c.s),
    ['S1', 'S5', 'S8'],
  );
  assert.ok(ok.calls.every((c) => c.region === 'eu'));
  const sidecar = JSON.parse(readFileSync(join(ok.dir, 'bench-entry.json'), 'utf8'));
  assert.equal(sidecar.entry.platform, 'fly');
  assert.deepEqual(sidecar.exits, { S1: 0, S5: 0, S8: 0 });

  for (const text of [
    file(['fly', false]),
    file(['fly', true, 'emulated']),
    file(['aws', true]),
    '{',
    file(['fly', 'true']),
  ]) {
    const r = run({}, text);
    assert.equal(r.code, 2, text);
    assert.equal(r.calls.length, 0, text);
  }
});

test('runEntry refuses before any request: confirmation, target, keys and entry', () => {
  const refused = (env, text) => {
    const r = run(env, text);
    assert.equal(r.code, 2, JSON.stringify(env));
    assert.equal(r.calls.length, 0, JSON.stringify(env));
  };
  refused({ CONFIRM_BUDGETS: '' });
  refused({ CONFIRM_BUDGETS: 'aws' });
  refused({ HOSTMARK_BASE_URL: 'http://hostmark.example.com' });
  refused({ HOSTMARK_BASE_URL: 'https://localhost' });
  refused({ HOSTMARK_BASE_URL: '' });
  refused({ HOSTMARK_API_KEY: '' });
  refused({ HOSTMARK_ADMIN_API_KEY: '' });
  refused({ BENCH_ENTRY: 'not json' });
  refused({ BENCH_ENTRY: entryOf({ platform: '../x' }) });
  refused({ BENCH_ENTRY: entryOf({ region: 'EU west' }) });
  refused({ BENCH_ENTRY: entryOf({ phase: '' }) });
  refused({ BENCH_ENTRY: entryOf({ scenarios: 'S1 S5', budgets: false }), CONFIRM_BUDGETS: '' });
});

test('runEntry hands the child a small environment and acknowledges budgets only for S5 and S6', () => {
  const { calls } = run({});
  const by = Object.fromEntries(calls.map((c) => [c.s, c.e]));
  assert.equal(by.S5.LOAD_ACK_BUDGETS, 'yes');
  assert.equal(by.S1.LOAD_ACK_BUDGETS, undefined);
  assert.equal(by.S8.LOAD_ACK_BUDGETS, undefined);
  for (const e of Object.values(by)) {
    assert.equal(e.BASE_URL, 'https://hostmark.example.com');
    assert.equal(e.LOAD_ACK_REMOTE, 'hostmark.example.com');
    assert.equal(e.REGION, 'eu');
    assert.equal(e.GITHUB_TOKEN, undefined);
    assert.equal(e.HOSTMARK_API_KEY, undefined);
    assert.equal(e.API_KEY, 'key-1');
  }
  assert.equal(by.S8.ADMIN_API_KEY, 'admin-1');
  for (const [name, e] of Object.entries(by)) {
    if (name !== 'S8') assert.equal(e.ADMIN_API_KEY, undefined, `${name} gets no admin key`);
  }
  const noBudgets = run(
    { BENCH_ENTRY: entryOf({ scenarios: 'S1 S12', budgets: false }), CONFIRM_BUDGETS: 'cloudflare' },
    file(['fly', true], ['cloudflare', true]),
  );
  assert.equal(noBudgets.code, 0);
  assert.ok(noBudgets.calls.every((c) => c.e.LOAD_ACK_BUDGETS === undefined));
  assert.equal(noBudgets.calls[1].e.PURGE_URL, undefined);
  const purge = run({
    BENCH_ENTRY: entryOf({ scenarios: 'S12 S15', budgets: true }),
    HOSTMARK_PURGE_URL: 'https://api.example.com/purge',
    HOSTMARK_PURGE_TOKEN: 't',
  });
  assert.ok(
    purge.calls.every((c) => c.e.PURGE_URL === 'https://api.example.com/purge' && c.e.PURGE_TOKEN === 't'),
  );
});

test('runEntry returns the worst exit of the scenarios and still writes the sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-run-'));
  const code = runEntry({
    env: { ...ENV, BENCH_ENTRY: entryOf({ scenarios: 'S1 S8' }) },
    platformsText: file(['fly', true]),
    resultsDir: dir,
    exec: (s) => (s === 'S1' ? 1 : 3),
  });
  assert.equal(code, 3);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'bench-entry.json'), 'utf8')).exits, { S1: 1, S8: 3 });
});

test('bench-plan.mjs: nothing enabled exits 0 with count=0 and writes the output a skipped job needs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-plan-'));
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'out');
  writeFileSync(join(dir, 'platforms.json'), file(['local', false, 'emulated'], ['fly', false]));
  const r = spawnSync(
    process.execPath,
    [join(here, '..', 'tools', 'bench-plan.mjs'), '--out', join(dir, 'plan.json')],
    {
      env: { PATH: process.env.PATH, BENCH_PLATFORMS_FILE: join(dir, 'platforms.json'), GITHUB_OUTPUT: out },
      encoding: 'utf8',
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(out, 'utf8').split('\n');
  assert.ok(lines.includes('count=0'));
  assert.ok(lines.includes('core_count=0'));
  assert.ok(lines.includes('reach_count=0'));
  assert.equal(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')).count, 0);
});

test('bench-plan.mjs: a bad platforms.json, a disabled named platform and a missing mode exit 1 with no output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-plan-'));
  const go = (platformsText, env) => {
    const out = join(dir, `out-${Math.random()}`);
    writeFileSync(join(dir, 'platforms.json'), platformsText);
    const r = spawnSync(
      process.execPath,
      [join(here, '..', 'tools', 'bench-plan.mjs'), '--out', join(dir, 'plan.json')],
      {
        env: {
          PATH: process.env.PATH,
          BENCH_PLATFORMS_FILE: join(dir, 'platforms.json'),
          GITHUB_OUTPUT: out,
          ...env,
        },
        encoding: 'utf8',
      },
    );
    let output = '';
    try {
      output = readFileSync(out, 'utf8');
    } catch {
      // no output file is the expected outcome of a refusal
    }
    return { status: r.status, output };
  };
  assert.deepEqual(go('{', {}), { status: 1, output: '' });
  assert.deepEqual(go(file(['fly', false]), { PLATFORMS: 'fly', RUNNER_MODE: 'regional' }), {
    status: 1,
    output: '',
  });
  assert.deepEqual(go(file(['fly', true]), { PLATFORMS: 'all' }), { status: 1, output: '' });
  const live = go(file(['fly', true]), { PLATFORMS: 'all', RUNNER_MODE: 'github-hosted', SCENARIOS: 'S1' });
  assert.equal(live.status, 0);
  assert.match(live.output, /^count=1$/m);
});
