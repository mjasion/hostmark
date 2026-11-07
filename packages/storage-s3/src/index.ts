// S3-compatible ObjectStorage on aws4fetch: Web Crypto and fetch only, so it runs on Workers, Node and Bun.

import type { ObjectStorage } from '@hostmark/core/ports';
import { AwsClient, AwsV4Signer } from 'aws4fetch';

export const STORAGE_IMPL = 's3' as const;

export interface S3StorageOptions {
  /** Server-side endpoint, e.g. `http://minio:9000` or `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  /**
   * Browser-reachable endpoint used only for presigned URLs. SigV4 signs the host, so presigning with an
   * internal hostname would produce URLs that fail in a browser. Defaults to `endpoint`.
   */
  publicEndpoint?: string;
  bucket: string;
  /**
   * Virtual-hosted-style URLs (`https://<bucket>.<host>/<key>`) for every call and every presigned URL, instead of
   * path-style (`https://<host>/<bucket>/<key>`). Tigris requires it (its presigned URLs must be
   * virtual-hosted, and buckets created since 2025-02-19 do not support path-style); MinIO behind a plain host name needs path-style, the
   * default.
   */
  virtualHost?: boolean;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials (an IAM role on AWS Lambda) carry a session token that every signature must include. */
  sessionToken?: string;
  fetch?: typeof fetch;
}

export class S3Error extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
  }
}

// aws4fetch retries 10 times by default. Retries are hidden latency in a benchmark, so one retry on
// 5xx/429 is all that is allowed (also bounds the worst case below the queue visibility timeout).
const RETRIES = 1;
const RETRY_BASE_MS = 50;
const DELETE_CONCURRENCY = 4;

// '!' '\'' '(' ')' '*' are left alone by encodeURIComponent but SigV4 wants them encoded.
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKey(key: string): string {
  const segments = key.split('/');
  // The URL parser resolves dot segments before signing, which would sign a different object.
  if (key === '' || segments.some((s) => s === '.' || s === '..')) {
    throw new Error(`Invalid object key: ${JSON.stringify(key)}`);
  }
  return segments.map(encodeSegment).join('/');
}

/** A bucket name that is one DNS label: a dot would leave the TLS wildcard certificate of the host (Tigris, S3). */
const DNS_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * The URL of a bucket, without a trailing slash: `<endpoint>/<bucket>` (path-style), or the endpoint with the bucket
 * as the first label of its host (virtual-hosted-style). A path on the endpoint is kept. Object keys follow after `/`.
 */
export function bucketUrl(endpoint: string, bucket: string, virtualHost = false): string {
  const base = endpoint.replace(/\/+$/, '');
  if (!virtualHost) return `${base}/${encodeSegment(bucket)}`;
  if (!DNS_BUCKET.test(bucket)) {
    throw new Error(
      `Bucket ${JSON.stringify(bucket)} cannot be used with virtual-hosted URLs: it must be 3 to 63 lowercase letters, digits and hyphens`,
    );
  }
  const url = new URL(base);
  url.hostname = `${bucket}.${url.hostname}`;
  return url.toString().replace(/\/+$/, '');
}

async function snippet(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
  } catch {
    return '';
  }
}

/** The base of every presigned URL: the public endpoint (else the server one) in the configured URL style. */
const publicBucketUrl = (
  options: Pick<S3StorageOptions, 'endpoint' | 'publicEndpoint' | 'bucket' | 'virtualHost'>,
) => bucketUrl(options.publicEndpoint ?? options.endpoint, options.bucket, options.virtualHost);

/**
 * The origin every presigned URL of `createS3Storage(options)` points to: what a browser connects to for uploads and
 * loads thumbnails from, and so the storage source of the web app's Content-Security-Policy (D310).
 */
export function presignedOrigin(
  options: Pick<S3StorageOptions, 'endpoint' | 'publicEndpoint' | 'bucket' | 'virtualHost'>,
): string {
  return new URL(publicBucketUrl(options)).origin;
}

export function createS3Storage(options: S3StorageOptions): ObjectStorage {
  const base = bucketUrl(options.endpoint, options.bucket, options.virtualHost);
  const publicBase = publicBucketUrl(options);
  const doFetch = options.fetch ?? ((input: Request) => fetch(input));
  const cache = new Map<string, ArrayBuffer>();
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    sessionToken: options.sessionToken,
    service: 's3',
    region: options.region,
    cache,
    retries: RETRIES,
  });

  const objectUrl = (root: string, key: string) => `${root}/${encodeKey(key)}`;

  async function send(method: string, key: string, init?: { body?: Uint8Array; contentType?: string }) {
    const url = objectUrl(base, key);
    for (let attempt = 0; ; attempt++) {
      const headers = init?.contentType ? { 'content-type': init.contentType } : undefined;
      const req = await client.sign(url, { method, headers, body: init?.body as BodyInit | undefined });
      const res = await doFetch(req);
      if ((res.status < 500 && res.status !== 429) || attempt >= RETRIES) return res;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, Math.random() * RETRY_BASE_MS * 2 ** attempt));
    }
  }

  /** A missing bucket is a 404 too; it is a deployment error, not a missing object. HEAD carries it in a header. */
  const missingBucket = (res: Response, text = ''): boolean =>
    text.includes('NoSuchBucket') ||
    res.headers.get('x-minio-error-code') === 'NoSuchBucket' ||
    res.headers.get('x-amz-error-code') === 'NoSuchBucket';

  async function fail(op: string, key: string, res: Response): Promise<never> {
    throw new S3Error(res.status, `S3 ${op} ${key} failed: ${res.status} ${await snippet(res)}`.trim());
  }

  async function presign(
    method: 'GET' | 'PUT',
    key: string,
    ttlSeconds: number,
    headers?: Record<string, string>,
  ): Promise<string> {
    const url = new URL(objectUrl(publicBase, key));
    url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.floor(ttlSeconds))));
    const signer = new AwsV4Signer({
      method,
      url: url.toString(),
      headers,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      service: 's3',
      region: options.region,
      cache,
      signQuery: true,
      // Without this content-type and content-length are excluded from the signature.
      allHeaders: headers !== undefined,
    });
    return (await signer.sign()).url.toString();
  }

  return {
    presignPut(key, contentType, bytes, ttlSeconds) {
      return presign('PUT', key, ttlSeconds, {
        'content-type': contentType,
        'content-length': String(bytes),
      });
    },

    presignGet(key, ttlSeconds) {
      return presign('GET', key, ttlSeconds);
    },

    async get(key) {
      const res = await send('GET', key);
      if (res.status === 404) {
        const text = await snippet(res);
        if (missingBucket(res, text)) throw new S3Error(404, `S3 GET ${key} failed: ${text}`);
        return null;
      }
      if (!res.ok) return fail('GET', key, res);
      return new Uint8Array(await res.arrayBuffer());
    },

    async put(key, body, contentType) {
      const res = await send('PUT', key, { body, contentType });
      if (!res.ok) return fail('PUT', key, res);
      await res.body?.cancel();
    },

    async head(key) {
      const res = await send('HEAD', key);
      if (res.status === 404) {
        if (missingBucket(res)) throw new S3Error(404, `S3 HEAD ${key} failed: NoSuchBucket`);
        return null;
      }
      if (!res.ok) return fail('HEAD', key, res);
      return {
        size: Number(res.headers.get('content-length') ?? 0),
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    },

    // Individual DELETEs: a file has at most four keys, and DeleteObjects requires a Content-MD5 or
    // checksum header that Web Crypto cannot produce cheaply (no MD5).
    async delete(keys) {
      const queue = [...new Set(keys)];
      const worker = async () => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
          const res = await send('DELETE', key);
          // 404 means it is already gone, unless the bucket itself is missing.
          if (res.status === 404 && missingBucket(res, await snippet(res.clone()))) {
            throw new S3Error(404, `S3 DELETE ${key} failed: NoSuchBucket`);
          }
          if (!res.ok && res.status !== 404) await fail('DELETE', key, res);
          await res.body?.cancel();
        }
      };
      await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, queue.length) }, worker));
    },
  };
}
