// Entry point of the pipeline scripts. Workflows call `node adapters/cloudflare/pipeline/cli.mjs <command>` and pass
// everything a pull request can influence through environment variables or validated flags, never by pasting it
// into a shell script.
//
//   gate        <platforms.json> [--platform] [--require-deployed] [--same-repo <head> <base>]
//   provision   --pr N --sha S --public-url U --bucket B [--config wrangler.api.jsonc --config wrangler.consumer.jsonc]
//   teardown    --pr N [--config ...]
//   comment     --pr N --status deployed|failed|closed [--sha S] [--url U] [--branch B] [--print]
//   secrets-file --out F      writes the preview's Worker secrets (from PREVIEW_* variables) as JSON, mode 600
//   decide      --signal-file F
//   snapshot    --config wrangler.api.jsonc --config wrangler.consumer.jsonc   (outputs api=<id> consumer=<id>)
//   restore     --config wrangler.consumer.jsonc --stable <id> --config wrangler.api.jsonc --stable <id>
//   rollout     --config wrangler.api.jsonc --sha S --url U [--verify S1,S2]   (http probe + verification)
//   rollout     --config wrangler.consumer.jsonc --sha S --no-probe --verify S4  (no HTTP surface: verification only)
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { renderComment } from './comment.mjs';
import { runGate } from './gate.mjs';
import { upsertComment } from './github.mjs';
import { createNeonClient, positiveInt } from './neon.mjs';
import { parseJsonc, renderPreviewConfig } from './preview-config.mjs';
import { combine, runProbe } from './probe.mjs';
import { provisionPreview, teardownPreview } from './provision.mjs';
import {
  DEFAULT_POLICY,
  decideSafe,
  parseOutputFile,
  restoreStable,
  runRollout,
  servingVersion,
  uploadedVersionId,
} from './rollout.mjs';

/**
 * The repository tree to deploy. The pipeline scripts of a pull request preview run from a trusted (base) checkout and
 * are pointed at the pull request's tree with HOSTMARK_ROOT, so editing these scripts in a pull request changes
 * nothing about what runs with the secrets. Default: the tree these files are in.
 */
export function repositoryRoot(env, here) {
  return env.HOSTMARK_ROOT ? resolve(env.HOSTMARK_ROOT) : resolve(here, '../../..');
}

const ROOT = repositoryRoot(process.env, dirname(fileURLToPath(import.meta.url)));
const ADAPTER = join(ROOT, 'adapters/cloudflare');

const ALWAYS_PRIVATE = /^(NEON_|PREVIEW_|PRODUCTION_|LOAD_API_KEY$|GITHUB_TOKEN$|ACTIONS_)/;

/**
 * The environment of a child process. The migration and the load run execute repository code, so they get none of
 * the credentials; `wrangler` gets the Cloudflare ones and nothing else.
 */
export function scrubbed(env, forWrangler) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !ALWAYS_PRIVATE.test(name) && (forWrangler || !name.startsWith('CLOUDFLARE_')),
    ),
  );
}

/** Runs `wrangler` through pnpm in the adapter directory, anything else from the repository root. */
export function realExec(args, { env = {}, cwd } = {}) {
  const [command, ...rest] = args;
  const [file, argv, dir] =
    command === 'wrangler'
      ? ['pnpm', ['exec', 'wrangler', ...rest], cwd ?? ADAPTER]
      : [command, rest, cwd ?? ROOT];
  return new Promise((resolveExec) => {
    const child = spawn(file, argv, {
      cwd: dir,
      env: { ...scrubbed(process.env, command === 'wrangler'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      stdout += d;
      process.stderr.write(d);
    });
    child.on('error', (error) => resolveExec({ code: 127, stdout: String(error.message) }));
    child.on('close', (code) => resolveExec({ code: code ?? 1, stdout }));
  });
}

/** Worker secrets of a preview. They come from PREVIEW_* variables, so a production secret is never read by name. */
export function previewSecrets(env) {
  return {
    BETTER_AUTH_SECRET: need(env, 'PREVIEW_BETTER_AUTH_SECRET'),
    R2_ACCESS_KEY_ID: need(env, 'PREVIEW_R2_ACCESS_KEY_ID'),
    R2_SECRET_ACCESS_KEY: need(env, 'PREVIEW_R2_SECRET_ACCESS_KEY'),
  };
}

const need = (env, name) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

function setOutput(env, name, value) {
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `${name}=${String(value).replace(/[\r\n]/g, ' ')}\n`);
}

/** `wrangler.api.jsonc` of pull request 7 becomes `wrangler.api.pr-7.generated.jsonc` (git-ignored). */
export const generatedConfigName = (config, pr) => config.replace(/\.jsonc$/, `.pr-${pr}.generated.jsonc`);

const PREVIEW_CONFIGS = ['wrangler.api.jsonc', 'wrangler.consumer.jsonc'];
const readBase = (configPath) => parseJsonc(readFileSync(resolve(ADAPTER, configPath), 'utf8'));

export async function main(
  argv,
  {
    env = process.env,
    exec = realExec,
    fetch: fetchImpl = globalThis.fetch,
    log = console.log,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const [command, ...rest] = argv;
  if (command === 'gate') return runGate(rest, { env, print: log });

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      pr: { type: 'string' },
      sha: { type: 'string' },
      'public-url': { type: 'string' },
      bucket: { type: 'string' },
      config: { type: 'string', multiple: true },
      public: { type: 'string', default: 'wrangler.api.jsonc' },
      verify: { type: 'string', default: 'S1,S2' },
      'no-probe': { type: 'boolean', default: false },
      stable: { type: 'string', multiple: true },
      status: { type: 'string' },
      url: { type: 'string' },
      'run-url': { type: 'string' },
      branch: { type: 'string' },
      print: { type: 'boolean', default: false },
      'signal-file': { type: 'string' },
      out: { type: 'string' },
    },
  });
  void positionals;

  if (command === 'secrets-file') {
    if (!values.out) throw new Error('--out is required');
    writeFileSync(values.out, `${JSON.stringify(previewSecrets(env), null, 2)}\n`, { mode: 0o600 });
    return 0;
  }

  if (command === 'snapshot') {
    // Records, before anything changes, the version each Worker serves at 100%. A run that is cancelled or fails
    // puts exactly these back (`restore`). An unclear state refuses here, before the database is migrated.
    let failed = false;
    for (const config of values.config ?? []) {
      const role = /^wrangler\.([a-z]+)\.jsonc$/.exec(config)?.[1];
      const version = role ? await servingVersion(exec, config) : null;
      if (!version) {
        log(`cannot determine the version of ${config} serving 100% of traffic`);
        failed = true;
        continue;
      }
      log(`${config}: ${version} serves 100%`);
      setOutput(env, role, version);
    }
    return failed || !values.config ? 1 : 0;
  }

  if (command === 'restore') {
    // `--config wrangler.consumer.jsonc --stable <id>` pairs, in the order given (consumer first, then api).
    const configs = values.config ?? [];
    const stables = values.stable ?? [];
    if (configs.length === 0 || configs.length !== stables.length)
      throw new Error('restore needs as many --stable ids as --config files');
    let failed = false;
    for (const [index, config] of configs.entries()) {
      const result = await restoreStable({
        exec,
        config,
        stable: stables[index],
        message: `restore after a failed or cancelled run ${values.sha ?? ''}`.trim(),
      });
      log(`${config}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
      if (result.outcome === 'failed') failed = true;
    }
    return failed ? 1 : 0;
  }

  if (command === 'decide') {
    let signal;
    try {
      signal = JSON.parse(readFileSync(need({ F: values['signal-file'] }, 'F'), 'utf8'));
    } catch {
      signal = undefined; // a missing or unreadable signal is "no signal": rollback
    }
    const verdict = decideSafe(signal);
    log(`${verdict.action}: ${verdict.reason}`);
    setOutput(env, 'action', verdict.action);
    return verdict.action === 'promote' ? 0 : 1;
  }

  const pr = values.pr === undefined ? undefined : positiveInt(values.pr, '--pr');

  if (command === 'provision' || command === 'teardown') {
    const neon = createNeonClient({
      apiKey: need(env, 'NEON_API_KEY'),
      projectId: need(env, 'NEON_PROJECT_ID'),
      fetch: fetchImpl,
    });
    const configs = values.config ?? PREVIEW_CONFIGS;
    const bases = configs.map(readBase);
    if (command === 'teardown') {
      await teardownPreview({ exec, neon, bases, pr, log });
      return 0;
    }
    const result = await provisionPreview({
      exec,
      neon,
      bases,
      pr,
      neonEnv: {
        parentId: need(env, 'NEON_PREVIEW_PARENT_BRANCH_ID'),
        database: need(env, 'NEON_DATABASE'),
        role: need(env, 'NEON_ROLE'),
      },
      log,
    });
    const workers = bases.map((b) => b.name);
    configs.forEach((config, index) => {
      const rendered = renderPreviewConfig(bases[index], {
        pr,
        sha: values.sha,
        publicUrl: values['public-url'],
        previewBucket: values.bucket,
        hyperdriveId: result.hyperdriveId,
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        workers,
        isPublic: config === values.public,
      });
      writeFileSync(
        resolve(ADAPTER, generatedConfigName(config, pr)),
        `${JSON.stringify(rendered, null, 2)}\n`,
      );
    });
    setOutput(env, 'branch', result.branch);
    return 0;
  }

  if (command === 'comment') {
    const body = renderComment({
      status: values.status,
      sha: values.sha,
      url: values.url,
      runUrl: values['run-url'],
      databaseBranch: values.branch,
    });
    if (values.print) {
      log(body);
      return 0;
    }
    const result = await upsertComment({
      token: need(env, 'GITHUB_TOKEN'),
      repo: need(env, 'GITHUB_REPOSITORY'),
      pr,
      body,
      fetch: fetchImpl,
    });
    log(`comment ${result.action} (${result.id})`);
    return 0;
  }

  if (command === 'rollout') return rollout({ env, exec, fetch: fetchImpl, log, values, sleep });

  throw new Error(`unknown command ${JSON.stringify(command)}`);
}

async function rollout({ env, exec, fetch: fetchImpl, log, values, sleep }) {
  const [config] = values.config ?? [];
  if (!config) throw new Error('--config is required');
  const worker = readBase(config).name;
  const sha = values.sha;
  const url = values.url;
  const outDir = mkdtempSync(join(tmpdir(), 'hostmark-rollout-'));
  const outFile = join(outDir, 'wrangler-output.ndjson');

  // 1. What serves production now. If that is unclear nothing is uploaded or shifted, because there would be
  //    nothing certain to roll back to.
  const stable = await servingVersion(exec, config);
  if (!stable) {
    log('cannot determine the version serving 100% of production traffic: refusing to start a rollout');
    return 1;
  }

  // 2. Upload the candidate. It serves no traffic yet.
  const uploaded = await exec(
    [
      'wrangler',
      'versions',
      'upload',
      '--config',
      config,
      '--tag',
      sha,
      '--message',
      `commit ${sha}`,
      '--var',
      `APP_VERSION:${sha}`,
    ],
    {
      env: { WRANGLER_OUTPUT_FILE_PATH: outFile },
    },
  );
  let candidate = null;
  try {
    candidate = uploadedVersionId(parseOutputFile(readFileSync(outFile, 'utf8')));
  } catch {
    candidate = null;
  }
  if (uploaded.code !== 0 || !candidate) {
    log('uploading the candidate version failed or printed no version id: nothing was deployed');
    return 1;
  }

  const noProbe = values['no-probe'];
  let measure;
  if (!noProbe) {
    const probeInput = {
      baseUrl: url,
      workerName: worker,
      expectVersion: sha,
      fetch: fetchImpl,
      sleep,
      intervalMs: Number(env.PROBE_INTERVAL_MS ?? 200),
    };
    measure = async () => {
      const pinned = await runProbe({ ...probeInput, count: 30, override: candidate });
      const mixed = await runProbe({ ...probeInput, count: 30, expectVersion: undefined });
      return combine(pinned, mixed);
    };

    // 3. Judge the candidate while it still serves 0%: a broken build never sees a user.
    const preflight = decideSafe(await measure().catch(() => undefined));
    log(`preflight: ${preflight.action} (${preflight.reason})`);
    if (preflight.action === 'rollback') return 1;
  }

  const scenarios = values.verify.split(',').filter((id) => /^S[0-9]{1,2}$/.test(id));
  if (scenarios.length === 0) throw new Error('--verify needs scenario ids such as S1,S2');
  const verify = async () => {
    const loadEnv = {
      BASE_URL: url,
      API_KEY: need(env, 'LOAD_API_KEY'),
      REGION: 'cloudflare-global',
      VARIANT: sha,
      LOAD_ACK_REMOTE: new URL(url).host,
    };
    const result = await exec(['node', 'load/run.mjs', ...scenarios, '--short'], { env: loadEnv });
    return { ok: result.code === 0, detail: `load run exited ${result.code}` };
  };

  const result = await runRollout({
    exec,
    probe: measure,
    verify,
    sleep,
    log,
    candidate,
    stable,
    sha,
    config,
    policy: DEFAULT_POLICY,
  });
  log(`rollout: ${result.outcome} (${result.reason})`);
  setOutput(env, 'outcome', result.outcome);
  return result.outcome === 'promoted' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`pipeline: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
