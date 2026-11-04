// scripts/deploy.sh against fake gcloud, terraform and docker: the state backend and the non-interactive apply (D247).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url));
const override = fileURLToPath(new URL('../infra/state_backend_override.tf', import.meta.url));

// Each fake appends its argv to FAKE_LOG. terraform also records whether the backend override exists at that moment.
const fake = (name: string, extra = '') => `#!/usr/bin/env bash
printf '%s\\n' "${name} $*" >> "$FAKE_LOG"
${extra}
exit 0
`;
const FAKES = {
  gcloud: fake('gcloud'),
  docker: fake('docker'),
  terraform: fake(
    'terraform',
    `if [ "$1" = init ]; then [ -f "$OVERRIDE" ] && printf 'override: %s\\n' "$(tr '\\n' ' ' < "$OVERRIDE")" >> "$FAKE_LOG"; fi
if [ "$1" = output ]; then echo 203.0.113.7; fi`,
  ),
};

const BASE = {
  GCP_PROJECT: 'hm-test',
  DOMAIN: 'bench.example.com',
  DATABASE_URL: 'postgres://u:p@db.example/hm',
  BETTER_AUTH_SECRET: 'a'.repeat(40),
  APP_VERSION: 'abc1234',
  SEED_API_KEY: 'hm_seed_user',
  SEED_ADMIN_API_KEY: 'hm_seed_admin',
};

describe('gcp deploy script', () => {
  let dir: string;
  let log: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hm-gcp-fake-'));
    for (const [name, body] of Object.entries(FAKES)) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    log = join(dir, `log-${Math.random()}`);
    writeFileSync(log, '');
  });

  const run = (env: Record<string, string>) => {
    const res = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: process.env.HOME ?? '',
        FAKE_LOG: log,
        OVERRIDE: override,
        ...BASE,
        ...env,
      },
    });
    return { ...res, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
  };
  const tf = (calls: string[], sub: string) => calls.filter((c) => c.startsWith(`terraform ${sub}`));

  it('refuses to run in CI without a state bucket, before touching anything', () => {
    const res = run({ CI: 'true' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('GCP_STATE_BUCKET is required in CI');
    expect(res.calls).toEqual([]);
  });

  it('in CI: state in the bucket, applies without asking, removes the override', () => {
    const res = run({ CI: 'true', GCP_STATE_BUCKET: 'hm-tfstate' });
    expect(res.status, res.stderr).toBe(0);
    expect(tf(res.calls, 'init')).toEqual([
      'terraform init -input=false -backend-config bucket=hm-tfstate -backend-config prefix=hostmark/gcp',
    ]);
    expect(res.calls).toContain('override: terraform {   backend "gcs" {} } ');
    const applies = tf(res.calls, 'apply');
    expect(applies).toHaveLength(2);
    for (const a of applies) expect(a).toMatch(/^terraform apply -input=false -auto-approve -var /);
    expect(existsSync(override)).toBe(false);
  });

  it('on a workstation: local state and a prompt, as before', () => {
    const res = run({});
    expect(res.status, res.stderr).toBe(0);
    expect(tf(res.calls, 'init')).toEqual(['terraform init -input=false']);
    expect(res.calls.some((c) => c.startsWith('override:'))).toBe(false);
    for (const a of tf(res.calls, 'apply')) expect(a).not.toContain('-auto-approve');
  });

  it('never puts a secret on a command line', () => {
    const res = run({ CI: 'true', GCP_STATE_BUCKET: 'hm-tfstate' });
    const all = res.calls.join('\n');
    for (const secret of [
      BASE.DATABASE_URL,
      BASE.BETTER_AUTH_SECRET,
      BASE.SEED_API_KEY,
      BASE.SEED_ADMIN_API_KEY,
    ])
      expect(all).not.toContain(secret);
  });
});
