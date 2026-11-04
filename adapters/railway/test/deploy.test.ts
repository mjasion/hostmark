import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url));
const root = resolve(dirname(script), '../../..');
const TOKEN = 'railway-project-token-0123456789-abcdef';
const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

// A fake `railway` that records argv, cwd and whether the token arrived as environment, and can leak or fail.
// FAKE_FAIL=<command>:<service> exits 9. `deployment list` prints the next status of FAKE_STATUS (comma separated,
// per service, the last one repeating; default SUCCESS) as Railway's JSON list, newest first.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const service = args[args.indexOf('--service') + 1];
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: args, cwd: process.cwd(), token: process.env.RAILWAY_TOKEN ?? null }) + '\\n');
if (process.env.FAKE_LEAK) { if (args[0] !== 'deployment') console.log('using token ' + process.env.RAILWAY_TOKEN); console.error('auth ' + process.env.RAILWAY_TOKEN); }
if (process.env.FAKE_FAIL === args[0] + ':' + service) process.exit(9);
if (args[0] === 'deployment') {
  const counter = process.env.FAKE_LOG + '.' + service;
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  const statuses = (process.env.FAKE_STATUS || 'SUCCESS').split(',');
  const status = statuses[Math.min(n, statuses.length - 1)];
  console.log(JSON.stringify([{ id: 'dep-' + service, status, createdAt: '2026-11-04T10:00:00Z' }, { id: 'old', status: 'REMOVED' }]));
}
`;

describe('railway deploy script', () => {
  let dir: string;
  let log: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hm-railway-fake-'));
    log = join(dir, 'log.jsonl');
    writeFileSync(join(dir, 'railway'), FAKE);
    chmodSync(join(dir, 'railway'), 0o755);
  });
  beforeEach(() => {
    for (const suffix of ['', '.api', '.worker', '.scheduler']) rmSync(log + suffix, { force: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [script, '--poll-seconds', '0', ...args], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_LOG: log, ...env },
    });
  const records = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; token: string | null });
  const list = (service: string) => ['deployment', 'list', '--service', service, '--json', '--limit', '1'];
  const dockerfile = 'RAILWAY_DOCKERFILE_PATH=adapters/railway/Dockerfile';

  it('per service of services.json, api first: sets the variables, uploads the root, checks the status', () => {
    const r = run([], { RAILWAY_TOKEN: TOKEN, APP_VERSION: 'v42' });
    expect(r.status, r.stderr).toBe(0);
    const set = (service: string, ...vars: string[]) => [
      'variable',
      'set',
      'APP_VERSION=v42',
      dockerfile,
      ...vars,
      '--service',
      service,
      '--skip-deploys',
    ];
    expect(records().map((x) => x.argv)).toEqual([
      set('api', 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS=10', 'RAILWAY_HEALTHCHECK_TIMEOUT_SEC=60'),
      ['up', '--ci', '--service', 'api'],
      list('api'),
      set('worker', 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS=70'),
      ['up', '--ci', '--service', 'worker'],
      list('worker'),
      set('scheduler', 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30', 'RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0'),
      ['up', '--ci', '--service', 'scheduler'],
      list('scheduler'),
    ]);
    for (const rec of records()) {
      expect(rec.cwd).toBe(root);
      expect(rec.token).toBe(TOKEN); // the token reaches the CLI as environment only
    }
  });

  it('stamps every service with 12 characters of the commit when APP_VERSION is unset (S14, D281)', () => {
    expect(HEAD).toMatch(/^[0-9a-f]{40}/);
    const r = run([], { RAILWAY_TOKEN: TOKEN });
    expect(r.status, r.stderr).toBe(0);
    const sets = records().filter((x) => x.argv[0] === 'variable');
    expect(sets).toHaveLength(3);
    for (const s of sets) expect(s.argv).toContain(`APP_VERSION=${HEAD.slice(0, 12)}`);
  });

  it('waits while the newest deployment is in progress, then goes on (D284)', () => {
    const r = run([], { RAILWAY_TOKEN: TOKEN, FAKE_STATUS: 'BUILDING,DEPLOYING,SUCCESS' });
    expect(r.status, r.stderr).toBe(0);
    expect(records().filter((x) => x.argv[0] === 'deployment' && x.argv[3] === 'api')).toHaveLength(3);
    expect(r.stdout).toMatch(/api: DEPLOYING\n[\s\S]*api: SUCCESS/);
  });

  it.each(['FAILED', 'CRASHED', 'REMOVED', 'SLEEPING'])(
    'stops when the deployment ends %s after railway up returned 0',
    (status) => {
      const r = run([], { RAILWAY_TOKEN: TOKEN, FAKE_STATUS: `DEPLOYING,${status}` });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`api: the deployment ended ${status}`);
      expect(records().some((x) => x.argv.includes('worker'))).toBe(false);
    },
  );

  it('stops when the deployment is still in progress at the status timeout', () => {
    const r = run(['--status-timeout', '0'], { RAILWAY_TOKEN: TOKEN, FAKE_STATUS: 'DEPLOYING' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/api: still DEPLOYING 0 s after railway up returned/);
  });

  it('keeps the token out of argv and scrubs it from what the CLI prints', () => {
    const r = run([], { RAILWAY_TOKEN: TOKEN, FAKE_LEAK: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(r.stdout).toContain('using token ***');
    for (const rec of records()) expect(JSON.stringify(rec.argv)).not.toContain(TOKEN);
  });

  it('stops at the first failing command with its exit code', () => {
    const r = run([], { RAILWAY_TOKEN: TOKEN, FAKE_FAIL: 'up:api' });
    expect(r.status).toBe(9);
    expect(r.stderr).toMatch(/railway exited with 9/);
    expect(records().map((x) => x.argv[0])).toEqual(['variable', 'up']);
  });

  it('does not upload when the variables cannot be set', () => {
    const r = run([], { RAILWAY_TOKEN: TOKEN, FAKE_FAIL: 'variable:api' });
    expect(r.status).toBe(9);
    expect(records().map((x) => x.argv[0])).toEqual(['variable']);
  });

  it('refuses to run without RAILWAY_TOKEN', () => {
    const r = run([], {});
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/missing environment variables: RAILWAY_TOKEN/);
    expect(existsSync(log)).toBe(false);
  });

  it('--dry-run prints the commands and runs nothing', () => {
    const r = run(['--dry-run'], {});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\$ railway up --ci --service scheduler/);
    expect(r.stdout).toContain(`$ railway variable set APP_VERSION=${HEAD.slice(0, 12)} ${dockerfile}`);
    expect(r.stdout).toContain('$ railway deployment list --service scheduler --json --limit 1');
    expect(existsSync(log)).toBe(false);
  });
});
