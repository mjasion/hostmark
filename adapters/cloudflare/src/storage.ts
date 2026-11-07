import type { ObjectStorage } from '@hostmark/core/ports';
import { createS3Storage, presignedOrigin } from '@hostmark/storage-s3';

export interface R2StorageOptions {
  bucket: R2Bucket;
  accountId: string;
  bucketName: string;
  /** S3 compatible R2 token. Used to presign only. */
  accessKeyId: string;
  secretAccessKey: string;
  /** Origin that presigned URLs point to; defaults to `https://<accountId>.r2.cloudflarestorage.com`. */
  publicEndpoint?: string;
}

const DELETE_BATCH = 1000;

/** The endpoint presigned URLs are built on: the account's S3 origin unless `publicEndpoint` replaces it. */
const presignEndpoint = (options: Pick<R2StorageOptions, 'accountId' | 'publicEndpoint'>) =>
  options.publicEndpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`;

/**
 * The origin of every presigned URL of `createR2Storage(options)`: the storage source of the web app's CSP (D310). The
 * Worker uses it for the panel shell and `scripts/build.mjs` for the prerendered pages, from the same vars.
 */
export function r2PresignedOrigin(
  options: Pick<R2StorageOptions, 'accountId' | 'bucketName' | 'publicEndpoint'>,
): string {
  return presignedOrigin({ endpoint: presignEndpoint(options), bucket: options.bucketName });
}

/**
 * Reads and writes go through the R2 binding: no signing, no subrequest to the S3 endpoint. Presigned URLs are the one
 * thing a binding cannot make, so those come from `@hostmark/storage-s3` against the account's S3 origin (R2 presigns
 * work on that origin only, not on a custom domain).
 */
export function createR2Storage(options: R2StorageOptions): ObjectStorage {
  const signer = createS3Storage({
    endpoint: presignEndpoint(options),
    bucket: options.bucketName,
    region: 'auto',
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
  });
  const { bucket } = options;
  return {
    presignPut: (key, contentType, bytes, ttlSeconds) =>
      signer.presignPut(key, contentType, bytes, ttlSeconds),
    presignGet: (key, ttlSeconds) => signer.presignGet(key, ttlSeconds),

    async get(key) {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },

    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },

    async head(key) {
      const object = await bucket.head(key);
      if (!object) return null;
      return {
        size: object.size,
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      };
    },

    async delete(keys) {
      const unique = [...new Set(keys)];
      for (let i = 0; i < unique.length; i += DELETE_BATCH)
        await bucket.delete(unique.slice(i, i + DELETE_BATCH));
    },
  };
}
