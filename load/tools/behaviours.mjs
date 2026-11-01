// Local experiments for two behaviours that a benchmark cannot see from the outside but that change what its numbers
// mean (docs/plan.md E2). Both need the compose stack, read the database and the worker log, and stop, kill or start
// the worker containers, so they refuse any target but this machine.
//
//   node load/tools/behaviours.mjs abandoned-send   # files.attempts after duplicate sends (D76)
//   node load/tools/behaviours.mjs repeat-killer    # a killer consuming its siblings' attempts (D64)
//
// Both recreate the worker service with the replica count and concurrency they test (the stack's default is
// WORKER_REPLICAS=2 at WORKER_CONCURRENCY=1, D97) and put the default back when they end. Run them with
// BUILDX_CONFIG set the way the adapter README says, because compose may build. The third behaviour, the worker
// memory limit under a stream of maximum-size images (D79), is S9.
//
//   abandoned-send: CONFIGS="1x1,1x4,2x1" (replicas x concurrency), RESENDS="0,3,6", FIXTURE
//   repeat-killer:  CONCURRENCY=4 (default), KILLS=5, SIBLINGS=8
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackHost, parseBaseUrl } from '../lib/guard.js';
import { resolveKeys } from './keys.mjs';
import {
  containerState,
  dbNow,
  observeLocal,
  psql,
  queueDepth,
  serviceContainers,
} from './observe-local.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = join(here, '..');
const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:58080').replace(/\/+$/, '');
const PROJECT = process.env.HM_COMPOSE_PROJECT ?? 'hostmark';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (args, timeout = 60000) => spawnSync('docker', args, { encoding: 'utf8', timeout });
const stackDir = join(load, '..', 'adapters', 'local');

/**
 * Recreates the worker service with the given replicas and concurrency; without arguments it returns to the compose
 * file's defaults. Waits until every replica runs and its consumer has had time to connect.
 */
async function setWorkers({ replicas, concurrency } = {}) {
  const env = { ...process.env };
  delete env.WORKER_REPLICAS;
  delete env.WORKER_CONCURRENCY;
  if (replicas !== undefined) env.WORKER_REPLICAS = String(replicas);
  if (concurrency !== undefined) env.WORKER_CONCURRENCY = String(concurrency);
  const r = spawnSync('docker', ['compose', 'up', '-d', '--no-deps', 'worker'], {
    cwd: stackDir,
    env,
    encoding: 'utf8',
    timeout: 300000,
  });
  if (r.status !== 0) throw new Error(`docker compose up worker failed: ${r.stderr || r.stdout}`);
  await sleep(8000);
}

const workerNames = () => serviceContainers('worker');
const startWorkers = () => {
  const names = workerNames();
  if (names.length > 0) docker(['start', ...names]);
};
const allRunning = () => workerNames().every((n) => containerState(n)?.running === true);

if (!isLoopbackHost(parseBaseUrl(BASE_URL).host)) {
  console.error('behaviours.mjs stops and kills containers: it only runs against a loopback BASE_URL');
  process.exit(2);
}
const keys = resolveKeys(process.env, true);
if (!keys.API_KEY || !keys.ADMIN_API_KEY) {
  console.error('API_KEY and ADMIN_API_KEY are needed (or adapters/local/.env)');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(load, 'fixtures', 'manifest.json'), 'utf8'));
const fixture = (name) => ({ name, meta: manifest[name], bytes: readFileSync(join(load, 'fixtures', name)) });
let counter = 0;
const runId = Date.now().toString(36).slice(-6);

/** The 16 byte slot gets a token that is unique per upload, so the worker's deduplication (D54) never applies. */
function unique(fx) {
  const copy = Buffer.from(fx.bytes);
  const token = `${runId}b${String(counter++).padStart(9, '0')}`.slice(0, 16);
  copy.write(token, fx.meta.slotOffset, 'latin1');
  return copy;
}

async function upload(fx, { admin = false, chaos } = {}) {
  const key = admin ? keys.ADMIN_API_KEY : keys.API_KEY;
  const body = unique(fx);
  const created = await fetch(`${BASE_URL}/api/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/jpeg', bytes: body.length }),
  });
  if (created.status !== 201) throw new Error(`create upload answered ${created.status}`);
  const { fileId, uploadUrl, uploadHeaders } = await created.json();
  const put = await fetch(uploadUrl, { method: 'PUT', headers: uploadHeaders, body });
  if (!put.ok) throw new Error(`PUT answered ${put.status}`);
  const complete = await fetch(`${BASE_URL}/api/uploads/${fileId}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, ...(chaos ? { 'x-chaos': chaos } : {}) },
  });
  if (complete.status !== 200) throw new Error(`complete answered ${complete.status}`);
  return fileId;
}

const rows = (ids) =>
  JSON.parse(
    psql(
      `select coalesce(json_agg(row_to_json(t) order by t.created_at), '[]') from (
         select id, status, attempts, last_error, queued_at, ready_at, created_at from files
         where id in (${ids.map((i) => `'${i}'`).join(',')})) t`,
    ) || '[]',
  );

/** Counts what the worker logged per file since `since`; the log is the independent source for "ran N times". */
function workerLog(since, ids) {
  const text = workerNames()
    .map((n) => docker(['logs', '--since', since, n], 60000))
    .map((out) => `${out.stdout}${out.stderr}`)
    .join('\n');
  const per = Object.fromEntries(ids.map((id) => [id, {}]));
  for (const line of text.split('\n')) {
    const id = ids.find((i) => line.includes(i));
    if (!id) continue;
    try {
      const msg = JSON.parse(line).msg;
      per[id][msg] = (per[id][msg] ?? 0) + 1;
    } catch {
      // not a JSON log line
    }
  }
  return per;
}

async function waitTerminal(ids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let current = rows(ids);
  while (Date.now() < deadline && current.some((r) => !['ready', 'failed'].includes(r.status))) {
    await sleep(3000);
    current = rows(ids);
  }
  return current;
}

const runJob = (job) => {
  const r = docker(['exec', `${PROJECT}-scheduler-1`, 'node', 'dist/run-job.js', job], 60000);
  return `${r.stdout}${r.stderr}`.trim().split('\n').pop();
};

function save(name, result) {
  const dir = join(load, 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${name}: ${file}`);
  return file;
}

async function drainQueue() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const q = queueDepth();
    if (q.wait === 0 && q.active === 0 && q.delayed === 0) return;
    await sleep(2000);
  }
}

const gitHead = () =>
  spawnSync('git', ['--no-optional-locks', 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    cwd: load,
  }).stdout.trim();

// --- abandoned send ---------------------------------------------------------------------------------------------
// With the workers stopped, a file waits in the queue. `requeue-stuck` re-sends every row whose last activity is older
// than ten minutes, so the same file gets one more job per run (D76). The rows are aged in SQL instead of waiting ten
// minutes per run. When the workers start, the jobs of one file overlap: each start claims the row and adds one to
// `files.attempts`, whether or not the earlier start is still working. Only the worker log says how often it ran.
// Each case is one file alone in the queue: with several files the jobs interleave first in, first out, and the
// duplicates of a file reach it after it is done, which hides the over-count. The cases run per replica count and
// concurrency, because the over-count needs overlapping jobs: at one process and concurrency 1 they cannot overlap.
async function abandonedSend() {
  const resends = (process.env.RESENDS ?? '0,3,6').split(',').map(Number);
  const configs = (process.env.CONFIGS ?? '1x1,1x4,2x1').split(',').map((c) => {
    const [replicas, concurrency] = c.split('x').map(Number);
    return { replicas, concurrency };
  });
  const fx = fixture(process.env.FIXTURE ?? 'jpeg-50mp.jpg');
  const cases = [];
  try {
    for (const config of configs) {
      await setWorkers(config);
      for (const n of resends) {
        await drainQueue();
        docker(['stop', '-t', '5', ...workerNames()]);
        const since = dbNow().replace(/\.\d+Z$/, 'Z');
        const id = await upload(fx);
        const rounds = [];
        for (let round = 1; round <= n; round++) {
          psql(`update files set last_activity_at = now() - interval '11 minutes' where id = '${id}'`);
          rounds.push({ round, output: runJob('requeue-stuck'), queue: queueDepth() });
        }
        const queueBeforeWorkers = queueDepth();
        const startedAt = new Date().toISOString();
        startWorkers();
        const final = await waitTerminal([id], 180000);
        await sleep(8000); // the duplicates of a ready file are acked a moment later
        const log = workerLog(startedAt, [id])[id];
        const row = rows([id])[0];
        const processed = log['process_image done'] ?? 0;
        cases.push({
          ...config,
          resends: n,
          jobsInQueue: queueBeforeWorkers.wait + queueBeforeWorkers.delayed,
          id,
          since,
          rounds,
          status: row?.status,
          attempts: row?.attempts,
          processedToCompletion: processed,
          attemptsExceedProcessings: (row?.attempts ?? 0) > processed,
          workerLog: log,
          allTerminal: final.every((r) => ['ready', 'failed'].includes(r.status)),
        });
        console.log(
          `abandoned-send ${config.replicas}x${config.concurrency} resends ${n}: attempts ${row?.attempts}, processed ${processed}, ${row?.status}`,
        );
      }
    }
    return save('B-abandoned-send', {
      behaviour: 'abandoned-send (D76)',
      date: new Date().toISOString(),
      commit: gitHead(),
      setup: { fixture: fx.name, configs: 'replicas x concurrency', resends },
      cases,
    });
  } finally {
    await setWorkers();
  }
}

// --- repeat killer ----------------------------------------------------------------------------------------------
// One file with `x-chaos: crash` kills the worker on its first start (the genuine path, D65). `chaos` crashes only on
// the first attempt, so the further kills of a poison input are simulated by `docker kill` while siblings are being
// processed. Jobs in flight at a kill lose a start each time; jobs still waiting do not. 50 MP JPEGs keep a job in
// flight for seconds. The loss needs more than one job in flight in the killed process, so it needs a concurrency
// above 1: at concurrency 1 a process holds only the job it is working on, and another replica is not affected.
// The tool runs one replica at CONCURRENCY (default 4).
async function repeatKiller() {
  const kills = Number(process.env.KILLS ?? 5);
  const siblingCount = Number(process.env.SIBLINGS ?? 8);
  const concurrency = Number(process.env.CONCURRENCY ?? 4);
  await setWorkers({ replicas: 1, concurrency });
  try {
    await drainQueue();
    const big = fixture('jpeg-50mp.jpg');
    const tiny = fixture('jpeg-tiny.jpg');
    const observer = await observeLocal.start({ id: 'repeat-killer' });
    const since = new Date().toISOString();
    const worker = () => containerState(workerNames()[0]);
    // Read before the killer is sent: the crash can come within a second, before the siblings are uploaded.
    let restartsSeen = worker()?.restarts ?? 0;
    const killer = await upload(tiny, { admin: true, chaos: 'crash' });
    const siblings = [];
    for (let i = 0; i < siblingCount; i++) siblings.push(await upload(big));
    const all = [killer, ...siblings];
    const events = [];
    const mark = (what, extra = {}) => events.push({ at: new Date().toISOString(), what, ...extra });
    const siblingStarts = () => rows(siblings).reduce((n, r) => n + r.attempts, 0);
    const inFlight = () =>
      rows(siblings)
        .filter((r) => r.status === 'processing')
        .map((r) => r.id);

    // Kill 1 is the killer's own crash: wait for the worker to exit by itself.
    const waitForRestart = async (label, timeoutMs = 240000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const s = worker();
        if (s?.running && s.restarts > restartsSeen) {
          restartsSeen = s.restarts;
          mark(label, { restarts: s.restarts, attempts: rows(all).map((r) => r.attempts) });
          return true;
        }
        await sleep(2000);
      }
      return false;
    };
    const crashed = await waitForRestart('worker exited by x-chaos crash');
    let startsAtKill = siblingStarts();
    const perKill = [];
    for (let k = 2; crashed && k <= kills; k++) {
      // Wait until the stalled jobs are taken back (lock 60 s, check 30 s) and a sibling is in flight again.
      const deadline = Date.now() + 240000;
      let target = [];
      while (Date.now() < deadline && target.length === 0) {
        await sleep(1000);
        // Rows of killed jobs stay `processing` until the stalled check; only a start after the last kill counts.
        target = siblingStarts() > startsAtKill ? inFlight() : [];
        const open = rows(all).filter((r) => !['ready', 'failed'].includes(r.status));
        if (open.length === 0) break;
      }
      if (target.length === 0) {
        mark('no sibling left in flight, stopping the kills');
        break;
      }
      await sleep(1500);
      const active = queueDepth().active; // jobs the process holds: at most the concurrency
      const before = siblingStarts();
      docker(['kill', workerNames()[0]]);
      mark(`docker kill ${k} of ${kills}`, {
        processingRows: target.length,
        activeJobs: active,
        attempts: rows(all).map((r) => r.attempts),
      });
      // Docker does not apply the restart policy to a container that was killed by hand, so start it the way a
      // supervisor would. A crash (kill 1) is restarted by the policy.
      await sleep(2000);
      docker(['start', workerNames()[0]]);
      mark(`worker started after kill ${k}`);
      startsAtKill = siblingStarts();
      perKill.push({ kill: k, activeJobsAtKill: active, siblingStartsBefore: before });
    }
    const final = await waitTerminal(all, 12 * 60000);
    await sleep(5000);
    const usage = await observer.stop();
    const log = workerLog(since, all);
    const dlq = queueDepth().dlq;
    const finalRows = rows(all);
    const siblingRows = finalRows.filter((r) => r.id !== killer);
    return save('B-repeat-killer', {
      behaviour: 'repeat-killer (D64)',
      date: new Date().toISOString(),
      commit: gitHead(),
      since,
      setup: {
        kills,
        siblings: siblingCount,
        siblingFixture: big.name,
        replicas: 1,
        workerConcurrency: concurrency,
        killsAre: 'first x-chaos crash, then docker kill while a sibling was processing',
      },
      events,
      perKill,
      files: finalRows.map((r) => ({
        role: r.id === killer ? 'killer' : 'sibling',
        id: r.id,
        status: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        workerLog: log[r.id],
      })),
      maxSiblingAttempts: Math.max(...siblingRows.map((r) => r.attempts)),
      siblingsFailed: siblingRows.filter((r) => r.status === 'failed').length,
      dlqDepth: dlq,
      allTerminal: final.every((r) => ['ready', 'failed'].includes(r.status)),
      observed: { worker: usage?.worker, window: usage?.db },
    });
  } finally {
    await setWorkers();
  }
}

const which = process.argv[2];
try {
  if (which === 'abandoned-send') await abandonedSend();
  else if (which === 'repeat-killer') await repeatKiller();
  else {
    console.error('usage: behaviours.mjs abandoned-send | repeat-killer');
    process.exitCode = 2;
  }
} finally {
  if (!allRunning()) startWorkers();
}
