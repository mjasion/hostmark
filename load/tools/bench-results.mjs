// Reading and merging result files (D90, D98) for the benchmark report. No I/O except `collect`, which reads a
// directory tree. A result keeps its own identity here: platform, region, `treeSha`, mode, validity. Nothing is
// averaged in this file; report.mjs groups rows and says when it does.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const RUN_KIND = 'hostmark-benchmark-run';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The numbers that characterise a scenario, as `{name, unit, value}`. Order is the order of the report columns. */
export function primaryNumbers(result) {
  const m = result.metrics ?? {};
  const out = [];
  const add = (name, unit, value) => {
    const v = num(value);
    if (v !== null) out.push({ name, unit, value: v });
  };
  const trend = (key, fields, label, unit) => {
    for (const f of fields) add(`${label} ${f}`, unit, m[key]?.[f]);
  };
  switch (result.scenario) {
    case 'S4':
      trend('upload_to_ready_ms', ['p50', 'p95'], 'upload to ready', 'ms');
      add('upload ok', '', m.upload_ok?.rate);
      break;
    case 'S5':
      add('drain', 's', m.drain_seconds?.value);
      add('uploads ok', '', m.upload_ok?.rate);
      add('drained', '', m.drained?.rate);
      break;
    case 'S7':
      trend('cold_first_request_ms', ['p50', 'p95'], 'cold first request', 'ms');
      trend('cold_first_db_request_ms', ['p50'], 'cold first db request', 'ms');
      break;
    case 'S8':
      add('cpu runs passed', '', m.cpu_passed?.count);
      add('cpu runs max elapsed', 'ms', m.cpu_elapsed_ms?.max);
      break;
    case 'S9':
      trend('upload_to_ready_ms{phase:png}', ['p95'], 'png to ready', 'ms');
      trend('upload_to_ready_ms{phase:stream}', ['p95'], 'stream to ready', 'ms');
      break;
    case 'S10':
      add('ttfb p50', 'ms', m.ttfb_ms?.med);
      add('lcp p50', 'ms', m.lcp_ms?.med);
      add('transfer', 'B', m.transfer_bytes?.med);
      break;
    case 'S13':
      add('flow p50', 'ms', m.flow_ms?.med);
      add('flow p95', 'ms', m.flow_ms?.p95);
      add('inp max', 'ms', m.inp_ms?.max);
      break;
    case 'S14':
      add('time to new version', 's', m.time_to_expected_version_s?.value);
      break;
    default:
      for (const f of ['p50', 'p95', 'p99']) add(f, 'ms', result.headline?.[f]);
      add('failed', '', result.headline?.failedRate);
  }
  return out;
}

/** The platform a result without a sidecar belongs to: the target's own `x-platform` without its variant suffix. */
export function platformFromHeader(xPlatform) {
  return String(xPlatform ?? 'unknown').replace(/-(portable|idiomatic)$/, '') || 'unknown';
}

/** One result file as a flat row. `sidecar` is bench-entry.json from the same directory, when there is one. */
export function summarise(result, file, sidecar = null) {
  const status = ['passed', 'failed', 'skipped', 'invalid'].includes(result.status)
    ? result.status
    : 'unknown';
  const platform = sidecar?.entry?.platform ?? platformFromHeader(result['x-platform']);
  const xPlatform = typeof result['x-platform'] === 'string' ? result['x-platform'] : '';
  // The variant is the VARIANT label of the run; a result without it still says it in the target's x-platform.
  const variant = String(result.labels?.variant || /-(portable|idiomatic)$/.exec(xPlatform)?.[1] || '');
  const deviations = (result.load?.deviations ?? []).map((d) => `${d.param}=${d.value} (spec ${d.spec})`);
  return {
    platform,
    scenario: result.scenario,
    region: result.labels?.region || 'unlabelled',
    file: basename(file),
    date: result.date ?? result.startedAt ?? '',
    status,
    rawStatus: status === 'unknown' ? String(result.status ?? '') : '',
    mode: result.load?.mode ?? 'unknown',
    deviations,
    treeSha: typeof result.treeSha === 'string' && result.treeSha !== '' ? result.treeSha : 'unknown',
    dirty: result.dirty === true,
    commit: result.commit ?? '',
    variant,
    xPlatform,
    xVersion: result['x-version'] ?? '',
    // A target that answers as another platform was not the one that was meant (sidecar known) or is mislabelled.
    platformMismatch: sidecar ? !(xPlatform === platform || xPlatform.startsWith(`${platform}-`)) : false,
    hostWatched: result.host?.watcher === 'ok',
    pausedS: num(result.host?.pausedS) ?? 0,
    skippedReason: result.skipped?.reason ?? '',
    failedThresholds: Array.isArray(result.failedThresholds) ? result.failedThresholds : [],
    expectedVersion: result.expectedVersion ?? null,
    numbers: primaryNumbers(result),
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const isResult = (j) =>
  j && typeof j === 'object' && /^S(?:[1-9]|1[0-5])$/.test(j.scenario ?? '') && 'status' in j;
const isRun = (j) => j && typeof j === 'object' && j.kind === RUN_KIND && Array.isArray(j.rows);

/**
 * Reads files and directories (two levels deep, so `results/<artifact>/*.json` works). Returns raw results with their
 * sidecar, merged runs, and the files that were neither (behaviour records, unreadable JSON), so nothing is dropped
 * without a trace.
 */
export function collect(paths) {
  const results = [];
  const runs = [];
  const ignored = [];
  const visit = (path, depth) => {
    const st = statSync(path);
    if (st.isDirectory()) {
      if (depth > 2) return;
      const names = readdirSync(path).sort();
      const sidecar = names.includes('bench-entry.json') ? readJson(join(path, 'bench-entry.json')) : null;
      for (const n of names) {
        const child = join(path, n);
        if (statSync(child).isDirectory()) visit(child, depth + 1);
        else if (n.endsWith('.json') && n !== 'bench-entry.json') {
          const j = readJson(child);
          if (isRun(j)) runs.push({ file: child, run: j });
          else if (isResult(j)) results.push({ file: child, result: j, sidecar });
          else ignored.push(child);
        }
      }
      return;
    }
    const j = readJson(path);
    if (isRun(j)) runs.push({ file: path, run: j });
    else if (isResult(j)) results.push({ file: path, result: j, sidecar: null });
    else ignored.push(path);
  };
  for (const p of paths) visit(p, 0);
  return { results, runs, ignored };
}

/**
 * One workflow run (or one ad hoc set of files) as a single record. It keeps every row, says which trees it holds,
 * and lists what the plan expected and did not get. `plan` is plan.json or null.
 */
export function mergeRun({ id, plan = null, items, now = new Date(), source = {} }) {
  const rows = items.map((i) => summarise(i.result, i.file, i.sidecar ?? null));
  const problems = [];
  const treeShas = [...new Set(rows.map((r) => r.treeSha))].sort();
  for (const r of rows) {
    if (r.platformMismatch) {
      problems.push(
        `${r.scenario} ${r.region}: the target answered as "${r.xPlatform}", the planned platform is ${r.platform}`,
      );
    }
  }
  const missing = [];
  if (plan) {
    for (const e of plan.expected ?? []) {
      const have = rows.filter(
        (r) => r.platform === e.platform && r.scenario === e.scenario && r.region === e.region,
      );
      if (have.some((r) => r.status !== 'invalid' && r.status !== 'unknown')) continue;
      missing.push({
        ...e,
        reason: have.length > 0 ? `only ${have.map((r) => r.status).join(', ')} results` : 'no result file',
      });
    }
  }
  return {
    schema: 1,
    kind: RUN_KIND,
    id,
    generatedAt: now.toISOString(),
    source,
    mode: plan?.mode ?? null,
    expectedRegions: plan?.regions ?? null,
    treeShas,
    consistentTree: treeShas.length <= 1,
    complete: plan ? missing.length === 0 : null,
    missing,
    skipped: plan?.skipped ?? [],
    refusedPlatforms: plan?.refusedPlatforms ?? [],
    notes: plan?.notes ?? [],
    problems,
    rows,
  };
}
