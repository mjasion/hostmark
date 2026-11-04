// The `hostmark-seed` Cloud Run Job (`node dist/seed.js`). Everything a job prints lands in Cloud Logging, so this seed
// never generates a key and never prints one: both values come from Secret Manager (`scripts/deploy.sh` stores them),
// as Fly and Railway pass theirs as platform secrets. The shared `packages/db` CLI prints the keys it generates (D14),
// which is right on the owner's terminal and wrong here.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '@hostmark/db';
import { createNodeDb } from '@hostmark/db/node';

export interface SeedJobEnv {
  DATABASE_URL?: string;
  SEED_API_KEY?: string;
  SEED_ADMIN_API_KEY?: string;
}

/** Returns the exit code. `log` and `error` receive no key value in any case. */
export async function runSeedJob(
  env: SeedJobEnv,
  log: (line: string) => void = console.log,
  error: (line: string) => void = console.error,
): Promise<number> {
  const missing = (['DATABASE_URL', 'SEED_API_KEY', 'SEED_ADMIN_API_KEY'] as const).filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    // Without both values the seed would generate a key, and a generated key is only usable if it is printed.
    error(
      `${missing.join(', ')} required: the seed job does not generate keys, because its output goes to Cloud Logging`,
    );
    return 1;
  }
  const { db, close } = createNodeDb(env.DATABASE_URL as string, { max: 1 });
  try {
    const result = await seed(db, { apiKey: env.SEED_API_KEY, adminApiKey: env.SEED_ADMIN_API_KEY });
    if (result.generated.apiKey || result.generated.adminApiKey) {
      error('the seed generated a key although both values were set; it is not printed');
      return 1;
    }
    log('seed applied');
    return 0;
  } catch (err) {
    // The message of a database error names no key; a key is only ever hashed before it reaches a query.
    error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await runSeedJob(process.env));
}
