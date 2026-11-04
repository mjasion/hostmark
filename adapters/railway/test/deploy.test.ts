import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url));
const root = resolve(dirname(script), '../../..');
const TOKEN = 'railway-project-token-0123456789-abcdef';

// A fake `railway` that records argv, cwd and whether the token arrived as environment, and can leak or fail.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: args, cwd: process.cwd(), token: process.env.RAILWAY_TOKEN ?? null }) + '\\n');
if (process.env.FAKE_LEAK) { console.log('using token ' + process.env.RAILWAY_TOKEN); console.error('auth ' + process.env.RAILWAY_TOKEN); }
if (process.env.FAKE_FAIL === args[3]) process.exit(9);
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

  it('uploads the repository root once per service of services.json, api first, waiting for each', () => {
    const r = run([], { RAILWAY_TOKEN: TOKEN });
    expect(r.status, r.stderr).toBe(0);
    expect(records().map((x) => x.argv)).toEqual([
      ['up', '--ci', '--service', 'api'],
      ['up', '--ci', '--service', 'worker'],
      ['up', '--ci', '--service', 'scheduler'],
    ]);
    for (const rec of records()) {
      expect(rec.cwd).toBe(root);
      expect(rec.token).toBe(TOKEN); // the token reaches the CLI as environment only
    }
  });

  it('keeps the token out of argv and scrubs it from what the CLI prints', () => {
    const r = run([], { RAILWAY_TOKEN: TOKEN, FAKE_LEAK: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(r.stdout).toContain('using token ***');
    for (const rec of records()) expect(JSON.stringify(rec.argv)).not.toContain(TOKEN);
  });

  it('stops at the first failing service with its exit code', () => {
    const r = run([], { RAILWAY_TOKEN: TOKEN, FAKE_FAIL: 'api' });
    expect(r.status).toBe(9);
    expect(r.stderr).toMatch(/railway exited with 9/);
    expect(records()).toHaveLength(1);
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
    expect(existsSync(log)).toBe(false);
  });
});
