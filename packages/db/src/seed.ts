import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { generateApiKey, hashApiKey } from './api-key';
import type { Database } from './database';
import { apiKeys, files, user } from './schema';

export interface SeedOptions {
  /** Plain value of the regular key. Absent: an existing key of the seed user is kept, else one is generated. */
  apiKey?: string;
  /** Plain value of the admin key. Absent: an existing key of the admin user is kept, else one is generated. */
  adminApiKey?: string;
}

export interface SeedResult {
  /** Plain value of the key; undefined when an existing key was kept (its value is not recoverable). */
  apiKey: string | undefined;
  adminApiKey: string | undefined;
  /** True when the value was generated, so the caller has to show it once. */
  generated: { apiKey: boolean; adminApiKey: boolean };
}

export const SEED_USER_ID = 'seed-user';
export const SEED_ADMIN_USER_ID = 'seed-admin';

/**
 * Emails of the seed users, the single source for the seed and for signup (D80). A real account holding one of
 * them makes every later seed fail on the unique email, and adopting it would hand out admin, so signup refuses
 * both.
 */
export const SEED_USER_EMAIL = 'seed@hostmark.test';
export const SEED_ADMIN_EMAIL = 'admin@hostmark.test';
export const RESERVED_EMAILS: readonly string[] = [SEED_USER_EMAIL, SEED_ADMIN_EMAIL];

/** Case-insensitive and ignoring surrounding whitespace, the way Better Auth stores an email. */
export const isReservedEmail = (email: string): boolean =>
  RESERVED_EMAILS.includes(email.trim().toLowerCase());

/**
 * D14: users first (`api_keys.user_id` is NOT NULL), then one regular and one admin key. A value the caller
 * provides is the only key of its seed user afterwards (rotation, D75); an unset value keeps what exists and
 * generates a key only for a user without one. The seed users have no credentials and cannot log in.
 */
export async function seed(db: Database, options: SeedOptions = {}): Promise<SeedResult> {
  if (options.apiKey !== undefined && options.apiKey === options.adminApiKey)
    throw new Error('The regular and the admin API key must differ');

  const slots = [
    { userId: SEED_USER_ID, name: 'seed', isAdmin: false, provided: options.apiKey },
    { userId: SEED_ADMIN_USER_ID, name: 'seed-admin', isAdmin: true, provided: options.adminApiKey },
  ];
  const plain: (string | undefined)[] = slots.map((slot) => slot.provided);
  const generated: boolean[] = slots.map(() => false);

  await db.transaction(async (tx) => {
    await tx
      .insert(user)
      .values([
        { id: SEED_USER_ID, name: 'Seed user', email: SEED_USER_EMAIL },
        { id: SEED_ADMIN_USER_ID, name: 'Seed admin', email: SEED_ADMIN_EMAIL },
      ])
      .onConflictDoNothing();

    const wanted: { userId: string; keyHash: string; name: string; isAdmin: boolean }[] = [];
    const upsert = async () => {
      if (wanted.length === 0) return;
      await tx
        .insert(apiKeys)
        .values(wanted)
        .onConflictDoUpdate({
          target: apiKeys.keyHash,
          set: { userId: sql`excluded.user_id`, name: sql`excluded.name`, isAdmin: sql`excluded.is_admin` },
        });
      wanted.length = 0;
    };

    for (const slot of slots) {
      if (slot.provided === undefined) continue;
      const keyHash = await hashApiKey(slot.provided);
      // Rotation: a key left over from an earlier value must stop working. Uploads keep existing
      // (api_key_id is nulled first, the foreign key also sets null on delete).
      const stale = await tx
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, slot.userId), ne(apiKeys.keyHash, keyHash)));
      const ids = stale.map((k) => k.id);
      if (ids.length > 0) {
        await tx.update(files).set({ apiKeyId: null }).where(inArray(files.apiKeyId, ids));
        await tx.delete(apiKeys).where(inArray(apiKeys.id, ids));
      }
      wanted.push({ userId: slot.userId, keyHash, name: slot.name, isAdmin: slot.isAdmin });
    }
    // Before the unset slots look: a provided value can be the key the other seed user holds, and takes it over.
    await upsert();

    for (const [i, slot] of slots.entries()) {
      if (slot.provided !== undefined) continue;
      const [existing] = await tx
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.userId, slot.userId))
        .limit(1);
      if (existing) continue;
      const value = generateApiKey();
      wanted.push({
        userId: slot.userId,
        keyHash: await hashApiKey(value),
        name: slot.name,
        isAdmin: slot.isAdmin,
      });
      plain[i] = value;
      generated[i] = true;
    }
    await upsert();
  });

  return {
    apiKey: plain[0],
    adminApiKey: plain[1],
    generated: { apiKey: generated[0] === true, adminApiKey: generated[1] === true },
  };
}
