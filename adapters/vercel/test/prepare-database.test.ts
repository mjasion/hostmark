// D277: scripts/deploy.mjs migrates and seeds before `vercel deploy`, in a log that is kept, so no key is generated or
// printed. The Postgres part runs when DATABASE_URL is set, on a database of its own.
import { randomUUID } from 'node:crypto';
import { apiKeys, hashApiKey } from '@hostmark/db';
import { createNodeDb } from '@hostmark/db/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareDatabase } from '../scripts/prepare-database';

const databaseUrl = process.env.DATABASE_URL;

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => void lines.push(line) };
}

describe('prepare-database', () => {
  it('refuses to run without both keys, so it never generates one, and prints no value', async () => {
    const out = capture();
    const err = capture();
    const code = await prepareDatabase(
      { DATABASE_URL: 'postgres://u:pw-1234@127.0.0.1:1/db', SEED_API_KEY: 'hm_only-regular-1234' },
      out.write,
      err.write,
    );
    expect(code).toBe(1);
    expect(err.lines.join('\n')).toMatch(/^SEED_ADMIN_API_KEY required/);
    expect([...out.lines, ...err.lines].join('\n')).not.toMatch(/hm_only-regular-1234|pw-1234/);
  });

  it('reports a database it cannot reach without the URL', async () => {
    const out = capture();
    const err = capture();
    const url = 'postgres://u:pw-5678@127.0.0.1:1/db';
    const code = await prepareDatabase(
      { DATABASE_URL: url, SEED_API_KEY: 'hm_a-1234', SEED_ADMIN_API_KEY: 'hm_b-1234' },
      out.write,
      err.write,
    );
    expect(code).toBe(1);
    expect(err.lines.join('\n')).toMatch(/^migrations failed/);
    expect([...out.lines, ...err.lines].join('\n')).not.toMatch(/pw-5678|hm_a-1234|hm_b-1234/);
  });
});

(databaseUrl ? describe : describe.skip)('prepare-database against Postgres', () => {
  const name = `hm_vercel_prepare_${randomUUID().replaceAll('-', '')}`;
  let url: string;
  let admin: ReturnType<typeof createNodeDb>;

  beforeAll(async () => {
    admin = createNodeDb(databaseUrl as string, { max: 1 });
    await admin.db.execute(`create database ${name}`);
    const u = new URL(databaseUrl as string);
    u.pathname = `/${name}`;
    url = u.toString();
  });

  afterAll(async () => {
    await admin?.db.execute(`drop database if exists ${name} with (force)`);
    await admin?.close();
  });

  const keys = async () => {
    const node = createNodeDb(url, { max: 1 });
    try {
      return await node.db.select({ keyHash: apiKeys.keyHash, isAdmin: apiKeys.isAdmin }).from(apiKeys);
    } finally {
      await node.close();
    }
  };

  it('migrates an empty database, seeds both keys from the environment and prints neither; a rerun rotates', async () => {
    for (const round of [1, 2]) {
      const regular = `hm_${randomUUID().replaceAll('-', '')}`;
      const adminKey = `hm_${randomUUID().replaceAll('-', '')}`;
      const out = capture();
      const err = capture();
      const code = await prepareDatabase(
        { DATABASE_URL: url, SEED_API_KEY: regular, SEED_ADMIN_API_KEY: adminKey },
        out.write,
        err.write,
      );
      expect(code, `round ${round}: ${err.lines.join('\n')}`).toBe(0);
      expect(out.lines).toEqual(['migrations applied', 'seed applied']);
      expect(err.lines).toEqual([]);
      const rows = await keys();
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ keyHash: await hashApiKey(regular), isAdmin: false });
      expect(rows).toContainEqual({ keyHash: await hashApiKey(adminKey), isAdmin: true });
    }
  });
});
