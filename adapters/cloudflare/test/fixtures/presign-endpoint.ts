import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AwsV4Signer } from 'aws4fetch';
import type { Miniflare } from 'miniflare';

export const accessKeyId = 'test-access-key';
export const secretAccessKey = 'test-secret-key';
export const bucketName = 'hostmark-files';

export type Bucket = Awaited<ReturnType<Miniflare['getR2Bucket']>>;

/**
 * Stands in for `<account>.r2.cloudflarestorage.com`: serves presigned PUT and GET for the objects of the bucket
 * binding. It verifies the SigV4 query signature the way the S3 API does (signed host, content type and length,
 * expiry), so a URL that does not match what `presignPut` signed is refused. It is not R2: how R2 itself treats a
 * mismatching length or content type is not measured (see the README).
 */
export function presignEndpoint(
  getBucket: () => Promise<Bucket>,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
    const reply = (status: number, body = '') => res.writeHead(status).end(body);
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const given = url.searchParams.get('X-Amz-Signature');
      const date = url.searchParams.get('X-Amz-Date') ?? '';
      const expires = Number(url.searchParams.get('X-Amz-Expires'));
      const issued = Date.parse(
        date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
      );
      if (!given || Number.isNaN(issued)) return reply(403, 'AccessDenied');
      if (Date.now() > issued + expires * 1000) return reply(403, 'ExpiredToken');
      const signedHeaders = (url.searchParams.get('X-Amz-SignedHeaders') ?? '')
        .split(';')
        .filter((h) => h !== 'host');
      const headers: Record<string, string> = {};
      for (const name of signedHeaders) headers[name] = String(req.headers[name] ?? '');
      url.searchParams.delete('X-Amz-Signature');
      const signer = new AwsV4Signer({
        method: req.method ?? 'GET',
        url: url.toString(),
        headers,
        accessKeyId,
        secretAccessKey,
        service: 's3',
        region: 'auto',
        signQuery: true,
        allHeaders: signedHeaders.length > 0,
        datetime: date,
      });
      const expected = (await signer.sign()).url.searchParams.get('X-Amz-Signature');
      if (expected !== given) return reply(403, 'SignatureDoesNotMatch');

      const [, bucketPart, ...rest] = url.pathname.split('/');
      if (bucketPart !== bucketName || rest.length === 0) return reply(404, 'NoSuchBucket');
      const key = rest.map(decodeURIComponent).join('/');
      const bucket = await getBucket();
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        await bucket.put(key, Buffer.concat(chunks), {
          httpMetadata: { contentType: String(req.headers['content-type'] ?? '') },
        });
        return reply(200);
      }
      if (req.method === 'GET') {
        const object = await bucket.get(key);
        if (!object) return reply(404, 'NoSuchKey');
        res.writeHead(200, {
          'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        });
        return res.end(Buffer.from(await object.arrayBuffer()));
      }
      return reply(405);
    } catch (e) {
      return reply(500, String(e));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    );
  });
}
