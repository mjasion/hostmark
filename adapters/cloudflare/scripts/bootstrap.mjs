// First deploy of the Cloudflare portable variant from a clean clone, in one command (acceptance criterion 1, D256):
//   pnpm install && pnpm --filter @hostmark/adapter-cloudflare bootstrap [--dry-run] [--sha <commit>]
// Later releases go through cloudflare-production.yml (D142), which needs a Worker that already serves 100%; this is
// what creates it (D143 (4)). Never run by CI or by a test against an account.
//
// Needs, in the environment: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (read by wrangler), DATABASE_URL (the
// direct Neon endpoint: migrations, seed and Hyperdrive), and the Worker secrets BETTER_AUTH_SECRET,
// R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY. Optional: SEED_API_KEY, SEED_ADMIN_API_KEY (otherwise generated and
// printed once by the seed). The plain values (account id, PUBLIC_URL) must already be in the three wrangler configs;
// the Hyperdrive id is the one value this script fills in itself.
//
// Secrets reach wrangler on standard input (`wrangler secret bulk`), never as an argument, and every line wrangler
// prints is scrubbed of them. The one exception is DATABASE_URL for `wrangler hyperdrive create`, which takes the
// origin only as arguments (wrangler 4.157 has no stdin or environment form): it is visible to other local users in
// the process list for the life of that command and is masked in what this script prints (D256).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DeployError, privateDir, requireEnv, scrubber } from '../../../tools/platform/exec.mjs';
import { hyperdriveIdFromList, hyperdriveIdFromOutput, parseJsonc } from '../pipeline/preview-config.mjs';
import { PLACEHOLDER_HYPERDRIVE_ID, placeholderProblems } from './placeholders.mjs';

const ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIGS = ['wrangler.api.jsonc', 'wrangler.consumer.jsonc', 'wrangler.scheduler.jsonc'];
export const WORKER_SECRETS = ['BETTER_AUTH_SECRET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
export const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'DATABASE_URL', ...WORKER_SECRETS];
/** Name of the production Hyperdrive config. */
export const HYPERDRIVE_NAME = 'hostmark';
/** The longest retention Queues allows (14 days, Workers Paid); the default of 4 days loses dead letters too soon. */
export const DLQ_RETENTION_SECONDS = 1_209_600;
/** D74: originals and variants expire after 8 days. */
const LIFECYCLE = [
  ['expire-originals', 'originals/'],
  ['expire-variants', 'variants/'],
];
const ALREADY = /already exist|already taken|already in use|already owned/i;

/**
 * @typedef {(args: string[], options?: { input?: string, env?: Record<string, string> }) => Promise<{ code: number, stdout: string }>} Exec
 * `args[0]` is `wrangler`, `pnpm` or `node`. `input` is written to standard input; without it stdin is closed.
 */

/**
 * The whole first deploy. Every command goes through `exec`, so the test runs it against a fake wrangler. Refuses
 * (exit 2) before the first command when a variable or an owner value in the configs is missing.
 *
 * @param {{ exec: Exec, env: Record<string, string | undefined>, root?: string, sha: string, log?: (line: string) => void }} input
 */
export async function bootstrap({ exec, env, root = ADAPTER, sha, log = console.log }) {
  const vars = requireEnv(REQUIRED, env);
  if (!/^[0-9a-f]{7,40}$/.test(sha ?? ''))
    throw new DeployError(`--sha must be a commit id, got "${sha}"`, 2);

  // 1. The owner's values. Hyperdrive is created below, so only its id may still be the placeholder.
  const texts = Object.fromEntries(CONFIGS.map((file) => [file, readFileSync(join(root, file), 'utf8')]));
  const configs = Object.fromEntries(CONFIGS.map((file) => [file, parseJsonc(texts[file])]));
  const problems = CONFIGS.flatMap((file) =>
    placeholderProblems(file, configs[file], { skip: ['hyperdrive'] }),
  );
  const ids = new Set(CONFIGS.flatMap((file) => (configs[file].hyperdrive ?? []).map((h) => h.id)));
  if (ids.size !== 1) problems.push('the three configs must share one Hyperdrive id');
  const api = configs['wrangler.api.jsonc'];
  const bucket = api.r2_buckets?.[0]?.bucket_name;
  const publicUrl = api.vars?.PUBLIC_URL;
  // The queue names come from the consumer config, which `pnpm check` holds to @hostmark/contract (D101).
  const consumer = configs['wrangler.consumer.jsonc'].queues?.consumers?.[0];
  const queue = consumer?.queue;
  const deadLetters = consumer?.dead_letter_queue;
  if (!queue || !deadLetters) problems.push('wrangler.consumer.jsonc: no consumer with a dead letter queue');
  if (!bucket) problems.push('wrangler.api.jsonc: no R2 bucket');
  if (!URL.canParse(publicUrl ?? '')) problems.push('wrangler.api.jsonc: vars.PUBLIC_URL is not a URL');
  if (problems.length > 0)
    throw new DeployError(`set the owner values in the configs first:\n- ${problems.join('\n- ')}`, 2);

  const run = async (args, options = {}) => {
    const result = await exec(args, options);
    if (result.code !== 0)
      throw new DeployError(`${args.slice(0, 3).join(' ')} exited with ${result.code}`, result.code);
    return result.stdout;
  };
  /** A create that may already have happened: "already exists" counts as done. */
  const create = async (args) => {
    const result = await exec(args);
    if (result.code === 0) return 'created';
    if (ALREADY.test(result.stdout)) return 'existed';
    throw new DeployError(`${args.slice(0, 4).join(' ')} exited with ${result.code}`, result.code);
  };
  const wrangler = (file, ...args) => ['wrangler', ...args, '--config', file];

  // 2. R2: bucket, CORS for the browser's presigned PUT from PUBLIC_URL only, and the 8 day expiry (D74).
  await create(['wrangler', 'r2', 'bucket', 'create', bucket]);
  const scratch = privateDir('hostmark-bootstrap-');
  try {
    const cors = JSON.parse(readFileSync(join(root, 'r2', 'cors.json'), 'utf8'));
    for (const rule of cors.rules) rule.allowed.origins = [new URL(publicUrl).origin];
    const corsFile = scratch.write('cors.json', `${JSON.stringify(cors, null, 2)}\n`);
    await run(['wrangler', 'r2', 'bucket', 'cors', 'set', bucket, '--file', corsFile, '--force']);
  } finally {
    scratch.remove();
  }
  for (const [name, prefix] of LIFECYCLE)
    await create([
      'wrangler',
      'r2',
      'bucket',
      'lifecycle',
      'add',
      bucket,
      name,
      prefix,
      '--expire-days',
      '8',
      '--force',
    ]);

  // 3. Queues. The dead letter queue keeps messages 14 days; an existing one is updated to that.
  await create(['wrangler', 'queues', 'create', queue]);
  const retention = ['--message-retention-period-secs', String(DLQ_RETENTION_SECONDS)];
  if ((await create(['wrangler', 'queues', 'create', deadLetters, ...retention])) === 'existed')
    await run(['wrangler', 'queues', 'update', deadLetters, ...retention]);

  // 4. Hyperdrive in front of the database, query cache off (D106). Its id goes into the three configs, which the
  //    owner then commits: the production pipeline deploys the committed files.
  let hyperdriveId = [...ids][0];
  if (hyperdriveId === PLACEHOLDER_HYPERDRIVE_ID) {
    const origin = ['--connection-string', vars.DATABASE_URL, '--caching-disabled'];
    const made = await exec(['wrangler', 'hyperdrive', 'create', HYPERDRIVE_NAME, ...origin]);
    if (made.code === 0) hyperdriveId = hyperdriveIdFromOutput(made.stdout);
    else if (ALREADY.test(made.stdout)) {
      hyperdriveId = hyperdriveIdFromList(await run(['wrangler', 'hyperdrive', 'list']), HYPERDRIVE_NAME);
      if (hyperdriveId) await run(['wrangler', 'hyperdrive', 'update', hyperdriveId, ...origin]);
    } else throw new DeployError(`wrangler hyperdrive create exited with ${made.code}`, made.code);
    if (!hyperdriveId) throw new DeployError('could not read the Hyperdrive id from the wrangler output', 1);
    for (const file of CONFIGS) {
      const text = texts[file].split(`"${PLACEHOLDER_HYPERDRIVE_ID}"`).join(`"${hyperdriveId}"`);
      writeFileSync(join(root, file), text);
    }
    log(`Hyperdrive ${hyperdriveId} written into ${CONFIGS.join(', ')}: commit these files.`);
  }

  // 5. The complete configs pass the offline check in deploy mode (D255).
  await run(['node', '--import', 'tsx', 'scripts/check-config.ts', '--deploy']);

  // 6. Database: expand-only migrations, then the seed (idempotent).
  const dbEnv = { DATABASE_URL: vars.DATABASE_URL };
  for (const name of ['SEED_API_KEY', 'SEED_ADMIN_API_KEY']) if (env[name]) dbEnv[name] = env[name];
  await run(['pnpm', '--filter', '@hostmark/db', 'run', 'migrate'], { env: dbEnv });
  await run(['pnpm', '--filter', '@hostmark/db', 'run', 'seed'], { env: dbEnv });

  // 7. Web assets, then each Worker: secrets on stdin first (a Worker that does not exist yet is created as a draft
  //    by `secret bulk`), then the deploy. The api first: the others bind to hostmark-api#Media.
  await run(['node', '--import', 'tsx', 'scripts/build.mjs']);
  const secrets = JSON.stringify(Object.fromEntries(WORKER_SECRETS.map((name) => [name, vars[name]])));
  for (const file of CONFIGS) {
    await run(wrangler(file, 'secret', 'bulk'), { input: secrets });
    await run(wrangler(file, 'deploy', '--var', `APP_VERSION:${sha}`));
  }
  // `wrangler deploy` sets the cron triggers too; this applies them again on their own, so a scheduler whose deploy
  // went through but whose triggers did not is put right by a rerun.
  await run(wrangler('wrangler.scheduler.jsonc', 'triggers', 'deploy'));
  log(`Deployed ${sha}. Next releases: cloudflare-production.yml (README).`);
}

/** The real `exec`: wrangler from this adapter, pnpm from PATH, node is this node. Output is scrubbed. */
export function realExec({ root = ADAPTER, scrub, env = process.env }) {
  const program = (name) =>
    name === 'wrangler'
      ? join(root, 'node_modules', '.bin', 'wrangler')
      : name === 'node'
        ? process.execPath
        : name;
  return (args, { input, env: extra = {} } = {}) => {
    console.log(scrub(`$ ${args.join(' ')}${input === undefined ? '' : '   (values on stdin)'}`));
    return new Promise((resolveRun, reject) => {
      const child = spawn(program(args[0]), args.slice(1), {
        cwd: args[0] === 'pnpm' ? resolve(root, '../..') : root,
        env: { ...env, ...extra },
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
        process.stdout.write(scrub(chunk));
      });
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
        process.stderr.write(scrub(chunk));
      });
      child.on('error', (error) => reject(new DeployError(`${args[0]}: ${scrub(error.message)}`, 1)));
      child.on('close', (code) => resolveRun({ code: code ?? 1, stdout }));
      if (input !== undefined) child.stdin.end(input);
    });
  };
}

/** Secret values to mask: each whole value, and the password inside DATABASE_URL on its own. */
export function secretValues(env) {
  const values = [
    'CLOUDFLARE_API_TOKEN',
    'DATABASE_URL',
    ...WORKER_SECRETS,
    'SEED_API_KEY',
    'SEED_ADMIN_API_KEY',
  ]
    .map((name) => env[name])
    .filter(Boolean);
  if (env.DATABASE_URL && URL.canParse(env.DATABASE_URL)) {
    const password = decodeURIComponent(new URL(env.DATABASE_URL).password);
    if (password) values.push(password);
  }
  return values;
}

async function cli(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean', default: false }, sha: { type: 'string' } },
  });
  const scrub = scrubber(secretValues(env));
  const exec = values['dry-run']
    ? async (args, { input } = {}) => {
        console.log(scrub(`$ ${args.join(' ')}${input === undefined ? '' : '   (values on stdin)'}`));
        return { code: 0, stdout: args[2] === 'create' && args[1] === 'hyperdrive' ? 'a'.repeat(32) : '' };
      }
    : realExec({ scrub, env });
  let sha = values.sha;
  if (!sha) {
    const head = await realExec({ scrub, env })(['git', 'rev-parse', 'HEAD']);
    sha = head.stdout.trim();
  }
  // A dry run prints every command and runs none; it reads and writes a copy of the configs.
  const dryRoot = values['dry-run'] ? dryCopy() : ADAPTER;
  await bootstrap({ exec, env, root: dryRoot, sha });
}

/** A scratch copy of the files a dry run reads and writes, so `--dry-run` leaves the repository untouched. */
function dryCopy() {
  const dir = privateDir('hostmark-bootstrap-dry-');
  mkdirSync(join(dir.path, 'r2'));
  for (const file of [...CONFIGS, 'r2/cors.json'])
    writeFileSync(join(dir.path, file), readFileSync(join(ADAPTER, file)));
  process.on('exit', () => dir.remove());
  return dir.path;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  cli().catch((error) => {
    if (!(error instanceof DeployError)) throw error;
    console.error(error.message);
    process.exitCode = error.code;
  });
}
