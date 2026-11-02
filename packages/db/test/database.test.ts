import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeys, files, hashApiKey, seed, user } from '../src';
import { createNodeDb, migrate, type NodeDb } from '../src/node';

// Runs against a real PostgreSQL when DATABASE_URL is set, e.g. DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('database', () => {
  let node: NodeDb;

  beforeAll(async () => {
    await migrate(url as string);
    node = createNodeDb(url as string, { max: 2 });
  });

  afterAll(async () => {
    await node?.close();
  });

  it('applies migrations twice without error', async () => {
    await migrate(url as string);
  });

  it('seeds idempotently and stores only hashes', async () => {
    const first = await seed(node.db, { apiKey: 'regular-key', adminApiKey: 'admin-key' });
    await seed(node.db, { apiKey: 'regular-key', adminApiKey: 'admin-key' });
    expect(first.generated).toEqual({ apiKey: false, adminApiKey: false });

    const rows = await node.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, await hashApiKey('admin-key')));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isAdmin).toBe(true);
    expect(rows[0]?.keyHash).not.toContain('admin-key');
  });

  it('replaces the previous keys when the values change, and keeps uploads', async () => {
    await seed(node.db, { apiKey: 'old-regular', adminApiKey: 'old-admin' });
    const [oldKey] = await node.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, await hashApiKey('old-regular')));
    const id = crypto.randomUUID();
    await node.db.insert(files).values({
      id,
      userId: 'seed-user',
      apiKeyId: oldKey?.id,
      contentType: 'image/png',
      originalKey: `originals/seed-user/${id}`,
      expiresAt: new Date(),
    });

    await seed(node.db, { apiKey: 'new-regular', adminApiKey: 'new-admin' });
    const hashes = (await node.db.select({ h: apiKeys.keyHash }).from(apiKeys)).map((r) => r.h);
    expect(hashes).toContain(await hashApiKey('new-regular'));
    expect(hashes).toContain(await hashApiKey('new-admin'));
    expect(hashes).not.toContain(await hashApiKey('old-regular'));
    expect(hashes).not.toContain(await hashApiKey('old-admin'));
    const [file] = await node.db.select().from(files).where(eq(files.id, id));
    expect(file?.apiKeyId).toBeNull();
    await node.db.delete(files).where(eq(files.id, id));
  });

  it('keeps the row id and the uploads linked to it when the same values are seeded again', async () => {
    await seed(node.db, { apiKey: 'same-regular', adminApiKey: 'same-admin' });
    const byHash = async (key: string) =>
      (
        await node.db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.keyHash, await hashApiKey(key)))
      )[0];
    const before = await byHash('same-regular');
    const adminBefore = await byHash('same-admin');
    const id = crypto.randomUUID();
    await node.db.insert(files).values({
      id,
      userId: 'seed-user',
      apiKeyId: before?.id,
      contentType: 'image/png',
      originalKey: `originals/seed-user/${id}`,
      expiresAt: new Date(),
    });

    await seed(node.db, { apiKey: 'same-regular', adminApiKey: 'same-admin' });
    expect((await byHash('same-regular'))?.id).toBe(before?.id);
    expect((await byHash('same-admin'))?.id).toBe(adminBefore?.id);
    const [file] = await node.db.select().from(files).where(eq(files.id, id));
    expect(file?.apiKeyId).toBe(before?.id);
    await node.db.delete(files).where(eq(files.id, id));
  });

  it('leaves the other seed user a key when a provided value is the key that user holds', async () => {
    await wipeSeedKeys();
    const first = await seed(node.db);
    const adminValue = first.adminApiKey as string;
    // The admin key moves to seed-user; seed-admin is unset, so it must not be left without a key.
    const second = await seed(node.db, { apiKey: adminValue });
    expect(await keysOf('seed-user')).toEqual([await hashApiKey(adminValue)]);
    const adminKeys = await keysOf('seed-admin');
    expect(adminKeys).toHaveLength(1);
    expect(adminKeys).not.toContain(await hashApiKey(adminValue));
    expect(second.generated).toEqual({ apiKey: false, adminApiKey: true });
    expect(adminKeys).toEqual([await hashApiKey(second.adminApiKey as string)]);
  });

  it('rejects equal values for both keys', async () => {
    await expect(seed(node.db, { apiKey: 'same', adminApiKey: 'same' })).rejects.toThrow(/differ/);
  });

  it('updates is_admin when a value changes its role', async () => {
    await seed(node.db, { apiKey: 'role-a', adminApiKey: 'role-b' });
    await seed(node.db, { apiKey: 'role-b', adminApiKey: 'role-a' });
    const flag = async (key: string) =>
      (
        await node.db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.keyHash, await hashApiKey(key)))
      )[0]?.isAdmin;
    expect(await flag('role-a')).toBe(true);
    expect(await flag('role-b')).toBe(false);
  });

  const keysOf = async (userId: string) =>
    (await node.db.select({ h: apiKeys.keyHash }).from(apiKeys).where(eq(apiKeys.userId, userId))).map(
      (r) => r.h,
    );
  const wipeSeedKeys = async () => {
    await node.db.update(files).set({ apiKeyId: null });
    await node.db.delete(apiKeys).where(inArray(apiKeys.userId, ['seed-user', 'seed-admin']));
  };

  it('generates keys for seed users that have none', async () => {
    await wipeSeedKeys();
    const r = await seed(node.db);
    expect(r.generated).toEqual({ apiKey: true, adminApiKey: true });
    expect(await keysOf('seed-user')).toEqual([await hashApiKey(r.apiKey as string)]);
    expect(await keysOf('seed-admin')).toEqual([await hashApiKey(r.adminApiKey as string)]);
  });

  it('keeps the first keys working when it runs again without values', async () => {
    await wipeSeedKeys();
    const first = await seed(node.db);
    const second = await seed(node.db);
    expect(second).toEqual({
      apiKey: undefined,
      adminApiKey: undefined,
      generated: { apiKey: false, adminApiKey: false },
    });
    expect(await keysOf('seed-user')).toEqual([await hashApiKey(first.apiKey as string)]);
    expect(await keysOf('seed-admin')).toEqual([await hashApiKey(first.adminApiKey as string)]);
  });

  it('rotates only the key that is provided and keeps the other', async () => {
    await wipeSeedKeys();
    const first = await seed(node.db);
    const second = await seed(node.db, { apiKey: 'only-regular' });
    expect(second.generated).toEqual({ apiKey: false, adminApiKey: false });
    expect(await keysOf('seed-user')).toEqual([await hashApiKey('only-regular')]);
    expect(await keysOf('seed-admin')).toEqual([await hashApiKey(first.adminApiKey as string)]);
  });

  it('removes keys added by hand to a seed user when its key is provided', async () => {
    await seed(node.db, { apiKey: 'fixed-a', adminApiKey: 'fixed-b' });
    await node.db
      .insert(apiKeys)
      .values({ userId: 'seed-user', keyHash: await hashApiKey('by-hand'), name: 'hand' });
    await seed(node.db, { apiKey: 'fixed-a', adminApiKey: 'fixed-b' });
    expect(await keysOf('seed-user')).toEqual([await hashApiKey('fixed-a')]);
  });

  it('sets files.api_key_id to null when its key row is deleted', async () => {
    const [key] = await node.db
      .insert(apiKeys)
      .values({ userId: 'seed-user', keyHash: await hashApiKey('fk-key'), name: 'fk' })
      .returning();
    const id = crypto.randomUUID();
    await node.db.insert(files).values({
      id,
      userId: 'seed-user',
      apiKeyId: key?.id,
      contentType: 'image/png',
      originalKey: `originals/seed-user/${id}`,
      expiresAt: new Date(),
    });
    await node.db.delete(apiKeys).where(eq(apiKeys.id, key?.id as string));
    const [file] = await node.db.select().from(files).where(eq(files.id, id));
    expect(file?.apiKeyId).toBeNull();
    await node.db.delete(files).where(eq(files.id, id));
  });

  it('takes over a key hash held by another user, with the seed role and name', async () => {
    await node.db
      .insert(user)
      .values({ id: 'other-user', name: 'Other', email: 'other@hostmark.test' })
      .onConflictDoNothing();
    const keyHash = await hashApiKey('taken');
    await node.db.delete(apiKeys).where(eq(apiKeys.keyHash, keyHash));
    await node.db.insert(apiKeys).values({ userId: 'other-user', keyHash, name: 'theirs', isAdmin: true });
    await seed(node.db, { apiKey: 'taken', adminApiKey: 'taken-admin' });
    const [row] = await node.db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
    expect(row).toMatchObject({ userId: 'seed-user', name: 'seed', isAdmin: false });
  });

  it('inserts a file inside a transaction and rolls back on error', async () => {
    const id = '0192f1c2-7b3a-7c1e-8a4d-3f2b1c0d9e8f';
    await expect(
      node.db.transaction(async (tx) => {
        await tx.insert(files).values({
          id,
          userId: 'seed-user',
          contentType: 'image/png',
          originalKey: `originals/seed-user/${id}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await node.db.select().from(files).where(eq(files.id, id))).toHaveLength(0);
  });

  it('rejects an api key without a user', async () => {
    await expect(
      node.db.insert(apiKeys).values({ userId: 'nobody', keyHash: 'x', name: 'x' }),
    ).rejects.toThrow();
    expect(await node.db.select().from(user).where(eq(user.id, 'nobody'))).toHaveLength(0);
  });
});
