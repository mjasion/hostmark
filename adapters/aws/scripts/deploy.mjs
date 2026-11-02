// One-command deploy of the aws-portable adapter. Run from the repository root:
//   pnpm --filter @hostmark/adapter-aws platform-deploy -- --stack hostmark --code-bucket <packaging-bucket>
// Also reachable as `pnpm platform deploy aws` (tools/platform, D70), which refuses unless platforms.json enables aws
// and every secret it names is set; `AWS_CODE_BUCKET` replaces `--code-bucket` there.
// `--dry-run` prints every command and runs none of them (no AWS call, no network).
// The script only shells out to the `aws` CLI with the caller's own credentials. Nothing is stored in the repository.
// Secrets (DATABASE_URL, BETTER_AUTH_SECRET, ORIGIN_SECRET) are read from the environment, written to a 0600 file in
// a fresh 0700 directory, handed to the CLI as `--parameter-overrides file://...` and removed afterwards. They are
// never in argv and never printed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

class DeployError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function run(cmd, args, options = {}) {
  console.log(`$ ${[cmd, ...args].join(' ')}`);
  if (dry) return { status: 0, stdout: '' };
  const result = spawnSync(cmd, args, {
    stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) throw new DeployError(`${cmd} exited with ${result.status}`, result.status ?? 1);
  return result;
}

const template = resolve(adapter, 'template.yaml');
const packaged = resolve(adapter, 'dist/packaged.yaml');
const scratch = dry ? undefined : mkdtempSync(resolve(tmpdir(), 'hostmark-aws-'));
const paramsFile = resolve(scratch ?? tmpdir(), 'parameters.json');

function deploy(extra) {
  const entries = [
    ['DatabaseUrl', process.env.DATABASE_URL],
    ['BetterAuthSecret', process.env.BETTER_AUTH_SECRET],
    ['OriginSecret', process.env.ORIGIN_SECRET],
    ['HostmarkRegion', process.env.HOSTMARK_REGION ?? 'frankfurt'],
    ...extra,
  ];
  if (!dry)
    writeFileSync(
      paramsFile,
      JSON.stringify(entries.map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }))),
      { mode: 0o600 },
    );
  run('aws', [
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

function output(key) {
  if (dry) return `<${key}>`;
  const query = `Stacks[0].Outputs[?OutputKey==\`${key}\`].OutputValue`;
  const args = ['cloudformation', 'describe-stacks', '--region', region, '--stack-name', stack];
  return run('aws', [...args, '--query', query, '--output', 'text'], { capture: true }).stdout.trim();
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
    run('pnpm', ['--filter', '@hostmark/web', 'build'], { env: rum });
    run('pnpm', ['--filter', '@hostmark/adapter-aws', 'build']);
  }

  // 2. Package the Lambda code and deploy, first pass: creates the distribution and everything else.
  run('aws', [
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
  deploy([]);

  // 3. Second pass: the functions learn the distribution id and the public URL (a Lambda environment cannot refer to
  //    the distribution that refers to the function, so the first pass cannot set them).
  const distributionId = output('DistributionId');
  const domain = output('DistributionDomain');
  const publicUrl = process.env.PUBLIC_URL ?? `https://${domain}`;
  deploy([
    ['DistributionId', distributionId],
    ['PublicUrl', publicUrl],
  ]);

  // 4. Web app into the content bucket under site/. Hashed assets are immutable; the HTML must be revalidated.
  const bucket = output('BucketName');
  const dist = 'apps/web/dist';
  const sync = ['s3', 'sync', dist, `s3://${bucket}/site/`, '--region', region, '--delete'];
  run('aws', [...sync, '--exclude', '*.html', '--cache-control', 'public, max-age=31536000, immutable']);
  run('aws', [
    ...sync,
    '--exclude',
    '*',
    '--include',
    '*.html',
    '--cache-control',
    'public, max-age=0, must-revalidate',
  ]);
  run('aws', ['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', '/*']);

  console.log(
    `\nDone. ${publicUrl}\nNext (once): DATABASE_URL=... pnpm --filter @hostmark/adapter-aws prepare-database`,
  );
} catch (error) {
  if (!(error instanceof DeployError)) throw error;
  console.error(error.message);
  process.exitCode = error.code;
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
