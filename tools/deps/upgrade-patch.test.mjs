// Runs the "Apply patch" step of .github/workflows/pnpm-upgrade.yml, verbatim, against throwaway repositories, so the
// path allowlist of the write-token job is tested by behaviour and not by its spelling (D330).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(join(repo, '.github/workflows/pnpm-upgrade.yml'), 'utf8');

/** The `run: |` block of the named step, without its indentation. */
function stepScript(name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `step ${name}`);
  const run = lines.findIndex((l, i) => i > start && /^\s+run: \|$/.test(l));
  const indent = lines[run + 1].length - lines[run + 1].trimStart().length;
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const env = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env, encoding: 'utf8' });

/** A clone whose origin/main holds a small workspace, plus RUNNER_TEMP with the patch in place. */
function fixture(patch) {
  const base = mkdtempSync(join(tmpdir(), 'hostmark-upgrade-'));
  const upstream = join(base, 'upstream');
  mkdirSync(join(upstream, 'packages', 'core'), { recursive: true });
  writeFileSync(join(upstream, 'package.json'), '{ "name": "root" }\n');
  writeFileSync(join(upstream, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(join(upstream, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(
    join(upstream, 'packages', 'core', 'package.json'),
    '{ "name": "core", "version": "1.0.0" }\n',
  );
  writeFileSync(join(upstream, 'packages', 'core', 'guard.ts'), 'export const guard = true;\n');
  git(upstream, 'init', '-q');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-qm', 'base');
  const work = join(base, 'work');
  git(base, 'clone', '-q', upstream, work);
  const runnerTemp = join(base, 'runner');
  mkdirSync(join(runnerTemp, 'patch'), { recursive: true });
  writeFileSync(join(runnerTemp, 'patch', 'upgrade.patch'), patch);
  return { work, runnerTemp };
}

/** Runs the step as GitHub runs a `run:` block (bash -e -o pipefail), then the commit if it passed. */
function applyPatch(patch) {
  const { work, runnerTemp } = fixture(patch);
  const res = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepScript('Apply patch')],
    {
      cwd: work,
      env: { ...env, RUNNER_TEMP: runnerTemp, BRANCH: 'chore/pnpm-upgrade' },
      encoding: 'utf8',
    },
  );
  if (res.status !== 0) return { ok: false, output: res.stdout + res.stderr };
  git(work, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'chore: pnpm upgrade');
  const changed = git(work, 'show', '--name-status', '--no-renames', '--format=', 'HEAD').trim().split('\n');
  return { ok: true, changed };
}

const bump = `diff --git a/packages/core/package.json b/packages/core/package.json
--- a/packages/core/package.json
+++ b/packages/core/package.json
@@ -1 +1 @@
-{ "name": "core", "version": "1.0.0" }
+{ "name": "core", "version": "1.0.1" }
`;

test('a manifest bump is applied and committed alone', () => {
  const result = applyPatch(bump);
  assert.ok(result.ok, result.output);
  assert.deepEqual(result.changed, ['M\tpackages/core/package.json']);
});

test('a rename of another file onto a new manifest path is refused (its source would be deleted)', () => {
  const result = applyPatch(`diff --git a/pnpm-workspace.yaml b/packages/zz/package.json
similarity index 100%
rename from pnpm-workspace.yaml
rename to packages/zz/package.json
`);
  assert.equal(result.ok, false);
  assert.match(result.output, /Patch touches unexpected paths: pnpm-workspace\.yaml/);
});

test('a deletion of a manifest followed by a rename onto it is refused', () => {
  const result = applyPatch(`diff --git a/packages/core/package.json b/packages/core/package.json
deleted file mode 100644
--- a/packages/core/package.json
+++ /dev/null
@@ -1 +0,0 @@
-{ "name": "core", "version": "1.0.0" }
diff --git a/packages/core/guard.ts b/packages/core/package.json
similarity index 100%
rename from packages/core/guard.ts
rename to packages/core/package.json
`);
  assert.equal(result.ok, false);
  assert.match(result.output, /packages\/core\/guard\.ts/);
});

test('a plain deletion or a new file outside the allowlist is refused', () => {
  const deletion = applyPatch(`diff --git a/packages/core/guard.ts b/packages/core/guard.ts
deleted file mode 100644
--- a/packages/core/guard.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const guard = true;
`);
  assert.equal(deletion.ok, false);
  const added = applyPatch(`${bump}diff --git a/.npmrc b/.npmrc
new file mode 100644
--- /dev/null
+++ b/.npmrc
@@ -0,0 +1 @@
+registry=https://example.invalid/
`);
  assert.equal(added.ok, false);
  assert.match(added.output, /\.npmrc/);
});
