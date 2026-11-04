# @hostmark/storage-s3

`ObjectStorage` for any S3-compatible API (R2, S3, GCS interoperable mode, Tigris, MinIO) on `aws4fetch`.
Path-style URLs by default, virtual-hosted-style on request; Web Crypto and `fetch` only, so it runs on Workers, Node
and Bun.

```ts
createS3Storage({ endpoint, publicEndpoint?, bucket, region, accessKeyId, secretAccessKey, virtualHost?, fetch? })
```

Adapters supply the credentials from their own environment (no secrets in the repository).

- `publicEndpoint` is used only for presigned URLs. SigV4 signs the host, so it must be the host the browser
  will call. Server-side calls use `endpoint`.
- `virtualHost: true` puts the bucket in the host name (`https://<bucket>.<host>/<key>`) for every server call and
  every presigned URL, of `endpoint` and `publicEndpoint` alike (D280). Tigris needs it: its documentation says
  presigned URLs must be virtual-hosted and path-style URLs are not supported for buckets created since 2025-02-19. The bucket
  name must then be one DNS label (3 to 63 lowercase letters, digits, hyphens; no dot, which the TLS wildcard
  certificate would not cover), or `createS3Storage` throws. The default stays path-style, which MinIO behind a plain
  host name (`http://minio:9000`) needs. `bucketUrl(endpoint, bucket, virtualHost)` is exported for bucket-level
  calls (`init-bucket` of `packages/node-runtime`).
- `presignPut` signs `content-type` and `content-length` (`bytes` is the exact length, D10). The client must
  send exactly these headers.
- At most one retry on 5xx/429. Hidden retries distort benchmark latency.
- `delete` issues single `DELETE` requests, four at a time; a missing key is success.
- Keys may contain `/`. Segments `.` and `..` and empty keys are rejected because the URL parser would
  resolve them before signing.

## What each backend enforces on a presigned PUT

| Backend                            | Signed `content-type`                                  | Signed `content-length`                                                          |
| ---------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| MinIO (`chainguard/minio`, tested) | enforced: other type gives 403 `SignatureDoesNotMatch` | enforced: any other length (smaller or larger) gives 403 `SignatureDoesNotMatch` |
| AWS S3                             | enforced when the header is in `SignedHeaders`         | enforced when signed (documented behaviour, not tested here)                     |
| Cloudflare R2                      | not verified here                                      | not verified here                                                                |

D10's `head` check in `complete` remains the fallback for any backend that ignores a signed header. R2 and S3
rows are not tested in this package; run the MinIO suite plus a manual check before relying on them.

Other MinIO behaviour: keys with `//` are rejected (`XMinioInvalidObjectName`), and a `HEAD` on a missing
bucket answers 404 without a body but with `x-minio-error-code: NoSuchBucket`. `get`, `head` and `delete` all
report a missing bucket as an error; only a missing object is `null` (`get`, `head`) or fine (`delete`). Backends
that send no error code on HEAD cannot be told apart, and `head` returns `null` there.

## Tests

`pnpm exec vitest run --project storage-s3` runs the offline tests. The integration suite is skipped unless
`S3_TEST_ENDPOINT` is set (optional `S3_TEST_ACCESS_KEY`, `S3_TEST_SECRET_KEY`; they default to the credentials of
the compose stack, `hostmark` / `hostmark-local-secret`); it creates its own bucket.

```sh
docker run -d --name hostmark-minio -p 127.0.0.1:59000:9000 \
  -e MINIO_ROOT_USER=hostmarktest -e MINIO_ROOT_PASSWORD=hostmarktest-secret \
  cgr.dev/chainguard/minio server /data
S3_TEST_ENDPOINT=http://127.0.0.1:59000 pnpm exec vitest run --project storage-s3
```

The official `minio/minio` image is no longer published to Docker Hub or Quay, so the example uses the
Chainguard build.
