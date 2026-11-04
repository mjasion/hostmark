#!/usr/bin/env node
// Entry point: runs one load scenario or all of them.
//   node load/run.mjs <S1..S15 | all> [--short] [--region NAME] [--list] [--dry-run] [--no-observe] [--no-idle-wait]
// k6 scenarios run in the grafana/k6 image, Playwright scenarios in the Playwright image. Configuration is by
// environment variable only (see README.md). Nothing here names a platform.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGuard, parseBaseUrl } from './lib/guard.js';
import { resolveKeys } from './tools/keys.mjs';
import { observeLocal, queueDepth } from './tools/observe-local.mjs';
import { headTree, workingTree } from './tools/tree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const K6_IMAGE = process.env.K6_IMAGE ?? 'grafana/k6:2.3.0';
const PW_IMAGE = process.env.PLAYWRIGHT_IMAGE ?? 'mcr.microsoft.com/playwright:v1.64.1-noble';
const FWD_IMAGE = process.env.FORWARD_IMAGE ?? 'node:22.23.4-slim';

/** Order is the order of `all`. `admin` scenarios need ADMIN_API_KEY. */
export const SCENARIOS = {
  S1: { kind: 'k6', file: 's01-health.js', title: 'Baseline GET /api/health' },
  S2: { kind: 'k6', file: 's02-read.js', title: 'Read GET /api/files/:id' },
  S3: { kind: 'k6', file: 's03-list.js', title: 'List GET /api/files?limit=50' },
  S4: {
    kind: 'k6',
    file: 's04-upload.js',
    title: 'End-to-end upload, 1 MB JPEG',
    uploads: true,
    freshWorkers: true,
  },
  S5: { kind: 'k6', file: 's05-burst.js', title: 'Upload burst', uploads: true, freshWorkers: true },
  S6: { kind: 'k6', file: 's06-spike.js', title: 'Traffic spike on S2' },
  S7: { kind: 'k6', file: 's07-cold.js', title: 'Cold start' },
  S8: {
    kind: 'k6',
    file: 's08-cpu.js',
    title: 'CPU limit POST /api/debug/cpu',
    admin: true,
    needs: ['ADMIN_API_KEY'],
  },
  S9: {
    kind: 'k6',
    file: 's09-large.js',
    title: 'Large file, 10 MB PNG, then a stream of maximum-size images',
    uploads: true,
    freshWorkers: true,
  },
  S10: { kind: 'playwright', file: 's10-landing.spec.ts', title: 'Landing page in a browser' },
  S11: { kind: 'k6', file: 's11-regions.js', title: 'GET /api/files/:id from one region' },
  S12: { kind: 'k6', file: 's12-public.js', title: '/f/:id cold and warm cache' },
  S13: { kind: 'playwright', file: 's13-flow.spec.ts', title: 'User flow in the panel' },
  S14: { kind: 'k6', file: 's14-deploy.js', title: 'Deploy propagation' },
  S15: { kind: 'k6', file: 's15-purge.js', title: 'Cache purge', needs: ['PURGE_URL'] },
};

function parseArgs(argv) {
  const out = {
    targets: [],
    short: false,
    list: false,
    dryRun: false,
    observe: true,
    idleWait: true,
    region: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--short') out.short = true;
    else if (a === '--list') out.list = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-observe') out.observe = false;
    else if (a === '--no-idle-wait') out.idleWait = false;
    else if (a === '--region') out.region = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out.targets.push(a);
  }
  return out;
}

function selectScenarios(targets) {
  if (targets.length === 0) throw new Error('name a scenario (S1..S15) or "all"; --list shows them');
  const ids = targets.flatMap((t) =>
    t.toLowerCase() === 'all' ? Object.keys(SCENARIOS) : [t.toUpperCase()],
  );
  for (const id of ids) if (!SCENARIOS[id]) throw new Error(`unknown scenario ${id}`);
  return [...new Set(ids)];
}

function git(args) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, ...opts });

/** Ports the sidecar forwards: the one in BASE_URL, the object store the presigned URLs name, and a loopback PURGE_URL. */
function forwardPorts(baseUrl) {
  const port = parseBaseUrl(baseUrl).port || (baseUrl.startsWith('https') ? '443' : '80');
  const ports = [port, process.env.STORE_PORT ?? '59000'];
  if (process.env.PURGE_URL) {
    try {
      const purge = parseBaseUrl(process.env.PURGE_URL.replaceAll('{base}', baseUrl).replace(/[?#].*$/, ''));
      if (purge.port) ports.push(purge.port);
    } catch {
      /* the guard has already reported an unreadable PURGE_URL */
    }
  }
  return [...new Set(ports)].join(',');
}

/** Docker Desktop has no host network: a loopback target needs the forwarder. Linux can share the host network. */
function networkMode(loopback) {
  if (!loopback) return { kind: 'default' };
  if (process.env.HM_LOAD_NETWORK === 'host') return { kind: 'host' };
  if (process.env.HM_LOAD_NETWORK === 'sidecar') return { kind: 'sidecar' };
  const os = sh('docker', ['info', '--format', '{{.OperatingSystem}}']).stdout ?? '';
  return /desktop/i.test(os) ? { kind: 'sidecar' } : { kind: 'host' };
}

let forwarderRoute = null;

function startSidecar(baseUrl) {
  const name = `hostmark-load-fwd-${process.pid}`;
  // Docker Desktop's path to a published port stalls new connections after a server-side close (D99), so a running
  // stack is reached over its own network.
  const stackNetwork = `${process.env.HM_COMPOSE_PROJECT ?? 'hostmark'}_default`;
  const onStack = sh('docker', ['network', 'inspect', stackNetwork]).status === 0;
  forwarderRoute = onStack ? 'compose-network' : 'published-port';
  if (!onStack) console.error(`No network ${stackNetwork}: using the published ports, which stall (D99).`);
  const r = sh('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    ...(onStack ? ['--network', stackNetwork, '-e', 'FORWARD_ROUTES=58080=api:8080,59000=minio:9000'] : []),
    '-e',
    `FORWARD_PORTS=${forwardPorts(baseUrl)}`,
    '-v',
    `${join(here, 'tools')}:/tools:ro`,
    FWD_IMAGE,
    'node',
    '/tools/forward.mjs',
  ]);
  if (r.status !== 0) throw new Error(`could not start the forwarder: ${r.stderr}`);
  // The listeners are up as soon as the log line appears.
  for (let i = 0; i < 40; i++) {
    if ((sh('docker', ['logs', name]).stdout ?? '').includes('forwarding')) return name;
    spawnSync('sleep', ['0.25']);
  }
  sh('docker', ['rm', '-f', name]);
  throw new Error('the forwarder did not start');
}

const stopSidecar = (name) => sh('docker', ['rm', '-f', name]);

/** Runs a container, streams its output and returns the exit code and what it printed. */
function runContainer(args, { onLine, env }) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let buffer = '';
    const feed = (chunk) => {
      buffer += chunk.toString();
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        if (!line.includes('HM_EVENT ')) process.stdout.write(`${line}\n`);
        onLine(line);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const PASS_ENV = [
  'BASE_URL',
  'API_KEY',
  'ADMIN_API_KEY',
  'REGION',
  'TOPOLOGY',
  'VARIANT',
  'NOTE',
  'LOAD_ACK_REMOTE',
  'LOAD_ACK_BUDGETS',
  'COMMIT_SHA',
  'COMMIT_DIRTY',
  'TREE_SHA',
  'LOAD_ACK_PURGE_HOST',
  'SHORT',
];

/** Load parameters (RPS, DURATION and so on) passed to the k6 container under their own names when set. */
const PARAM_NAMES = [
  'RPS',
  'DURATION',
  'UPLOADS',
  'PEAK_RPS',
  'RAMP',
  'HOLD',
  'GAPS',
  'REPEATS',
  'LEVELS',
  'ITERATIONS',
  'VISITS',
  'RUNS',
  'POLL_MS',
  'P95_MS',
  'MAX_FAILED',
  'PURGE_URL',
  'PURGE_METHOD',
  'PURGE_TOKEN',
  'EXPECT_VERSION',
  'PURGE_BODY',
  'PURGE_AT',
  'BURST_SECONDS',
  'DRAIN_TIMEOUT',
  'POLL_S',
  'PNG_UPLOADS',
  'STREAM_UPLOADS',
  'STREAM_WAIT',
  'DEPLOY_STARTED_AT',
  'READY_P95_MS',
  'TTFB_P95_MS',
  'LCP_P95_MS',
  'FLOW_P95_MS',
  'INP_MAX_MS',
  'UPLOAD_FIXTURE',
];

/** `-e NAME` without a value makes the docker client copy it from its own environment, so keys stay out of `ps`. */
function containerEnv(base) {
  const out = [];
  for (const name of [...PASS_ENV, ...PARAM_NAMES]) if (base[name] !== undefined) out.push('-e', name);
  return out;
}

/** Local stack only: waits (up to 15 min) until the image queue has nothing waiting or active. Returns seconds waited. */
async function waitForIdleQueue() {
  const started = Date.now();
  const idle = () => {
    const q = queueDepth();
    return q.wait + q.active === 0;
  };
  try {
    while (!idle() && Date.now() - started < 900000) await new Promise((r) => setTimeout(r, 3000));
  } catch {
    /* the stack is not the compose project: nothing to wait for */
  }
  return Math.round((Date.now() - started) / 1000);
}

/**
 * Any target: waits (up to 15 min) until none of the key's newest 100 files is queued or processing, using the API
 * only. A previous scenario's backlog would otherwise be counted into this one. Returns seconds waited.
 */
async function waitForIdleApi(baseUrl, key) {
  const started = Date.now();
  const busy = async () => {
    const res = await fetch(`${baseUrl}/api/files?limit=100`, {
      headers: { authorization: `Bearer ${key}` },
      redirect: 'manual',
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body.items.some((f) => f.status === 'queued' || f.status === 'processing');
  };
  try {
    while (Date.now() - started < 900000 && (await busy())) await new Promise((r) => setTimeout(r, 3000));
  } catch {
    /* an unreachable target is reported by the scenario itself */
  }
  return Math.round((Date.now() - started) / 1000);
}

/**
 * S14 on the local stack: HM_LOCAL_DEPLOY=1 builds the image with a new APP_VERSION before k6 starts and recreates the
 * api container 10 s after it started, so the poll sees the downtime and the version change. Returns what happened.
 */
function prepareLocalDeploy(sha) {
  const version = `${sha || 'local'}-redeploy-${Date.now().toString(36)}`;
  const composeEnv = {
    ...process.env,
    APP_VERSION: version,
    BUILDX_CONFIG: process.env.BUILDX_CONFIG ?? join(process.env.TMPDIR ?? '/tmp', 'buildx'),
  };
  const cwd = join(repo, 'adapters', 'local');
  const build = spawnSync('docker', ['compose', 'build', 'api'], {
    cwd,
    env: composeEnv,
    encoding: 'utf8',
    timeout: 1500000,
  });
  const record = {
    version,
    buildExit: build.status,
    buildTail: `${build.stdout}${build.stderr}`.trim().split('\n').slice(-3),
  };
  const run = () =>
    new Promise((resolve) => {
      record.upStartedAt = new Date().toISOString();
      const up = spawn('docker', ['compose', 'up', '-d', '--no-deps', 'api'], {
        cwd,
        env: composeEnv,
        stdio: 'ignore',
      });
      up.on('close', (code) => {
        record.upExit = code;
        record.upFinishedAt = new Date().toISOString();
        resolve(record);
      });
    });
  return { record, version, trigger: () => (record.buildExit === 0 ? run() : Promise.resolve(record)) };
}

async function runOne(id, ctx) {
  const sc = SCENARIOS[id];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${id}-${ctx.env.REGION ?? 'local'}-${stamp}.json`;
  const events = [];
  const env = { ...ctx.env, SHORT: ctx.short ? '1' : '0' };
  if (sc.admin && !env.ADMIN_API_KEY) throw new Error(`${id} needs ADMIN_API_KEY`);
  if (!env.API_KEY) throw new Error('API_KEY is not set');

  let deploy = null;
  if (id === 'S14' && env.HM_LOCAL_DEPLOY === '1' && ctx.observe && !ctx.dryRun) {
    deploy = prepareLocalDeploy(env.COMMIT_SHA);
    env.EXPECT_VERSION = deploy.version;
  }
  let deployDone = Promise.resolve(null);

  const net =
    ctx.network.kind === 'sidecar'
      ? ['--network', `container:${ctx.sidecar}`]
      : ctx.network.kind === 'host'
        ? ['--network', 'host']
        : [];
  const resultDir = join(here, 'results');
  mkdirSync(resultDir, { recursive: true });
  const containerName = `hostmark-load-${id.toLowerCase()}-${process.pid}`;

  let args;
  if (sc.kind === 'k6') {
    args = [
      'run',
      '--rm',
      '--name',
      containerName,
      ...net,
      '--user',
      `${process.getuid?.() ?? 0}`,
      '-v',
      `${here}:/load:ro`,
      '-v',
      `${resultDir}:/results`,
      ...containerEnv(env),
      '-e',
      `RESULT_FILE=/results/${file}`,
      K6_IMAGE,
      'run',
      '--log-format',
      'raw',
      '--quiet',
      `/load/scenarios/${sc.file}`,
    ];
  } else {
    args = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--ipc=host',
      ...net,
      '--user',
      `${process.getuid?.() ?? 0}`,
      '-v',
      `${repo}:/repo:ro`,
      '-v',
      `${resultDir}:/results`,
      ...containerEnv(env),
      '-e',
      `RESULT_FILE=/results/${file}`,
      '-e',
      `SCENARIO=${id}`,
      '-e',
      'HOME=/tmp',
      '-e',
      'LOAD_DIR=/repo/load',
      PW_IMAGE,
      // The specs are copied next to a symlink to apps/web's node_modules: @playwright/test is a dependency of
      // that workspace only, and load/ stays independent of it. The repository itself is mounted read-only.
      'sh',
      '-c',
      `rm -rf /tmp/pw && mkdir /tmp/pw && cp -r /repo/load/playwright/. /tmp/pw/ && mkdir -p /tmp/lib && cp -r /repo/load/lib/guard.js /tmp/lib/ && ln -s /repo/apps/web/node_modules /tmp/pw/node_modules && cd /tmp/pw && node node_modules/@playwright/test/cli.js test -c playwright.config.ts ${sc.file}`,
    ];
  }
  if (ctx.dryRun) {
    console.log(`[dry-run] ${id}: docker ${args.join(' ')}`);
    return { id, code: 0, file: null };
  }
  // The previous scenario may have left jobs behind (S4 above the worker's rate does); they would delay this one.
  const idleWaitS = !ctx.idleWait
    ? 0
    : ctx.observe
      ? await waitForIdleQueue()
      : sc.uploads
        ? await waitForIdleApi(env.BASE_URL, env.API_KEY)
        : 0;
  // Scenarios that report worker memory start on freshly restarted workers, so the cgroup peak is theirs alone; the
  // ones that upload keep observing until the backlog is processed, so database percentiles cover every file.
  const observer = ctx.observe
    ? await observeLocal.start({
        id,
        drainSeconds: sc.uploads ? 900 : 0,
        freshWorkers: Boolean(sc.freshWorkers),
      })
    : null;
  ctx.running = containerName;
  const pauseWatch = watchHostPauses();
  if (deploy) deployDone = new Promise((resolve) => setTimeout(() => deploy.trigger().then(resolve), 10000));
  let code = await runContainer(args, {
    env,
    onLine: (line) => {
      const m = /HM_EVENT (\{.*\})/.exec(line);
      if (m) {
        try {
          events.push(JSON.parse(m[1]));
        } catch {
          /* a truncated line is not an event */
        }
      }
    },
  });
  ctx.running = null;
  const observed = observer ? await observer.stop() : null;
  await deployDone;
  const hostPauses = await pauseWatch.stop();
  const path = join(resultDir, file);
  let status = null;
  if (existsSync(path)) {
    const result = JSON.parse(readFileSync(path, 'utf8'));
    result.exitCode = code;
    result.events = summariseEvents(events);
    const identity = events.find((e) => e.type === 'identity');
    if (identity && !result['x-platform']) {
      result['x-platform'] = identity.platform;
      result['x-version'] ??= identity.version;
    }
    if (forwarderRoute) result.forwarderRoute = forwarderRoute;
    if (observed) result.local = { ...observed, waitedForIdleQueueS: idleWaitS };
    const pausedS = Math.round((hostPauses ?? []).reduce((sum, p) => sum + p.gapS, 0) * 10) / 10;
    result.host = {
      watcher: hostPauses === null ? 'failed' : 'ok',
      pauses: hostPauses ?? [],
      pausedS,
      keepAwake,
    };
    if (hostPauses === null) {
      // No watcher, no proof that the host stayed awake.
      result.status = 'invalid';
      result.passed = null;
      if (code === 0) code = 3;
      console.error(`${id}: INVALID, the pause watcher did not report. Run it again.`);
    } else if (hostPauses.length > 0) {
      // The numbers include time the machine did not run: the result says so instead of passing or failing.
      result.status = 'invalid';
      result.passed = null;
      if (code === 0) code = 3;
      console.error(
        `${id}: INVALID, the host was paused ${JSON.stringify(hostPauses)} (sleep?). Run it again.`,
      );
    }
    if (deploy) {
      // `t` of the version events counts from the first poll; the zero point of a deploy is when `up` was started.
      const seen = events.find((e) => e.type === 'version' && e.to === deploy.version);
      if (seen && deploy.record.upStartedAt)
        deploy.record.versionSeenAfterUpStartedS =
          Math.round((seen.at - Date.parse(deploy.record.upStartedAt)) / 100) / 10;
      result.localDeploy = deploy.record;
    }
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    status = result.status ?? null;
  } else {
    // A run that wrote nothing has no verdict, whatever its exit code says.
    console.error(`${id}: no result file was written (exit ${code})`);
    if (code === 0) code = 1;
  }
  return { id, code, status, file: existsSync(path) ? path : null };
}

/**
 * A laptop that sleeps (lid closed on battery) freezes the Docker VM and this process with it, and the run then
 * measures the sleep. The watcher is a child process (`tools/pause-watch.mjs`), so a blocking call here cannot delay
 * its ticks; `stop()` resolves with the pauses it saw, or with `null` when the watcher could not report.
 */
function watchHostPauses() {
  let out = '';
  const child = spawn(process.execPath, [join(here, 'tools', 'pause-watch.mjs')], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.stdout.on('data', (d) => {
    out += d;
  });
  const closed = new Promise((resolve) => {
    child.on('error', resolve);
    child.on('close', resolve);
  });
  return {
    async stop() {
      child.stdin.end();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
      child.kill();
      try {
        return JSON.parse(out.trim().split('\n').pop()).pauses;
      } catch {
        return null;
      }
    },
  };
}

let keepAwake = null;

/** Asks macOS not to idle-sleep while this process runs. A closed lid still sleeps the host. */
function startKeepAwake() {
  if (process.platform !== 'darwin') return { tool: 'none', started: false, reason: 'not darwin' };
  try {
    const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { tool: 'caffeinate -i', started: child.pid !== undefined };
  } catch (error) {
    return { tool: 'caffeinate -i', started: false, reason: String(error.message ?? error) };
  }
}

/** Keeps the log events small: errors are capped, header values are listed once. */
function summariseEvents(events) {
  const errors = events.filter((e) => e.type === 'error');
  return {
    errors: { total: errors.length, sample: errors.slice(0, 10) },
    cacheHeaders: [
      ...new Map(
        events.filter((e) => e.type === 'header').map((e) => [`${e.header}=${e.value}`, e]),
      ).values(),
    ],
    other: events.filter((e) => e.type !== 'error' && e.type !== 'header').slice(0, 200),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  keepAwake = keepAwake ?? startKeepAwake();
  if (args.list) {
    for (const [id, s] of Object.entries(SCENARIOS)) {
      const needs = [
        ...(s.admin ? ['ADMIN_API_KEY'] : []),
        ...(s.needs?.filter((n) => n !== 'ADMIN_API_KEY') ?? []),
      ];
      const note = needs.length > 0 ? `  [needs ${needs.join(', ')}]` : '';
      console.log(`${id.padEnd(4)} ${s.kind.padEnd(11)} ${s.title}${note}`);
    }
    return 0;
  }
  const ids = selectScenarios(args.targets);
  if (
    args.targets.some((t) => t.toLowerCase() === 'all') &&
    !args.short &&
    !process.env.GAPS &&
    !args.dryRun
  ) {
    console.error(
      'refusing "all" without --short: S7 in full waits 5, 15 and 60 minutes between requests, three times (about 13 hours). Use --short, set GAPS, or name the scenarios (S7 explicitly runs in full).',
    );
    return 2;
  }
  const baseUrl = (process.env.BASE_URL ?? 'http://127.0.0.1:58080').replace(/\/+$/, '');
  let loopback = true;
  for (const id of ids) {
    const guardEnv = { ...process.env, ...(args.region ? { REGION: args.region } : {}) };
    const verdict = checkGuard({ baseUrl, scenario: id, env: guardEnv });
    loopback = verdict.loopback;
    if (verdict.problems.length > 0) {
      console.error(`refusing to run ${id}: ${verdict.problems.join('; ')}`);
      return 2;
    }
  }
  const keys = resolveKeys(process.env, loopback);
  const sha = git(['rev-parse', '--short', 'HEAD']);
  // The tree of the working copy, so a result names the exact code it ran: dirty means it differs from HEAD.
  const tree = workingTree(repo);
  const dirty = tree === '' || tree !== headTree(repo) ? '1' : '0';
  const env = {
    ...process.env,
    BASE_URL: baseUrl,
    ...keys,
    COMMIT_SHA: sha,
    COMMIT_DIRTY: dirty,
    TREE_SHA: tree,
    ...(args.region ? { REGION: args.region } : {}),
  };
  const network = args.dryRun ? { kind: 'sidecar' } : networkMode(loopback);
  const ctx = {
    env,
    short: args.short,
    dryRun: args.dryRun,
    observe: args.observe && loopback,
    idleWait: args.idleWait,
    network,
    sidecar: null,
  };
  if (network.kind === 'sidecar' && !args.dryRun) ctx.sidecar = startSidecar(baseUrl);
  else if (args.dryRun) ctx.sidecar = 'hostmark-load-fwd-DRYRUN';
  let worst = 0;
  const summary = [];
  const cleanup = () => {
    if (ctx.running) sh('docker', ['rm', '-f', ctx.running]);
    if (ctx.sidecar && !args.dryRun) stopSidecar(ctx.sidecar);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  }
  try {
    for (const id of ids) {
      const r = await runOne(id, ctx);
      summary.push(r);
      worst = Math.max(worst, r.code);
    }
  } finally {
    cleanup();
  }
  console.log('\nsummary');
  for (const r of summary)
    console.log(
      `  ${r.id.padEnd(4)} exit ${r.code}  ${(r.status ?? 'no result').toUpperCase().padEnd(8)} ${r.file ?? ''}`,
    );
  return worst;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
