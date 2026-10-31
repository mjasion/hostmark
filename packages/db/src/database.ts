import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema';

/**
 * Drizzle database over any PostgreSQL driver (postgres-js, node-postgres, Neon, Hyperdrive through
 * either). A transaction callback receives a `PgTransaction`, which is assignable to this type too, so
 * helpers can accept `Database` and run both inside and outside `db.transaction`.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
