import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectStorage } from '../../src/ports';

/** What the backend enforces on presigned URLs. Declared flags are tested; the others are visible skips. */
export interface StorageCapabilities {
  /** A PUT whose body length differs from the presigned `bytes` is rejected. */
  rejectsWrongLength?: boolean;
  /** A PUT with another Content-Type than the presigned one is rejected. */
  rejectsWrongContentType?: boolean;
  /** A URL stops working once its TTL has passed. */
  expiresUrls?: boolean;
}

export interface StorageContractHarness {
  storage: ObjectStorage;
  capabilities?: StorageCapabilities;
  close?(): Promise<void>;
}

const bytes = (text: string) => new TextEncoder().encode(text);

/** Behaviour every ObjectStorage adapter must show. Keys are unique per run, so the bucket may be shared. */
export function describeObjectStorageContract(
  name: string,
  factory: () => Promise<StorageContractHarness>,
): void {
  describe(`ObjectStorage contract: ${name}`, () => {
    let h: StorageContractHarness;
    const prefix = `contract/${crypto.randomUUID()}`;
    beforeAll(async () => {
      h = await factory();
    });
    afterAll(async () => {
      await h?.close?.();
    });

    it('returns null for a missing object from get and head', async () => {
      expect(await h.storage.get(`${prefix}/missing`)).toBeNull();
      expect(await h.storage.head(`${prefix}/missing`)).toBeNull();
    });

    it('stores an upload made with a presigned PUT and reads it back', async () => {
      const key = `${prefix}/presigned.bin`;
      const body = bytes('hello presigned world');
      const url = await h.storage.presignPut(key, 'image/png', body.byteLength, 300);
      const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body });
      expect(res.ok).toBe(true);

      expect(await h.storage.head(key)).toEqual({ size: body.byteLength, contentType: 'image/png' });
      expect(await h.storage.get(key)).toEqual(body);
    });

    it('puts and gets with the content type kept', async () => {
      const key = `${prefix}/direct.webp`;
      await h.storage.put(key, bytes('webp bytes'), 'image/webp');
      expect(await h.storage.head(key)).toEqual({ size: 10, contentType: 'image/webp' });
      expect(await h.storage.get(key)).toEqual(bytes('webp bytes'));
    });

    it('overwrites an existing object', async () => {
      const key = `${prefix}/overwrite`;
      await h.storage.put(key, bytes('first'), 'text/plain');
      await h.storage.put(key, bytes('second value'), 'text/plain');
      expect(await h.storage.get(key)).toEqual(bytes('second value'));
      expect((await h.storage.head(key))?.size).toBe(12);
    });

    it('serves a presigned GET URL', async () => {
      const key = `${prefix}/readable`;
      await h.storage.put(key, bytes('readable'), 'image/webp');
      const res = await fetch(await h.storage.presignGet(key, 300));
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes('readable'));
    });

    it('rejects a PUT whose length differs from the presigned one', async (ctx) => {
      if (!h.capabilities?.rejectsWrongLength) return ctx.skip();
      const key = `${prefix}/wrong-length.bin`;
      const url = await h.storage.presignPut(key, 'image/png', 10, 300);
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: bytes('this body is much longer than ten bytes'),
      });
      expect(res.ok).toBe(false);
      expect(await h.storage.head(key)).toBeNull();
    });

    it('rejects a PUT with another content type than the presigned one', async (ctx) => {
      if (!h.capabilities?.rejectsWrongContentType) return ctx.skip();
      const key = `${prefix}/wrong-type.bin`;
      const body = bytes('0123456789');
      const url = await h.storage.presignPut(key, 'image/png', body.byteLength, 300);
      const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'text/html' }, body });
      expect(res.ok).toBe(false);
      expect(await h.storage.head(key)).toBeNull();
    });

    it('stops honouring a presigned URL after its TTL', async (ctx) => {
      if (!h.capabilities?.expiresUrls) return ctx.skip();
      const key = `${prefix}/expiring`;
      const body = bytes('0123456789');
      await h.storage.put(key, body, 'image/png');
      const put = await h.storage.presignPut(`${prefix}/expired-put`, 'image/png', body.byteLength, 1);
      const get = await h.storage.presignGet(key, 1);
      expect((await fetch(get)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 2500));
      expect((await fetch(get)).ok).toBe(false);
      const res = await fetch(put, { method: 'PUT', headers: { 'content-type': 'image/png' }, body });
      expect(res.ok).toBe(false);
    });

    it('deletes many keys at once and tolerates missing ones', async () => {
      const keys = [`${prefix}/d1`, `${prefix}/d2`];
      for (const k of keys) await h.storage.put(k, bytes('x'), 'text/plain');
      await expect(h.storage.delete([...keys, `${prefix}/never-existed`])).resolves.toBeUndefined();
      for (const k of keys) expect(await h.storage.get(k)).toBeNull();
    });

    it('deleting only missing keys is not an error', async () => {
      await expect(h.storage.delete([`${prefix}/nothing`])).resolves.toBeUndefined();
      await expect(h.storage.delete([])).resolves.toBeUndefined();
    });
  });
}
