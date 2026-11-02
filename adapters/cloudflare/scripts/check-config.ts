// Offline validation of the three wrangler configs: no network, no account, nothing is deployed.
//   node --import tsx scripts/check-config.ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKOFF_SECONDS, DLQ_NAME, MAX_ATTEMPTS, QUEUE_NAME, SCHEDULER_JOBS } from '@hostmark/contract';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems: string[] = [];
const expect = (ok: boolean, message: string) => {
  if (!ok) problems.push(message);
};

// wrangler writes its log and caches next to the user's config by default; keep everything in a scratch directory.
const scratch = mkdtempSync(join(tmpdir(), 'hostmark-cf-check-'));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(scratch, 'xdg'),
  WRANGLER_LOG_PATH: join(scratch, 'logs'),
  WRANGLER_SEND_METRICS: 'false',
  CI: '1',
};
mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
mkdirSync(env.WRANGLER_LOG_PATH, { recursive: true });
Object.assign(process.env, env);
// Imported only now: wrangler reads these variables when it loads.
const { unstable_readConfig: readConfig } = await import('wrangler');

const services = ['api', 'consumer', 'scheduler'] as const;
const configs = Object.fromEntries(
  services.map((name) => [
    name,
    readConfig({ config: join(root, `wrangler.${name}.jsonc`) }, { hideWarnings: false }),
  ]),
) as Record<(typeof services)[number], ReturnType<typeof readConfig>>;

for (const name of services) {
  const c = configs[name];
  expect(c.compatibility_flags.includes('nodejs_compat'), `${name}: nodejs_compat is missing`);
  expect(c.compatibility_date >= '2026-08-04', `${name}: compatibility_date must be 2026-08-04 or later`);
  expect(
    c.hyperdrive.length === 1 && c.hyperdrive[0]?.binding === 'HYPERDRIVE',
    `${name}: one HYPERDRIVE binding expected`,
  );
  expect(
    c.r2_buckets.some((b: { binding: string }) => b.binding === 'BUCKET'),
    `${name}: BUCKET binding is missing`,
  );
  expect(
    c.queues.producers?.some(
      (p: { binding: string; queue: string }) => p.binding === 'QUEUE' && p.queue === QUEUE_NAME,
    ),
    `${name}: QUEUE producer for ${QUEUE_NAME} is missing`,
  );
  // A secret in `vars` would be committed with the file.
  for (const key of ['BETTER_AUTH_SECRET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    expect(!(key in c.vars), `${name}: ${key} is a secret and must come from \`wrangler secret put\``);
  }
  expect(c.vars.ENVIRONMENT !== 'local', `${name}: ENVIRONMENT must not be local in a deployable config`);
  expect(
    c.vars.R2_BUCKET_NAME === c.r2_buckets[0]?.bucket_name,
    `${name}: R2_BUCKET_NAME differs from the bucket binding`,
  );
  if (name !== 'api') {
    const media = c.services.find((s: { binding: string }) => s.binding === 'MEDIA');
    expect(
      media?.service === configs.api.name && media?.entrypoint === 'Media',
      `${name}: MEDIA must point at ${configs.api.name}#Media (D100)`,
    );
  }
}

// D100: only the Media entrypoint of the api caches, and the consumer and scheduler have no cache of their own.
const api = configs.api;
const exportsMap =
  (api as unknown as { exports?: Record<string, { cache?: { enabled?: boolean } }> }).exports ?? {};
expect(exportsMap.Media?.cache?.enabled === true, 'api: exports.Media.cache.enabled must be true');
expect(exportsMap.default?.cache?.enabled === false, 'api: exports.default.cache.enabled must be false');
expect(api.assets?.binding === 'ASSETS', 'api: ASSETS binding is missing');
const first = api.assets?.run_worker_first;
expect(
  Array.isArray(first) && ['/api/*', '/f/*', '/media/*'].every((p) => first.includes(p)),
  'api: run_worker_first must list /api/*, /f/* and /media/*',
);

// D17 on Cloudflare Queues.
const consumer = configs.consumer.queues.consumers?.[0];
expect(consumer?.queue === QUEUE_NAME, `consumer: must consume ${QUEUE_NAME}`);
expect(consumer?.max_retries === MAX_ATTEMPTS - 1, `consumer: max_retries must be ${MAX_ATTEMPTS - 1}`);
expect(consumer?.dead_letter_queue === DLQ_NAME, `consumer: dead_letter_queue must be ${DLQ_NAME}`);
expect(consumer?.max_batch_size === 1, 'consumer: max_batch_size must be 1');
expect(consumer?.retry_delay === BACKOFF_SECONDS[0], `consumer: retry_delay must be ${BACKOFF_SECONDS[0]}`);

// D19: the cron strings are the contract's.
const crons = [...(configs.scheduler.triggers.crons ?? [])].sort();
const wanted = Object.values(SCHEDULER_JOBS).sort();
expect(
  JSON.stringify(crons) === JSON.stringify(wanted),
  `scheduler: crons ${JSON.stringify(crons)} differ from SCHEDULER_JOBS ${JSON.stringify(wanted)}`,
);

// The Workers bundle offline. The assets directory is only read for the upload size, so an empty stand-in is enough.
const assetsDir = join(root, '.build', 'assets');
if (!existsSync(assetsDir)) {
  mkdirSync(join(assetsDir, 'app'), { recursive: true });
  writeFileSync(join(assetsDir, 'app', 'index.html'), '<!doctype html>');
}
for (const name of services) {
  const run = spawnSync(
    join(root, 'node_modules', '.bin', 'wrangler'),
    ['deploy', '-c', `wrangler.${name}.jsonc`, '--dry-run', '--outdir', join(scratch, `out-${name}`)],
    { cwd: root, env, encoding: 'utf8' },
  );
  const upload = /Total Upload: ([^\n]+)/.exec(run.stdout)?.[1];
  expect(run.status === 0, `${name}: wrangler deploy --dry-run failed:\n${run.stdout}\n${run.stderr}`);
  if (run.status === 0) console.log(`${name}: bundles (${upload})`);
}

const licenses = spawnSync(process.execPath, [join(root, 'scripts', 'licenses.mjs'), '--check'], {
  cwd: root,
  encoding: 'utf8',
});
expect(licenses.status === 0, `licences: ${licenses.stderr.trim() || licenses.stdout.trim()}`);

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('wrangler configs valid (offline)');
