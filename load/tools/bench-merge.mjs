#!/usr/bin/env node
// Merges the result files of one workflow run (all regions, all platforms) with its plan into one run.json.
//   node load/tools/bench-merge.mjs --results <dir>... [--plan plan.json] --id <run id> --out run.json [--source k=v]...
// Results of different trees, or of a host that paused, stay in the file as they are, marked; nothing is averaged.
import { readFileSync, writeFileSync } from 'node:fs';
import { collect, mergeRun } from './bench-results.mjs';

function parse(argv) {
  const out = { results: [], source: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results') out.results.push(argv[++i]);
    else if (a === '--plan') out.plan = argv[++i];
    else if (a === '--id') out.id = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--source') {
      const [k, ...v] = (argv[++i] ?? '').split('=');
      if (k) out.source[k] = v.join('=');
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!out.id || !out.out || out.results.length === 0)
    throw new Error('--id, --out and --results are required');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(out.id))
    throw new Error('--id may only hold letters, digits, dot, dash and underscore');
  return out;
}

try {
  const args = parse(process.argv.slice(2));
  const plan = args.plan ? JSON.parse(readFileSync(args.plan, 'utf8')) : null;
  const { results, runs, ignored } = collect(args.results);
  if (runs.length > 0)
    throw new Error('a merged run.json was found among the results; merge raw results only');
  const run = mergeRun({ id: args.id, plan, items: results, source: args.source });
  writeFileSync(args.out, `${JSON.stringify(run, null, 2)}\n`);
  console.log(
    `merged ${run.rows.length} results into ${args.out} (${run.treeShas.length} tree(s), ${run.missing.length} missing)`,
  );
  for (const p of run.problems) console.log(`  problem: ${p}`);
  for (const f of ignored) console.log(`  ignored: ${f}`);
} catch (err) {
  console.error(`merge failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
