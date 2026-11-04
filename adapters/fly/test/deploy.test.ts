import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url));
const root = resolve(dirname(script), '../../..');
const TOKEN = 'FlyV1 fm2_deploy-token-0123456789abcdefghij';
const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

// A fake `flyctl` that records argv, cwd and whether the token arrived as environment, and can leak or fail.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: args, cwd: process.cwd(), token: process.env.FLY_API_TOKEN ?? null }) + '\\n');
if (process.env.FAKE_LEAK) { console.log('token ' + process.env.FLY_API_TOKEN); console.error('auth ' + process.env.FLY_API_TOKEN); }
if (process.env.FAKE_FAIL === args[0]) process.exit(4);
`;

describe('fly deploy script', () => {
  let dir: string;
  let log: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hm-fly-fake-'));
    log = join(dir, 'log.jsonl');
    writeFileSync(join(dir, 'flyctl'), FAKE);
    chmodSync(join(dir, 'flyctl'), 0o755);
  });
  beforeEach(() => rmSync(log, { force: true }));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_LOG: log, ...env },
    });
  const records = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; token: string | null });

  it('deploys from the repository root with --ha=false, then pins the machine counts', () => {
    const r = run([], { FLY_API_TOKEN: TOKEN, APP_VERSION: 'v42' });
    expect(r.status, r.stderr).toBe(0);
    const config = ['--config', 'adapters/fly/fly.toml'];
    const build = ['--dockerfile', 'adapters/fly/Dockerfile', '--build-arg', 'APP_VERSION=v42'];
    expect(records().map((x) => x.argv)).toEqual([
      ['deploy', ...config, ...build, '--ha=false', '--yes', '.'],
      ['scale', 'count', 'api=1', 'worker=2', 'scheduler=1', ...config, '--yes'],
      ['status', ...config],
    ]);
    for (const rec of records()) {
      expect(rec.cwd).toBe(root);
      expect(rec.token).toBe(TOKEN);
    }
  });

  it('stamps the image with 12 characters of the commit when APP_VERSION is unset (S14, D281)', () => {
    expect(HEAD).toMatch(/^[0-9a-f]{40}/);
    const r = run([], { FLY_API_TOKEN: TOKEN });
    expect(r.status, r.stderr).toBe(0);
    const deploy = records()[0]?.argv ?? [];
    expect(deploy[deploy.indexOf('--build-arg') + 1]).toBe(`APP_VERSION=${HEAD.slice(0, 12)}`);
  });

  it('refuses an APP_VERSION that is not a plain token, before calling flyctl', () => {
    const r = run([], { FLY_API_TOKEN: TOKEN, APP_VERSION: '--yes; rm' });
    expect(r.status).toBe(2);
    expect(existsSync(log)).toBe(false);
  });

  it('sets a count for exactly the process groups of fly.toml, and one scheduler (D159)', () => {
    run([], { FLY_API_TOKEN: TOKEN });
    const scale = records().find((x) => x.argv[0] === 'scale')?.argv ?? [];
    const counts = Object.fromEntries(
      scale.filter((a) => a.includes('=')).map((a) => a.split('=') as [string, string]),
    );
    const toml = parse(readFileSync(join(root, 'adapters/fly/fly.toml'), 'utf8')) as {
      processes: Record<string, string>;
    };
    expect(Object.keys(counts).sort()).toEqual(Object.keys(toml.processes).sort());
    expect(counts.scheduler).toBe('1');
  });

  it('keeps the token out of argv and scrubs it from what flyctl prints', () => {
    const r = run([], { FLY_API_TOKEN: TOKEN, FAKE_LEAK: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    for (const rec of records()) expect(JSON.stringify(rec.argv)).not.toContain(TOKEN);
  });

  it('stops when the deploy fails, before scaling', () => {
    const r = run([], { FLY_API_TOKEN: TOKEN, FAKE_FAIL: 'deploy' });
    expect(r.status).toBe(4);
    expect(records().map((x) => x.argv[0])).toEqual(['deploy']);
  });

  it('refuses to run without FLY_API_TOKEN', () => {
    const r = run([], {});
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/missing environment variables: FLY_API_TOKEN/);
    expect(existsSync(log)).toBe(false);
  });

  it('--dry-run prints the commands and runs nothing', () => {
    const r = run(['--dry-run'], {});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\$ flyctl scale count api=1 worker=2 scheduler=1/);
    expect(r.stdout).toContain(`--build-arg APP_VERSION=${HEAD.slice(0, 12)}`);
    expect(existsSync(log)).toBe(false);
  });
});
