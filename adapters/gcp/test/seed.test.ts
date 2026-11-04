import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { apiKeys, hashApiKey } from '@hostmark/db';
import { createNodeDb, migrate } from '@hostmark/db/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedJob } from '../src/seed';

const databaseUrl = process.env.DATABASE_URL;

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe('seed job (Cloud Run Job output goes to Cloud Logging)', () => {
  it('is the bundle that the hostmark-seed job runs', () => {
    expect(readFileSync(new URL('../build.mjs', import.meta.url), 'utf8')).toMatch(/seed: 'src\/seed\.ts'/);
  });

  it('refuses to run without both keys, so it never generates one, and prints no value', async () => {
    const out = capture();
    const err = capture();
    const code = await runSeedJob(
      { DATABASE_URL: 'postgres://unused', SEED_API_KEY: 'hm_only-regular-1234' },
      out.write,
      err.write,
    );
    expect(code).toBe(1);
    expect(err.lines.join('\n')).toMatch(/SEED_ADMIN_API_KEY required/);
    expect([...out.lines, ...err.lines].join('\n')).not.toContain('hm_only-regular-1234');
  });
});

(databaseUrl ? describe : describe.skip)('seed job against Postgres', () => {
  const name = `hm_gcp_seed_${randomUUID().replaceAll('-', '')}`;
  let url: string;
  let admin: ReturnType<typeof createNodeDb>;

  beforeAll(async () => {
    admin = createNodeDb(databaseUrl as string, { max: 1 });
    await admin.db.execute(`create database ${name}`);
    const u = new URL(databaseUrl as string);
    u.pathname = `/${name}`;
    url = u.toString();
    await migrate(url);
  });

  afterAll(async () => {
    await admin?.db.execute(`drop database if exists ${name} with (force)`);
    await admin?.close();
  });

  it('applies both keys from the environment and prints neither', async () => {
    const regular = `hm_${randomUUID().replaceAll('-', '')}`;
    const adminKey = `hm_${randomUUID().replaceAll('-', '')}`;
    const out = capture();
    const err = capture();
    const code = await runSeedJob(
      { DATABASE_URL: url, SEED_API_KEY: regular, SEED_ADMIN_API_KEY: adminKey },
      out.write,
      err.write,
    );
    expect(code).toBe(0);
    expect(out.lines).toEqual(['seed applied']);
    expect(err.lines).toEqual([]);

    const node = createNodeDb(url, { max: 1 });
    try {
      const rows = await node.db.select({ keyHash: apiKeys.keyHash, isAdmin: apiKeys.isAdmin }).from(apiKeys);
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ keyHash: await hashApiKey(regular), isAdmin: false });
      expect(rows).toContainEqual({ keyHash: await hashApiKey(adminKey), isAdmin: true });
    } finally {
      await node.close();
    }
  });
});
