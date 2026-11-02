// The gate and the plan of the benchmark workflow (.github/workflows/benchmark.yml, D170 to D179).
// Pure functions with no I/O, so the logic that decides where load may go is tested on its own. The workflow
// plan job calls it before any secret, environment or runner of a platform is touched; bench-run.mjs calls the same
// checks again just before the first request.

export const SCENARIO_IDS = Array.from({ length: 15 }, (_, i) => `S${i + 1}`);

/** One load generator is enough: these run from the primary region, one platform at a time (job `core`). */
export const CORE_SCENARIOS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'];

/** The spec runs these from every region in parallel (job `reach`). */
export const REACH_SCENARIOS = ['S10', 'S11', 'S12', 'S13', 'S14', 'S15'];

/** Can cost real money on a metered platform: need an explicit budget confirmation for that platform (spec, D90). */
export const BUDGET_SCENARIOS = ['S5', 'S6'];

/** What a run without a `scenarios` input does. S7 and S14 are left out on purpose, see EXPLICIT_ONLY. */
export const STANDARD_SCENARIOS = [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S8',
  'S9',
  'S10',
  'S11',
  'S12',
  'S13',
  'S15',
];

/** Scenarios that run only when named, with the reason that is shown when they are not selected. */
export const EXPLICIT_ONLY = {
  S7: 'the specified form waits 13 hours; select it on purpose, on a self-hosted runner',
  S14: 'it needs a deploy during the run (EXPECT_VERSION); without one it only proves that x-version is served',
};

const NAME = /^[a-z][a-z0-9-]*$/;
const SCENARIO_LIST = /^S(?:[1-9]|1[0-5])(?:,S(?:[1-9]|1[0-5]))*$/;
const NAME_LIST = /^[a-z][a-z0-9-]*(?:,[a-z][a-z0-9-]*)*$/;

/** The longest a hosted runner may take (6 h) and the budget for everything but S7. */
const TIMEOUT_MINUTES = 150;
const TIMEOUT_SLOW_MINUTES = 960;

/**
 * Reads platforms.json as text. Fails closed: anything that is not exactly the documented shape throws, and only a
 * JSON `true` counts as enabled (the string "true" does not).
 */
export function parsePlatforms(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`platforms.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (
    data === null ||
    typeof data !== 'object' ||
    !Array.isArray(data.platforms) ||
    data.platforms.length === 0
  ) {
    throw new Error('platforms.json must be { "platforms": [ ... ] } with at least one entry');
  }
  const seen = new Set();
  return data.platforms.map((p, i) => {
    const where = `platforms[${i}]`;
    if (p === null || typeof p !== 'object') throw new Error(`${where} is not an object`);
    if (typeof p.name !== 'string' || !NAME.test(p.name))
      throw new Error(`${where}.name is not a platform name`);
    if (seen.has(p.name)) throw new Error(`${where}.name ${p.name} is listed twice`);
    seen.add(p.name);
    if (typeof p.enabled !== 'boolean')
      throw new Error(`${where}.enabled of ${p.name} must be true or false`);
    if (p.status !== 'emulated' && p.status !== 'deployed') {
      throw new Error(`${where}.status of ${p.name} must be "emulated" or "deployed"`);
    }
    return { name: p.name, enabled: p.enabled, status: p.status };
  });
}

/** regions.json: a primary region and at least one region, each with the runner label that serves it. */
export function parseRegions(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.regions) || data.regions.length === 0)
    throw new Error('regions.json lists no region');
  const regions = data.regions.map((r, i) => {
    if (typeof r?.name !== 'string' || !NAME.test(r.name))
      throw new Error(`regions[${i}].name is not a region name`);
    if (typeof r.label !== 'string' || !NAME.test(r.label))
      throw new Error(`regions[${i}].label is not a label`);
    return { name: r.name, label: r.label, location: String(r.location ?? '') };
  });
  if (new Set(regions.map((r) => r.name)).size !== regions.length)
    throw new Error('a region is listed twice');
  if (!regions.some((r) => r.name === data.primary))
    throw new Error('regions.json: primary is not a listed region');
  return { primary: data.primary, regions };
}

/**
 * Which platforms may receive load. Each one that does not is returned with the reason, so the report can say why
 * it was left out. `local` is never benchmarked from Actions: its stack runs on the owner's machine.
 */
export function eligiblePlatforms(platforms) {
  const eligible = [];
  const refused = [];
  for (const p of platforms) {
    if (!p.enabled) refused.push({ platform: p.name, reason: 'disabled in platforms.json' });
    else if (p.name === 'local')
      refused.push({ platform: p.name, reason: 'the local stack is not reachable from a runner' });
    else if (p.status !== 'deployed') {
      refused.push({
        platform: p.name,
        reason: `enabled but status is "${p.status}": nothing is deployed to measure`,
      });
    } else eligible.push(p.name);
  }
  return { eligible, refused };
}

function splitList(raw, what, pattern) {
  const text = (raw ?? '').trim().replaceAll(/\s+/g, '');
  if (text === '') return [];
  if (!pattern.test(text))
    throw new Error(`${what} is not a comma separated list in the expected form: ${JSON.stringify(raw)}`);
  return [...new Set(text.split(','))];
}

/**
 * Turns the trigger into a plan. `input` holds the strings of the dispatch inputs (or the repository variables for a
 * scheduled run), `platforms` and `regions` are the parsed files. It never reads the environment itself.
 *
 * - `input.platforms`: `all` or a comma list. A named platform that is not eligible is an error, not a skip.
 * - `input.scenarios`: empty means STANDARD_SCENARIOS; naming a scenario overrides EXPLICIT_ONLY.
 * - `input.confirmBudgets`: comma list of platforms whose budgets and billing alerts the owner has set. Empty means
 *   nobody: S5 and S6 are dropped for everyone. There is no default and no "all".
 * - `input.runnerMode`: `regional` (self-hosted runners labelled per region) or `github-hosted` (one vantage point
 *   of unknown location). Anything else, including empty, is refused when a platform would run; with nothing to run
 *   the plan is empty and the mode is not looked at.
 */
export function buildPlan({ platforms, regions, input, now = new Date() }) {
  const mode = (input.runnerMode ?? '').trim();
  const { eligible, refused } = eligiblePlatforms(platforms);
  const known = new Set(platforms.map((p) => p.name));

  const asked = (input.platforms ?? '').trim();
  let chosen;
  if (asked === '' || asked === 'all') chosen = eligible;
  else {
    const named = splitList(asked, 'platforms', NAME_LIST);
    for (const n of named) {
      if (!known.has(n)) throw new Error(`platform ${n} is not in platforms.json`);
      if (!eligible.includes(n)) {
        const why = refused.find((r) => r.platform === n)?.reason ?? 'not eligible';
        throw new Error(`platform ${n} was named but may not receive load: ${why}`);
      }
    }
    chosen = named;
  }

  const confirmed = splitList(input.confirmBudgets, 'confirm_budgets', NAME_LIST);
  for (const n of confirmed) {
    if (!known.has(n)) throw new Error(`confirm_budgets names ${n}, which is not in platforms.json`);
  }
  // The mode is checked only when there is something to run, so a scheduled run on a repository where nothing is
  // enabled ends green and quiet instead of failing every month before the owner has configured anything.
  if (chosen.length > 0 && mode !== 'regional' && mode !== 'github-hosted') {
    throw new Error(
      `runner mode must be "regional" or "github-hosted" (got ${JSON.stringify(input.runnerMode ?? '')}): it is never defaulted`,
    );
  }

  const explicit = splitList(input.scenarios, 'scenarios', SCENARIO_LIST);
  let scenarios = explicit.length > 0 ? explicit : STANDARD_SCENARIOS;
  const notes = [];
  if (mode === 'github-hosted' && scenarios.includes('S7')) {
    if (explicit.length > 0)
      throw new Error('S7 needs more than the 6 hours a GitHub-hosted job may take: use regional runners');
    scenarios = scenarios.filter((s) => s !== 'S7');
  }
  scenarios = SCENARIO_IDS.filter((s) => scenarios.includes(s));

  const regionList =
    mode === 'regional'
      ? regions.regions
      : [{ name: 'github-hosted', label: '', location: 'unknown: GitHub chooses the data centre' }];
  const primary = mode === 'regional' ? regions.primary : 'github-hosted';
  const runsOn = (r) =>
    JSON.stringify(mode === 'regional' ? ['self-hosted', 'hostmark-bench', r.label] : ['ubuntu-latest']);

  const expected = [];
  const skipped = [];
  const core = [];
  const reach = [];
  for (const platform of chosen) {
    const budgets = confirmed.includes(platform);
    const run = [];
    for (const s of scenarios) {
      if (BUDGET_SCENARIOS.includes(s) && !budgets) {
        skipped.push({
          platform,
          scenario: s,
          reason: `budgets and billing alerts of ${platform} are not confirmed`,
        });
        continue;
      }
      run.push(s);
    }
    for (const s of SCENARIO_IDS) {
      if (scenarios.includes(s)) continue;
      skipped.push({ platform, scenario: s, reason: EXPLICIT_ONLY[s] ?? 'not selected' });
    }
    const coreRun = run.filter((s) => CORE_SCENARIOS.includes(s));
    const reachRun = run.filter((s) => REACH_SCENARIOS.includes(s));
    const entry = (region, list, phase) => ({
      name: `${phase} ${platform} ${region.name}`,
      phase,
      platform,
      region: region.name,
      scenarios: list.join(' '),
      runs_on: runsOn(region),
      timeout: list.includes('S7') ? TIMEOUT_SLOW_MINUTES : TIMEOUT_MINUTES,
      budgets,
    });
    if (coreRun.length > 0)
      core.push(
        entry(
          regionList.find((r) => r.name === primary),
          coreRun,
          'core',
        ),
      );
    if (reachRun.length > 0) for (const r of regionList) reach.push(entry(r, reachRun, 'reach'));
    for (const s of coreRun) expected.push({ platform, scenario: s, region: primary });
    for (const s of reachRun)
      for (const r of regionList) expected.push({ platform, scenario: s, region: r.name });
  }

  if (mode === 'github-hosted') {
    notes.push(
      'github-hosted: every scenario runs from one vantage point that GitHub chooses and does not document, so no regional comparison exists (D171).',
    );
  }
  if (chosen.length === 0) notes.push('no platform is enabled and deployed: nothing runs');
  return {
    schema: 1,
    generatedAt: now.toISOString(),
    mode: chosen.length > 0 ? mode : null,
    primary: chosen.length > 0 ? primary : null,
    regions: chosen.length > 0 ? regionList.map((r) => r.name) : [],
    platforms: chosen.map((name) => ({ name, budgetsConfirmed: confirmed.includes(name) })),
    refusedPlatforms: refused,
    scenarios,
    expected,
    skipped,
    notes,
    core: { include: core },
    reach: { include: reach },
    count: core.length + reach.length,
  };
}

/** A runnable target: https only (a benchmark over http measures nothing a user sees), a real host, no credentials. */
export function checkTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`the base URL is not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'https:') throw new Error('the base URL must be https');
  if (url.username !== '' || url.password !== '') throw new Error('the base URL must not carry credentials');
  if (url.search !== '' || url.hash !== '')
    throw new Error('the base URL must not carry a query or a fragment');
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) ||
    host === '[::1]' ||
    host === '0.0.0.0'
  ) {
    throw new Error(`the base URL ${host} is loopback: a runner would measure itself`);
  }
  return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, host: url.host };
}

/**
 * The check that runs on the load job, immediately before k6. It re-reads the same facts as the plan, so a matrix
 * entry that was edited or replayed cannot reach a platform that is disabled now.
 */
export function checkEntry({ entry, platforms, input = {} }) {
  const problems = [];
  const p = platforms.find((x) => x.name === entry.platform);
  if (!p) problems.push(`platform ${entry.platform} is not in platforms.json`);
  else {
    const { eligible, refused } = eligiblePlatforms(platforms);
    if (!eligible.includes(p.name))
      problems.push(refused.find((r) => r.platform === p.name)?.reason ?? 'not eligible');
  }
  const list = (entry.scenarios ?? '').split(' ').filter(Boolean);
  if (list.length === 0) problems.push('the entry lists no scenario');
  for (const s of list) if (!SCENARIO_IDS.includes(s)) problems.push(`${s} is not a scenario`);
  const confirmed = splitList(input.confirmBudgets, 'confirm_budgets', NAME_LIST);
  const budgets = confirmed.includes(entry.platform);
  if (entry.budgets !== budgets) problems.push('the entry and the confirmation disagree about the budgets');
  for (const s of list) {
    if (BUDGET_SCENARIOS.includes(s) && !budgets)
      problems.push(`${s} needs the budgets of ${entry.platform} confirmed`);
  }
  return { ok: problems.length === 0, problems, budgets };
}
