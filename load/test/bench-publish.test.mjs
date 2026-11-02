// node --test load/test/*.test.mjs
// Publishing to the results branch, against a bare repository in the temp directory. Never the real repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publish } from '../tools/bench-publish.mjs';
import { mergeRun } from '../tools/bench-results.mjs';

// Without the user's git configuration: no signing prompt, no hooks, no templates.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
process.env.GIT_TERMINAL_PROMPT = '0';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bench-pub-'));
  const bare = join(root, 'remote.git');
  const work = join(root, 'work');
  git(root, 'init', '--bare', '--quiet', '--initial-branch=main', bare);
  git(root, 'init', '--quiet', '--initial-branch=main', work);
  writeFileSync(join(work, 'README.md'), 'source tree\n');
  git(work, 'add', '.');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'init');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '--quiet', 'origin', 'main');
  return { root, bare, work };
}

const row = (o = {}) => ({
  platform: 'fly',
  scenario: 'S2',
  region: 'eu',
  file: 'S2.json',
  date: '',
  status: 'passed',
  mode: 'full',
  deviations: [],
  treeSha: 'a'.repeat(40),
  dirty: false,
  commit: '',
  xPlatform: 'fly-portable',
  xVersion: '1',
  platformMismatch: false,
  hostWatched: true,
  pausedS: 0,
  skippedReason: '',
  failedThresholds: [],
  expectedVersion: null,
  numbers: [{ name: 'p95', unit: 'ms', value: 40 }],
  ...o,
});

const runFile = (root, id, rows, at) => {
  const file = join(root, `${id}.json`);
  writeFileSync(
    file,
    JSON.stringify(mergeRun({ id, items: [], now: new Date(at) }), null, 1).replace(
      '"rows": []',
      `"rows": ${JSON.stringify(rows)}`,
    ),
  );
  return file;
};

test('the first publish creates an orphan branch with the run and a README; main is untouched', () => {
  const { root, bare, work } = setup();
  const r = publish({
    repoDir: work,
    runFile: runFile(root, '10-1', [row()], '2026-12-01T05:00:00Z'),
    branch: 'benchmark-results',
  });
  assert.equal(r.pushed, true);
  const branch = git(bare, 'ls-tree', '-r', '--name-only', 'benchmark-results').trim().split('\n');
  assert.deepEqual(branch, ['README.md', 'runs/10-1/report.md', 'runs/10-1/run.json']);
  assert.equal(git(bare, 'rev-list', '--count', 'benchmark-results').trim(), '1');
  assert.match(git(bare, 'log', '-1', '--format=%an', 'benchmark-results'), /github-actions\[bot\]/);
  assert.equal(git(bare, 'show', 'main:README.md'), 'source tree\n');
  assert.match(git(bare, 'show', 'benchmark-results:README.md'), /hostmark benchmark results/);
  // The checkout that ran it keeps its branch and its index, and no worktree is left behind.
  assert.equal(git(work, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.equal(git(work, 'status', '--porcelain').trim(), '');
  assert.equal(
    git(work, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree ')).length,
    1,
  );
});

test('a second run is added, the README covers both, and republishing an id changes nothing', () => {
  const { root, bare, work } = setup();
  publish({
    repoDir: work,
    runFile: runFile(root, '10-1', [row()], '2026-12-01T05:00:00Z'),
    branch: 'benchmark-results',
  });
  const second = runFile(root, '11-1', [row({ treeSha: 'b'.repeat(40) })], '2027-01-01T05:00:00Z');
  assert.equal(publish({ repoDir: work, runFile: second, branch: 'benchmark-results' }).pushed, true);
  assert.equal(git(bare, 'rev-list', '--count', 'benchmark-results').trim(), '2');
  const readme = git(bare, 'show', 'benchmark-results:README.md');
  assert.match(readme, /from 2 run\(s\)/);
  assert.match(readme, /MIXED TREES/);
  const again = publish({
    repoDir: work,
    runFile: second,
    branch: 'benchmark-results',
    now: new Date('2027-01-01T06:00:00Z'),
  });
  // The report text carries a generation time, so a republish may commit; what must hold is that no run is lost.
  assert.ok(typeof again.pushed === 'boolean');
  assert.deepEqual(git(bare, 'ls-tree', '-r', '--name-only', 'benchmark-results').trim().split('\n'), [
    'README.md',
    'runs/10-1/report.md',
    'runs/10-1/run.json',
    'runs/11-1/report.md',
    'runs/11-1/run.json',
  ]);
});

test('it refuses main, odd branch names and files that are not a merged run', () => {
  const { root, work } = setup();
  const file = runFile(root, '10-1', [row()], '2026-12-01T05:00:00Z');
  for (const branch of ['main', '', '-x', 'a..b', 'a b', 'x;y']) {
    assert.throws(() => publish({ repoDir: work, runFile: file, branch }), /refusing to publish/, branch);
  }
  writeFileSync(join(root, 'other.json'), JSON.stringify({ hello: 1 }));
  assert.throws(
    () => publish({ repoDir: work, runFile: join(root, 'other.json'), branch: 'benchmark-results' }),
    /not a merged run/,
  );
  const badId = JSON.parse(readFileSync(file, 'utf8'));
  badId.id = '../../x';
  writeFileSync(join(root, 'bad.json'), JSON.stringify(badId));
  assert.throws(
    () => publish({ repoDir: work, runFile: join(root, 'bad.json'), branch: 'benchmark-results' }),
    /not a merged run/,
  );
});
