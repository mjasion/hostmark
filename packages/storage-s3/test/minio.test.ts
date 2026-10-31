// Integration tests against a real S3 API. Set S3_TEST_ENDPOINT (plus S3_TEST_ACCESS_KEY and
// S3_TEST_SECRET_KEY) to run them, e.g. against a throwaway MinIO container.
import http from 'node:http';
import { AwsClient } from 'aws4fetch';
import { beforeAll, describe, expect, it } from 'vitest';
import { createS3Storage } from '../src/index';

const endpoint = process.env.S3_TEST_ENDPOINT;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY ?? 'hostmark';
const secretAccessKey = process.env.S3_TEST_SECRET_KEY ?? 'hostmark-local-secret';
const bucket = `hostmark-test-${Date.now()}`;
const region = 'us-east-1';

/** Raw PUT with an explicit Content-Length: fetch refuses to send a mismatching one. */
function rawPut(url: string, headers: Record<string, string>, body: Uint8Array) {
  return new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe.skipIf(!endpoint)('S3 storage against a real server', () => {
  const storage = createS3Storage({
    endpoint: endpoint ?? '',
    // 127.0.0.1 and localhost are different hosts for SigV4; presigned URLs must use publicEndpoint.
    publicEndpoint: endpoint?.replace('127.0.0.1', 'localhost'),
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
  });
  const bytes = (n: number, v = 7) => new Uint8Array(n).fill(v);

  beforeAll(async () => {
    const admin = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region });
    const res = await admin.fetch(`${endpoint}/${bucket}`, { method: 'PUT' });
    expect(res.status).toBe(200);
  });

  it('put, get, head round trip', async () => {
    await storage.put('t/roundtrip', bytes(1000), 'image/webp');
    expect(await storage.get('t/roundtrip')).toEqual(bytes(1000));
    expect(await storage.head('t/roundtrip')).toEqual({ size: 1000, contentType: 'image/webp' });
  });

  it('returns null for missing objects', async () => {
    expect(await storage.get('t/missing')).toBeNull();
    expect(await storage.head('t/missing')).toBeNull();
  });

  it('throws with the status for credentials the server rejects', async () => {
    const bad = createS3Storage({
      endpoint: endpoint ?? '',
      bucket,
      region,
      accessKeyId,
      secretAccessKey: 'wrong',
    });
    await expect(bad.get('t/roundtrip')).rejects.toThrow(/403/);
    await expect(bad.head('t/roundtrip')).rejects.toThrow(/403/);
  });

  it('throws for a missing bucket on get', async () => {
    const s = createS3Storage({
      endpoint: endpoint ?? '',
      bucket: 'no-such-bucket-xyz',
      region,
      accessKeyId,
      secretAccessKey,
    });
    await expect(s.get('k')).rejects.toThrow(/NoSuchBucket/);
    await expect(s.head('k')).rejects.toThrow(/NoSuchBucket/);
    await expect(s.delete(['k'])).rejects.toThrow(/NoSuchBucket/);
  });

  it('presignGet works on the public endpoint', async () => {
    await storage.put('t/get', bytes(10, 3), 'image/png');
    const url = await storage.presignGet('t/get', 60);
    expect(new URL(url).hostname).toBe(endpoint?.includes('127.0.0.1') ? 'localhost' : new URL(url).hostname);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes(10, 3));
  });

  it('presignGet fails against the internal host (host is signed)', async () => {
    const url = new URL(await storage.presignGet('t/get', 60));
    url.hostname = '127.0.0.1';
    expect((await fetch(url)).status).toBe(403);
  });

  it('presignPut accepts exactly the signed type and length', async () => {
    const url = await storage.presignPut('t/upload', 'image/png', 500, 60);
    const status = await rawPut(url, { 'content-type': 'image/png', 'content-length': '500' }, bytes(500));
    expect(status).toBe(200);
    expect(await storage.head('t/upload')).toEqual({ size: 500, contentType: 'image/png' });
  });

  it('presignPut rejects a different content type', async () => {
    const url = await storage.presignPut('t/upload-type', 'image/png', 500, 60);
    const status = await rawPut(url, { 'content-type': 'image/jpeg', 'content-length': '500' }, bytes(500));
    expect(status).toBe(403);
    expect(await storage.head('t/upload-type')).toBeNull();
  });

  it.each([499, 501, 5000])('presignPut rejects content length %i when 500 was signed', async (len) => {
    const url = await storage.presignPut(`t/upload-len-${len}`, 'image/png', 500, 60);
    const status = await rawPut(
      url,
      { 'content-type': 'image/png', 'content-length': String(len) },
      bytes(len),
    );
    expect(status).toBe(403);
    expect(await storage.head(`t/upload-len-${len}`)).toBeNull();
  });

  it('presignPut rejects an expired URL', async () => {
    const url = await storage.presignPut('t/expired', 'image/png', 5, 1);
    await new Promise((r) => setTimeout(r, 2100));
    expect(await rawPut(url, { 'content-type': 'image/png', 'content-length': '5' }, bytes(5))).toBe(403);
  });

  it('handles keys with special characters', async () => {
    const keys = [
      'k/with space',
      'k/plus+sign',
      'k/percent%20literal',
      'k/unicode-żółć-日本',
      "k/punct!'()*~._-",
      'k/amp&eq=q?hash#x',
    ];
    for (const key of keys) {
      await storage.put(key, bytes(3), 'image/png');
      expect(await storage.head(key), key).toEqual({ size: 3, contentType: 'image/png' });
      const res = await fetch(await storage.presignGet(key, 60));
      expect(res.status, key).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(3);
      const up = await storage.presignPut(`${key}-up`, 'image/png', 2, 60);
      expect(await rawPut(up, { 'content-type': 'image/png', 'content-length': '2' }, bytes(2)), key).toBe(
        200,
      );
    }
    await storage.delete([...keys, ...keys.map((k) => `${k}-up`)]);
    for (const key of keys) expect(await storage.head(key), key).toBeNull();
  });

  it('delete removes objects, ignores missing keys and accepts an empty list', async () => {
    await storage.put('t/d1', bytes(1), 'image/png');
    await storage.put('t/d2', bytes(1), 'image/png');
    await storage.delete([]);
    await storage.delete(['t/d1', 't/d2', 't/never-existed']);
    expect(await storage.head('t/d1')).toBeNull();
    expect(await storage.head('t/d2')).toBeNull();
  });
});
