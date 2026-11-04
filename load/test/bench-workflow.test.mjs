// node --test load/test/*.test.mjs
// Static checks of .github/workflows/benchmark.yml that actionlint does not make: the repository's own rules for this
// workflow (D170 to D179). actionlint itself is run separately (load/BENCHMARK.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, '..', '..', '.github', 'workflows', 'benchmark.yml'), 'utf8');
const lines = text.split('\n');
// The workflow installs the pnpm that `packageManager` names; Renovate moves both together (D328).
const pnpmPin = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).packageManager;

/** The jobs as { name, body } by indentation: a job starts at two spaces under `jobs:`. */
function jobs() {
  const start = lines.indexOf('jobs:');
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(lines[i]);
    if (m) out.push({ name: m[1], from: i, body: [] });
    else if (out.length > 0) out.at(-1).body.push(lines[i]);
  }
  return out.map((j) => ({ ...j, text: j.body.join('\n') }));
}

/** Every `run:` script, inline or block, as text. */
function runScripts() {
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] === '|' || m[2] === '>' || m[2] === '|-' || m[2] === '>-') {
      const indent = m[1].length;
      const block = [];
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > indent); j++)
        block.push(lines[j]);
      scripts.push(block.join('\n'));
    } else scripts.push(m[2]);
  }
  return scripts;
}

test('every action is pinned to a full commit SHA', () => {
  const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
});

test('no run script interpolates an expression', () => {
  const scripts = runScripts();
  assert.ok(scripts.length >= 5);
  for (const s of scripts) assert.doesNotMatch(s, /\$\{\{/, s);
});

test('permissions are read-only at the top and write only on the publish job', () => {
  assert.match(text, /^permissions:\n {2}contents: read\n/m);
  const writes = jobs()
    .filter((j) => /contents: write/.test(j.text))
    .map((j) => j.name);
  assert.deepEqual(writes, ['publish']);
  assert.equal([...text.matchAll(/(?<!\w)[a-z-]+: write/g)].length, 1);
  assert.doesNotMatch(text, /pull_request|pull_request_target|workflow_run|push:/);
});

test('it runs on dispatch and a monthly schedule only', () => {
  assert.match(text, /^on:\n {2}workflow_dispatch:\n/m);
  const crons = [...text.matchAll(/cron:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.equal(crons.length, 1);
  const [minute, hour, day, month, weekday] = crons[0].split(' ');
  assert.match(minute, /^\d+$/);
  assert.match(hour, /^\d+$/);
  assert.match(day, /^\d+$/, 'a monthly schedule names one day of the month');
  assert.equal(month, '*');
  assert.equal(weekday, '*');
});

test('runner_mode is a required input with no default, and the budget confirmation defaults to nobody', () => {
  const inputs = text.slice(text.indexOf('    inputs:'), text.indexOf('  schedule:'));
  const section = (name) => {
    const at = inputs.indexOf(`      ${name}:`);
    const next = inputs.slice(at + 1).search(/\n {6}[a-z_]+:/);
    return inputs.slice(at, next === -1 ? undefined : at + 1 + next);
  };
  assert.match(section('runner_mode'), /required: true/);
  assert.doesNotMatch(section('runner_mode'), /default:/);
  assert.match(section('confirm_budgets'), /default: (?:''|"")/);
});

test('the gate comes first: every other job depends on plan and checks its outputs and result', () => {
  const byName = Object.fromEntries(jobs().map((j) => [j.name, j]));
  assert.deepEqual(Object.keys(byName), ['plan', 'core', 'reach', 'publish']);
  assert.doesNotMatch(byName.plan.text, /needs:/);
  assert.doesNotMatch(byName.plan.text, /secrets\./, 'the plan job reaches no secret');
  assert.doesNotMatch(byName.plan.text, /environment:/, 'the plan job reaches no environment');
  for (const name of ['core', 'reach', 'publish']) {
    const j = byName[name];
    assert.match(j.text, /needs: (?:plan|\[plan[^\]]*\])/, name);
    const cond = j.text.slice(j.text.indexOf('    if:'), j.text.indexOf('    runs-on:'));
    assert.match(cond, /needs\.plan\.result == 'success'/, name);
    assert.match(cond, /needs\.plan\.outputs\.\w*count != ''/, name);
    assert.match(cond, /needs\.plan\.outputs\.\w*count != '0'/, name);
  }
});

test('secrets and environments are used by the two load jobs only, and each load job has an environment', () => {
  const withSecrets = jobs()
    .filter((j) => /secrets\./.test(j.text))
    .map((j) => j.name);
  assert.deepEqual(withSecrets, ['core', 'reach']);
  for (const name of withSecrets) {
    const j = jobs().find((x) => x.name === name);
    assert.match(j.text, /environment: bench-\$\{\{ matrix\.platform \}\}/);
    assert.match(j.text, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.(?:core|reach)\) \}\}/);
  }
  assert.doesNotMatch(text, /secrets\.GITHUB_TOKEN/);
  assert.doesNotMatch(
    text,
    /^\s{0,4}[A-Z_]+:\s*\$\{\{\s*secrets\./m,
    'no secret at workflow or top-level env',
  );
});

test('nothing runs off main: the gate job carries the branch check, and the others need the gate', () => {
  const plan = jobs().find((j) => j.name === 'plan');
  assert.match(plan.text, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
});

test('a dispatch uses its inputs alone; the variables are read for the schedule only', () => {
  for (const [name, input, variable] of [
    ['BENCH_SCENARIOS', 'scenarios', 'BENCH_SCENARIOS'],
    ['BENCH_CONFIRM_BUDGETS', 'confirm_budgets', 'BENCH_BUDGETS_CONFIRMED'],
    ['BENCH_RUNNER_MODE', 'runner_mode', 'BENCH_RUNNER_MODE'],
  ]) {
    const line = lines.find((l) => l.startsWith(`  ${name}:`));
    assert.ok(line, name);
    assert.match(line, new RegExp(`github\\.event_name == 'workflow_dispatch' && inputs\\.${input} `), name);
    assert.match(line, new RegExp(`github\\.event_name == 'schedule' && vars\\.${variable} \\|\\| ''`), name);
  }
  assert.doesNotMatch(text, /inputs\.\w+ \|\| vars\./, 'an empty input never falls back to a variable');
});

test('the load jobs install dependencies and make the fixtures in a step with no secret, before the run', () => {
  for (const name of ['core', 'reach']) {
    const j = jobs().find((x) => x.name === name);
    const steps = j.text.split(/\n {6}- /).slice(1);
    const at = steps.findIndex(
      (st) => /pnpm install --frozen-lockfile/.test(st) && /load\/tools\/fixtures\.mjs/.test(st),
    );
    const run = steps.findIndex((st) => /bench-run\.mjs/.test(st));
    assert.ok(at >= 0, `${name}: install and fixtures step`);
    assert.ok(at < run, `${name}: before the scenarios`);
    assert.doesNotMatch(steps[at], /secrets\.|env:|vars\./, `${name}: no secret, no environment variable`);
    assert.ok(steps[at].includes(` ${pnpmPin}\n`), `${name}: installs ${pnpmPin}`);
  }
});

test('the schedule cannot start two benchmarks at once', () => {
  assert.match(text, /^concurrency:\n {2}group: benchmark\n {2}cancel-in-progress: false\n/m);
});

test('checkouts do not keep the token, except where the job pushes', () => {
  for (const j of jobs()) {
    const checkout = j.text.slice(j.text.indexOf('actions/checkout'));
    const persists = !/persist-credentials: false/.test(checkout.slice(0, 200));
    assert.equal(persists, j.name === 'publish', j.name);
  }
});
