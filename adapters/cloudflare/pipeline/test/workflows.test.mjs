// Structural proof that the three Cloudflare workflows are off while the platform is disabled and are safe to run on
// a public repository. There is no YAML parser in the repository, so this reads the files line by line; the files are
// formatted by hand to keep that reliable, and the test fails loudly when it cannot find what it expects.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verificationPlan } from '../cli.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const FILES = readdirSync(WORKFLOWS).filter((f) => /^cloudflare-.*\.yml$/.test(f));

/** Splits the text under `jobs:` into `{ name, text }` per job (jobs are indented by two spaces). */
function jobsOf(text) {
  const start = text.indexOf('\njobs:\n');
  assert.ok(start >= 0, 'no jobs: section');
  const parts = text.slice(start + 6).split(/^ {2}(?=[a-z][a-z0-9-]*:\s*$)/m);
  return parts.filter((p) => p.trim() !== '').map((p) => ({ name: p.slice(0, p.indexOf(':')), text: p }));
}

test('the three workflows exist', () => {
  assert.deepEqual(FILES.sort(), [
    'cloudflare-preview-cleanup.yml',
    'cloudflare-preview.yml',
    'cloudflare-production.yml',
  ]);
});

for (const file of FILES) {
  const text = readFileSync(join(WORKFLOWS, file), 'utf8');
  const jobs = jobsOf(text);

  test(`${file}: no pull_request_target, empty top-level permissions`, () => {
    assert.doesNotMatch(text, /^\s*pull_request_target\s*:/m);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /pull_request_target/);
    assert.match(text, /^permissions: \{\}$/m);
  });

  test(`${file}: every action is pinned to a full commit SHA`, () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0);
    for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
  });

  test(`${file}: the first job is a gate with no secret and no environment`, () => {
    assert.equal(jobs[0].name, 'gate');
    assert.doesNotMatch(jobs[0].text, /secrets\./);
    assert.doesNotMatch(jobs[0].text, /^\s*environment:/m);
    assert.match(jobs[0].text, /adapters\/cloudflare\/pipeline\/gate\.mjs platforms\.json/);
  });

  test(`${file}: every other job needs the gate and is skipped unless it is enabled`, () => {
    assert.ok(jobs.length >= 2);
    for (const job of jobs.slice(1)) {
      assert.match(job.text, /^ {4}needs: (gate|\[gate(, [a-z-]+)*\])$/m, `${job.name} needs`);
      assert.match(job.text, /^ {4}if: .*needs\.gate\.outputs\.enabled == 'true'/m, `${job.name} if`);
    }
  });

  test(`${file}: secrets and environments appear only after the gate`, () => {
    for (const job of jobs.slice(1)) {
      // `environment:` is evaluated only for a job that runs, so a skipped job never creates one.
      if (/secrets\./.test(job.text))
        assert.match(job.text, /^ {4}environment: cloudflare-(preview|production)$/m);
    }
    assert.doesNotMatch(text, /secrets: inherit/);
    assert.doesNotMatch(text, /toJSON\(secrets\)/);
  });

  test(`${file}: nothing a pull request controls is interpolated into a script`, () => {
    // Walk the `run:` values (single line or block) and look for expressions in them.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      const body = [m[2]];
      if (/^[|>][-+]?$/.test(m[2])) {
        body.length = 0;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() !== '' && lines[j].search(/\S/) <= m[1].length) break;
          body.push(lines[j]);
        }
      }
      assert.doesNotMatch(body.join('\n'), /\$\{\{/, `run at line ${i + 1} contains an expression`);
    }
  });

  test(`${file}: every job has a timeout`, () => {
    for (const job of jobs) assert.match(job.text, /^ {4}timeout-minutes: \d+$/m, job.name);
  });
}

test('preview workflows run on pull_request only and never from the head in the gate', () => {
  for (const file of ['cloudflare-preview.yml', 'cloudflare-preview-cleanup.yml']) {
    const text = readFileSync(join(WORKFLOWS, file), 'utf8');
    assert.match(text, /^ {2}pull_request:$/m);
    assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.match(text, /--same-repo "\$HEAD_REPO" "\$BASE_REPO"/);
  }
});

test('preview triggers are limited to pull requests into main (F4)', () => {
  for (const file of ['cloudflare-preview.yml', 'cloudflare-preview-cleanup.yml']) {
    const text = readFileSync(join(WORKFLOWS, file), 'utf8');
    assert.match(text, /^ {2}pull_request:\n {4}branches: \[main\]$/m, file);
  }
});

test('previews are for trusted authors only (F5)', () => {
  for (const file of ['cloudflare-preview.yml', 'cloudflare-preview-cleanup.yml']) {
    const text = readFileSync(join(WORKFLOWS, file), 'utf8');
    const job = jobsOf(text).find((j) => j.name !== 'gate');
    assert.match(
      job.text,
      /^ {4}if: needs\.gate\.outputs\.enabled == 'true' && contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)$/m,
      file,
    );
  }
});

test('the preview runs the pipeline scripts of the base and deploys the head tree (F5)', () => {
  const text = readFileSync(join(WORKFLOWS, 'cloudflare-preview.yml'), 'utf8');
  const job = jobsOf(text).find((j) => j.name === 'preview');
  const checkouts = [
    ...job.text.matchAll(/uses: actions\/checkout@[^\n]*\n\s+with:\n((?: {10}[^\n]*\n)+)/g),
  ].map((m) => m[1]);
  assert.equal(checkouts.length, 2);
  assert.match(checkouts[0], /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(checkouts[0], /path: trusted/);
  assert.match(checkouts[1], /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(checkouts[1], /path: head/);
  assert.match(
    job.text,
    /PIPELINE: node \$\{\{ github\.workspace \}\}\/trusted\/adapters\/cloudflare\/pipeline\/cli\.mjs/,
  );
  assert.match(job.text, /HOSTMARK_ROOT: \$\{\{ github\.workspace \}\}\/head$/m);
  // nothing runs a script out of the head tree: the only head paths are install, build and wrangler
  assert.doesNotMatch(job.text, /node head\//);
  for (const m of job.text.matchAll(/^ {8}working-directory: (\S+)$/gm))
    assert.match(m[1], /^head(\/adapters\/cloudflare)?$/, m[1]);
  // install and build (the head's own code) run in steps with no secret
  const steps = job.text.split(/^ {6}- /m);
  for (const step of steps.filter((x) => /pnpm install|pnpm --filter/.test(x)))
    assert.doesNotMatch(step, /secrets\./, step);
});

test('production: fixtures and snapshot come before the rollouts, the restore is last and unconditional (F1, F10)', () => {
  const text = readFileSync(join(WORKFLOWS, 'cloudflare-production.yml'), 'utf8');
  const job = jobsOf(text).find((j) => j.name === 'deploy');
  const steps = job.text.split(/^ {6}- /m).slice(1);
  const index = (re) => steps.findIndex((x) => re.test(x));
  const fixtures = index(/node load\/tools\/fixtures\.mjs/);
  const install = index(/pnpm install --frozen-lockfile/);
  const snapshot = index(/\$PIPELINE snapshot /);
  const migrate = index(/run migrate/);
  const api = index(/rollout --config wrangler\.api\.jsonc/);
  const consumer = index(/rollout --config wrangler\.consumer\.jsonc/);
  assert.ok(install >= 0 && install < fixtures, 'fixtures after install');
  assert.ok(fixtures >= 0 && fixtures < api, 'fixtures before the first rollout');
  assert.doesNotMatch(steps[fixtures], /secrets\./);
  assert.ok(
    snapshot >= 0 && snapshot < migrate && migrate < api && api < consumer,
    'snapshot before anything changes',
  );
  const restore = steps.length - 1;
  assert.match(steps[restore], /\$PIPELINE restore /);
  assert.match(
    steps[restore],
    /^ {8}if: always\(\) && job\.status != 'success' && steps\.snapshot\.outcome == 'success'$/m,
  );
  // the consumer is restored before the api, both from the recorded outputs and never from an expression in a script
  assert.ok(steps[restore].indexOf('wrangler.consumer.jsonc') < steps[restore].indexOf('wrangler.api.jsonc'));
  assert.match(steps[restore], /STABLE_API: \$\{\{ steps\.snapshot\.outputs\.api \}\}/);
  assert.match(steps[restore], /STABLE_CONSUMER: \$\{\{ steps\.snapshot\.outputs\.consumer \}\}/);
  // no step after the rollouts may be able to leave the job green without the restore being considered
  assert.ok(restore > consumer);
});

test('every production rollout verifies with scenarios and a fixture this variant accepts (D103, D250)', () => {
  const text = readFileSync(join(WORKFLOWS, 'cloudflare-production.yml'), 'utf8');
  const rollouts = [...text.matchAll(/\$PIPELINE rollout ([^\n]+)/g)].map((m) => m[1]);
  assert.equal(rollouts.length, 2);
  for (const line of rollouts) {
    const verify = /--verify (\S+)/.exec(line)?.[1];
    const fixture = /--upload-fixture (\S+)/.exec(line)?.[1];
    assert.ok(verify, `${line}: no --verify`);
    // Throws for a scenario that uploads an image this variant refuses, or for S4 without the tiny fixture.
    assert.doesNotThrow(() => verificationPlan(verify, fixture), line);
  }
  const consumer = rollouts.find((l) => l.includes('wrangler.consumer.jsonc'));
  assert.match(consumer, /--no-probe --verify S4 --upload-fixture jpeg-tiny\.jpg/);
});

test('production checks the configs in deploy mode, which refuses the committed placeholders (D255)', () => {
  const text = readFileSync(join(WORKFLOWS, 'cloudflare-production.yml'), 'utf8');
  const verify = jobsOf(text).find((j) => j.name === 'verify');
  assert.match(verify.text, /run: pnpm --filter @hostmark\/adapter-cloudflare check --deploy$/m);
  assert.doesNotMatch(verify.text, /adapter-cloudflare check$/m);
});

test('production requires a deployed status and only runs from main', () => {
  const text = readFileSync(join(WORKFLOWS, 'cloudflare-production.yml'), 'utf8');
  assert.match(text, /gate\.mjs platforms\.json --require-deployed/);
  assert.match(text, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(text, /cancel-in-progress: false/);
});

test('preview secrets are the PREVIEW_* ones and the production database never appears in a preview workflow', () => {
  for (const file of ['cloudflare-preview.yml', 'cloudflare-preview-cleanup.yml']) {
    const text = readFileSync(join(WORKFLOWS, file), 'utf8');
    assert.doesNotMatch(text, /PRODUCTION|LOAD_API_KEY|cloudflare-production/, file);
  }
});

test('with the platform disabled the gate says disabled for every workflow shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-workflows-'));
  const platforms = join(dir, 'platforms.json');
  const gate = join(ROOT, 'adapters/cloudflare/pipeline/gate.mjs');
  const run = (args) => {
    const out = join(dir, 'out');
    writeFileSync(out, '');
    execFileSync('node', [gate, platforms, ...args], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: out } });
    return readFileSync(out, 'utf8');
  };
  for (const entry of [
    { name: 'cloudflare', enabled: false, status: 'emulated' },
    { name: 'cloudflare', enabled: false, status: 'deployed' },
    { name: 'cloudflare', enabled: 'true', status: 'deployed' },
    { name: 'cloudflare', status: 'deployed' },
  ]) {
    writeFileSync(platforms, JSON.stringify({ platforms: [entry] }));
    assert.match(run(['--same-repo', 'o/r', 'o/r']), /^enabled=false$/m, JSON.stringify(entry));
    assert.match(run(['--require-deployed']), /^enabled=false$/m, JSON.stringify(entry));
  }
  // Enabled but only emulated: previews may run, production may not.
  writeFileSync(
    platforms,
    JSON.stringify({ platforms: [{ name: 'cloudflare', enabled: true, status: 'emulated' }] }),
  );
  assert.match(run(['--same-repo', 'o/r', 'o/r']), /^enabled=true$/m);
  assert.match(run(['--require-deployed']), /^enabled=false$/m);
  assert.match(run(['--same-repo', 'fork/r', 'o/r']), /^enabled=false$/m);
});
