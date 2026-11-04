// scripts/bootstrap.mjs (D256) against a fake wrangler, pnpm and node: nothing here reaches an account.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, DLQ_RETENTION_SECONDS, type Exec, secretValues } from '../scripts/bootstrap.mjs';
import { root } from './build';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const NEW_ID = 'feedfacecafebeef0123456789abcdef';
const ENV = {
  CLOUDFLARE_API_TOKEN: 'cf-token-secret-0123456789abcdef',
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  DATABASE_URL: 'postgres://owner:db-password-7f3a9c@ep-x.eu-central-1.aws.neon.tech:5432/hostmark',
  BETTER_AUTH_SECRET: 'auth-secret-0123456789-abcdefghijklmnop',
  R2_ACCESS_KEY_ID: 'r2-key-id-0123456789',
  R2_SECRET_ACCESS_KEY: 'r2-secret-0123456789-abcdefghij',
};

interface Call {
  args: string[];
  input?: string;
  env?: Record<string, string>;
}

/** Answers like wrangler would; `existing` names what the account already has. */
function fakeExec(
  existing: { hyperdrive?: boolean; queues?: boolean; bucket?: boolean } = {},
  fail?: RegExp,
) {
  const calls: Call[] = [];
  const exec: Exec = async (args, options = {}) => {
    calls.push({ args, input: options.input, env: options.env });
    const line = args.join(' ');
    if (fail?.test(line)) return { code: 3, stdout: 'boom' };
    if (line.startsWith('wrangler r2 bucket create') && existing.bucket)
      return {
        code: 1,
        stdout: 'The bucket you tried to create already exists, and you own it. [code: 10004]',
      };
    if (line.startsWith('wrangler queues create') && existing.queues)
      return { code: 1, stdout: 'A queue with this name already exists' };
    if (line.startsWith('wrangler hyperdrive create'))
      return existing.hyperdrive
        ? { code: 1, stdout: 'A Hyperdrive config with the given name already exists [code: 2017]' }
        : { code: 0, stdout: `✅ Created new Hyperdrive PostgreSQL config: ${NEW_ID}` };
    if (line === 'wrangler hyperdrive list')
      return { code: 0, stdout: `│ ${NEW_ID} │ hostmark │ owner │ ep-x │ 5432 │` };
    return { code: 0, stdout: '' };
  };
  return { exec, calls, lines: () => calls.map((c) => c.args.join(' ')) };
}

describe('bootstrap', () => {
  let dir: string;
  beforeEach(() => {
    // A copy of the adapter's configs with the owner's values in, and the Hyperdrive id still the placeholder.
    dir = mkdtempSync(join(tmpdir(), 'hm-cf-bootstrap-'));
    mkdirSync(join(dir, 'r2'));
    cpSync(join(root, 'r2', 'cors.json'), join(dir, 'r2', 'cors.json'));
    for (const file of ['wrangler.api.jsonc', 'wrangler.consumer.jsonc', 'wrangler.scheduler.jsonc']) {
      const text = readFileSync(join(root, file), 'utf8')
        .replace('REPLACE_WITH_ACCOUNT_ID', ENV.CLOUDFLARE_ACCOUNT_ID)
        .replace('https://hostmark.example.com', 'https://hostmark.dev');
      writeFileSync(join(dir, file), text);
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runIt = (fake: ReturnType<typeof fakeExec>, env: Record<string, string> = ENV) =>
    bootstrap({ exec: fake.exec, env, root: dir, sha: SHA, log: () => {} });

  it('creates everything in order, then deploys the api first with APP_VERSION and redeploys the triggers', async () => {
    const fake = fakeExec();
    await runIt(fake);
    const lines = fake.lines();
    const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    expect(lines[0]).toBe('wrangler r2 bucket create hostmark-files');
    expect(lines).toContain('wrangler queues create image-jobs');
    expect(lines).toContain(
      `wrangler queues create image-jobs-dlq --message-retention-period-secs ${DLQ_RETENTION_SECONDS}`,
    );
    expect(DLQ_RETENTION_SECONDS).toBe(1_209_600);
    for (const [name, prefix] of [
      ['expire-originals', 'originals/'],
      ['expire-variants', 'variants/'],
    ])
      expect(lines).toContain(
        `wrangler r2 bucket lifecycle add hostmark-files ${name} ${prefix} --expire-days 8 --force`,
      );
    expect(lines.find((l) => l.startsWith('wrangler hyperdrive create'))).toMatch(
      /^wrangler hyperdrive create hostmark --connection-string \S+ --caching-disabled$/,
    );
    // The configs are complete before the deploy-mode check, the database before the Workers.
    expect(at('wrangler hyperdrive create')).toBeLessThan(
      at('node --import tsx scripts/check-config.ts --deploy'),
    );
    expect(at('node --import tsx scripts/check-config.ts --deploy')).toBeLessThan(
      at('pnpm --filter @hostmark/db run migrate'),
    );
    expect(at('pnpm --filter @hostmark/db run migrate')).toBeLessThan(
      at('pnpm --filter @hostmark/db run seed'),
    );
    expect(at('pnpm --filter @hostmark/db run seed')).toBeLessThan(at('node --import tsx scripts/build.mjs'));
    expect(at('node --import tsx scripts/build.mjs')).toBeLessThan(at('wrangler secret bulk'));
    const deploys = lines.filter((l) => / deploy --var /.test(l));
    expect(deploys).toEqual(
      ['api', 'consumer', 'scheduler'].map(
        (w) => `wrangler deploy --var APP_VERSION:${SHA} --config wrangler.${w}.jsonc`,
      ),
    );
    for (const w of ['api', 'consumer', 'scheduler'])
      expect(at(`wrangler secret bulk --config wrangler.${w}.jsonc`)).toBeLessThan(
        at(`wrangler deploy --var APP_VERSION:${SHA} --config wrangler.${w}.jsonc`),
      );
    expect(lines.at(-1)).toBe('wrangler triggers deploy --config wrangler.scheduler.jsonc');
  });

  it('sets CORS for PUBLIC_URL only, from a file that is gone afterwards', async () => {
    const fake = fakeExec();
    let seen: unknown;
    const exec: Exec = async (args, options) => {
      if (args.slice(0, 5).join(' ') === 'wrangler r2 bucket cors set')
        seen = JSON.parse(readFileSync(args[args.indexOf('--file') + 1] as string, 'utf8'));
      return fake.exec(args, options);
    };
    await bootstrap({ exec, env: ENV, root: dir, sha: SHA, log: () => {} });
    expect(seen).toMatchObject({
      rules: [{ allowed: { origins: ['https://hostmark.dev'], methods: ['GET', 'PUT'] } }],
    });
    const set = fake.calls.find((c) => c.args.includes('cors'));
    expect(() => readFileSync(set?.args[set.args.indexOf('--file') + 1] as string)).toThrow();
  });

  it('writes the new Hyperdrive id into the three configs', async () => {
    await runIt(fakeExec());
    for (const file of ['wrangler.api.jsonc', 'wrangler.consumer.jsonc', 'wrangler.scheduler.jsonc']) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text).toContain(`"id": "${NEW_ID}"`);
      expect(text).not.toContain('00000000000000000000000000000000');
    }
  });

  it('passes the Worker secrets on stdin only, and the database URL to the migration as environment', async () => {
    const fake = fakeExec();
    await runIt(fake);
    const bulk = fake.calls.filter((c) => c.args.includes('bulk'));
    expect(bulk).toHaveLength(3);
    for (const call of bulk)
      expect(JSON.parse(call.input ?? '')).toEqual({
        BETTER_AUTH_SECRET: ENV.BETTER_AUTH_SECRET,
        R2_ACCESS_KEY_ID: ENV.R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY: ENV.R2_SECRET_ACCESS_KEY,
      });
    for (const call of fake.calls) {
      const argv = call.args.join(' ');
      for (const name of [
        'CLOUDFLARE_API_TOKEN',
        'BETTER_AUTH_SECRET',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
      ] as const)
        expect(argv).not.toContain(ENV[name]);
      // The one documented exception: wrangler takes the Hyperdrive origin only as an argument (D256).
      if (!argv.startsWith('wrangler hyperdrive create')) expect(argv).not.toContain('db-password-7f3a9c');
    }
    const migrate = fake.calls.find((c) => c.args.includes('migrate'));
    expect(migrate?.env).toEqual({ DATABASE_URL: ENV.DATABASE_URL });
    expect(secretValues(ENV)).toContain('db-password-7f3a9c');
  });

  it('reuses what an earlier run created and sets the dead letter retention on the existing queue', async () => {
    const fake = fakeExec({ hyperdrive: true, queues: true, bucket: true });
    await runIt(fake);
    const lines = fake.lines();
    expect(lines).toContain(
      `wrangler queues update image-jobs-dlq --message-retention-period-secs ${DLQ_RETENTION_SECONDS}`,
    );
    expect(lines).toContain(
      `wrangler hyperdrive update ${NEW_ID} --connection-string ${ENV.DATABASE_URL} --caching-disabled`,
    );
    expect(readFileSync(join(dir, 'wrangler.api.jsonc'), 'utf8')).toContain(NEW_ID);
  });

  it('stops at the first failing command with its exit code', async () => {
    const fake = fakeExec({}, /^pnpm --filter @hostmark\/db run migrate/);
    await expect(runIt(fake)).rejects.toMatchObject({ code: 3 });
    expect(fake.lines().some((l) => /^wrangler (deploy|secret|triggers)/.test(l))).toBe(false);
  });

  it('refuses before any command without the variables or with a placeholder left in the configs', async () => {
    const missing = fakeExec();
    const { R2_SECRET_ACCESS_KEY: _, ...partial } = ENV;
    await expect(runIt(missing, partial)).rejects.toMatchObject({ code: 2, message: /R2_SECRET_ACCESS_KEY/ });
    expect(missing.calls).toEqual([]);

    writeFileSync(
      join(dir, 'wrangler.consumer.jsonc'),
      readFileSync(join(root, 'wrangler.consumer.jsonc'), 'utf8'),
    );
    const placeholder = fakeExec();
    await expect(runIt(placeholder)).rejects.toMatchObject({ code: 2, message: /REPLACE_WITH_ACCOUNT_ID/ });
    expect(placeholder.calls).toEqual([]);
  });

  it('as a command: refuses the committed configs and prints no secret', () => {
    const run = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'bootstrap.mjs'), '--dry-run', '--sha', SHA],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...ENV },
      },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/set the owner values in the configs first/);
    for (const value of Object.values(ENV)) expect(run.stdout + run.stderr).not.toContain(value);
  });
});
