import { AwsV4Signer } from 'aws4fetch';
import { describe, expect, it } from 'vitest';
import { bucketUrl, createS3Storage } from '../src/index';

const base = {
  endpoint: 'http://minio:9000',
  bucket: 'b',
  region: 'us-east-1',
  accessKeyId: 'AK',
  secretAccessKey: 'SK',
};

describe('presign (offline)', () => {
  it('signs content-type and content-length for PUT', async () => {
    const url = new URL(await createS3Storage(base).presignPut('originals/u/f', 'image/png', 1234, 600));
    expect(url.host).toBe('minio:9000');
    expect(url.pathname).toBe('/b/originals/u/f');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
  });

  it('presigns for the public endpoint only', async () => {
    const s = createS3Storage({ ...base, publicEndpoint: 'https://s3.example.com/' });
    expect(new URL(await s.presignGet('k', 60)).origin).toBe('https://s3.example.com');
    expect(new URL(await s.presignPut('k', 'image/png', 1, 60)).origin).toBe('https://s3.example.com');
  });

  it('signs only the host for GET', async () => {
    const url = new URL(await createS3Storage(base).presignGet('k', 60));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('keeps slashes and encodes everything else', async () => {
    const url = await createS3Storage(base).presignGet('a b/c+d/é(1)*.webp', 60);
    expect(new URL(url).pathname).toBe('/b/a%20b/c%2Bd/%C3%A9%281%29%2A.webp');
  });

  it('rejects keys the URL parser would rewrite', async () => {
    const s = createS3Storage(base);
    await expect(s.presignGet('a/../b', 60)).rejects.toThrow('Invalid object key');
    await expect(s.presignGet('', 60)).rejects.toThrow('Invalid object key');
  });
});

describe('virtual-hosted-style URLs (Tigris)', () => {
  const tigris = {
    ...base,
    endpoint: 'https://fly.storage.tigris.dev',
    bucket: 'hostmark-bucket',
    region: 'auto',
    virtualHost: true,
  };

  /** Signs `url` again at the presigned URL's own time; equal signatures mean the same host and path were signed. */
  async function resign(
    presigned: URL,
    url: string,
    headers?: Record<string, string>,
  ): Promise<string | null> {
    const unsigned = new URL(url);
    for (const [k, v] of presigned.searchParams) if (k === 'X-Amz-Expires') unsigned.searchParams.set(k, v);
    const signer = new AwsV4Signer({
      method: headers ? 'PUT' : 'GET',
      url: unsigned.toString(),
      headers,
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      service: 's3',
      region: 'auto',
      signQuery: true,
      allHeaders: headers !== undefined,
      datetime: presigned.searchParams.get('X-Amz-Date') ?? '',
    });
    return (await signer.sign()).url.searchParams.get('X-Amz-Signature');
  }

  it('puts the bucket in the host, for presigned GET and PUT', async () => {
    const s = createS3Storage(tigris);
    const get = new URL(await s.presignGet('variants/f/512.webp', 60));
    expect(get.origin).toBe('https://hostmark-bucket.fly.storage.tigris.dev');
    expect(get.pathname).toBe('/variants/f/512.webp');
    const put = new URL(await s.presignPut('originals/u/f', 'image/png', 1234, 600));
    expect(put.host).toBe('hostmark-bucket.fly.storage.tigris.dev');
    expect(put.pathname).toBe('/originals/u/f');
    expect(put.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
  });

  it('signs the virtual host, not the endpoint host', async () => {
    const s = createS3Storage(tigris);
    const get = new URL(await s.presignGet('k/a b', 60));
    const signature = get.searchParams.get('X-Amz-Signature');
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(await resign(get, 'https://hostmark-bucket.fly.storage.tigris.dev/k/a%20b')).toBe(signature);
    expect(await resign(get, 'https://fly.storage.tigris.dev/hostmark-bucket/k/a%20b')).not.toBe(signature);
    const put = new URL(await s.presignPut('k', 'image/png', 7, 60));
    const headers = { 'content-type': 'image/png', 'content-length': '7' };
    expect(await resign(put, 'https://hostmark-bucket.fly.storage.tigris.dev/k', headers)).toBe(
      put.searchParams.get('X-Amz-Signature'),
    );
  });

  it('uses the virtual host for server calls too', async () => {
    const seen: Request[] = [];
    const s = createS3Storage({
      ...tigris,
      // aws4fetch hands over a signed Request.
      fetch: async (input) => {
        seen.push(input as Request);
        return new Response(null, { status: 404 });
      },
    });
    expect(await s.head('originals/u/f')).toBeNull();
    await s.delete(['variants/x']);
    expect(seen.map((r) => r.url)).toEqual([
      'https://hostmark-bucket.fly.storage.tigris.dev/originals/u/f',
      'https://hostmark-bucket.fly.storage.tigris.dev/variants/x',
    ]);
    expect(seen[0]?.headers.get('authorization')).toMatch(/SignedHeaders=[^,]*host/);
  });

  it('applies to the public endpoint as well', async () => {
    const s = createS3Storage({ ...tigris, publicEndpoint: 'https://t3.storage.dev/' });
    expect(new URL(await s.presignGet('k', 60)).origin).toBe('https://hostmark-bucket.t3.storage.dev');
  });

  it('keeps path-style as the default (MinIO)', () => {
    expect(bucketUrl('http://minio:9000/', 'b')).toBe('http://minio:9000/b');
    expect(bucketUrl('http://minio:9000', 'b', false)).toBe('http://minio:9000/b');
    expect(bucketUrl('https://h.example/base/', 'my-bucket', true)).toBe('https://my-bucket.h.example/base');
  });

  it('refuses a bucket name that is not one DNS label', () => {
    for (const bucket of ['my.bucket', 'Upper', 'a', `x${'y'.repeat(63)}`, '-lead'])
      expect(() => createS3Storage({ ...tigris, bucket }), bucket).toThrow(/virtual-hosted/);
    expect(() => createS3Storage({ ...base, bucket: 'my.bucket' })).not.toThrow();
  });
});

describe('error handling (stubbed fetch)', () => {
  const stub = (status: number, body = '') =>
    createS3Storage({ ...base, fetch: async () => new Response(body || null, { status }) });

  it('maps 404 to null', async () => {
    expect(await stub(404, '<Code>NoSuchKey</Code>').get('k')).toBeNull();
    expect(await stub(404).head('k')).toBeNull();
  });

  it('throws on other failures instead of returning null', async () => {
    await expect(stub(403, '<Error><Code>AccessDenied</Code></Error>').get('k')).rejects.toThrow(
      /403.*AccessDenied/,
    );
    await expect(stub(403).head('k')).rejects.toThrow(/403/);
    await expect(stub(400).put('k', new Uint8Array(1), 'image/png')).rejects.toThrow(/400/);
    await expect(stub(403).delete(['k'])).rejects.toThrow(/403/);
  });

  it('treats a missing bucket as an error for get', async () => {
    await expect(stub(404, '<Code>NoSuchBucket</Code>').get('k')).rejects.toThrow(/NoSuchBucket/);
  });

  it('treats a missing bucket as an error for head and delete (m17)', async () => {
    const byHeader = createS3Storage({
      ...base,
      fetch: async () =>
        new Response(null, { status: 404, headers: { 'x-minio-error-code': 'NoSuchBucket' } }),
    });
    await expect(byHeader.head('k')).rejects.toThrow(/NoSuchBucket/);
    await expect(byHeader.delete(['k'])).rejects.toThrow(/NoSuchBucket/);
    // A missing object stays benign: head says null, delete is idempotent.
    expect(await stub(404, '<Code>NoSuchKey</Code>').head('k')).toBeNull();
    await expect(stub(404, '<Code>NoSuchKey</Code>').delete(['k'])).resolves.toBeUndefined();
    await expect(stub(404, '<Code>NoSuchBucket</Code>').delete(['k'])).rejects.toThrow(/NoSuchBucket/);
  });

  it('retries a 5xx at most once', async () => {
    let calls = 0;
    const s = createS3Storage({
      ...base,
      fetch: async () => {
        calls++;
        return new Response('x', { status: 503 });
      },
    });
    await expect(s.get('k')).rejects.toThrow(/503/);
    expect(calls).toBe(2);
  });

  it('delete: empty array is a no-op, concurrency is bounded, duplicates are collapsed', async () => {
    let active = 0;
    let max = 0;
    let calls = 0;
    const s = createS3Storage({
      ...base,
      fetch: async () => {
        calls++;
        max = Math.max(max, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return new Response(null, { status: 204 });
      },
    });
    await s.delete([]);
    expect(calls).toBe(0);
    await s.delete(Array.from({ length: 10 }, (_, i) => `k${i}`).concat('k0'));
    expect(calls).toBe(10);
    expect(max).toBeLessThanOrEqual(4);
  });
});
