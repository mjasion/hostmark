import { randomUUID } from 'node:crypto';
import { apiKeys, type Database, hashApiKey, user } from '@hostmark/db';
import { createNodeDb, migrate, type NodeDb } from '@hostmark/db/node';
import { sql } from 'drizzle-orm';

export const databaseUrl = process.env.DATABASE_URL;

export interface TestDb {
  db: Database;
  close(): Promise<void>;
}

/** A private database per test file, so files can run in parallel and tests cannot see each other's rows. */
export async function createTestDb(): Promise<TestDb> {
  const base = new URL(databaseUrl as string);
  const name = `hm_core_${randomUUID().replaceAll('-', '')}`;
  const admin = createNodeDb(base.toString(), { max: 1 });
  await admin.db.execute(sql.raw(`create database ${name}`));
  const url = new URL(base);
  url.pathname = `/${name}`;
  await migrate(url.toString());
  const node: NodeDb = createNodeDb(url.toString(), { max: 5 });
  return {
    db: node.db,
    close: async () => {
      await node.close();
      await admin.db.execute(sql.raw(`drop database if exists ${name} with (force)`));
      await admin.close();
    },
  };
}

export const KEYS = { alice: 'key-alice', bob: 'key-bob', admin: 'key-admin' } as const;
export const USERS = { alice: 'user-alice', bob: 'user-bob', admin: 'user-admin' } as const;

export async function resetAndSeed(db: Database): Promise<{ apiKeyIds: Record<keyof typeof KEYS, string> }> {
  await db.execute(sql`truncate table file_variants, files, daily_stats, api_keys, "user" cascade`);
  await db.insert(user).values(
    (Object.keys(USERS) as (keyof typeof USERS)[]).map((k) => ({
      id: USERS[k],
      name: k,
      email: `${k}@users.test`,
    })),
  );
  const ids = {} as Record<keyof typeof KEYS, string>;
  for (const k of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
    const [row] = await db
      .insert(apiKeys)
      .values({ userId: USERS[k], keyHash: await hashApiKey(KEYS[k]), name: k, isAdmin: k === 'admin' })
      .returning({ id: apiKeys.id });
    ids[k] = (row as { id: string }).id;
  }
  return { apiKeyIds: ids };
}
