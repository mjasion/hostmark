// node --test load/test/*.test.mjs
// Merging the result files of a workflow run and turning them into a report (D170 to D179). Fixtures are generated
// here; nothing is measured.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPlan, parsePlatforms, parseRegions } from '../tools/bench-lib.mjs';
import { collect, mergeRun, summarise } from '../tools/bench-results.mjs';
import { buildReport, esc } from '../tools/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);
const NOW = new Date('2026-12-01T05:30:00Z');

function result(o = {}) {
  const status = o.status ?? 'passed';
  return {
    schema: 1,
    scenario: o.scenario ?? 'S2',
    status,
    passed: status === 'passed' ? true : status === 'failed' ? false : null,
    date: o.date ?? '2026-12-01T05:20:00Z',
    treeSha: o.treeSha ?? TREE_A,
    dirty: o.dirty ?? false,
    commit: 'c0ffee',
    'x-platform': o.xPlatform ?? 'fly-portable',
    'x-version': '1.0.0',
    labels: { region: o.region ?? 'eu' },
    load: { mode: o.mode ?? 'full', deviations: o.deviations ?? [] },
    host: o.host === null ? undefined : (o.host ?? { watcher: 'ok', pauses: 0, pausedS: 0 }),
    headline: o.headline ?? { p50: 20, p95: 40, p99: 80, failedRate: 0 },
    failedThresholds: o.failedThresholds,
    skipped: status === 'skipped' ? { reason: o.reason ?? 'needs a purge endpoint' } : undefined,
  };
}

function dirOf(files, sidecar) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-res-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  if (sidecar) writeFileSync(join(dir, 'bench-entry.json'), JSON.stringify({ schema: 1, entry: sidecar }));
  return dir;
}

const entry = (region, platform = 'fly') => ({ platform, region, scenarios: 'S2', phase: 'reach' });

/** Three region artifacts as download-artifact lays them out: results/<artifact>/<files>. */
function threeRegions(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bench-art-'));
  for (const region of ['eu', 'us-east', 'ap-southeast']) {
    const sub = join(root, `results-reach-fly-${region}`);
    mkdirSync(sub);
    writeFileSync(
      join(sub, `S2-${region}.json`),
      JSON.stringify(result({ region, scenario: 'S11', ...(overrides[region] ?? {}) })),
    );
    writeFileSync(join(sub, 'bench-entry.json'), JSON.stringify({ schema: 1, entry: entry(region) }));
  }
  return root;
}

const regions = parseRegions(readFileSync(join(here, '..', 'regions.json'), 'utf8'));
const planFor = (scenarios) =>
  buildPlan({
    platforms: parsePlatforms(
      JSON.stringify({ platforms: [{ name: 'fly', enabled: true, status: 'deployed' }] }),
    ),
    regions,
    input: { runnerMode: 'regional', scenarios },
  });

test('three regions merge into one run, each row keeping its platform and region', () => {
  const { results, runs } = collect([threeRegions()]);
  assert.equal(runs.length, 0);
  const run = mergeRun({ id: '77-1', plan: planFor('S11'), items: results, now: NOW });
  assert.equal(run.kind, 'hostmark-benchmark-run');
  assert.deepEqual(run.rows.map((r) => r.region).sort(), ['ap-southeast', 'eu', 'us-east']);
  assert.ok(run.rows.every((r) => r.platform === 'fly' && r.scenario === 'S11'));
  assert.equal(run.complete, true);
  assert.deepEqual(run.missing, []);
  assert.equal(run.consistentTree, true);
  assert.deepEqual(run.treeShas, [TREE_A]);
});

test('a region that delivered nothing is listed as missing, not dropped', () => {
  const root = threeRegions();
  const { results } = collect([root]);
  const run = mergeRun({
    id: 'x',
    plan: planFor('S11'),
    items: results.filter((r) => r.sidecar.entry.region !== 'us-east'),
    now: NOW,
  });
  assert.equal(run.complete, false);
  assert.deepEqual(
    run.missing.map((m) => [m.platform, m.scenario, m.region, m.reason]),
    [['fly', 'S11', 'us-east', 'no result file']],
  );
  const { markdown, clean } = buildReport([run], { now: NOW });
  assert.equal(clean, false);
  assert.match(markdown, /\| S11 \| us-east \| NOT RUN \|/);
  assert.match(markdown, /NOT RUN: 1 planned result/);
});

test('an invalid result does not count as delivered, and it is marked in the report', () => {
  const root = threeRegions({
    'us-east': { status: 'invalid', host: { watcher: 'ok', pauses: 2, pausedS: 95 } },
  });
  const run = mergeRun({ id: 'x', plan: planFor('S11'), items: collect([root]).results, now: NOW });
  assert.deepEqual(
    run.missing.map((m) => m.region),
    ['us-east'],
  );
  assert.match(run.missing[0].reason, /only invalid/);
  const { markdown, summary } = buildReport([run], { now: NOW });
  assert.match(markdown, /INVALID: 1 result/);
  assert.equal(summary.counts.invalid, 1);
  const row = markdown.split('\n').find((l) => l.startsWith('| S11 | us-east | INVALID'));
  assert.ok(row, markdown);
  assert.match(row, /host paused 95 s/);
  assert.match(row, /left out of the numbers/);
});

test('results of different trees are never combined and the report says so', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-art-'));
  for (const [i, tree, p95] of [
    [1, TREE_A, 40],
    [2, TREE_A, 60],
    [3, TREE_B, 500],
  ]) {
    writeFileSync(
      join(root, `r${i}.json`),
      JSON.stringify(result({ treeSha: tree, headline: { p50: 10, p95, p99: 90 } })),
    );
  }
  const { runs } = { runs: [mergeRun({ id: 'x', items: collect([root]).results, now: NOW })] };
  assert.equal(runs[0].consistentTree, false);
  assert.deepEqual(runs[0].treeShas, [TREE_A, TREE_B]);
  const { markdown, summary } = buildReport(runs, { now: NOW });
  assert.match(markdown, /MIXED TREES: results of 2 different trees/);
  const groups = summary.groups.filter((g) => g.scenario === 'S2');
  assert.equal(groups.length, 2);
  const a = groups.find((g) => g.tree === TREE_A);
  const b = groups.find((g) => g.tree === TREE_B);
  assert.equal(a.n, 2);
  assert.ok(a.numbers.includes('p95 50 ms (40 ms to 60 ms)'), a.numbers.join());
  assert.ok(a.numbers.includes('p50 10 ms'), a.numbers.join());
  assert.equal(b.n, 1);
  assert.ok(b.numbers.some((n) => n === 'p95 500 ms'));
  assert.ok(b.notes.some((n) => /not combined/.test(n)));
});

test('results with a different load mode are not combined either', () => {
  const root = dirOf({
    'a.json': result({ mode: 'full' }),
    'b.json': result({ mode: 'reduced', deviations: [{ param: 'vus', value: 10, spec: 100 }] }),
  });
  const { summary, markdown } = buildReport(
    [mergeRun({ id: 'x', items: collect([root]).results, now: NOW })],
    { now: NOW },
  );
  assert.equal(summary.groups.length, 2);
  assert.match(markdown, /1 result\(s\) are reduced forms/);
});

const reportOf = (files) =>
  buildReport([mergeRun({ id: 'x', items: collect([dirOf(files)]).results, now: NOW })], { now: NOW });

test('two variants of one cell are two groups, never combined', () => {
  const { summary, markdown } = reportOf({
    'a.json': result({ xPlatform: 'fly-portable' }),
    'b.json': result({ xPlatform: 'fly-idiomatic', headline: { p50: 5, p95: 9, p99: 12 } }),
  });
  const groups = summary.groups.filter((g) => g.scenario === 'S2');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.variant).sort(), ['idiomatic', 'portable']);
  assert.ok(groups.every((g) => g.n === 1));
  assert.match(markdown, /other tree, variant or mode/);
});

test('the VARIANT label wins over the x-platform suffix', () => {
  const r = result({ xPlatform: 'fly-portable' });
  r.labels.variant = 'idiomatic';
  assert.equal(summarise(r, 'r.json').variant, 'idiomatic');
});

test('a result without a treeSha is warned about', () => {
  const r = result();
  delete r.treeSha;
  const { markdown } = reportOf({ 'a.json': r });
  assert.match(markdown, /1 result\(s\) carry no treeSha/);
});

test('an unrecognised status is shown and counted, never dropped', () => {
  const { markdown, summary } = reportOf({
    'a.json': result({ status: 'timed-out' }),
    'b.json': result({ scenario: 'S3' }),
  });
  assert.match(markdown, /UNRECOGNISED STATUS/);
  assert.match(markdown, /timed-out/);
  assert.match(markdown, /1 unrecognised/);
  assert.equal(summary.groups.filter((g) => g.scenario === 'S2').length, 1);
  assert.equal(summary.counts.passed, 1);
});

test('the same run given twice, and a copied result, are counted once and said so', () => {
  const items = collect([dirOf({ 'a.json': result() })]).results;
  const run = mergeRun({ id: 'x', items, now: NOW });
  const twice = buildReport([run, { ...run }], { now: NOW });
  assert.equal(twice.summary.counts.passed, 1);
  assert.match(twice.markdown, /1 duplicate run\(s\) or result\(s\) were counted once/);
  const other = mergeRun({ id: 'y', items, now: NOW });
  const copied = buildReport([run, other], { now: NOW });
  assert.equal(copied.summary.counts.passed, 1);
  assert.match(copied.markdown, /duplicate/);
  const distinct = reportOf({
    'a.json': result(),
    'b.json': result({ headline: { p50: 11, p95: 41, p99: 81 } }),
  });
  assert.doesNotMatch(distinct.markdown, /duplicate/);
});

test('a skipped scenario is SKIPPED with its reason, never PASSED, and not in the passed count', () => {
  const root = dirOf({
    'a.json': result({ scenario: 'S15', status: 'skipped', reason: 'no purge endpoint configured' }),
    'b.json': result({ scenario: 'S2' }),
  });
  const { markdown, summary } = buildReport(
    [mergeRun({ id: 'x', items: collect([root]).results, now: NOW })],
    { now: NOW },
  );
  const row = markdown.split('\n').find((l) => l.startsWith('| S15 |'));
  assert.match(row, /\| SKIPPED \|/);
  assert.doesNotMatch(row, /PASSED/);
  assert.match(row, /no purge endpoint configured/);
  assert.deepEqual([summary.counts.passed, summary.counts.skipped], [1, 1]);
  assert.match(markdown, /1 result\(s\) are SKIPPED/);
});

test('passed with failed results in one group is MIXED; failed alone is FAILED', () => {
  const root = dirOf({
    'a.json': result({}),
    'b.json': result({ status: 'failed', failedThresholds: ['http_req_duration p(95)<250'] }),
    'c.json': result({ scenario: 'S3', status: 'failed' }),
  });
  const { markdown } = buildReport([mergeRun({ id: 'x', items: collect([root]).results, now: NOW })], {
    now: NOW,
  });
  assert.match(markdown, /\| S2 \| eu \| MIXED \\?\(1 passed, 1 failed\\?\)/);
  assert.match(markdown, /\| S3 \| eu \| FAILED \|/);
  assert.match(markdown, /failed: http\\_req\\_duration/);
});

test('results without a host pause record, dirty trees and a missing plan are warned about', () => {
  const root = dirOf({ 'a.json': result({ host: null, dirty: true }) });
  const { markdown, clean } = buildReport([mergeRun({ id: 'x', items: collect([root]).results, now: NOW })], {
    now: NOW,
  });
  assert.equal(clean, false);
  assert.match(markdown, /no host pause record/);
  assert.match(markdown, /uncommitted changes/);
  assert.match(markdown, /no plan, so completeness is not checked/);
});

test('a target that answers as another platform than planned is flagged', () => {
  const root = dirOf({ 'a.json': result({ xPlatform: 'cloudflare-portable' }) }, entry('eu', 'fly'));
  const run = mergeRun({ id: 'x', items: collect([root]).results, now: NOW });
  assert.equal(run.rows[0].platform, 'fly');
  assert.equal(run.rows[0].platformMismatch, true);
  assert.match(run.problems[0], /answered as "cloudflare-portable"/);
  assert.match(buildReport([run], { now: NOW }).markdown, /target answered as cloudflare-portable, not fly/);
});

test('without a sidecar the platform comes from x-platform', () => {
  const row = summarise(result({ xPlatform: 'cloudflare-idiomatic' }), 'x.json');
  assert.equal(row.platform, 'cloudflare');
  assert.equal(row.platformMismatch, false);
  assert.equal(summarise({ ...result({}), 'x-platform': undefined }, 'x.json').platform, 'unknown');
});

test('a clean, complete run has no warnings', () => {
  const root = threeRegions();
  const run = mergeRun({ id: 'x', plan: planFor('S11'), items: collect([root]).results, now: NOW });
  const { markdown, clean } = buildReport([run], { now: NOW });
  assert.equal(clean, true, markdown);
  assert.match(markdown, /No warnings\./);
});

test('plan entries left out by the gate show as NOT RUN with the reason', () => {
  const plan = planFor('S5,S11');
  const run = mergeRun({ id: 'x', plan, items: [], now: NOW });
  const { markdown, summary } = buildReport([run], { now: NOW });
  assert.match(markdown, /\| S5 \| - \| NOT RUN \|[^\n]*budgets and billing alerts of fly are not confirmed/);
  assert.equal(summary.counts.passed, 0);
  assert.ok(summary.notRun.length >= 3);
});

test('refused platforms are listed and a github-hosted run is marked as one vantage point', () => {
  const platforms = parsePlatforms(
    JSON.stringify({
      platforms: [
        { name: 'fly', enabled: true, status: 'deployed' },
        { name: 'aws', enabled: false, status: 'emulated' },
      ],
    }),
  );
  const plan = buildPlan({ platforms, regions, input: { runnerMode: 'github-hosted', scenarios: 'S2' } });
  const { markdown } = buildReport([mergeRun({ id: 'x', plan, items: [], now: NOW })], { now: NOW });
  assert.match(markdown, /Not benchmarked: aws \(disabled in platforms.json\)/);
  assert.match(markdown, /one vantage point of unknown location/);
});

test('text from result files cannot break the markdown table or inject html', () => {
  const root = dirOf({
    'a.json': result({
      scenario: 'S15',
      status: 'skipped',
      reason: 'a | b\n<script>alert(1)</script> [x](http://evil) `c`',
    }),
  });
  const { markdown } = buildReport([mergeRun({ id: 'x', items: collect([root]).results, now: NOW })], {
    now: NOW,
  });
  const row = markdown.split('\n').find((l) => l.startsWith('| S15 |'));
  assert.ok(!row.includes('<script>'));
  assert.ok(!row.includes('[x]('));
  assert.equal(row.split(/(?<!\\)\|/).length, 10);
  assert.equal(esc('a|b\nc'), 'a\\|b c');
  assert.equal(esc('x'.repeat(1000)).length, 300);
});

test('the report stays under the step summary limit', () => {
  const rows = [];
  for (let i = 0; i < 6000; i++)
    rows.push(result({ scenario: 'S2', region: `r${i}`, treeSha: String(i).padStart(40, '0') }));
  const files = Object.fromEntries(rows.map((r, i) => [`f${i}.json`, r]));
  const { markdown } = buildReport(
    [mergeRun({ id: 'x', items: collect([dirOf(files)]).results, now: NOW })],
    { now: NOW },
  );
  assert.ok(Buffer.byteLength(markdown) <= 900_000, String(Buffer.byteLength(markdown)));
});

test('collect ignores behaviour records and unreadable files but reports them', () => {
  const dir = dirOf({ 'ok.json': result({}), 'behaviour.json': { kind: 'behaviours', checks: [] } });
  writeFileSync(join(dir, 'broken.json'), '{');
  const { results, ignored } = collect([dir]);
  assert.equal(results.length, 1);
  assert.equal(ignored.length, 2);
});

test('bench-merge.mjs and report.mjs work end to end and refuse a bad id', () => {
  const root = threeRegions();
  const out = mkdtempSync(join(tmpdir(), 'bench-out-'));
  writeFileSync(join(out, 'plan.json'), JSON.stringify(planFor('S11')));
  const merge = (id) =>
    spawnSync(
      process.execPath,
      [
        join(here, '..', 'tools', 'bench-merge.mjs'),
        '--results',
        root,
        '--plan',
        join(out, 'plan.json'),
        '--id',
        id,
        '--out',
        join(out, 'run.json'),
      ],
      { encoding: 'utf8' },
    );
  assert.equal(merge('../etc').status, 1);
  const ok = merge('77-1');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /merged 3 results/);
  const rep = spawnSync(
    process.execPath,
    [
      join(here, '..', 'tools', 'report.mjs'),
      join(out, 'run.json'),
      '--out',
      join(out, 'report.md'),
      '--json',
      join(out, 'summary.json'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /No warnings\./);
  assert.equal(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).counts.passed, 3);
});
