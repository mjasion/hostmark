import { describeObjectStorageContract } from '@hostmark/core/test/contract';
import { createS3Storage } from '@hostmark/storage-s3';
import { AwsClient } from 'aws4fetch';
import { describe, expect, it } from 'vitest';

// Against the MinIO of the compose stack: S3_TEST_ENDPOINT=http://127.0.0.1:59000
const endpoint = process.env.S3_TEST_ENDPOINT;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY ?? 'hostmark';
const secretAccessKey = process.env.S3_TEST_SECRET_KEY ?? 'hostmark-local-secret';
const region = 'us-east-1';

if (endpoint) {
  describeObjectStorageContract('MinIO via createS3Storage', async () => {
    const bucket = `contract-${Date.now()}`;
    const admin = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region });
    const created = await admin.fetch(`${endpoint}/${bucket}`, { method: 'PUT' });
    expect(created.status).toBe(200);
    return {
      storage: createS3Storage({ endpoint, bucket, region, accessKeyId, secretAccessKey }),
      capabilities: { rejectsWrongLength: true, rejectsWrongContentType: true, expiresUrls: true },
      close: async () => {
        await admin.fetch(`${endpoint}/${bucket}`, { method: 'DELETE' });
      },
    };
  });
} else {
  describe.skip('Object storage contract: MinIO via createS3Storage (set S3_TEST_ENDPOINT)', () => {
    it('skipped', () => {});
  });
}
