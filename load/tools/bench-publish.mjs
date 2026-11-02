#!/usr/bin/env node
// Publishes one merged run to a results branch of the repository (D175): runs/<id>/run.json, runs/<id>/report.md and a
// README.md that summarises every run on the branch. It needs `contents: write` and nothing else, creates the branch
// as an orphan when it does not exist, and never touches the branch the workflow checked out (it works in a separate
// git worktree). Re-publishing the same id replaces that run's files.
//   node load/tools/bench-publish.mjs --run run.json --branch benchmark-results [--remote origin]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, loadRuns } from './report.mjs';

const git = (cwd, args, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

export function publish({ repoDir, runFile, branch, remote = 'origin', message, now = new Date() }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,60}$/.test(branch) || branch.includes('..') || branch === 'main') {
    throw new Error(`refusing to publish to branch ${JSON.stringify(branch)}`);
  }
  const run = JSON.parse(readFileSync(runFile, 'utf8'));
  if (run.kind !== 'hostmark-benchmark-run' || !/^[A-Za-z0-9._-]{1,80}$/.test(run.id ?? '')) {
    throw new Error('not a merged run (bench-merge.mjs writes one)');
  }
  const tmp = mkdtempSync(join(tmpdir(), 'bench-publish-'));
  const work = join(tmp, 'wt');
  try {
    let exists = true;
    try {
      git(repoDir, ['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    } catch {
      exists = false;
    }
    git(repoDir, ['worktree', 'add', '--quiet', '--detach', work, exists ? `${remote}/${branch}` : 'HEAD']);
    if (exists) git(work, ['checkout', '--quiet', '-B', branch, `${remote}/${branch}`]);
    else {
      git(work, ['checkout', '--quiet', '--orphan', branch]);
      git(work, ['rm', '-rf', '--quiet', '--ignore-unmatch', '.']);
    }
    const dir = join(work, 'runs', run.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    writeFileSync(join(dir, 'report.md'), buildReport([run], { now }).markdown);
    const { runs } = loadRuns([join(work, 'runs')], now);
    const ordered = runs.sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)));
    writeFileSync(
      join(work, 'README.md'),
      buildReport(ordered, { title: 'hostmark benchmark results', now }).markdown,
    );
    git(work, ['add', '--all']);
    if (git(work, ['status', '--porcelain']).trim() === '') return { pushed: false, reason: 'no change' };
    git(work, [
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      message ?? `Benchmark run ${run.id}`,
    ]);
    git(work, ['push', '--quiet', remote, `HEAD:refs/heads/${branch}`]);
    return { pushed: true, branch };
  } finally {
    try {
      git(repoDir, ['worktree', 'remove', '--force', work]);
    } catch {
      // the worktree may not have been created
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const a = process.argv.slice(2);
    const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
    const result = publish({
      repoDir: process.cwd(),
      runFile: opt('--run'),
      branch: opt('--branch') ?? 'benchmark-results',
      remote: opt('--remote') ?? 'origin',
    });
    console.log(result.pushed ? `published to ${result.branch}` : `nothing to publish (${result.reason})`);
  } catch (err) {
    console.error(`publish failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
