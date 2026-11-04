import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url));
const root = resolve(dirname(script), '../../..');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

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
    expect(remote).toContain(
      `APP_VERSION=${COMMIT.slice(0, 12)} docker compose --env-file "$base/.env" up -d --build --wait --remove-orphans`,
    );
    expect(remote).toMatch(/if \[ ! -f "\$base\/\.env" \]; then .* exit 3; fi/);
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
