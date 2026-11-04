// Deploy of the railway-portable adapter to an existing Railway project (README, "Deploy from GitHub Actions").
//   pnpm platform deploy railway       (D70; or `pnpm --dir adapters/railway run platform-deploy`)
// `--dry-run` prints the commands and runs none.
// Needs the `railway` CLI and RAILWAY_TOKEN, a project token: it names the project and the environment, so nothing is
// linked on disk. The token reaches the CLI as its environment only and is scrubbed from everything it prints.
// Uploads the repository root (the image needs the workspace; `.gitignore` applies) once per service, in the order of
// services.json: `api` first, whose pre-deploy command migrates, then `worker` and `scheduler`. `--ci` waits for the
// build and the deployment and exits non-zero when either fails, so a failed `api` stops the rest.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { main, requireEnv, run, scrubber } from '../../../tools/platform/exec.mjs';

const adapter = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(adapter, '../..');
const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dry = values['dry-run'];

await main(async () => {
  const { RAILWAY_TOKEN } = dry ? { RAILWAY_TOKEN: '' } : requireEnv(['RAILWAY_TOKEN']);
  const scrub = scrubber([RAILWAY_TOKEN]);
  const services = Object.keys(JSON.parse(readFileSync(resolve(adapter, 'services.json'), 'utf8')).services);
  for (const service of services)
    await run('railway', ['up', '--ci', '--service', service], { cwd: root, scrub, dry });
  console.log('\nDone. Check that `scheduler` runs one replica (README, Scheduler).');
});
