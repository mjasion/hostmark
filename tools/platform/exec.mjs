// Shared by the platform-deploy scripts of adapters/railway, adapters/fly and adapters/vps (D240). Plain ESM, no
// dependency. A secret reaches a CLI as its environment or as a 0600 file, never as an argument, and every line a CLI
// prints passes through a scrubber before it is shown.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A refusal or a failed command; `code` becomes the exit code of the script. */
export class DeployError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** Returns the named variables, or throws (exit 2) naming every one that is unset or empty. Values are never shown. */
export function requireEnv(names, env = process.env) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) throw new DeployError(`missing environment variables: ${missing.join(', ')}`, 2);
  return Object.fromEntries(names.map((name) => [name, env[name]]));
}

/**
 * Returns a function that replaces each secret value with `***`. A multi-line value (an SSH key) is also replaced
 * line by line, because output is scrubbed one line at a time. Fragments shorter than 8 characters are left alone:
 * they would mask ordinary words, and a key line or a token is longer.
 */
export function scrubber(values) {
  const fragments = new Set();
  for (const value of values) {
    if (!value) continue;
    for (const part of [value, ...value.split(/\r?\n/)]) {
      const trimmed = part.trim();
      if (trimmed.length >= 8) fragments.add(trimmed);
    }
  }
  const ordered = [...fragments].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((out, fragment) => out.split(fragment).join('***'), text);
}

/** Copies a stream to `write` one complete line at a time, scrubbed; the rest is flushed when the stream ends. */
function pipeLines(stream, scrub, write) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const end = pending.lastIndexOf('\n');
    if (end === -1) return;
    write(scrub(pending.slice(0, end + 1)));
    pending = pending.slice(end + 1);
  });
  return new Promise((resolve) =>
    stream.on('end', () => {
      if (pending) write(scrub(pending));
      resolve();
    }),
  );
}

/**
 * Runs one command and resolves with its scrubbed standard output. Prints `$ cmd args` first. Standard input is
 * closed unless `stdin` is a file descriptor, so a CLI that would prompt fails instead of waiting. With `dry`, prints
 * and runs nothing. A non-zero exit rejects with a DeployError carrying that code.
 */
export function run(
  cmd,
  args,
  { cwd, env = process.env, stdin, scrub = (t) => t, dry = false, capture = false },
) {
  console.log(scrub(`$ ${[cmd, ...args].join(' ')}`));
  if (dry) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: [stdin ?? 'ignore', 'pipe', 'pipe'] });
    let captured = '';
    const out = pipeLines(child.stdout, scrub, (text) => {
      if (capture) captured += text;
      else process.stdout.write(text);
    });
    const err = pipeLines(child.stderr, scrub, (text) => process.stderr.write(text));
    child.on('error', (error) => reject(new DeployError(`${cmd}: ${scrub(error.message)}`, 1)));
    child.on('close', async (code, signal) => {
      await Promise.all([out, err]);
      if (code === 0) resolve(captured);
      else
        reject(
          new DeployError(`${cmd} ${signal ? `was killed by ${signal}` : `exited with ${code}`}`, code || 1),
        );
    });
  });
}

/**
 * The version a deployment reports in `x-version` (S14, D281): `APP_VERSION` when set, else the first 12 characters
 * of the commit of HEAD in `cwd` (the stamp of the VPS deploy), else of `GITHUB_SHA`. Throws (exit 2) when there is
 * none, so a deployment never reports `dev`, and refuses a value that is not a plain token, since it becomes an
 * argument of the platform CLI.
 */
export function appVersion({ cwd, env = process.env }) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const commit = head.status === 0 ? head.stdout.trim() : '';
  const version =
    env.APP_VERSION?.trim() ||
    (/^[0-9a-f]{40,64}$/.test(commit) ? commit.slice(0, 12) : '') ||
    env.GITHUB_SHA?.trim().slice(0, 12);
  if (!version)
    throw new DeployError(
      'APP_VERSION is not set and no commit was found: the deployment would report "dev"',
      2,
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version))
    throw new DeployError('APP_VERSION must be letters, digits, ".", "_" or "-" (at most 64)', 2);
  return version;
}

/** A fresh 0700 directory for secret files; `remove` deletes it with everything in it. */
export function privateDir(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  return {
    path,
    /** Writes `content` to a 0600 file in the directory and returns its path. */
    write(name, content) {
      const file = join(path, name);
      writeFileSync(file, content, { mode: 0o600 });
      return file;
    },
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** Runs `body`, prints a DeployError and sets the exit code from it; anything else is a bug and is rethrown. */
export async function main(body) {
  try {
    await body();
  } catch (error) {
    if (!(error instanceof DeployError)) throw error;
    console.error(error.message);
    process.exitCode = error.code;
  }
}
