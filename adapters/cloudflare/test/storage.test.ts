import { describeObjectStorageContract } from '@hostmark/core/test/contract';
import { createR2Storage } from '../src/storage';
import { accessKeyId, bucketName, presignEndpoint, secretAccessKey } from './fixtures/presign-endpoint';
import { newMiniflare } from './miniflare';

// The real createR2Storage over the R2 binding of Miniflare. Capability flags stay off: the shim above would only
// be testing itself, and what real R2 enforces on a presigned PUT is not measured without an account.
describeObjectStorageContract('R2 binding on Miniflare', async () => {
  const mf = newMiniflare([
    {
      name: 'storage',
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      compatibilityDate: '2026-08-06',
      r2Buckets: { BUCKET: bucketName },
    },
  ]);
  const bucket = await mf.getR2Bucket('BUCKET');
  const { server, origin } = await presignEndpoint(async () => bucket);
  return {
    storage: createR2Storage({
      bucket: bucket as never,
      accountId: 'test-account',
      bucketName,
      accessKeyId,
      secretAccessKey,
      publicEndpoint: origin,
    }),
    close: async () => {
      server.close();
      await mf.dispose();
    },
  };
});
