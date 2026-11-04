// Deploy of the fly-portable adapter to an existing Fly app (README, "Deploy from GitHub Actions").
//   pnpm platform deploy fly           (D70; or `pnpm --dir adapters/fly run platform-deploy`)
// `--dry-run` prints the commands and runs none.
// Needs `flyctl` and FLY_API_TOKEN, which flyctl reads from its environment; the token is never an argument and is
// scrubbed from everything flyctl prints. The app is the `app` of fly.toml.
// `--ha=false` and the count below are the rule of D159: Fly cannot pin a machine count in fly.toml, so every deploy
// sets it again, and the scheduler group has exactly one machine.
// The image gets APP_VERSION as a build argument (D281): APP_VERSION, else 12 characters of the commit of HEAD, so
// `x-version` changes with every deploy (S14). The Dockerfile turns the argument into the runtime variable.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appVersion, main, requireEnv, run, scrubber } from '../../../tools/platform/exec.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dry = values['dry-run'];

/** Machines per process group of fly.toml. The scheduler must stay at 1 (D19, D159). */
const COUNT = { api: 1, worker: 2, scheduler: 1 };
const config = ['--config', 'adapters/fly/fly.toml'];

await main(async () => {
  const { FLY_API_TOKEN } = dry ? { FLY_API_TOKEN: '' } : requireEnv(['FLY_API_TOKEN']);
  const version = appVersion({ cwd: root });
  const options = { cwd: root, scrub: scrubber([FLY_API_TOKEN]), dry };
  // The build context is the repository root: the image needs the whole workspace.
  const build = ['--dockerfile', 'adapters/fly/Dockerfile', '--build-arg', `APP_VERSION=${version}`];
  await run('flyctl', ['deploy', ...config, ...build, '--ha=false', '--yes', '.'], options);
  const counts = Object.entries(COUNT).map(([group, count]) => `${group}=${count}`);
  await run('flyctl', ['scale', 'count', ...counts, ...config, '--yes'], options);
  await run('flyctl', ['status', ...config], options);
});
