// The git tree of a working copy, as it would be committed: HEAD plus every change and every untracked file that is
// not ignored. It is computed in a temporary index (GIT_INDEX_FILE), so the real index is never read or written.
// A result carries it as `treeSha`; once the working copy is committed, `git rev-parse <commit>^{tree}` is equal.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(repo, args, env = {}) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Tree of HEAD, or an empty string when there is no commit. */
export function headTree(repo) {
  try {
    return git(repo, ['rev-parse', 'HEAD^{tree}']);
  } catch {
    return '';
  }
}

/** Tree of the working copy, or an empty string when it cannot be computed (no repository). */
export function workingTree(repo) {
  const dir = mkdtempSync(join(tmpdir(), 'hostmark-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(repo, ['read-tree', 'HEAD'], env);
    git(repo, ['add', '-A'], env);
    return git(repo, ['write-tree'], env);
  } catch {
    return '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
