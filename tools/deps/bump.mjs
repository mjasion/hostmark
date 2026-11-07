// Raises every exactly pinned dependency of the workspace to its newest release within the same major, and the
// lockfile with it (D330). The manifests pin exact versions, which `pnpm update` alone never moves, so this loosens
// each exact pin to a caret range, lets `pnpm update --recursive` pick the newest release in range (minimumReleaseAge,
// allowBuilds and the overrides of pnpm-workspace.yaml apply), and pins the result again. Majors are left to Renovate
// and the owner. For a 0.x version the caret allows patches only, as semver treats a 0.x minor as breaking.
//
//   node tools/deps/bump.mjs            # run in the repository root
//   node tools/deps/bump.mjs --dry-run  # loosen and pin in memory only, print what would be loosened
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Kept where they are: `path-to-regexp` must equal the version `@vercel/routing-utils` matches with (D231). */
export const SKIP = new Set(['path-to-regexp']);
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const EXACT = /^\d+\.\d+\.\d+$/;

/** The workspace's package.json files: the root and every directory under apps/, packages/ and adapters/. */
export function manifests(root) {
  const found = [join(root, 'package.json')];
  for (const group of ['apps', 'packages', 'adapters']) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(file)) found.push(file);
    }
  }
  return found;
}

/** Turns each exact pin into `^version`; returns the entries it changed. */
export function loosen(manifest, skip = SKIP) {
  const changed = [];
  for (const section of SECTIONS) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (skip.has(name) || typeof spec !== 'string' || !EXACT.test(spec)) continue;
      manifest[section][name] = `^${spec}`;
      changed.push({ section, name, from: spec });
    }
  }
  return changed;
}

/** Pins the loosened entries again, at whatever version the range now names. */
export function pin(manifest, entries) {
  for (const { section, name } of entries) {
    const spec = manifest[section]?.[name];
    if (typeof spec === 'string' && spec.startsWith('^')) manifest[section][name] = spec.slice(1);
  }
}

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, json) => writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const loosened = new Map();
  for (const file of manifests(root)) {
    const json = read(file);
    const entries = loosen(json);
    if (entries.length === 0) continue;
    loosened.set(file, entries);
    if (dryRun) for (const e of entries) console.log(`${file}: ${e.name} ${e.from}`);
    else write(file, json);
  }
  if (dryRun) return;
  try {
    run('pnpm', ['update', '--recursive'], root);
  } finally {
    // Pinned again even when the update failed, so a failure never leaves caret ranges behind.
    for (const [file, entries] of loosened) {
      const json = read(file);
      pin(json, entries);
      write(file, json);
    }
  }
  // The lockfile's specifiers follow the pinned manifests; the resolved versions stay.
  run('pnpm', ['install', '--no-frozen-lockfile'], root);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
