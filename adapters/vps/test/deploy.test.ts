import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url));
const root = resolve(dirname(script), '../../..');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// Not a real key: the script checks the PEM frame only, and the fake ssh compares bytes.
const KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBmYWtlLWtleS1mb3ItdGVzdHMtb25seS0wMTIzNDU2Nzg5YWJjZGVmAAAA',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');
const KNOWN_HOSTS = 'vps.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHBpbm5lZC1ob3N0LWtleQ';
const ENV = {
  VPS_HOST: 'vps.example.com',
  VPS_SSH_USER: 'deploy',
  VPS_SSH_KEY: KEY,
  VPS_SSH_KNOWN_HOSTS: KNOWN_HOSTS,
};

// A fake `git` that answers rev-parse and writes a stand-in archive, and a fake `ssh` that records argv, the files it
// was pointed at (content and mode), its standard input, and can leak the key or fail.
const FAKE_GIT = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cmd: 'git', argv: args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'rev-parse') console.log('${COMMIT}');
if (args[0] === 'archive') fs.writeFileSync(args[args.indexOf('-o') + 1], 'ARCHIVE-BYTES');
`;
const FAKE_SSH = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const option = (name) => args.find((a, i) => args[i - 1] === '-o' && a.startsWith(name + '='))?.split('=')[1];
const file = (p) => ({ path: p, content: fs.readFileSync(p, 'utf8'), mode: fs.statSync(p).mode & 0o777, dirMode: fs.statSync(path.dirname(p)).mode & 0o777 });
const key = file(args[args.indexOf('-i') + 1]);
const knownHosts = file(option('UserKnownHostsFile'));
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cmd: 'ssh', argv: args, key, knownHosts, stdin, env: Object.keys(process.env) }) + '\\n');
if (process.env.FAKE_LEAK) { console.log('key was ' + fs.readFileSync(key.path, 'utf8')); console.error(fs.readFileSync(key.path, 'utf8')); }
if (process.env.FAKE_FAIL) process.exit(255);
`;

type Rec = {
  cmd: string;
  argv: string[];
  cwd?: string;
  stdin?: string;
  env?: string[];
  key?: { path: string; content: string; mode: number; dirMode: number };
  knownHosts?: { path: string; content: string; mode: number };
};

describe('vps deploy script', () => {
  let dir: string;
  let log: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hm-vps-fake-'));
    log = join(dir, 'log.jsonl');
    writeFileSync(join(dir, 'git'), FAKE_GIT);
    writeFileSync(join(dir, 'ssh'), FAKE_SSH);
    chmodSync(join(dir, 'git'), 0o755);
    chmodSync(join(dir, 'ssh'), 0o755);
  });
  beforeEach(() => rmSync(log, { force: true }));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
        FAKE_LOG: log,
        TMPDIR: tmpdir(),
        ...env,
      },
    });
  const records = (): Rec[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  const sshCall = () => records().find((r) => r.cmd === 'ssh') as Rec;

  it('archives HEAD and streams it to the pinned host with strict host key checking', () => {
    const r = run([], ENV);
    expect(r.status, r.stderr).toBe(0);
    const [revParse, archive, ssh] = records();
    expect(revParse).toMatchObject({ cmd: 'git', argv: ['rev-parse', 'HEAD'], cwd: root });
    expect(archive?.argv.slice(0, 3)).toEqual(['archive', '--format=tar.gz', '-o']);
    expect(archive?.argv.at(-1)).toBe('HEAD');
    expect(ssh?.stdin).toBe('ARCHIVE-BYTES');

    const argv = ssh?.argv ?? [];
    expect(argv.slice(0, 2)).toEqual(['-F', 'none']);
    expect(argv).toContain('StrictHostKeyChecking=yes');
    expect(argv).toContain('BatchMode=yes');
    expect(argv).toContain('IdentitiesOnly=yes');
    expect(argv).toContain('GlobalKnownHostsFile=/dev/null');
    expect(argv.join(' ')).not.toMatch(/StrictHostKeyChecking=(no|accept-new|off)/);
    expect(argv.slice(-4, -1)).toEqual(['deploy', '--', 'vps.example.com']);
    expect(argv[argv.indexOf('-l') + 1]).toBe('deploy');
  });

  it('runs compose with the server-side .env and the commit as APP_VERSION', () => {
    run([], ENV);
    const remote = sshCall().argv.at(-1) ?? '';
    expect(remote).toMatch(/^set -eu\n/);
    expect(remote).toContain(`release="$base/releases/${COMMIT}"`);
    expect(remote).toContain('tar -xzf - -C "$release.partial"');
    expect(remote).toContain(`export APP_VERSION=${COMMIT.slice(0, 12)} CADDYFILE="$base/Caddyfile"`);
    expect(remote).toContain(
      'docker compose --env-file "$base/.env" up -d --build --wait --wait-timeout 600 --remove-orphans',
    );
    expect(remote).toMatch(/if \[ ! -f "\$base\/\.env" \]; then .* exit 3; fi/);
  });

  describe('the remote script, run in a shell with a fake docker (D285, D286, D289)', () => {
    const OLD = ['111111111111', '222222222222', '333333333333', '444444444444'];
    let home: string;
    let tarball: string;
    beforeAll(() => {
      // A real archive with the two files the remote script reads, and a fake docker that logs and lists images.
      const src = mkdtempSync(join(tmpdir(), 'hm-vps-src-'));
      mkdirSync(join(src, 'adapters/vps'), { recursive: true });
      writeFileSync(join(src, 'adapters/vps/Caddyfile'), read('Caddyfile'));
      writeFileSync(join(src, 'adapters/vps/docker-compose.yml'), read('docker-compose.yml'));
      tarball = join(dir, 'source.tar.gz');
      expect(spawnSync('tar', ['-czf', tarball, '-C', src, 'adapters']).status).toBe(0);
      rmSync(src, { recursive: true, force: true });
      writeFileSync(
        join(dir, 'docker'),
        `#!/bin/sh
printf '%s\\n' "{\\"argv\\":\\"$*\\",\\"cwd\\":\\"$PWD\\",\\"version\\":\\"$APP_VERSION\\",\\"caddyfile\\":\\"$CADDYFILE\\"}" >> "$FAKE_DOCKER_LOG"
if [ -n "$FAKE_DOCKER_FAIL" ]; then exit 1; fi
if [ "$1" = image ] && [ "$2" = ls ]; then printf '%s\\n' $FAKE_TAGS '<none>'; fi
if [ "$1" = image ] && [ "$2" = rm ] && [ "$3" = "hostmark-vps:$FAKE_IN_USE" ]; then exit 1; fi
exit 0
`,
      );
      chmodSync(join(dir, 'docker'), 0o755);
    });
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'hm-vps-home-'));
      mkdirSync(join(home, 'hostmark/releases'), { recursive: true });
      writeFileSync(join(home, 'hostmark/.env'), 'S3_BUCKET=hostmark\n');
      // Four earlier releases, oldest first: after this deploy the newest two of them and the new one are kept.
      OLD.forEach((v, i) => {
        const release = join(home, `hostmark/releases/${v}${'0'.repeat(28)}`);
        mkdirSync(release);
        utimesSync(release, 1_000_000 + i, 1_000_000 + i);
      });
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    const remote = (env: Record<string, string> = {}) => {
      run([], ENV);
      const dockerLog = join(home, 'docker.jsonl');
      const r = spawnSync('sh', ['-c', sshCall().argv.at(-1) ?? ''], {
        encoding: 'utf8',
        input: readFileSync(tarball),
        env: {
          HOME: home,
          PATH: `${dir}:/usr/bin:/bin`,
          FAKE_DOCKER_LOG: dockerLog,
          FAKE_TAGS: [...OLD, COMMIT.slice(0, 12), 'dev'].join(' '),
          ...env,
        },
      });
      const calls = existsSync(dockerLog)
        ? readFileSync(dockerLog, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as { argv: string; cwd: string; version: string; caddyfile: string })
        : [];
      return { r, calls };
    };

    it('starts the release with one Caddyfile path for every release, then reloads Caddy', () => {
      const { r, calls } = remote();
      expect(r.status, r.stderr).toBe(0);
      const caddyfile = join(home, 'hostmark/Caddyfile');
      expect(readFileSync(caddyfile, 'utf8')).toBe(read('Caddyfile'));
      const [up, reload] = calls;
      expect(up?.argv).toBe(
        `compose --env-file ${home}/hostmark/.env up -d --build --wait --wait-timeout 600 --remove-orphans`,
      );
      expect(up?.cwd).toBe(join(home, `hostmark/releases/${COMMIT}/adapters/vps`));
      expect(up?.version).toBe(COMMIT.slice(0, 12));
      expect(up?.caddyfile).toBe(caddyfile);
      expect(reload?.argv).toBe(
        `compose --env-file ${home}/hostmark/.env exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
      );
      expect(reload?.caddyfile).toBe(caddyfile);
      expect(readlinkSync(join(home, 'hostmark/current'))).toBe(join(home, `hostmark/releases/${COMMIT}`));
    });

    it('rewrites the Caddyfile in place, so the file Caddy has mounted changes too', () => {
      const caddyfile = join(home, 'hostmark/Caddyfile');
      writeFileSync(caddyfile, 'old config\n');
      const inode = statSync(caddyfile).ino;
      expect(remote().r.status).toBe(0);
      expect(statSync(caddyfile).ino).toBe(inode);
      expect(readFileSync(caddyfile, 'utf8')).toBe(read('Caddyfile'));
    });

    it('keeps three releases and removes the images of the others, not those of the kept ones', () => {
      const { r, calls } = remote();
      expect(r.status, r.stderr).toBe(0);
      const releases = readdirSync(join(home, 'hostmark/releases')).map((d) => d.slice(0, 12));
      expect(releases.sort()).toEqual([OLD[2], OLD[3], COMMIT.slice(0, 12)].sort());
      const removed = calls.filter((c) => c.argv.startsWith('image rm')).map((c) => c.argv);
      expect(removed).toEqual([
        `image rm hostmark-vps:${OLD[0]}`,
        `image rm hostmark-vps:${OLD[1]}`,
        'image rm hostmark-vps:dev',
      ]);
    });

    it('goes on when an old image is still in use, and says so', () => {
      const { r, calls } = remote({ FAKE_IN_USE: OLD[0] ?? '' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain(`kept hostmark-vps:${OLD[0]}: still in use`);
      expect(calls.filter((c) => c.argv.startsWith('image rm'))).toHaveLength(3);
    });

    it('stops before linking when compose fails, and keeps the old releases', () => {
      const { r, calls } = remote({ FAKE_DOCKER_FAIL: '1' });
      expect(r.status).not.toBe(0);
      expect(calls).toHaveLength(1);
      expect(existsSync(join(home, 'hostmark/current'))).toBe(false);
      expect(readdirSync(join(home, 'hostmark/releases'))).toHaveLength(5);
    });
  });

  it('hands the key and the host key over as 0600 files in a 0700 directory, removed afterwards', () => {
    run([], ENV);
    const { key, knownHosts } = sshCall();
    expect(key?.content).toBe(`${KEY}\n`);
    expect(key?.mode).toBe(0o600);
    expect(key?.dirMode).toBe(0o700);
    expect(knownHosts?.content).toBe(`${KNOWN_HOSTS}\n`);
    expect(knownHosts?.mode).toBe(0o600);
    expect(existsSync(key?.path ?? '')).toBe(false);
    expect(existsSync(dirname(key?.path ?? ''))).toBe(false);
    expect(sshCall().env).not.toContain('VPS_SSH_KEY');
  });

  it('keeps the key out of argv and scrubs it from the output, even when ssh prints it', () => {
    const r = run([], { ...ENV, FAKE_LEAK: '1' });
    expect(r.status, r.stderr).toBe(0);
    const keyLines = KEY.split('\n').filter((l) => !l.startsWith('-----'));
    for (const line of keyLines) {
      expect(r.stdout + r.stderr).not.toContain(line);
      for (const rec of records()) expect(JSON.stringify(rec.argv)).not.toContain(line);
    }
    expect(r.stdout).toContain('***');
  });

  it('fails with the ssh exit code and still removes the key', () => {
    const r = run([], { ...ENV, FAKE_FAIL: '1' });
    expect(r.status).toBe(255);
    expect(r.stderr).toMatch(/ssh exited with 255/);
    expect(existsSync(sshCall().key?.path ?? '')).toBe(false);
  });

  it('refuses to run without the variables, naming each', () => {
    const r = run([], { VPS_HOST: 'vps.example.com' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/missing environment variables: VPS_SSH_USER, VPS_SSH_KEY, VPS_SSH_KNOWN_HOSTS/);
    expect(records()).toEqual([]);
  });

  it.each([
    ['a host that ssh would read as an option', { VPS_HOST: '-oProxyCommand=sh' }, /VPS_HOST/],
    ['a host with a user', { VPS_HOST: 'root@vps.example.com' }, /VPS_HOST/],
    ['a user that is not a name', { VPS_SSH_USER: 'deploy -v' }, /VPS_SSH_USER/],
    ['a key that is not a private key', { VPS_SSH_KEY: 'ssh-ed25519 AAAA' }, /VPS_SSH_KEY/],
    ['known hosts without a key', { VPS_SSH_KNOWN_HOSTS: 'vps.example.com' }, /VPS_SSH_KNOWN_HOSTS/],
  ])('refuses %s before anything runs', (_, override, message) => {
    const r = run([], { ...ENV, ...override });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(records()).toEqual([]);
  });

  it('accepts an IPv6 address as the host', () => {
    const r = run([], { ...ENV, VPS_HOST: '2001:db8::10' });
    expect(r.status, r.stderr).toBe(0);
    expect(sshCall().argv.at(-2)).toBe('2001:db8::10');
  });

  it('--dry-run prints the commands and runs nothing', () => {
    const r = run(['--dry-run'], {});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\$ ssh -F none/);
    expect(records()).toEqual([]);
  });
});
