import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Param = { ParameterKey: string; ParameterValue: string };
const script = fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url));

const SECRETS = {
  DATABASE_URL: 'postgres://user:db-secret-pw-7f3a@host.example/db',
  BETTER_AUTH_SECRET: 'auth-secret-0123456789-abcdefghijklmnop',
  ORIGIN_SECRET: 'origin-secret-0123456789-abcdefghijklmnop',
};

// A fake `aws` that records its argv and, when it gets a parameters file, what the file looked like.
const FAKE_AWS = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.FAKE_LOG;
fs.appendFileSync(log, JSON.stringify({ argv: args }) + '\\n');
const i = args.indexOf('--parameter-overrides');
if (i >= 0) {
  const path = args[i + 1].replace(/^file:\\/\\//, '');
  const mode = fs.statSync(path).mode & 0o777;
  const dirMode = fs.statSync(require('node:path').dirname(path)).mode & 0o777;
  const params = JSON.parse(fs.readFileSync(path, 'utf8'));
  fs.appendFileSync(log, JSON.stringify({ file: path, mode, dirMode, params }) + '\\n');
}
if (args.includes('describe-stacks')) process.stdout.write('some-output-value\\n');
`;

describe('deploy script', () => {
  let dir: string;
  let log: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hm-aws-fake-'));
    log = join(dir, 'log.jsonl');
    writeFileSync(join(dir, 'aws'), FAKE_AWS);
    chmodSync(join(dir, 'aws'), 0o755);
  });
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

  it('--dry-run prints the two pass deploy and the site sync, and runs nothing', () => {
    const r = run(['--dry-run', '--stack', 'hm', '--code-bucket', 'pkg'], SECRETS);
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('$ '));
    const deploys = lines.filter((l) => l.includes('cloudformation deploy'));
    expect(deploys).toHaveLength(2);
    expect(lines.some((l) => l.includes('s3 sync') && l.includes('/site/'))).toBe(true);
    expect(lines.some((l) => l.includes('create-invalidation'))).toBe(true);
    expect(existsSync(log)).toBe(false);
  });

  it('keeps secrets out of stdout, stderr and the argv of aws; the file is 0600 and removed', () => {
    const r = run(
      ['--skip-build', '--stack', 'hm', '--code-bucket', 'pkg', '--region', 'eu-central-1'],
      SECRETS,
    );
    expect(r.status, r.stderr).toBe(0);
    const records = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const argvs = records.filter((x) => x.argv).map((x) => JSON.stringify(x.argv));
    for (const secret of Object.values(SECRETS)) {
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
      for (const argv of argvs) expect(argv).not.toContain(secret);
    }
    const files = records.filter((x) => x.file);
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f.mode).toBe(0o600);
      expect(f.dirMode).toBe(0o700);
      const byKey = Object.fromEntries(f.params.map((p: Param) => [p.ParameterKey, p.ParameterValue]));
      expect(byKey.DatabaseUrl).toBe(SECRETS.DATABASE_URL);
      expect(byKey.BetterAuthSecret).toBe(SECRETS.BETTER_AUTH_SECRET);
      expect(byKey.OriginSecret).toBe(SECRETS.ORIGIN_SECRET);
      expect(existsSync(f.file)).toBe(false);
    }
    expect(
      Object.keys(Object.fromEntries(files[0].params.map((p: Param) => [p.ParameterKey, 1]))),
    ).not.toContain('DistributionId');
    expect(files[1].params.map((p: Param) => p.ParameterKey)).toContain('DistributionId');
  });

  it('removes the file and does not print secrets when aws fails', () => {
    writeFileSync(join(dir, 'aws'), `${FAKE_AWS}\nif (args.includes('deploy')) process.exit(5);\n`);
    rmSync(log, { force: true });
    const r = run(['--skip-build', '--code-bucket', 'pkg'], SECRETS);
    expect(r.status).toBe(5);
    for (const secret of Object.values(SECRETS)) expect(r.stdout + r.stderr).not.toContain(secret);
    const file = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((x) => x.file);
    expect(existsSync(file.file)).toBe(false);
  });

  it('refuses to run without the secrets', () => {
    const r = run(['--skip-build', '--code-bucket', 'pkg'], {});
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing environment variables');
  });
});
