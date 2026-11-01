import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Local keys come from the environment; for a loopback target the compose .env (gitignored) is a fallback. */
export function resolveKeys(env, loopback) {
  const out = { API_KEY: env.API_KEY ?? '', ADMIN_API_KEY: env.ADMIN_API_KEY ?? '' };
  const dotenv = join(repo, 'adapters', 'local', '.env');
  if (loopback && (!out.API_KEY || !out.ADMIN_API_KEY) && existsSync(dotenv)) {
    const vars = Object.fromEntries(
      readFileSync(dotenv, 'utf8')
        .split('\n')
        .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
    out.API_KEY ||= vars.SEED_API_KEY ?? '';
    out.ADMIN_API_KEY ||= vars.SEED_ADMIN_API_KEY ?? '';
  }
  return out;
}
