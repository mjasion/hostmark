// Compile-time only (checked by `tsc`): every driver's database must be usable as `Database`,
// including the transaction object, so core code can stay driver independent.
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Database } from '../src';
import type * as schema from '../src/schema';

export function accepts(db: Database): Promise<void> {
  return db.transaction(async (tx) => {
    const inner: Database = tx;
    await inner.transaction(async (nested) => {
      const _n: Database = nested;
    });
  });
}

export const fromPostgresJs = (db: PostgresJsDatabase<typeof schema>) => accepts(db);
export const fromNeon = (db: NeonDatabase<typeof schema>) => accepts(db);
