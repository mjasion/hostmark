// Creates the bucket and applies lifecycle and CORS. Idempotent; used by the compose `minio-init` job.
import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { loadEnv } from './env';

const env = loadEnv();
const client = new AwsClient({
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  service: 's3',
  region: env.S3_REGION,
  // aws4fetch retries every 5xx, 501 included, with backoff: the CORS call that MinIO cannot serve took 14 to 33 s.
  retries: 0,
});
const bucketUrl = `${env.S3_ENDPOINT.replace(/\/+$/, '')}/${env.S3_BUCKET}`;

async function call(subresource: string, body?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/xml';
    // MinIO insists on Content-MD5 for lifecycle and CORS documents.
    headers['content-md5'] = createHash('md5').update(body).digest('base64');
  }
  return client.fetch(subresource ? `${bucketUrl}?${subresource}` : bucketUrl, {
    method: 'PUT',
    body,
    headers,
  });
}

async function waitForServer(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await client.fetch(bucketUrl, { method: 'HEAD' });
      await res.body?.cancel();
      // Any answer below 500 means the server is up (404: no bucket yet); a 5xx is a server still starting.
      if (res.status < 500) return;
      throw new Error(`server not ready: ${res.status}`);
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

await waitForServer();

const created = await call('');
const createdText = await created.text();
if (!created.ok && !createdText.includes('BucketAlreadyOwnedByYou')) {
  throw new Error(`create bucket failed: ${created.status} ${createdText}`);
}
console.log(`bucket ${env.S3_BUCKET}: ${created.ok ? 'created' : 'exists'}`);

// Safeguard from the spec: originals older than 8 days go even if the scheduler never runs. Variants follow (D74).
const rule = (prefix: string) =>
  `<Rule><ID>expire-${prefix.replace('/', '')}</ID><Filter><Prefix>${prefix}</Prefix></Filter>` +
  '<Status>Enabled</Status><Expiration><Days>8</Days></Expiration></Rule>';
const lifecycle = await call(
  'lifecycle',
  `<LifecycleConfiguration>${rule('originals/')}${rule('variants/')}</LifecycleConfiguration>`,
);
if (!lifecycle.ok) throw new Error(`lifecycle failed: ${lifecycle.status} ${await lifecycle.text()}`);
console.log('lifecycle: originals/ and variants/ expire after 8 days');

const cors = await call(
  'cors',
  '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>PUT</AllowedMethod>' +
    '<AllowedMethod>GET</AllowedMethod><AllowedHeader>Content-Type</AllowedHeader></CORSRule></CORSConfiguration>',
);
if (cors.ok) {
  console.log('cors: PUT and GET from any origin');
} else if (cors.status === 501) {
  // MinIO has no per-bucket CORS API; the server-wide MINIO_API_CORS_ALLOW_ORIGIN setting applies instead.
  console.log('cors: bucket API not implemented by this MinIO build, relying on MINIO_API_CORS_ALLOW_ORIGIN');
} else {
  throw new Error(`cors failed: ${cors.status} ${await cors.text()}`);
}
