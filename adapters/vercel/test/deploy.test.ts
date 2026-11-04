import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url));

const SECRETS = {
  VERCEL_TOKEN: 'tok-secret-0123456789-abcdefghijkl',
  DATABASE_URL: 'postgres://user:db-secret-pw-7f3a@host.example/db',
  BETTER_AUTH_SECRET: 'auth-secret-0123456789-abcdefghijklmnop',
  CRON_SECRET: 'cron-secret-0123456789-abcdef',
  S3_ACCESS_KEY_ID: 'akid-secret-0123456789',
  S3_SECRET_ACCESS_KEY: 'sak-secret-0123456789-abcdefghij',
  SEED_API_KEY: 'hm_seed-secret-0123456789',
  SEED_ADMIN_API_KEY: 'hm_seed-admin-secret-0123456789',
};
const PLAIN = {
  VERCEL_ORG_ID: 'team_abc',
  VERCEL_PROJECT_ID: 'prj_abc',
  PUBLIC_URL: 'https://hostmark.example.com',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'hostmark',
};

// A fake `vercel` that records argv and stdin, and echoes what it received (a leaky CLI) when asked.
const FAKE_VERCEL = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stdin = args[0] === 'env' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: args, stdin, hasToken: Boolean(process.env.VERCEL_TOKEN) }) + '\\n');
if (process.env.FAKE_LEAK) { process.stdout.write('added ' + stdin + '\\n'); process.stderr.write('echo ' + stdin + '\\n'); }
if (process.env.FAKE_FAIL && args[0] === 'build') process.exit(7);
`;

// Preloaded into every Node process through NODE_OPTIONS: it stands in for scripts/prepare-database.ts (which would
// need the database) and leaves every other process alone. It records what the script received and can echo it.
const FAKE_PREPARE = `import fs from 'node:fs';
if (process.argv[1]?.endsWith('prepare-database.ts')) {
  const env = { DATABASE_URL: process.env.DATABASE_URL, SEED_API_KEY: process.env.SEED_API_KEY, SEED_ADMIN_API_KEY: process.env.SEED_ADMIN_API_KEY };
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: ['prepare-database', ...process.argv.slice(2)], stdin: '', hasToken: Boolean(process.env.VERCEL_TOKEN), env }) + '\\n');
  if (process.env.FAKE_LEAK) { process.stdout.write('seeded ' + env.SEED_API_KEY + '\\n'); process.stderr.write('on ' + env.DATABASE_URL + '\\n'); }
  process.exit(process.env.FAKE_FAIL_PREPARE ? 5 : 0);
}
`;

describe('vercel deploy script', () => {
  let dir: string;
  let log: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hm-vercel-fake-'));
    log = join(dir, 'log.jsonl');
    writeFileSync(join(dir, 'vercel'), FAKE_VERCEL);
    chmodSync(join(dir, 'vercel'), 0o755);
    writeFileSync(join(dir, 'fake-prepare.mjs'), FAKE_PREPARE);
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
        NODE_OPTIONS: `--import ${pathToFileURL(join(dir, 'fake-prepare.mjs')).href}`,
        ...env,
      },
    });
  const records = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as { argv: string[]; stdin: string; hasToken: boolean; env?: Record<string, string> },
      );

  it('--dry-run prints the commands and runs no vercel', () => {
    const r = run(['--dry-run'], {});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\$ vercel deploy --prebuilt --prod/);
    expect(r.stdout).toMatch(/--import tsx scripts\/prepare-database\.ts\n/);
    expect(existsSync(log)).toBe(false);
  });

  it('passes secrets on stdin only: not in argv, stdout or stderr, even when the CLI echoes them', () => {
    const r = run([], { ...SECRETS, ...PLAIN, FAKE_LEAK: '1' });
    expect(r.status, r.stderr).toBe(0);
    for (const secret of Object.values(SECRETS)) {
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
      for (const rec of records()) expect(JSON.stringify(rec.argv)).not.toContain(secret);
    }
    const adds = records().filter((x) => x.argv[0] === 'env');
    const byName = Object.fromEntries(adds.map((x) => [x.argv[2], x.stdin]));
    expect(byName.DATABASE_URL).toBe(SECRETS.DATABASE_URL);
    expect(byName.CRON_SECRET).toBe(SECRETS.CRON_SECRET);
    expect(byName.VERCEL_TOKEN).toBeUndefined();
    // The seed keys are for the database step only; no function reads them, so they are no project variables.
    expect(byName.SEED_API_KEY).toBeUndefined();
    expect(byName.SEED_ADMIN_API_KEY).toBeUndefined();
    expect(records().every((x) => x.hasToken)).toBe(true); // the token reaches the CLI as environment only
    expect(records().at(-1)?.argv).toEqual(['deploy', '--prebuilt', '--prod']);
  });

  it('migrates and seeds after the build and before the deploy, with the values as environment (D277)', () => {
    const r = run([], { ...SECRETS, ...PLAIN });
    expect(r.status, r.stderr).toBe(0);
    const steps = records().map((x) => x.argv[0]);
    expect(steps.slice(-4)).toEqual(['pull', 'build', 'prepare-database', 'deploy']);
    const prepare = records().find((x) => x.argv[0] === 'prepare-database');
    expect(prepare?.argv).toEqual(['prepare-database']);
    expect(prepare?.env).toEqual({
      DATABASE_URL: SECRETS.DATABASE_URL,
      SEED_API_KEY: SECRETS.SEED_API_KEY,
      SEED_ADMIN_API_KEY: SECRETS.SEED_ADMIN_API_KEY,
    });
  });

  it('does not deploy when the database step fails', () => {
    const r = run([], { ...SECRETS, ...PLAIN, FAKE_FAIL_PREPARE: '1', FAKE_LEAK: '1' });
    expect(r.status).toBe(5);
    expect(records().some((x) => x.argv[0] === 'deploy')).toBe(false);
    for (const secret of Object.values(SECRETS)) expect(r.stdout + r.stderr).not.toContain(secret);
  });

  it('stops at the first failing command with its exit code and leaks nothing', () => {
    const r = run([], { ...SECRETS, ...PLAIN, FAKE_FAIL: '1' });
    expect(r.status).toBe(7);
    expect(records().some((x) => x.argv[0] === 'deploy')).toBe(false);
    // A failed build leaves the database alone.
    expect(records().some((x) => x.argv[0] === 'prepare-database')).toBe(false);
    for (const secret of Object.values(SECRETS)) expect(r.stdout + r.stderr).not.toContain(secret);
  });

  it('refuses to run without the variables', () => {
    const r = run([], { VERCEL_TOKEN: SECRETS.VERCEL_TOKEN });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/missing environment variables: .*DATABASE_URL/);
    expect(r.stderr).toMatch(/SEED_API_KEY, SEED_ADMIN_API_KEY/);
    expect(existsSync(log)).toBe(false);
  });
});
