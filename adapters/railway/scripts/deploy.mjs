// Deploy of the railway-portable adapter to an existing Railway project (README, "Deploy from GitHub Actions").
//   pnpm platform deploy railway       (D70; or `pnpm --dir adapters/railway run platform-deploy`)
// `--dry-run` prints the commands and runs none.
// Needs the `railway` CLI and RAILWAY_TOKEN, a project token: it names the project and the environment, so nothing is
// linked on disk. The token reaches the CLI as its environment only and is scrubbed from everything it prints.
// For each service of services.json, in its order (`api` first, whose pre-deploy command migrates, then `worker` and
// `scheduler`):
//   1. `railway variable set ... --skip-deploys`: APP_VERSION (D281) and the deployment settings Railway reads from
//      service variables (Dockerfile path, draining, overlap, health check timeout; D283), taken from services.json.
//      `--skip-deploys` commits them without a deploy; the upload below is the deploy that applies them.
//   2. `railway up --ci`: uploads the repository root (the image needs the workspace; `.gitignore` applies) and
//      exits non-zero when the deployment fails, so a failed `api` stops the rest.
//   3. `railway deployment list --json --limit 1` until the newest deployment of the service is SUCCESS (D284). `--ci`
//      is documented as "exits when the build completes", so this catches a deploy that `--ci` left before it ended.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appVersion, DeployError, main, requireEnv, run, scrubber } from '../../../tools/platform/exec.mjs';

const adapter = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(adapter, '../..');
const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    // Seconds between two status checks, and how long to wait for a terminal status after `up --ci` returned.
    'poll-seconds': { type: 'string', default: '10' },
    'status-timeout': { type: 'string', default: '900' },
  },
});
const dry = values['dry-run'];
const pollMs = Number(values['poll-seconds']) * 1000;
const timeoutMs = Number(values['status-timeout']) * 1000;

/** Statuses of `railway deployment list` that are still on their way to SUCCESS; anything else but SUCCESS fails. */
const IN_PROGRESS = new Set(['QUEUED', 'WAITING', 'INITIALIZING', 'BUILDING', 'DEPLOYING']);

/** The service variables of one service: the build stamp and the settings Railway reads from variables (D283). */
function serviceVariables(config, settings, version) {
  const vars = { APP_VERSION: version, RAILWAY_DOCKERFILE_PATH: config.dockerfilePath };
  if (settings.drainingSeconds !== undefined)
    vars.RAILWAY_DEPLOYMENT_DRAINING_SECONDS = String(settings.drainingSeconds);
  if (settings.overlapSeconds !== undefined)
    vars.RAILWAY_DEPLOYMENT_OVERLAP_SECONDS = String(settings.overlapSeconds);
  if (settings.healthcheckTimeout !== undefined)
    vars.RAILWAY_HEALTHCHECK_TIMEOUT_SEC = String(settings.healthcheckTimeout);
  return vars;
}

/** The status of the newest deployment in the output of `railway deployment list --json`. */
function newestStatus(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new DeployError('railway deployment list --json did not print JSON');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.deployments;
  const status = Array.isArray(list) ? list[0]?.status : undefined;
  if (typeof status !== 'string')
    throw new DeployError('railway deployment list --json listed no deployment');
  return status.toUpperCase();
}

await main(async () => {
  const { RAILWAY_TOKEN } = dry ? { RAILWAY_TOKEN: '' } : requireEnv(['RAILWAY_TOKEN']);
  if (!(pollMs >= 0) || !(timeoutMs >= 0))
    throw new DeployError('--poll-seconds and --status-timeout take a number of seconds', 2);
  const version = appVersion({ cwd: root });
  const scrub = scrubber([RAILWAY_TOKEN]);
  const options = { cwd: root, scrub, dry };
  const config = JSON.parse(readFileSync(resolve(adapter, 'services.json'), 'utf8'));
  for (const [service, settings] of Object.entries(config.services)) {
    const vars = Object.entries(serviceVariables(config, settings, version)).map(([k, v]) => `${k}=${v}`);
    await run('railway', ['variable', 'set', ...vars, '--service', service, '--skip-deploys'], options);
    await run('railway', ['up', '--ci', '--service', service], options);
    const list = ['deployment', 'list', '--service', service, '--json', '--limit', '1'];
    if (dry) {
      await run('railway', list, options);
      continue;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = newestStatus(await run('railway', list, { ...options, capture: true }));
      console.log(`${service}: ${status}`);
      if (status === 'SUCCESS') break;
      if (!IN_PROGRESS.has(status)) throw new DeployError(`${service}: the deployment ended ${status}`);
      if (Date.now() >= deadline)
        throw new DeployError(`${service}: still ${status} ${timeoutMs / 1000} s after railway up returned`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  console.log(`\nDone: ${version}. Check that \`scheduler\` runs one replica (README, Scheduler).`);
});
