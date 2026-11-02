#!/usr/bin/env node
// Turns result files (raw `load/results/*.json`, or the run.json files that bench-merge.mjs writes) into a markdown
// summary and a JSON summary.
//   node load/tools/report.mjs <path>... [--out report.md] [--json summary.json] [--title text]
// Rules, because a benchmark table is easy to misread:
//   - Results are combined only when platform, scenario, region, variant, `treeSha` and load mode (with its
//     deviations) are all equal. Anything else is a separate row, marked, and never merged into a median.
//   - A result the host pause watcher marked `invalid` is counted and shown, and is not part of any number.
//   - A skipped scenario (S15 without a purge API) is SKIPPED with its reason; it is never counted as passed.
//   - What the plan expected and did not get is NOT RUN, with the reason.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collect, mergeRun } from './bench-results.mjs';

const MAX_BYTES = 900_000; // a step summary holds 1 MiB
const SCENARIO_ORDER = (s) => Number(String(s).slice(1));

/** Markdown-safe text from a result: the target and the files are not trusted. */
export function esc(value) {
  return String(value ?? '')
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/[\\|<>`[\]*_~]/g, (c) => `\\${c}`)
    .slice(0, 300);
}

export function fmt(value, unit) {
  const v = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return unit === '' ? String(v) : `${v} ${unit}`;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const modeSig = (r) => `${r.variant ?? ''}|${r.mode}|${r.deviations.join(';')}`;
const cell = (r) => `${r.platform}|${r.scenario}|${r.region}`;

/** Groups rows that may be combined: same cell, same tree, same load mode. Returns the groups in report order. */
export function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${cell(r)}|${r.treeSha}|${modeSig(r)}`;
    if (!groups.has(key)) groups.set(key, { key, cell: cell(r), rows: [] });
    groups.get(key).rows.push(r);
  }
  const list = [...groups.values()];
  const perCell = new Map();
  for (const g of list) perCell.set(g.cell, (perCell.get(g.cell) ?? 0) + 1);
  for (const g of list) g.cellGroups = perCell.get(g.cell);
  list.sort(
    (a, b) =>
      a.rows[0].platform.localeCompare(b.rows[0].platform) ||
      SCENARIO_ORDER(a.rows[0].scenario) - SCENARIO_ORDER(b.rows[0].scenario) ||
      a.rows[0].region.localeCompare(b.rows[0].region) ||
      a.rows[0].treeSha.localeCompare(b.rows[0].treeSha) ||
      modeSig(a.rows[0]).localeCompare(modeSig(b.rows[0])),
  );
  return list;
}

/** One report row for a group. The numbers are medians of the valid results only. */
export function describeGroup(g) {
  const rows = g.rows;
  const first = rows[0];
  const by = (s) => rows.filter((r) => r.status === s);
  const valid = rows.filter((r) => r.status === 'passed' || r.status === 'failed');
  let result;
  if (valid.length === 0) {
    result = by('skipped').length > 0 ? 'SKIPPED' : by('invalid').length > 0 ? 'INVALID' : 'UNKNOWN';
  } else if (by('failed').length === 0) result = 'PASSED';
  else if (by('passed').length === 0) result = 'FAILED';
  else result = `MIXED (${by('passed').length} passed, ${by('failed').length} failed)`;

  const notes = [];
  if (by('invalid').length > 0) {
    const paused = Math.round(by('invalid').reduce((s, r) => s + r.pausedS, 0) * 10) / 10;
    notes.push(
      `${by('invalid').length} invalid result(s), host paused ${paused} s or watcher missing: left out of the numbers`,
    );
  }
  if (valid.some((r) => !r.hostWatched))
    notes.push('no host pause record: sleep during the run is not excluded');
  if (rows.some((r) => r.dirty)) notes.push('tree had uncommitted changes');
  if (rows.some((r) => r.platformMismatch))
    notes.push(`target answered as ${esc(first.xPlatform)}, not ${esc(first.platform)}`);
  if (by('skipped').length > 0) {
    const reasons = [
      ...new Set(
        by('skipped')
          .map((r) => r.skippedReason)
          .filter(Boolean),
      ),
    ];
    notes.push(`measured nothing${reasons.length > 0 ? `: ${reasons.map(esc).join('; ')}` : ''}`);
  }
  const failedThresholds = [...new Set(valid.flatMap((r) => r.failedThresholds))];
  if (failedThresholds.length > 0) notes.push(`failed: ${failedThresholds.map(esc).join('; ')}`);
  if (first.mode === 'reduced' && first.deviations.length > 0)
    notes.push(`reduced: ${first.deviations.map(esc).join(', ')}`);
  if (g.cellGroups > 1)
    notes.push(`1 of ${g.cellGroups} groups for this cell (other tree, variant or mode): not combined`);
  if (first.scenario === 'S14') notes.push('measures propagation only if a deploy happened during the run');

  const names = [];
  for (const r of valid) for (const n of r.numbers) if (!names.some((x) => x.name === n.name)) names.push(n);
  const numbers = names.map((n) => {
    const values = valid
      .map((r) => r.numbers.find((x) => x.name === n.name)?.value)
      .filter((v) => v !== undefined);
    if (new Set(values).size === 1) return `${n.name} ${fmt(values[0], n.unit)}`;
    return `${n.name} ${fmt(median(values), n.unit)} (${fmt(Math.min(...values), n.unit)} to ${fmt(Math.max(...values), n.unit)})`;
  });
  return {
    platform: first.platform,
    scenario: first.scenario,
    region: first.region,
    result,
    n: valid.length,
    total: rows.length,
    variant: first.variant ?? '',
    mode: first.mode,
    tree: first.treeSha,
    dirty: rows.some((r) => r.dirty),
    numbers,
    notes,
    files: rows.map((r) => r.file),
  };
}

/**
 * The same run given twice (by id, the newest wins) and the same measurement given twice (same cell, tree, variant,
 * status and result timestamp) count once. A rerun of a workflow has another id, so it is not caught by the first.
 */
function dedupe(allRuns) {
  const byId = new Map();
  for (const run of allRuns) {
    const old = byId.get(run.id);
    if (!old || String(run.generatedAt) >= String(old.generatedAt)) byId.set(run.id, run);
  }
  let duplicates = allRuns.length - byId.size;
  const seen = new Set();
  const rows = [];
  for (const run of byId.values()) {
    for (const r of run.rows) {
      const key = r.date
        ? `${cell(r)}|${modeSig(r)}|${r.treeSha}|${r.status}|${r.date}|${JSON.stringify(r.numbers ?? null)}`
        : '';
      if (key && seen.has(key)) duplicates++;
      else {
        if (key) seen.add(key);
        rows.push({ ...r, runId: run.id });
      }
    }
  }
  return { runs: [...byId.values()], rows, duplicates };
}

/**
 * @param {Array<object>} runs merged runs (bench-results.mergeRun)
 * @param {{title?: string, now?: Date}} [opts]
 */
export function buildReport(allRuns, opts = {}) {
  const { runs, rows, duplicates } = dedupe(allRuns);
  const groups = groupRows(rows).map(describeGroup);
  const count = (s) => rows.filter((r) => r.status === s).length;
  const missing = runs.flatMap((run) => (run.missing ?? []).map((m) => ({ ...m, runId: run.id })));
  const planSkipped = runs.flatMap((run) => (run.skipped ?? []).map((m) => ({ ...m, runId: run.id })));
  const trees = [...new Set(rows.map((r) => r.treeSha))].sort();
  const warnings = [];

  for (const run of runs) for (const p of run.problems ?? []) warnings.push(`run ${esc(run.id)}: ${esc(p)}`);
  if (trees.length > 1) {
    warnings.push(
      `MIXED TREES: results of ${trees.length} different trees (${trees.map((t) => t.slice(0, 8)).join(', ')}) are in this report. Rows of different trees are never combined.`,
    );
  }
  if (duplicates > 0) warnings.push(`${duplicates} duplicate run(s) or result(s) were counted once.`);
  const unrecognised = rows.filter((r) => r.status === 'unknown');
  if (unrecognised.length > 0) {
    const names = [...new Set(unrecognised.map((r) => esc(r.rawStatus || 'no status')))].join(', ');
    warnings.push(
      `UNRECOGNISED STATUS: ${unrecognised.length} result(s) have a status this report does not know (${names}); they are in no number.`,
    );
  }
  const noTree = rows.filter((r) => r.treeSha === 'unknown').length;
  if (noTree > 0)
    warnings.push(
      `${noTree} result(s) carry no treeSha, so the code they ran is unknown; they form their own group.`,
    );
  if (count('invalid') > 0) {
    warnings.push(
      `INVALID: ${count('invalid')} result(s) are invalid (host paused or no watcher) and are not in any number. Run them again.`,
    );
  }
  const unwatched = rows.filter(
    (r) => (r.status === 'passed' || r.status === 'failed') && !r.hostWatched,
  ).length;
  if (unwatched > 0)
    warnings.push(
      `${unwatched} result(s) have no host pause record; a sleeping host is not excluded for them.`,
    );
  const reduced = rows.filter((r) => r.mode === 'reduced').length;
  if (reduced > 0) warnings.push(`${reduced} result(s) are reduced forms, not the specified load.`);
  const dirty = rows.filter((r) => r.dirty).length;
  if (dirty > 0) warnings.push(`${dirty} result(s) were measured on a tree with uncommitted changes.`);
  if (count('skipped') > 0)
    warnings.push(
      `${count('skipped')} result(s) are SKIPPED: nothing was measured and they are not counted as passed.`,
    );
  if (missing.length > 0) warnings.push(`NOT RUN: ${missing.length} planned result(s) are missing.`);
  const unplanned = runs.filter((r) => r.complete === null).length;
  if (unplanned > 0) warnings.push(`${unplanned} run(s) have no plan, so completeness is not checked.`);
  for (const run of runs) {
    if (run.mode === 'github-hosted') {
      warnings.push(
        `run ${esc(run.id)}: GitHub-hosted runner, one vantage point of unknown location; no regional comparison.`,
      );
    }
  }

  const clean = warnings.length === 0;
  const lines = [];
  lines.push(`# ${esc(opts.title ?? 'hostmark benchmark')}`, '');
  lines.push(
    `Generated ${(opts.now ?? new Date()).toISOString()} from ${runs.length} run(s), ${rows.length} result file(s).`,
    '',
  );
  lines.push(
    `Counts: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped, ${count('invalid')} invalid, ${count('unknown')} unrecognised, ${missing.length} not run.`,
    '',
  );
  lines.push(clean ? 'No warnings.' : '## Read this first', '');
  for (const w of warnings) lines.push(`- ${w}`);
  if (!clean) lines.push('');

  for (const r of runs.flatMap((run) => run.refusedPlatforms ?? [])) {
    lines.push(`- Not benchmarked: ${esc(r.platform)} (${esc(r.reason)})`);
  }
  const platforms = [
    ...new Set([
      ...groups.map((g) => g.platform),
      ...missing.map((m) => m.platform),
      ...planSkipped.map((m) => m.platform),
    ]),
  ].sort();
  for (const platform of platforms) {
    lines.push('', `## ${esc(platform)}`, '');
    lines.push('| Scenario | Region | Result | Runs | Mode | Tree | Numbers | Notes |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    const entries = [
      ...groups
        .filter((g) => g.platform === platform)
        .map((g) => ({ ...g, sort: [SCENARIO_ORDER(g.scenario), g.region] })),
      ...missing
        .filter((m) => m.platform === platform)
        .map((m) => ({
          scenario: m.scenario,
          region: m.region,
          result: 'NOT RUN',
          n: 0,
          mode: '-',
          tree: '-',
          dirty: false,
          numbers: [],
          notes: [`${esc(m.reason)} (run ${esc(m.runId)})`],
          sort: [SCENARIO_ORDER(m.scenario), m.region],
        })),
      ...planSkipped
        .filter((m) => m.platform === platform)
        .map((m) => ({
          scenario: m.scenario,
          region: '-',
          result: 'NOT RUN',
          n: 0,
          mode: '-',
          tree: '-',
          dirty: false,
          numbers: [],
          notes: [`${esc(m.reason)} (run ${esc(m.runId)})`],
          sort: [SCENARIO_ORDER(m.scenario), '~'],
        })),
    ].sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1].localeCompare(b.sort[1]));
    for (const e of entries) {
      lines.push(
        `| ${esc(e.scenario)} | ${esc(e.region)} | ${e.result === 'NOT RUN' ? 'NOT RUN' : esc(e.result)} | ${e.n} | ${esc(e.mode)}${e.variant ? ` / ${esc(e.variant)}` : ''} | ${e.tree === '-' ? '-' : `${esc(e.tree.slice(0, 8))}${e.dirty ? ' (dirty)' : ''}`} | ${e.numbers.join('<br>') || '-'} | ${e.notes.join('<br>') || '-'} |`,
      );
    }
  }
  lines.push(
    '',
    '## How to read this',
    '',
    '- PASSED means every threshold held. FAILED means one did not. SKIPPED means the scenario could not run and measured nothing. INVALID means the host paused during the run. NOT RUN means the plan expected a result and none arrived, or the gate left the scenario out.',
    '- Runs is the number of valid results combined into the numbers; with more than one, the numbers are `median (min to max)`. Results are combined only for the same platform, scenario, region, variant, tree and load mode.',
    '- Timings from different machines or days are not comparable beyond the platform and region they belong to.',
  );

  let markdown = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(markdown) > MAX_BYTES) {
    markdown = `${markdown.slice(0, MAX_BYTES - 200)}\n\n(truncated: the full data is in the JSON summary)\n`;
  }
  const summary = {
    schema: 1,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    runs: runs.map((r) => ({ id: r.id, mode: r.mode, treeShas: r.treeShas, complete: r.complete })),
    counts: {
      passed: count('passed'),
      failed: count('failed'),
      skipped: count('skipped'),
      invalid: count('invalid'),
      unrecognised: count('unknown'),
      notRun: missing.length,
    },
    trees,
    warnings,
    groups,
    notRun: missing,
  };
  return { markdown, summary, clean };
}

/** Loads paths into runs: merged run files as they are, raw results as one ad hoc run per call. */
export function loadRuns(paths, now = new Date()) {
  const { results, runs, ignored } = collect(paths);
  const out = runs.map((r) => r.run);
  if (results.length > 0) {
    out.push(mergeRun({ id: 'files', plan: null, items: results, now, source: { paths: paths.join(' ') } }));
  }
  return { runs: out, ignored };
}

function main(argv) {
  const paths = [];
  let outFile;
  let jsonFile;
  let title;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') outFile = argv[++i];
    else if (a === '--json') jsonFile = argv[++i];
    else if (a === '--title') title = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else paths.push(a);
  }
  if (paths.length === 0)
    throw new Error('usage: report.mjs <path>... [--out report.md] [--json summary.json] [--title text]');
  const { runs, ignored } = loadRuns(paths);
  if (runs.length === 0) throw new Error('no result files found');
  const { markdown, summary } = buildReport(runs, { title });
  if (outFile) writeFileSync(outFile, markdown);
  else process.stdout.write(markdown);
  if (jsonFile) writeFileSync(jsonFile, `${JSON.stringify(summary, null, 2)}\n`);
  for (const f of ignored) console.error(`ignored (not a result): ${f}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`report failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
