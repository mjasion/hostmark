// pnpm platform list | check <name> | deploy <name> | matrix [name] [--exclude <name>]   (D70, D120, D123)
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { parsePlatforms } from './schema.mjs';

const USAGE = `usage: pnpm platform <command>
  list                list platforms with their state
  check <name>        report missing secrets and adapter directory, without printing values
  deploy <name>       deploy an enabled platform; refuses when it is disabled
  matrix [name] [--exclude <name>]
                      print the GitHub Actions matrix of enabled platforms (or of one), without the excluded`;

const DEPLOY_SCRIPT = 'platform-deploy';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadPlatforms(root) {
  const file = join(root, 'platforms.json');
  try {
    return parsePlatforms(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new Error(`platforms.json is invalid:\n${issues.join('\n')}`);
    }
    throw new Error(`platforms.json cannot be read: ${error.message}`);
  }
}

function spawnDeploy(platform, root) {
  return new Promise((resolveExit) => {
    const child = nodeSpawn('pnpm', ['--dir', platform.adapter, 'run', DEPLOY_SCRIPT], {
      cwd: root,
      stdio: 'inherit',
    });
    child.on('error', () => resolveExit(1));
    child.on('close', (code) => resolveExit(code ?? 1));
  });
}

/** Pulls every `--exclude <name>` pair out of argv; a dangling flag stays behind as an unknown platform name. */
function splitExclude(argv) {
  const positional = [];
  const excluded = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exclude' && i + 1 < argv.length) excluded.push(argv[++i]);
    else positional.push(argv[i]);
  }
  return [positional, excluded];
}

/**
 * Runs one command and returns the exit code: 0 done, 1 refused or failed, 2 usage error or unknown name.
 * `deploy` is injectable so tests never start a deployment.
 */
export async function run(argv, { root = repoRoot, env = process.env, out, err, deploy = spawnDeploy } = {}) {
  const [positional, excluded] = splitExclude(argv);
  const [command, name, ...rest] = positional;
  const print = out ?? ((line) => console.log(line));
  const fail = err ?? ((line) => console.error(line));

  if (!['list', 'check', 'deploy', 'matrix'].includes(command)) {
    fail(command ? `unknown command "${command}"\n${USAGE}` : USAGE);
    return 2;
  }
  if (excluded.length > 0 && command !== 'matrix') {
    fail(`--exclude belongs to matrix\n${USAGE}`);
    return 2;
  }
  if (rest.length > 0 || (command === 'list' && name !== undefined)) {
    fail(`too many arguments\n${USAGE}`);
    return 2;
  }
  if (name === undefined && (command === 'check' || command === 'deploy')) {
    fail(`${command} needs a platform name\n${USAGE}`);
    return 2;
  }

  let platforms;
  try {
    platforms = loadPlatforms(root);
  } catch (error) {
    fail(error.message);
    return 1;
  }

  if (command === 'list') {
    const width = Math.max(...platforms.map((p) => p.name.length));
    for (const p of platforms) {
      const adapter = existsSync(join(root, p.adapter)) ? p.adapter : `${p.adapter} (missing)`;
      print(
        `${p.name.padEnd(width)}  ${p.enabled ? 'enabled ' : 'disabled'}  ${p.status.padEnd(8)}  ${adapter}`,
      );
    }
    return 0;
  }

  let selected = platforms;
  if (name !== undefined) {
    const platform = platforms.find((p) => p.name === name);
    if (!platform) {
      fail(`unknown platform "${name}"; known: ${platforms.map((p) => p.name).join(', ')}`);
      return 2;
    }
    selected = [platform];
  }

  if (command === 'matrix') {
    for (const skipped of excluded) {
      if (!platforms.some((p) => p.name === skipped)) {
        fail(`unknown platform "${skipped}"; known: ${platforms.map((p) => p.name).join(', ')}`);
        return 2;
      }
    }
    if (name !== undefined && excluded.includes(name)) {
      fail(`platform "${name}" is excluded from this deployment route; see D123`);
      return 1;
    }
    const enabled = selected.filter((p) => p.enabled && !excluded.includes(p.name));
    if (name !== undefined && enabled.length === 0) {
      fail(`platform "${name}" is disabled in platforms.json; refusing to plan a deployment`);
      return 1;
    }
    print(JSON.stringify({ include: enabled.map((p) => ({ name: p.name })) }));
    return 0;
  }

  const [platform] = selected;
  const missingSecrets = platform.secrets.filter((secret) => !env[secret]);
  const adapterPresent = existsSync(join(root, platform.adapter));

  if (command === 'check') {
    print(`${platform.name}: ${platform.enabled ? 'enabled' : 'disabled'}, ${platform.status}`);
    print(`adapter ${platform.adapter}: ${adapterPresent ? 'present' : 'missing'}`);
    for (const secret of platform.secrets)
      print(`${secret}: ${missingSecrets.includes(secret) ? 'missing' : 'set'}`);
    return missingSecrets.length === 0 && adapterPresent ? 0 : 1;
  }

  if (!platform.enabled) {
    fail(`platform "${platform.name}" is disabled in platforms.json; refusing to deploy (D70)`);
    return 1;
  }
  if (!adapterPresent) {
    fail(`adapter ${platform.adapter} of "${platform.name}" does not exist; refusing to deploy`);
    return 1;
  }
  if (missingSecrets.length > 0) {
    fail(`secrets missing for "${platform.name}": ${missingSecrets.join(', ')}; refusing to deploy`);
    return 1;
  }
  return deploy(platform, root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
