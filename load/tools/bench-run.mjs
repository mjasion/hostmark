#!/usr/bin/env node
// Runs the scenarios of one matrix entry (one platform, one region) with load/run.mjs. This is the only place in the
// workflow that reads the target and its keys, and it checks the gate again before it does (bench-lib.checkEntry),
// so a matrix that was edited or replayed cannot send load to a platform that is disabled now.
//   BENCH_ENTRY (JSON of the matrix entry), CONFIRM_BUDGETS, HOSTMARK_BASE_URL, HOSTMARK_API_KEY,
//   HOSTMARK_ADMIN_API_KEY, HOSTMARK_PURGE_URL / _METHOD / _TOKEN, HOSTMARK_VARIANT, GITHUB_RUN_ID
// Exit: 0 all scenarios passed or were skipped, 2 refused before any request, otherwise the worst exit of run.mjs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET_SCENARIOS, checkEntry, checkTarget, parsePlatforms } from './bench-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

/** Everything the child needs and nothing else the job holds. */
function childEnv(base, extra) {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'USER', 'LANG', 'XDG_RUNTIME_DIR'];
  const env = {};
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k];
  return { ...env, ...extra };
}

/**
 * @param {object} o
 * @param {NodeJS.ProcessEnv} o.env
 * @param {(scenario: string, env: object, region: string) => number} o.exec runs one scenario, returns its exit code
 * @param {string} o.platformsText content of platforms.json
 * @param {string} o.resultsDir where the sidecar is written
 * @param {() => Date} [o.now]
 */
export function runEntry({ env, exec, platformsText, resultsDir, now = () => new Date() }) {
  const refuse = (msg) => {
    console.error(`bench-run refused: ${msg}`);
    return 2;
  };
  let entry;
  try {
    entry = JSON.parse(env.BENCH_ENTRY ?? '');
  } catch {
    return refuse('BENCH_ENTRY is not JSON');
  }
  for (const f of ['platform', 'region', 'scenarios', 'phase']) {
    if (typeof entry?.[f] !== 'string' || entry[f] === '') return refuse(`BENCH_ENTRY has no ${f}`);
  }
  for (const f of ['platform', 'region']) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry[f])) return refuse(`BENCH_ENTRY ${f} is not a plain name`);
  }
  let platforms;
  try {
    platforms = parsePlatforms(platformsText);
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
  let verdict;
  try {
    verdict = checkEntry({ entry, platforms, input: { confirmBudgets: env.CONFIRM_BUDGETS } });
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
  if (!verdict.ok) return refuse(verdict.problems.join('; '));

  let target;
  try {
    target = checkTarget(env.HOSTMARK_BASE_URL ?? '');
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
  const scenarios = entry.scenarios.split(' ').filter(Boolean);
  if (!env.HOSTMARK_API_KEY) return refuse('HOSTMARK_API_KEY is empty (an environment secret)');
  if (scenarios.includes('S8') && !env.HOSTMARK_ADMIN_API_KEY) {
    return refuse('S8 needs HOSTMARK_ADMIN_API_KEY (an environment secret)');
  }

  const startedAt = now().toISOString();
  const exits = {};
  let worst = 0;
  for (const s of scenarios) {
    const extra = {
      BASE_URL: target.baseUrl,
      API_KEY: env.HOSTMARK_API_KEY,
      ...(s === 'S8' && env.HOSTMARK_ADMIN_API_KEY ? { ADMIN_API_KEY: env.HOSTMARK_ADMIN_API_KEY } : {}),
      REGION: entry.region,
      TOPOLOGY: 'single',
      VARIANT: env.HOSTMARK_VARIANT || 'portable',
      NOTE: `benchmark workflow run ${env.GITHUB_RUN_ID ?? 'local'}`,
      LOAD_ACK_REMOTE: target.host,
      ...(BUDGET_SCENARIOS.includes(s) && verdict.budgets ? { LOAD_ACK_BUDGETS: 'yes' } : {}),
      ...(s === 'S12' || s === 'S15' ? purgeEnv(env) : {}),
    };
    const code = exec(s, childEnv(env, extra), entry.region);
    exits[s] = code;
    worst = Math.max(worst, code);
  }
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(
    join(resultsDir, 'bench-entry.json'),
    `${JSON.stringify({ schema: 1, entry, runId: env.GITHUB_RUN_ID ?? null, startedAt, finishedAt: now().toISOString(), exits }, null, 2)}\n`,
  );
  return worst;
}

function purgeEnv(env) {
  if (!env.HOSTMARK_PURGE_URL) return {};
  return {
    PURGE_URL: env.HOSTMARK_PURGE_URL,
    ...(env.HOSTMARK_PURGE_METHOD ? { PURGE_METHOD: env.HOSTMARK_PURGE_METHOD } : {}),
    ...(env.HOSTMARK_PURGE_TOKEN ? { PURGE_TOKEN: env.HOSTMARK_PURGE_TOKEN } : {}),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = runEntry({
    env: process.env,
    platformsText: readFileSync(process.env.BENCH_PLATFORMS_FILE ?? join(repo, 'platforms.json'), 'utf8'),
    resultsDir: join(repo, 'load', 'results'),
    exec: (scenario, env, region) => {
      console.log(`::group::${scenario} from ${region}`);
      const r = spawnSync(process.execPath, [join(repo, 'load', 'run.mjs'), scenario, '--region', region], {
        env,
        stdio: 'inherit',
        cwd: repo,
      });
      console.log('::endgroup::');
      return r.status ?? 1;
    },
  });
  process.exit(code);
}
