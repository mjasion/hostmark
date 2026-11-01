// What the local compose stack saw while a scenario ran: an independent source for k6's numbers and the evidence
// for the worker memory limit (D79), `files.attempts` and sibling jobs of a killed worker (D63, D64, D72).
// Only used against a loopback target. Everything is read through `docker exec` and `docker inspect` on the
// containers of the compose project; nothing is changed, except `freshWorkers`, which restarts the workers so that
// their cgroup `memory.peak` starts from zero. The worker service runs several replicas (D97): every figure is kept
// per replica and as a total.
import { spawn, spawnSync } from 'node:child_process';

const PROJECT = process.env.HM_COMPOSE_PROJECT ?? 'hostmark';
const name = (service) => `${PROJECT}-${service}-1`;
const run = (cmd, args, timeout = 30000) => spawnSync(cmd, args, { encoding: 'utf8', timeout });
const docker = (args, timeout) => run('docker', args, timeout);

export const available = () =>
  docker(['inspect', '-f', '{{.State.Running}}', name('postgres')], 10000).stdout.trim() === 'true';

export function psql(sql) {
  const r = docker(['exec', name('postgres'), 'psql', '-U', 'hostmark', '-d', 'hostmark', '-At', '-c', sql]);
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const psqlJson = (sql) => JSON.parse(psql(`select row_to_json(t) from (${sql}) t`) || 'null');

export function dbNow() {
  return psql('select to_char(now() at time zone \'utc\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\')');
}

/** Files created at or after `since`: status, attempts and upload_to_ready_ms (ready_at - queued_at). */
export function windowStats(since) {
  return psqlJson(`
    select
      (select count(*) from files where created_at >= '${since}') as files,
      (select coalesce(json_object_agg(status, n), '{}') from
        (select status, count(*) n from files where created_at >= '${since}' group by 1) s) as by_status,
      (select coalesce(json_object_agg(attempts, n), '{}') from
        (select attempts, count(*) n from files where created_at >= '${since}' group by 1 order by 1) a) as by_attempts,
      (select coalesce(max(attempts), 0) from files where created_at >= '${since}') as max_attempts,
      (select count(*) from files where created_at >= '${since}' and status = 'failed') as failed,
      (select count(*) from files where created_at >= '${since}' and status = 'pending_upload') as pending_upload,
      (select count(*) from files where created_at >= '${since}' and queued_at is not null) as queued,
      (select json_build_object(
          'n', count(*),
          'p50', round((percentile_cont(0.5) within group (order by ms))::numeric, 1),
          'p95', round((percentile_cont(0.95) within group (order by ms))::numeric, 1),
          'p99', round((percentile_cont(0.99) within group (order by ms))::numeric, 1),
          'max', round(max(ms)::numeric, 1))
        from (select extract(epoch from (ready_at - queued_at)) * 1000 as ms from files
              where created_at >= '${since}' and status = 'ready' and ready_at is not null and queued_at is not null) r
      ) as upload_to_ready_ms`);
}

/** Rows of the whole table, to show what the run left behind (pending_upload rows stay until cleanup). */
export function tableStats() {
  return psqlJson(`select
    (select coalesce(json_object_agg(status, n), '{}') from (select status, count(*) n from files group by 1) s) as by_status,
    (select count(*) from files) as files`);
}

export function queueDepth() {
  const q = (cmd, key) => Number(docker(['exec', name('redis'), 'redis-cli', cmd, key]).stdout.trim() || 0);
  return {
    wait: q('llen', 'bull:image-jobs:wait'),
    active: q('llen', 'bull:image-jobs:active'),
    delayed: q('zcard', 'bull:image-jobs:delayed'),
    failed: q('zcard', 'bull:image-jobs:failed'),
    dlq: q('llen', 'bull:image-jobs-dlq:wait'),
  };
}

/** Names of the containers of a compose service, sorted (`hostmark-worker-1`, `hostmark-worker-2`, ...). */
export function serviceContainers(service) {
  const r = docker(
    [
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${PROJECT}`,
      '--filter',
      `label=com.docker.compose.service=${service}`,
      '--format',
      '{{.Names}}',
    ],
    10000,
  );
  return r.stdout
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** State of one container by name, or of the first container of a service when given a service name. */
export function containerState(nameOrService) {
  const target = serviceContainers(nameOrService)[0] ?? nameOrService;
  const r = docker(
    [
      'inspect',
      '-f',
      '{"name":"{{.Name}}","restarts":{{.RestartCount}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}},"running":{{.State.Running}},"startedAt":"{{.State.StartedAt}}"}',
      target,
    ],
    10000,
  );
  try {
    const state = JSON.parse(r.stdout);
    return { ...state, name: state.name.replace(/^\//, '') };
  } catch {
    return null;
  }
}

/** One state per replica of a service. */
export const serviceStates = (service) => serviceContainers(service).map((n) => containerState(n));

/** The cgroup high-water mark of a container, MiB: what the kernel saw, not what a sample caught. */
export function cgroupPeakMiB(container) {
  for (const path of ['/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory/memory.max_usage_in_bytes']) {
    const r = docker(['exec', container, 'cat', path], 10000);
    const bytes = Number(r.stdout.trim());
    if (r.status === 0 && Number.isFinite(bytes) && bytes > 0)
      return Math.round((bytes / 1024 ** 2) * 10) / 10;
  }
  return null;
}

/** Restarts the workers (docker restart) and waits until all run, so that cgroup peaks and sampling start clean. */
export async function restartWorkers(timeoutS = 120) {
  const names = serviceContainers('worker');
  if (names.length === 0) return [];
  docker(['restart', '-t', '70', ...names], 150000);
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (names.every((n) => containerState(n)?.running === true)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // The consumers need a few seconds to connect to Redis before the first job.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return names;
}

const UNIT = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3 };
const toMiB = (text) => {
  const m = /^([\d.]+)\s*([A-Za-z]+)/.exec(text.trim());
  return m ? Math.round(((Number(m[1]) * (UNIT[m[2].toUpperCase()] ?? 1)) / 1024 ** 2) * 10) / 10 : null;
};

/** `docker stats` for the api and every worker replica every few seconds; the series is thinned to 60 points. */
function sampler(workers, intervalMs = 3000) {
  const samples = [];
  let stopped = false;
  const sample = async () => {
    const started = Date.now();
    const out = await new Promise((resolve) => {
      const c = spawn('docker', [
        'stats',
        '--no-stream',
        '--format',
        '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}',
        name('api'),
        ...workers,
      ]);
      let text = '';
      c.stdout.on('data', (d) => {
        text += d;
      });
      c.on('close', () => resolve(text));
      c.on('error', () => resolve(''));
    });
    const row = { t: Math.round(started / 1000), workers: {} };
    for (const line of out.trim().split('\n')) {
      const [container, mem, cpu] = line.split('|');
      if (!container || !mem) continue;
      const entry = { memMiB: toMiB(mem.split('/')[0]), cpuPct: Number.parseFloat(cpu) };
      if (container === name('api')) row.api = entry;
      else row.workers[container] = entry;
    }
    row.workerTotalMiB = Object.values(row.workers).reduce((sum, w) => sum + (w.memMiB ?? 0), 0);
    return row;
  };
  const first = sample();
  const loop = async () => {
    samples.push(await first);
    while (!stopped) {
      const started = Date.now();
      samples.push(await sample());
      const wait = intervalMs - (Date.now() - started);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  };
  const done = loop();
  const max = (pick) => samples.reduce((m, s) => Math.max(m, pick(s) ?? 0), 0);
  return {
    /** The first sample, taken before the load: the idle memory of every process. */
    async baseline() {
      const row = await first;
      return { api: row.api?.memMiB ?? null, workers: row.workers, workerTotalMiB: row.workerTotalMiB };
    },
    async stop() {
      stopped = true;
      await done;
      const step = Math.max(1, Math.ceil(samples.length / 60));
      return {
        intervalS: intervalMs / 1000,
        samples: samples.length,
        peakMemMiB: {
          api: max((s) => s.api?.memMiB),
          perWorker: Object.fromEntries(workers.map((w) => [w, max((s) => s.workers[w]?.memMiB)])),
          workerTotal: max((s) => s.workerTotalMiB),
        },
        peakCpuPct: {
          api: max((s) => s.api?.cpuPct),
          perWorker: Object.fromEntries(workers.map((w) => [w, max((s) => s.workers[w]?.cpuPct)])),
        },
        series: samples
          .filter((_, i) => i % step === 0)
          .map((s) => ({ t: s.t, apiMiB: s.api?.memMiB, workerTotalMiB: s.workerTotalMiB })),
      };
    },
  };
}

const restartsOf = (states) => states.reduce((n, s) => n + (s?.restarts ?? 0), 0);

export const observeLocal = {
  /**
   * Call before the scenario starts. The returned `stop()` waits for in-flight processing, then reports.
   * `freshWorkers` restarts the workers first, so `cgroupPeakMiB` covers this scenario only.
   */
  async start({ id, drainSeconds = 0, freshWorkers = false }) {
    if (!available()) return null;
    if (freshWorkers) await restartWorkers();
    const since = dbNow();
    const workers = serviceContainers('worker');
    const before = {
      workers: workers.map((n) => containerState(n)),
      api: containerState('api'),
      queue: queueDepth(),
    };
    const s = sampler(workers);
    const baseline = await s.baseline();
    return {
      since,
      async stop() {
        // Files still queued or processing belong to the run; give them time to finish before counting.
        const deadline = Date.now() + drainSeconds * 1000;
        let stats = windowStats(since);
        while (
          Date.now() < deadline &&
          (stats.by_status.queued ?? 0) + (stats.by_status.processing ?? 0) > 0
        ) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          stats = windowStats(since);
        }
        const usage = await s.stop();
        const after = workers.map((n) => containerState(n));
        return {
          scenario: id,
          since,
          until: dbNow(),
          db: stats,
          table: tableStats(),
          queue: { before: before.queue, after: queueDepth() },
          worker: {
            replicas: workers.length,
            freshWorkers,
            before: before.workers,
            after,
            restartsDuring: restartsOf(after) - restartsOf(before.workers),
            oomKilled: after.some((w) => w?.oomKilled === true),
            idleMemMiB: baseline,
            cgroupPeakMiB: {
              perWorker: Object.fromEntries(workers.map((n) => [n, cgroupPeakMiB(n)])),
              total: workers.reduce((sum, n) => sum + (cgroupPeakMiB(n) ?? 0), 0),
            },
          },
          api: { before: before.api, after: containerState('api') },
          usage,
        };
      },
    };
  },
};
