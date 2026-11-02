#!/usr/bin/env node
// First job of the benchmark workflow. Reads platforms.json and regions.json, applies the gate (bench-lib.mjs) and
// writes plan.json plus the job outputs. It touches no secret and no network. With nothing enabled it exits 0 with
// `count=0`, and every later job is skipped. Anything it cannot read exits 1: unknown input never starts load.
//   node load/tools/bench-plan.mjs [--out plan.json]
// Environment (all text, none of it interpolated into a shell): PLATFORMS, SCENARIOS, CONFIRM_BUDGETS, RUNNER_MODE,
// GITHUB_OUTPUT (optional), BENCH_PLATFORMS_FILE, BENCH_REGIONS_FILE (for tests).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, parsePlatforms, parseRegions } from './bench-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

function main() {
  const out = process.argv[2] === '--out' ? process.argv[3] : 'plan.json';
  const platforms = parsePlatforms(
    readFileSync(process.env.BENCH_PLATFORMS_FILE ?? join(repo, 'platforms.json'), 'utf8'),
  );
  const regions = parseRegions(
    readFileSync(process.env.BENCH_REGIONS_FILE ?? join(repo, 'load', 'regions.json'), 'utf8'),
  );
  const plan = buildPlan({
    platforms,
    regions,
    input: {
      platforms: process.env.PLATFORMS,
      scenarios: process.env.SCENARIOS,
      confirmBudgets: process.env.CONFIRM_BUDGETS,
      runnerMode: process.env.RUNNER_MODE,
    },
  });
  writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
  const lines = [
    `count=${plan.count}`,
    `core=${JSON.stringify(plan.core)}`,
    `reach=${JSON.stringify(plan.reach)}`,
    `core_count=${plan.core.include.length}`,
    `reach_count=${plan.reach.include.length}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(
    `plan: ${plan.platforms.map((p) => p.name).join(', ') || 'no platform'}; ${plan.core.include.length} core and ${plan.reach.include.length} reach jobs`,
  );
  for (const r of plan.refusedPlatforms) console.log(`  not benchmarked: ${r.platform} (${r.reason})`);
  for (const s of plan.skipped) console.log(`  not run: ${s.platform} ${s.scenario} (${s.reason})`);
  for (const n of plan.notes) console.log(`  note: ${n}`);
  if (plan.count === 0) console.log('nothing to run: every later job is skipped');
}

try {
  main();
} catch (err) {
  console.error(`plan refused: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
