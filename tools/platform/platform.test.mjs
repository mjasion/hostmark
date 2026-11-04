import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from './cli.mjs';
import { parsePlatforms } from './schema.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEVEN = ['cloudflare', 'gcp', 'aws', 'railway', 'fly', 'vercel', 'vps'];

const entry = (name, over = {}) => ({
  name,
  enabled: false,
  adapter: `adapters/${name}`,
  status: 'emulated',
  secrets: [`${name.toUpperCase()}_TOKEN`],
  ...over,
});

/** A repository root holding the given platforms.json content and the named adapter directories. */
function fakeRoot(platforms, adapters = []) {
  const root = mkdtempSync(join(tmpdir(), 'hostmark-platform-'));
  writeFileSync(join(root, 'platforms.json'), JSON.stringify({ platforms }));
  for (const name of adapters) mkdirSync(join(root, 'adapters', name), { recursive: true });
  return root;
}

async function invoke(args, options) {
  const out = [];
  const err = [];
  let deployed = null;
  const deploy = async (platform) => {
    deployed = platform.name;
    return 0;
  };
  const code = await run(args, {
    env: {},
    ...options,
    deploy,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), deployed };
}

const real = parsePlatforms(readFileSync(join(repo, 'platforms.json'), 'utf8'));

test('platforms.json lists local and all seven platforms, every one disabled and emulated', () => {
  assert.deepEqual(real.map((p) => p.name).sort(), ['local', ...SEVEN].sort());
  for (const p of real) {
    assert.equal(p.enabled, false, p.name);
    assert.equal(p.status, 'emulated', p.name);
  }
});

test('deploy refuses every platform of platforms.json and starts nothing', async () => {
  for (const { name } of real) {
    // Every secret is set and the adapter exists, so only `enabled` can be the reason.
    const env = Object.fromEntries(real.find((p) => p.name === name).secrets.map((s) => [s, 'x']));
    const result = await invoke(['deploy', name], { env });
    assert.equal(result.code, 1, name);
    assert.match(result.err, /disabled/, name);
    assert.equal(result.deployed, null, name);
  }
});

test('an unknown name or a missing argument is a usage error', async () => {
  const unknown = await invoke(['deploy', 'heroku']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown platform "heroku"; known: local, cloudflare/);
  assert.equal((await invoke(['deploy'])).code, 2);
  assert.equal((await invoke(['check', 'heroku'])).code, 2);
  assert.equal((await invoke(['frobnicate'])).code, 2);
  assert.equal((await invoke([])).code, 2);
  assert.equal((await invoke(['list', 'aws'])).code, 2);
});

test('list shows the state and marks an adapter directory that does not exist', async () => {
  const root = fakeRoot([entry('aws'), entry('fly', { enabled: true })], ['fly']);
  const { code, out } = await invoke(['list'], { root });
  assert.equal(code, 0);
  assert.match(out, /aws\s+disabled\s+emulated\s+adapters\/aws \(missing\)/);
  assert.match(out, /fly\s+enabled\s+emulated\s+adapters\/fly$/);
});

test('check names the missing secrets and never prints a value', async () => {
  const root = fakeRoot([entry('aws', { secrets: ['AWS_A', 'AWS_B'] })], ['aws']);
  const result = await invoke(['check', 'aws'], { root, env: { AWS_A: 'hunter2' } });
  assert.equal(result.code, 1);
  assert.match(result.out, /AWS_A: set/);
  assert.match(result.out, /AWS_B: missing/);
  assert.doesNotMatch(result.out, /hunter2/);
  assert.equal((await invoke(['check', 'aws'], { root, env: { AWS_A: '1', AWS_B: '2' } })).code, 0);
});

test('deploy of an enabled platform needs its adapter and secrets, then starts', async () => {
  const platforms = [entry('aws', { enabled: true, secrets: ['AWS_A'] })];
  const noAdapter = await invoke(['deploy', 'aws'], { root: fakeRoot(platforms), env: { AWS_A: '1' } });
  assert.equal(noAdapter.code, 1);
  assert.match(noAdapter.err, /does not exist/);

  const root = fakeRoot(platforms, ['aws']);
  const noSecret = await invoke(['deploy', 'aws'], { root });
  assert.equal(noSecret.code, 1);
  assert.match(noSecret.err, /secrets missing for "aws": AWS_A/);
  assert.equal(noSecret.deployed, null);

  const ok = await invoke(['deploy', 'aws'], { root, env: { AWS_A: '1' } });
  assert.equal(ok.code, 0);
  assert.equal(ok.deployed, 'aws');
});

test('matrix holds only enabled platforms, and refuses a named disabled one', async () => {
  const root = fakeRoot([entry('aws'), entry('fly', { enabled: true }), entry('vps', { enabled: true })]);
  assert.deepEqual(JSON.parse((await invoke(['matrix'], { root })).out), {
    include: [{ name: 'fly' }, { name: 'vps' }],
  });
  assert.deepEqual(JSON.parse((await invoke(['matrix', 'fly'], { root })).out), {
    include: [{ name: 'fly' }],
  });
  assert.equal((await invoke(['matrix', 'aws'], { root })).code, 1);
  assert.deepEqual(JSON.parse((await invoke(['matrix'])).out), { include: [] });
});

test('an invalid platforms.json stops every command with the offending path', async () => {
  const root = fakeRoot([entry('aws', { enabled: 'no' })]);
  const result = await invoke(['list'], { root });
  assert.equal(result.code, 1);
  assert.match(result.err, /platforms\.0\.enabled/);
});

test('the schema rejects what would make a deployment ambiguous or unsafe', () => {
  const parse = (platforms) => () => parsePlatforms(JSON.stringify({ platforms }));
  assert.doesNotThrow(parse([entry('aws')]));
  assert.throws(parse([]), /too small|at least/i);
  assert.throws(parse([entry('aws'), entry('aws')]), /listed once/);
  assert.throws(parse([entry('aws', { status: 'live' })]));
  assert.throws(parse([entry('aws', { adapter: '../aws' })]));
  assert.throws(parse([entry('aws', { adapter: 'adapters/aws/x' })]));
  assert.throws(parse([entry('AWS')]));
  assert.throws(parse([entry('aws', { secrets: ['aws_token'] })]));
  assert.throws(parse([entry('aws', { secrets: ['A', 'A'] })]));
  assert.throws(parse([entry('aws', { secrets: [{ name: 'A', value: 'x' }] })]));
  assert.throws(parse([{ ...entry('aws'), token: 'x' }]));
  const { secrets: _, ...noSecrets } = entry('aws');
  assert.throws(parse([noSecrets]));
});

test('matrix --exclude drops a platform from "all" and refuses it by name', async () => {
  const root = fakeRoot([entry('cloudflare', { enabled: true }), entry('fly', { enabled: true })]);
  const all = await invoke(['matrix', '--exclude', 'cloudflare'], { root });
  assert.deepEqual(JSON.parse(all.out), { include: [{ name: 'fly' }] });
  const named = await invoke(['matrix', 'cloudflare', '--exclude', 'cloudflare'], { root });
  assert.equal(named.code, 1);
  assert.match(named.err, /excluded/);
  assert.equal((await invoke(['matrix', '--exclude', 'heroku'], { root })).code, 2);
  assert.equal((await invoke(['deploy', 'fly', '--exclude', 'fly'], { root })).code, 2);
});

const workflowText = (file) => readFileSync(join(repo, '.github', 'workflows', file), 'utf8');

test('the deploy workflow is manual only, main only, and references exactly the secrets of platforms.json', () => {
  const workflow = workflowText('deploy.yml');
  const triggers = workflow.match(/^on:\n((?: {2}.*\n|\n)+)/m)?.[1] ?? '';
  assert.match(triggers, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(triggers, /\b(push|pull_request|schedule|workflow_run)\b/);

  // Both jobs run only on main, because a branch carries its own platforms.json.
  assert.equal(workflow.match(/^ {4}if: github\.ref == 'refs\/heads\/main'/gm)?.length, 2);

  const referenced = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  const named = real.flatMap((p) => p.secrets);
  assert.deepEqual([...new Set(referenced)].sort(), [...new Set(named)].sort());

  // No secret is set before the last install: they are on the deploy step alone.
  assert.ok(workflow.indexOf('secrets.') > workflow.lastIndexOf('pnpm install'));
  assert.doesNotMatch(workflow, /^ {4}env:/m);
});

test('Cloudflare has one deployment route, cloudflare-production.yml, and deploy.yml is not it', () => {
  const workflow = workflowText('deploy.yml');
  const options = workflow.match(/options: \[(.*)\]/)?.[1].split(', ');
  assert.deepEqual(options, ['all', ...real.map((p) => p.name).filter((name) => name !== 'cloudflare')]);
  assert.match(workflow, /platform matrix "\$\{args\[@\]\}" --exclude cloudflare\)/);
  assert.match(
    readFileSync(join(repo, 'tools', 'platform', 'README.md'), 'utf8'),
    /cloudflare-production\.yml/,
  );
});

test('no workflow expression is expanded inside a shell command, and every action is pinned to a SHA', () => {
  for (const file of ['deploy.yml', 'ci.yml', 'pnpm-upgrade.yml']) {
    const lines = workflowText(file).split('\n');
    // A `run:` line or a line of its block scalar; blocks end at the next key with less indentation.
    let inRun = null;
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      if (inRun !== null && line.trim() !== '' && indent <= inRun) inRun = null;
      if (/^\s*(- )?run:/.test(line)) inRun = indent;
      if (/^\s*(- )?run:/.test(line) || inRun !== null)
        assert.doesNotMatch(line, /\$\{\{/, `${file}: ${line.trim()}`);
    }
    for (const line of lines.filter((l) => /\buses:/.test(l))) {
      assert.match(line, /uses: [\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${file}: ${line.trim()}`);
    }
  }
});

/** The text of one job of a workflow, from its key to the next job key. */
function jobText(workflow, name) {
  const start = workflow.search(new RegExp(`^ {2}${name}:\\n`, 'm'));
  assert.ok(start >= 0, `job ${name}`);
  const rest = workflow.slice(start + 1);
  const end = rest.search(/^ {2}[\w-]+:\n/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The steps of a job, each with its `name:` (or its first line) and its text. */
function steps(job) {
  return job
    .split(/^ {6}- /m)
    .slice(1)
    .map((text) => ({ name: /^(?:name: )?(.*)$/m.exec(text)?.[1] ?? '', text }));
}

test('only the deploy job may request an OIDC token; the default and the plan job read contents only', () => {
  const workflow = workflowText('deploy.yml');
  assert.match(workflow, /^permissions:\n {2}contents: read\n\n/m);
  assert.equal(workflow.match(/^ +id-token:/gm)?.length, 1);
  assert.doesNotMatch(jobText(workflow, 'plan'), /permissions:|id-token/);
  assert.match(jobText(workflow, 'deploy'), /^ {4}permissions:\n {6}contents: read\n {6}id-token: write\n/m);
});

test('each login and tool step runs for its own platform only, after the last install', () => {
  const deploy = steps(jobText(workflowText('deploy.yml'), 'deploy'));
  const install = deploy.findLastIndex((s) => /pnpm install/.test(s.text));
  const expected = {
    'Install the Railway CLI': 'railway',
    'Install flyctl': 'fly',
    'Install the Vercel CLI': 'vercel',
    'Log in to AWS': 'aws',
    'Log in to Google Cloud': 'gcp',
    'Set up gcloud': 'gcp',
    'Set up Terraform': 'gcp',
  };
  for (const [name, platform] of Object.entries(expected)) {
    const index = deploy.findIndex((s) => s.name === name);
    assert.ok(index > install, `${name} exists and comes after the install`);
    assert.match(deploy[index].text, new RegExp(`^ {8}if: matrix\\.name == '${platform}'$`, 'm'), name);
  }
  // Between the install and the deploy step, every step belongs to one platform.
  for (const step of deploy.slice(install + 1, -1))
    assert.match(step.text, /^ {8}if: matrix\.name == '[a-z]+'$/m, step.name);
  assert.equal(deploy.at(-1).name, 'Deploy');

  // AWS assumes the role through OIDC, never with a stored key; GCP uses Workload Identity Federation, no key file.
  const aws = deploy.find((s) => s.name === 'Log in to AWS').text;
  assert.match(aws, /role-to-assume: \$\{\{ secrets\.AWS_ROLE_ARN \}\}/);
  assert.doesNotMatch(aws, /aws-access-key-id|aws-secret-access-key/);
  const gcp = deploy.find((s) => s.name === 'Log in to Google Cloud').text;
  assert.match(gcp, /workload_identity_provider: \$\{\{ secrets\.GCP_WORKLOAD_IDENTITY_PROVIDER \}\}/);
  assert.match(gcp, /service_account: \$\{\{ secrets\.GCP_SERVICE_ACCOUNT \}\}/);
  assert.doesNotMatch(gcp, /credentials_json/);
});

test('a downloaded CLI is pinned to a version and checked against a SHA-256 before it is unpacked', () => {
  const deploy = steps(jobText(workflowText('deploy.yml'), 'deploy'));
  const downloads = deploy.filter((s) => /curl /.test(s.text));
  assert.equal(downloads.length, 2);
  for (const step of downloads) {
    assert.match(step.text, /VERSION: \d+\.\d+\.\d+\n/, step.name);
    assert.match(step.text, /SHA256: [0-9a-f]{64}\n/, step.name);
    assert.ok(step.text.indexOf('sha256sum --check') < step.text.indexOf('tar -x'), step.name);
  }
});

test('the vercel job installs the CLI its deploy script spawns, at one exact version (D270)', () => {
  const deploy = steps(jobText(workflowText('deploy.yml'), 'deploy'));
  const step = deploy.find((s) => s.name === 'Install the Vercel CLI');
  assert.ok(step, 'Install the Vercel CLI');
  const version = /^ {8}run: npm install --global vercel@(\d+\.\d+\.\d+)$/m.exec(step.text)?.[1];
  assert.ok(version, 'an exact version, no range and no tag');
  assert.doesNotMatch(step.text, /secrets\./);
  const script = readFileSync(join(repo, 'adapters', 'vercel', 'scripts', 'deploy.mjs'), 'utf8');
  assert.match(script, /run\('vercel', \[/);
  // The README names the version the workflow installs.
  const readme = readFileSync(join(repo, 'adapters', 'vercel', 'README.md'), 'utf8');
  assert.ok(readme.includes(`vercel@${version}`), `adapters/vercel/README.md names vercel@${version}`);
});

test('every platform that deploy.yml can reach has a platform-deploy script', () => {
  for (const p of real.filter((x) => !['cloudflare', 'local'].includes(x.name))) {
    const pkg = JSON.parse(readFileSync(join(repo, p.adapter, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts?.['platform-deploy'], `${p.adapter} has no platform-deploy script`);
  }
});

test('pnpm-upgrade.yml: dependency code runs without write access, and the patch may touch manifests only (D330)', () => {
  const text = workflowText('pnpm-upgrade.yml');
  assert.match(text, /^permissions: \{\}$/m);
  const update = text.slice(text.indexOf('\n  update:'), text.indexOf('\n  pr:'));
  const pr = text.slice(text.indexOf('\n  pr:'));
  assert.match(update, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(update, /contents: write|pull-requests: write|GH_TOKEN/);
  assert.match(update, /persist-credentials: false/);
  // The job with the write token installs and runs nothing from the dependencies.
  assert.doesNotMatch(pr, /^\s*(- )?(run: )?(pnpm|npm|npx|node)\s/m);
  assert.doesNotMatch(pr, /uses: (actions\/setup-node|pnpm\/action-setup)@/);
  assert.ok(
    pr.includes(
      String.raw`grep -vxE 'package\.json|(apps|packages|adapters)/[^/]+/package\.json|pnpm-lock\.yaml|adapters/cloudflare/licenses/THIRD-PARTY-LICENSES\.txt'`,
    ),
    'the patch filter allows only the manifests, the lockfile and the licence file',
  );
  // Minor and patch bumps through the script, majors never (D330).
  assert.match(update, /run: node tools\/deps\/bump\.mjs\n/);
  assert.doesNotMatch(text, /--latest/);
  // The licence file of the Cloudflare bundle is regenerated with the bump (D105).
  assert.match(update, /run: pnpm --filter @hostmark\/adapter-cloudflare run licenses/);
  assert.match(text, /cron: ["']23 9 \* \* 1["']/);
});
