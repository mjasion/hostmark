import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import type { Database } from './database';
import * as schema from './schema';

/** For runtimes that own the connection (Workers with Hyperdrive create one client per request). No Node imports. */
export function databaseFromPostgresJs(client: Sql): Database {
  return drizzle(client, { schema });
}
