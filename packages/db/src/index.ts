// Driver independent: nothing here imports a PostgreSQL driver. Node helpers live in `@hostmark/db/node`.

export { generateApiKey, hashApiKey } from './api-key';
export type { Database } from './database';
export * as schema from './schema';
export * from './schema';
export {
  isReservedEmail,
  RESERVED_EMAILS,
  SEED_ADMIN_EMAIL,
  SEED_ADMIN_USER_ID,
  SEED_USER_EMAIL,
  SEED_USER_ID,
  type SeedOptions,
  type SeedResult,
  seed,
} from './seed';
