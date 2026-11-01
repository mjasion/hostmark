import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { headTree, workingTree } from '../tools/tree.mjs';

const git = (repo, ...args) => {
  const r = spawnSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test('the working tree equals HEAD^{tree} once that exact tree is committed, and the index is not touched', () => {
  const repo = mkdtempSync(join(tmpdir(), 'hostmark-tree-'));
  try {
    git(repo, 'init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(repo, 'tracked.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    const clean = workingTree(repo);
    assert.equal(clean, headTree(repo));

    // a change, a new file in a new directory and an ignored file
    writeFileSync(join(repo, 'tracked.txt'), 'two\n');
    mkdirSync(join(repo, 'dir'));
    writeFileSync(join(repo, 'dir', 'new.txt'), 'new\n');
    writeFileSync(join(repo, 'ignored.txt'), 'x\n');
    const indexBefore = readFileSync(join(repo, '.git', 'index'));
    const dirty = workingTree(repo);
    assert.notEqual(dirty, headTree(repo));
    assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore, 'the real index is unchanged');
    assert.equal(
      git(repo, 'status', '--porcelain', '--', 'tracked.txt'),
      'M tracked.txt',
      'nothing was staged',
    );

    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'second');
    assert.equal(git(repo, 'rev-parse', 'HEAD^{tree}'), dirty);
    assert.equal(workingTree(repo), dirty);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('outside a repository the tree is empty, which counts as dirty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostmark-notgit-'));
  try {
    assert.equal(workingTree(dir), '');
    assert.equal(headTree(dir), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
