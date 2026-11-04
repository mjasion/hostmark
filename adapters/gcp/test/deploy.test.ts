// scripts/deploy.sh against fake gcloud, terraform and docker: the state backend and the non-interactive apply (D247),
// the migration before the services (D298) and secrets written only when they changed (D299).
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
// gcloud keeps Secret Manager in FAKE_SECRETS/<secret>/<n>.value and <n>.state; the values arrive on standard input only.
const GCLOUD_SECRETS = `if [ "$1 $2" = "secrets versions" ]; then
  op=$3; shift 3; secret=""; target=""; filter=""; limit=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --secret) secret=$2; shift 2 ;;
      --filter) filter=$2; shift 2 ;;
      --limit) limit=$2; shift 2 ;;
      --project|--format) shift 2 ;;
      --*) shift ;;
      *) [ -z "$target" ] && target=$1; shift ;;
    esac
  done
  case "$op" in
    access)
      d="$FAKE_SECRETS/$secret"; n=$(ls "$d" 2>/dev/null | grep -c '.value$')
      [ "$n" -gt 0 ] || exit 1
      cat "$d/$n.value" ;;
    add)
      d="$FAKE_SECRETS/$target"; mkdir -p "$d"; n=$(( $(ls "$d" | grep -c '.value$') + 1 ))
      cat > "$d/$n.value"; echo ENABLED > "$d/$n.state"
      echo "projects/hm-test/secrets/$target/versions/$n" ;;
    list)
      d="$FAKE_SECRETS/$target"; count=0
      for f in $(ls "$d" 2>/dev/null | grep '.state$' | sort -n); do
        n=\${f%.state}
        if [ "$filter" = state=ENABLED ] && [ "$(cat "$d/$f")" != ENABLED ]; then continue; fi
        echo "projects/hm-test/secrets/$target/versions/$n"; count=$((count + 1))
        if [ -n "$limit" ] && [ "$count" -ge "$limit" ]; then break; fi
      done ;;
    disable)
      echo DISABLED > "$FAKE_SECRETS/$secret/$target.state" ;;
  esac
fi`;
const FAKES = {
  gcloud: fake('gcloud', GCLOUD_SECRETS),
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
  let secrets: string;
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
    secrets = mkdtempSync(join(dir, 'secrets-'));
  });

  const run = (env: Record<string, string>) => {
    const res = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: process.env.HOME ?? '',
        FAKE_LOG: log,
        FAKE_SECRETS: secrets,
        OVERRIDE: override,
        ...BASE,
        ...env,
      },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    writeFileSync(log, '');
    return { ...res, calls };
  };
  /** The versions of a secret in the fake store, oldest first: value and state. */
  const versions = (secret: string) => {
    const d = join(secrets, secret);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.value'))
      .map((f) => Number.parseInt(f, 10))
      .sort((a, b) => a - b)
      .map((n) => ({
        value: readFileSync(join(d, `${n}.value`), 'utf8'),
        state: readFileSync(join(d, `${n}.state`), 'utf8').trim(),
      }));
  };
  const added = (calls: string[]) =>
    calls.filter((c) => c.startsWith('gcloud secrets versions add ')).map((c) => c.split(' ')[4]);
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
    expect(applies).toHaveLength(3);
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

  it('never puts a secret on a command line or on its output', () => {
    const OTLP_HEADERS = 'Authorization=Basic%20c2VjcmV0';
    const res = run({ CI: 'true', GCP_STATE_BUCKET: 'hm-tfstate', OTLP_HEADERS });
    expect(res.status, res.stderr).toBe(0);
    const all = [...res.calls, res.stdout, res.stderr].join('\n');
    for (const secret of [
      BASE.DATABASE_URL,
      BASE.BETTER_AUTH_SECRET,
      BASE.SEED_API_KEY,
      BASE.SEED_ADMIN_API_KEY,
      OTLP_HEADERS,
    ])
      expect(all).not.toContain(secret);
    // ...and yet every value reached Secret Manager.
    expect(versions('hostmark-database-url').map((v) => v.value)).toEqual([BASE.DATABASE_URL]);
    expect(versions('hostmark-otlp-headers').map((v) => v.value)).toEqual([OTLP_HEADERS]);
  });

  it('migrates on the new image before the services move to it (D298)', () => {
    const res = run({ CI: 'true', GCP_STATE_BUCKET: 'hm-tfstate' });
    expect(res.status, res.stderr).toBe(0);
    const at = (pred: (c: string) => boolean) => res.calls.findIndex(pred);
    const migrateJob = at(
      (c) =>
        c.startsWith('terraform apply') && c.endsWith(' -target=google_cloud_run_v2_job.operator["migrate"]'),
    );
    const migrate = at(
      (c) => c.startsWith('gcloud run jobs execute hostmark-migrate ') && c.endsWith(' --wait'),
    );
    const full = at((c) => c.startsWith('terraform apply') && !c.includes('-target='));
    const lastSecret = res.calls.findLastIndex((c) => c.startsWith('gcloud secrets versions add '));
    expect(lastSecret).toBeGreaterThanOrEqual(0);
    expect(migrateJob).toBeGreaterThan(lastSecret);
    expect(migrate).toBeGreaterThan(migrateJob);
    expect(full).toBeGreaterThan(migrate);
    expect(res.calls[migrateJob]).toContain(
      '-var image=europe-west3-docker.pkg.dev/hm-test/hostmark/hostmark:abc1234',
    );
  });

  it('stores a secret only when its value changed, and keeps one version enabled (D299)', () => {
    const first = run({});
    expect(first.status, first.stderr).toBe(0);
    expect(added(first.calls).sort()).toEqual([
      'hostmark-auth-secret',
      'hostmark-database-url',
      'hostmark-seed-admin-api-key',
      'hostmark-seed-api-key',
    ]);

    const same = run({});
    expect(same.status, same.stderr).toBe(0);
    expect(added(same.calls)).toEqual([]);
    expect(same.stdout).toContain('hostmark-database-url: unchanged');

    const rotated = run({ DATABASE_URL: 'postgres://u:p2@db.example/hm' });
    expect(rotated.status, rotated.stderr).toBe(0);
    expect(added(rotated.calls)).toEqual(['hostmark-database-url']);
    expect(versions('hostmark-database-url')).toEqual([
      { value: BASE.DATABASE_URL, state: 'DISABLED' },
      { value: 'postgres://u:p2@db.example/hm', state: 'ENABLED' },
    ]);
    expect(versions('hostmark-auth-secret').map((v) => v.state)).toEqual(['ENABLED']);
  });

  it('generates a missing seed key once and leaves it alone afterwards', () => {
    const env = { SEED_API_KEY: '', SEED_ADMIN_API_KEY: '' };
    expect(run(env).status).toBe(0);
    const generated = versions('hostmark-seed-api-key');
    expect(generated).toHaveLength(1);
    expect(generated[0]?.value).toMatch(/^hm_[0-9a-f]{64}$/);
    const again = run(env);
    expect(again.status, again.stderr).toBe(0);
    expect(added(again.calls)).toEqual([]);
    expect(versions('hostmark-seed-api-key')).toEqual(generated);
  });

  it('keeps signup off unless asked, and passes the telemetry settings (D290, D291)', () => {
    const off = run({});
    expect(off.status, off.stderr).toBe(0);
    for (const a of tf(off.calls, 'apply')) {
      expect(a).toContain('-var auth_signup_enabled=false');
      expect(a).toContain('-var otlp_endpoint= ');
      expect(a).toContain('-var otlp_headers=false');
    }
    expect(added(off.calls)).not.toContain('hostmark-otlp-headers');

    const on = run({
      AUTH_SIGNUP_ENABLED: 'true',
      OTLP_ENDPOINT: 'https://otlp.example.com',
      OTLP_HEADERS: 'Authorization=Basic%20eA',
    });
    expect(on.status, on.stderr).toBe(0);
    for (const a of tf(on.calls, 'apply')) {
      expect(a).toContain('-var auth_signup_enabled=true');
      expect(a).toContain('-var otlp_endpoint=https://otlp.example.com ');
      expect(a).toContain('-var otlp_headers=true');
    }
    expect(added(on.calls)).toContain('hostmark-otlp-headers');

    const bad = run({ AUTH_SIGNUP_ENABLED: 'yes' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('AUTH_SIGNUP_ENABLED must be true or false');
    expect(bad.calls).toEqual([]);
  });
});
