// Deploy of the vps-portable adapter to a prepared server over SSH (README, "Deploy from GitHub Actions").
//   pnpm platform deploy vps           (D70; or `pnpm --dir adapters/vps run platform-deploy`)
// `--dry-run` prints the commands and runs none.
// Sends `git archive HEAD` to the server on the standard input of `ssh`, unpacks it into
// ~/hostmark/releases/<commit>, and runs `docker compose up -d --build --wait` there with ~/hostmark/.env, which the
// owner created once and which never leaves the server. The pipeline holds only SSH material: the private key and the
// pinned host key are written to 0600 files in a fresh 0700 directory, deleted afterwards, and are never arguments.
// Host key checking is strict against that pinned file only; an unknown or changed host key stops the deploy.
import { closeSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DeployError, main, privateDir, requireEnv, run, scrubber } from '../../../tools/platform/exec.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dry = values['dry-run'];

const NAMES = ['VPS_HOST', 'VPS_SSH_USER', 'VPS_SSH_KEY', 'VPS_SSH_KNOWN_HOSTS'];
const RELEASES_KEPT = 3;
/**
 * Seconds a wait of `docker compose up --wait` may take: a one-shot job (minio-user, minio-init, migrate, seed) or a
 * health check. The image build is not counted.
 */
const WAIT_TIMEOUT_SECONDS = 600;

/** Refuses values that ssh could read as an option or that are not what the name says, before anything runs. */
function validate({ VPS_HOST, VPS_SSH_USER, VPS_SSH_KEY, VPS_SSH_KNOWN_HOSTS }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(VPS_HOST) && !/^[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*$/.test(VPS_HOST))
    throw new DeployError('VPS_HOST must be a host name or an IP address, without user or port', 2);
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(VPS_SSH_USER))
    throw new DeployError('VPS_SSH_USER must be a plain user name', 2);
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(VPS_SSH_KEY))
    throw new DeployError('VPS_SSH_KEY must be a private key in PEM or OpenSSH format', 2);
  const entries = VPS_SSH_KNOWN_HOSTS.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (entries.length === 0 || entries.some((l) => l.trim().split(/\s+/).length < 3))
    throw new DeployError(
      'VPS_SSH_KNOWN_HOSTS must hold known_hosts lines (`ssh-keyscan` output, checked)',
      2,
    );
  if (/PRIVATE KEY/.test(VPS_SSH_KNOWN_HOSTS))
    throw new DeployError('VPS_SSH_KNOWN_HOSTS holds a private key; it takes the public host key', 2);
}

/** The script the server runs. It holds the commit id and nothing secret. */
function remoteScript(commit) {
  const version = commit.slice(0, 12);
  return [
    'set -eu',
    'base="$HOME/hostmark"',
    `release="$base/releases/${commit}"`,
    'if [ ! -f "$base/.env" ]; then echo "$base/.env is missing (adapters/vps/README.md)" >&2; exit 3; fi',
    'rm -rf "$release.partial"',
    'mkdir -p "$release.partial"',
    'tar -xzf - -C "$release.partial"',
    'rm -rf "$release"',
    'mv "$release.partial" "$release"',
    'cd "$release/adapters/vps"',
    // One Caddyfile path for every release (D285): a bind mount whose source moves with the release would make
    // Compose recreate Caddy, and drop connections, on every deploy. `cat >` rewrites the file in place, so the
    // mounted inode stays, and the reload below loads it (Caddy ignores a reload with an unchanged config).
    'cat Caddyfile > "$base/Caddyfile"',
    `export APP_VERSION=${version} CADDYFILE="$base/Caddyfile"`,
    // `--wait` alone waits without limit; a health check that never passes must fail the deploy (D286).
    `docker compose --env-file "$base/.env" up -d --build --wait --wait-timeout ${WAIT_TIMEOUT_SECONDS} --remove-orphans`,
    'docker compose --env-file "$base/.env" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile',
    'ln -sfn "$release" "$base/current"',
    `cd "$base/releases" && ls -1t | tail -n +${RELEASES_KEPT + 1} | xargs -r rm -rf --`,
    // Images of releases that were removed (D289): each deploy builds a new hostmark-vps:<version>. The images of the
    // kept releases stay for a manual rollback; one still used by a container is kept with a note.
    `keep="$(ls -1 | cut -c1-12)"`,
    `docker image ls --format '{{.Tag}}' hostmark-vps | while read -r tag; do`,
    '  case "$tag" in "" | "<none>") continue ;; esac',
    '  printf \'%s\\n\' "$keep" | grep -qxF -- "$tag" && continue',
    '  docker image rm "hostmark-vps:$tag" >/dev/null || echo "kept hostmark-vps:$tag: still in use" >&2',
    'done',
  ].join('\n');
}

await main(async () => {
  const env = dry ? Object.fromEntries(NAMES.map((n) => [n, `<${n}>`])) : requireEnv(NAMES);
  if (!dry) validate(env);
  const scrub = scrubber([env.VPS_SSH_KEY]);
  // git and ssh get the environment without the key: ssh reads it from the file only.
  const { VPS_SSH_KEY: _key, VPS_SSH_KNOWN_HOSTS: _hosts, ...childEnv } = process.env;
  const secrets = dry ? null : privateDir('hostmark-vps-');
  try {
    const dir = secrets?.path ?? '<private dir>';
    const key = secrets?.write(
      'id',
      env.VPS_SSH_KEY.endsWith('\n') ? env.VPS_SSH_KEY : `${env.VPS_SSH_KEY}\n`,
    );
    const knownHosts = secrets?.write('known_hosts', `${env.VPS_SSH_KNOWN_HOSTS.trim()}\n`);
    const archive = `${dir}/source.tar.gz`;

    const commit = dry
      ? '<commit>'
      : (await run('git', ['rev-parse', 'HEAD'], { cwd: root, env: childEnv, scrub, capture: true })).trim();
    if (!dry && !/^[0-9a-f]{40,64}$/.test(commit)) throw new DeployError(`unexpected commit id "${commit}"`);
    await run('git', ['archive', '--format=tar.gz', '-o', archive, 'HEAD'], {
      cwd: root,
      env: childEnv,
      scrub,
      dry,
    });

    const ssh = [
      '-F',
      'none',
      '-i',
      key ?? `${dir}/id`,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHosts ?? `${dir}/known_hosts`}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'ConnectTimeout=20',
      '-o',
      'ServerAliveInterval=30',
      '-l',
      env.VPS_SSH_USER,
      '--',
      env.VPS_HOST,
      remoteScript(commit),
    ];
    const stdin = dry ? undefined : openSync(archive, 'r');
    try {
      await run('ssh', ssh, { cwd: root, env: childEnv, scrub, dry, stdin });
    } finally {
      if (stdin !== undefined) closeSync(stdin);
    }
    console.log(`\nDone. ${env.VPS_HOST} runs ${commit.slice(0, 12)}.`);
  } finally {
    secrets?.remove();
  }
});
