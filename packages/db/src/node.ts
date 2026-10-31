import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { Database } from './database';
import * as schema from './schema';

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export interface NodeDb {
  db: Database;
  close(): Promise<void>;
}

export function createNodeDb(url: string, options: { max?: number } = {}): NodeDb {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

export async function migrate(url: string): Promise<void> {
  // A dedicated single connection: migrations take locks and must not share a pool.
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await drizzleMigrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}
