// One-command deploy of the vercel-portable adapter. Run from the repository root:
//   pnpm --filter @hostmark/adapter-vercel platform-deploy            (or `pnpm platform deploy vercel`, D70)
// `--dry-run` prints every command and runs none of them.
// Needs the `vercel` CLI and a project whose Root Directory is `adapters/vercel` (README). The CLI reads VERCEL_TOKEN,
// VERCEL_ORG_ID and VERCEL_PROJECT_ID from the environment. Secret values reach the CLI only on stdin (`vercel env add`)
// or as that environment; they are never in argv, and every line the CLI prints is scrubbed of them before it is shown.
// Before `vercel deploy` the database is migrated and seeded from this machine (scripts/prepare-database.ts, D277): the
// seed keys come from SEED_API_KEY and SEED_ADMIN_API_KEY, are never generated or printed, and are not project
// variables, because no function reads them.
// The build reads a copy of vercel.json with the HTML Content-Security-Policy added (scripts/security-headers.ts,
// D310): the policy names the origin of the presigned URLs, from the same S3 variables the functions presign with.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const adapter = resolve(here, '..');
const root = resolve(adapter, '../..');

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dry = values['dry-run'];

const SECRETS = [
  'VERCEL_TOKEN',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'CRON_SECRET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'SEED_API_KEY',
  'SEED_ADMIN_API_KEY',
];
/** Secrets this script uses itself and does not store on the project. */
const LOCAL = ['VERCEL_TOKEN', 'SEED_API_KEY', 'SEED_ADMIN_API_KEY'];
const PLAIN = ['PUBLIC_URL', 'S3_ENDPOINT', 'S3_BUCKET'];
/** Plain variables stored only when set. S3_PUBLIC_ENDPOINT changes the presigned origin, so the policy must match. */
const OPTIONAL_PLAIN = ['S3_PUBLIC_ENDPOINT'];
const IDS = ['VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'];
const missing = [...SECRETS, ...PLAIN, ...IDS].filter((name) => !process.env[name]);
if (missing.length && !dry) {
  console.error(`missing environment variables: ${missing.join(', ')}`);
  process.exit(2);
}

class DeployError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const secretValues = SECRETS.map((name) => process.env[name]).filter((v) => v && v.length >= 4);
const scrub = (text) => secretValues.reduce((t, v) => t.split(v).join('***'), text);

function run(cmd, args, input, cwd = root) {
  console.log(`$ ${[cmd, ...args].join(' ')}${input === undefined ? '' : '   (value on stdin)'}`);
  if (dry) return;
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, env: process.env });
  if (result.stdout) process.stdout.write(scrub(result.stdout));
  if (result.stderr) process.stderr.write(scrub(result.stderr));
  if (result.error) throw new DeployError(`${cmd}: ${scrub(result.error.message)}`, 1);
  if (result.status !== 0) throw new DeployError(`${cmd} exited with ${result.status}`, result.status ?? 1);
}

const scratch = dry ? join(tmpdir(), 'hm-vercel-XXXXXX') : mkdtempSync(join(tmpdir(), 'hm-vercel-'));
const config = join(scratch, 'vercel.json');

try {
  // 1. Offline checks of vercel.json.
  run(process.execPath, ['--import', 'tsx', 'scripts/check-config.ts'], undefined, adapter);

  // 2. Project variables. The value is the standard input of the CLI, never an argument.
  const vars = [
    ...SECRETS.filter((n) => !LOCAL.includes(n)).map((n) => [n, '--sensitive']),
    ...PLAIN.map((n) => [n, '--no-sensitive']),
    ...OPTIONAL_PLAIN.filter((n) => process.env[n]).map((n) => [n, '--no-sensitive']),
  ];
  for (const [name, flag] of vars)
    run('vercel', ['env', 'add', name, 'production', flag, '--force', '--yes'], process.env[name] ?? '');

  // 3. Build, prepare the database, deploy the prebuilt output. A failed build changes no table; the new code goes
  //    live only after its migrations ran. The values reach the script as environment, never argv.
  run('vercel', ['pull', '--yes', '--environment=production']);
  run(process.execPath, ['--import', 'tsx', 'scripts/security-headers.ts', config], undefined, adapter);
  run('vercel', ['build', '--prod', '--local-config', config]);
  run(process.execPath, ['--import', 'tsx', 'scripts/prepare-database.ts'], undefined, adapter);
  run('vercel', ['deploy', '--prebuilt', '--prod']);
  console.log('\nDone.');
} catch (error) {
  if (!(error instanceof DeployError)) throw error;
  console.error(error.message);
  process.exitCode = error.code;
} finally {
  if (!dry) rmSync(scratch, { recursive: true, force: true });
}
