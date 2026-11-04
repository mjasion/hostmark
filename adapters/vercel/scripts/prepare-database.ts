// Migrations and seed of the deployment's database, run by scripts/deploy.mjs before `vercel deploy` (D277):
//   node --import tsx scripts/prepare-database.ts        (or `pnpm --filter @hostmark/adapter-vercel prepare-database`)
// The deploy usually runs in GitHub Actions, whose log is kept, so this never generates a key and never prints one:
// both seed keys come from the environment (D14, D75; as the GCP seed job does, D221). A value that differs from the
// stored key rotates it.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '@hostmark/db';
import { createNodeDb, migrate } from '@hostmark/db/node';

export interface PrepareEnv {
  DATABASE_URL?: string;
  SEED_API_KEY?: string;
  SEED_ADMIN_API_KEY?: string;
}

/** Returns the exit code. `log` and `error` receive no key value and no database URL in any case. */
export async function prepareDatabase(
  env: PrepareEnv,
  log: (line: string) => void = console.log,
  error: (line: string) => void = console.error,
): Promise<number> {
  const missing = (['DATABASE_URL', 'SEED_API_KEY', 'SEED_ADMIN_API_KEY'] as const).filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    // Without both values the seed would generate a key, and a generated key is only usable if it is printed.
    error(
      `${missing.join(', ')} required: the deploy seeds the database and never generates or prints a key`,
    );
    return 1;
  }
  const url = env.DATABASE_URL as string;
  try {
    await migrate(url);
    log('migrations applied');
  } catch (err) {
    error(`migrations failed: ${messageOf(err, env)}`);
    return 1;
  }
  const { db, close } = createNodeDb(url, { max: 1 });
  try {
    const result = await seed(db, { apiKey: env.SEED_API_KEY, adminApiKey: env.SEED_ADMIN_API_KEY });
    if (result.generated.apiKey || result.generated.adminApiKey) {
      error('the seed generated a key although both values were set; it is not printed');
      return 1;
    }
    log('seed applied');
    return 0;
  } catch (err) {
    error(`seed failed: ${messageOf(err, env)}`);
    return 1;
  } finally {
    await close();
  }
}

/** A database error names no key (keys are hashed before any query); the URL and the keys are removed anyway. */
function messageOf(err: unknown, env: PrepareEnv): string {
  const message = err instanceof Error ? err.message : String(err);
  return [env.DATABASE_URL, env.SEED_API_KEY, env.SEED_ADMIN_API_KEY]
    .filter((v): v is string => Boolean(v))
    .reduce((m, v) => m.split(v).join('***'), message);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await prepareDatabase(process.env));
}
