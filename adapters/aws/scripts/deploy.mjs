// One-command deploy of the aws-portable adapter. Run from the repository root:
//   pnpm --filter @hostmark/adapter-aws platform-deploy -- --stack hostmark --code-bucket <packaging-bucket>
// Also reachable as `pnpm platform deploy aws` (tools/platform, D70), which refuses unless platforms.json enables aws
// and every secret it names is set; `AWS_CODE_BUCKET` replaces `--code-bucket` there.
// `--dry-run` prints every command and runs none of them (no AWS call, no network).
// The script only shells out to the `aws` CLI with the caller's own credentials. Nothing is stored in the repository.
// Secrets (DATABASE_URL, BETTER_AUTH_SECRET, ORIGIN_SECRET) are read from the environment, written to a 0600 file in
// a fresh 0700 directory, handed to the CLI as `--parameter-overrides file://...` and removed afterwards, also on
// SIGINT, SIGTERM and SIGHUP. They are never in argv and never printed.
// The version (`x-version`, S14) is APP_VERSION, else the short commit of HEAD, else GITHUB_SHA; a deploy without one
// is refused, so a deployment never reports `dev`.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const adapter = resolve(here, '..');
const root = resolve(adapter, '../..');

const { values } = parseArgs({
  options: {
    stack: { type: 'string', default: 'hostmark' },
    'code-bucket': { type: 'string' },
    region: { type: 'string', default: process.env.AWS_REGION ?? 'eu-central-1' },
    'dry-run': { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
  },
});

const dry = values['dry-run'];
const stack = values.stack;
const region = values.region;
const codeBucket =
  values['code-bucket'] ?? process.env.AWS_CODE_BUCKET ?? (dry ? '<code-bucket>' : undefined);
if (!codeBucket) {
  console.error(
    '--code-bucket or AWS_CODE_BUCKET (an existing S3 bucket for the packaged Lambda code) is required',
  );
  process.exit(2);
}
const missing = ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'ORIGIN_SECRET'].filter((name) => !process.env[name]);
if (missing.length && !dry) {
  console.error(`missing environment variables: ${missing.join(', ')}`);
  process.exit(2);
}

function commitVersion() {
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim()) return git.stdout.trim();
  return process.env.GITHUB_SHA?.slice(0, 7);
}
const appVersion = process.env.APP_VERSION || commitVersion() || (dry ? '<version>' : undefined);
if (!appVersion) {
  console.error('APP_VERSION is not set and no commit was found: the deployment would report version "dev"');
  process.exit(2);
}

class DeployError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** The command running now, so that a signal can be passed on to it. */
let child;

function run(cmd, args, options = {}) {
  console.log(`$ ${[cmd, ...args].join(' ')}`);
  if (dry) return Promise.resolve({ status: 0, stdout: '' });
  return new Promise((resolvePromise, reject) => {
    // Asynchronous, so that a signal handler runs while the command does (spawnSync blocks it until the end).
    const proc = spawn(cmd, args, {
      stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      cwd: root,
      env: { ...process.env, ...options.env },
    });
    child = proc;
    let stdout = '';
    proc.stdout?.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    proc.on('error', (error) => {
      child = undefined;
      reject(new DeployError(`${cmd}: ${error.message}`, 1));
    });
    proc.on('close', (status) => {
      child = undefined;
      if (status === 0) resolvePromise({ status, stdout });
      else reject(new DeployError(`${cmd} exited with ${status}`, status ?? 1));
    });
  });
}

/** The key core's deep health check reads (packages/core/src/http/app.ts); `template-check` pins both. */
const HEALTH_PROBE_KEY = 'healthcheck/probe';
const template = resolve(adapter, 'template.yaml');
const packaged = resolve(adapter, 'dist/packaged.yaml');
const scratch = dry ? undefined : mkdtempSync(resolve(tmpdir(), 'hostmark-aws-'));
const paramsFile = resolve(scratch ?? tmpdir(), 'parameters.json');

function removeScratch() {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
// `finally` does not run when a signal ends the process. The command gets the same signal (a terminal sends SIGINT to
// the whole group anyway, a CI cancel may signal only this process), and the exit code is the usual 128 + n.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(signal, () => {
    removeScratch();
    child?.kill(signal);
    process.exit(128 + constants.signals[signal]);
  });
process.on('exit', removeScratch);

async function deploy(extra) {
  const entries = [
    ['DatabaseUrl', process.env.DATABASE_URL],
    ['BetterAuthSecret', process.env.BETTER_AUTH_SECRET],
    ['OriginSecret', process.env.ORIGIN_SECRET],
    ['HostmarkRegion', process.env.HOSTMARK_REGION ?? 'frankfurt'],
    ['AppVersion', appVersion],
    ...extra,
  ];
  if (!dry)
    writeFileSync(
      paramsFile,
      JSON.stringify(entries.map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }))),
      { mode: 0o600 },
    );
  await run('aws', [
    'cloudformation',
    'deploy',
    '--region',
    region,
    '--stack-name',
    stack,
    '--template-file',
    packaged,
    '--capabilities',
    'CAPABILITY_IAM',
    '--no-fail-on-empty-changeset',
    '--parameter-overrides',
    `file://${paramsFile}`,
  ]);
}

async function output(key) {
  if (dry) return `<${key}>`;
  const query = `Stacks[0].Outputs[?OutputKey==\`${key}\`].OutputValue`;
  const args = ['cloudformation', 'describe-stacks', '--region', region, '--stack-name', stack];
  return (await run('aws', [...args, '--query', query, '--output', 'text'], { capture: true })).stdout.trim();
}

try {
  // 1. Web app (Vite build plus the two prerendered pages) and the three Lambda bundles.
  if (!values['skip-build']) {
    // The RUM attributes are baked into the HTML (closed lists in packages/contract).
    const rum = {
      HOSTMARK_PLATFORM: 'aws',
      HOSTMARK_VARIANT: 'portable',
      HOSTMARK_TOPOLOGY: process.env.HOSTMARK_TOPOLOGY ?? 'single',
      HOSTMARK_REGION: process.env.HOSTMARK_REGION ?? 'frankfurt',
    };
    await run('pnpm', ['--filter', '@hostmark/web', 'build'], { env: rum });
    await run('pnpm', ['--filter', '@hostmark/adapter-aws', 'build']);
  }

  // 2. Package the Lambda code and deploy, first pass: creates the distribution and everything else.
  console.log(`version ${appVersion}`);
  await run('aws', [
    'cloudformation',
    'package',
    '--region',
    region,
    '--template-file',
    template,
    '--s3-bucket',
    codeBucket,
    '--output-template-file',
    packaged,
  ]);
  await deploy([]);

  // 3. Second pass: the functions learn the distribution id and the public URL (a Lambda environment cannot refer to
  //    the distribution that refers to the function, so the first pass cannot set them).
  const distributionId = await output('DistributionId');
  const domain = await output('DistributionDomain');
  const publicUrl = process.env.PUBLIC_URL ?? `https://${domain}`;
  await deploy([
    ['DistributionId', distributionId],
    ['PublicUrl', publicUrl],
  ]);

  // 4. The empty object that /api/health/deep sends HEAD for. The api role may read only this key outside originals/
  //    and variants/, and without s3:ListBucket a missing key answers 403, which the check reports as storage down.
  const bucket = await output('BucketName');
  await run('aws', [
    's3api',
    'put-object',
    '--bucket',
    bucket,
    '--key',
    HEALTH_PROBE_KEY,
    '--region',
    region,
  ]);

  // 5. Web app into the content bucket under site/. Only the hashed files under assets/ are immutable. rum.js keeps
  //    its name between deploys (D85) and gets five minutes like every other unhashed file (D88); HTML revalidates.
  const dist = 'apps/web/dist';
  const sync = ['s3', 'sync', dist, `s3://${bucket}/site/`, '--region', region, '--delete'];
  const assets = ['--exclude', '*', '--include', 'assets/*'];
  await run('aws', [...sync, ...assets, '--cache-control', 'public, max-age=31536000, immutable']);
  const unhashed = ['--exclude', 'assets/*', '--exclude', '*.html'];
  await run('aws', [...sync, ...unhashed, '--cache-control', 'public, max-age=300']);
  const html = ['--exclude', '*', '--include', '*.html'];
  await run('aws', [...sync, ...html, '--cache-control', 'public, max-age=0, must-revalidate']);
  await run('aws', [
    'cloudfront',
    'create-invalidation',
    '--distribution-id',
    distributionId,
    '--paths',
    '/*',
  ]);

  console.log(
    `\nDone. ${publicUrl}\nNext (once): DATABASE_URL=... pnpm --filter @hostmark/adapter-aws prepare-database`,
  );
} catch (error) {
  if (!(error instanceof DeployError)) throw error;
  console.error(error.message);
  process.exitCode = error.code;
} finally {
  removeScratch();
}
