# Decisions

This file resolves ambiguities in [`spec.md`](spec.md) and records deliberate deviations from it. **It
takes precedence over the spec.** When implementation forces a new decision, add an entry here in the same
change.

## Repository and process

**D1. Name and workflow.** The project is `hostmark`, packages use the `@hostmark/*` scope, and the licence
is `GPL-3.0-only`. Work is committed directly to `main`; the owner chose this over the spec's "each adapter
in a separate PR". Smoke test results go in the commit message or adapter README instead of a PR description.

**D2. Additional packages.** Two workspaces are added to the spec's tree:

- `packages/storage-s3` (`@hostmark/storage-s3`): the `aws4fetch` `ObjectStorage` implementation, shared by
  every adapter on the S3 API. It is portable, so it does not belong in a single adapter, and it is not
  domain logic, so it does not belong in core.
- `adapters/local`: the docker compose adapter required by E0.

**D3. Runtime targets.** Docker images and `engines` target Node 22, because maintenance task M2 depends on
upgrading from it. Tests may run on a newer host Node.

**D4. Internal packages are consumed as TypeScript source.** Each `package.json` `exports` map points at
`./src/*.ts`. Adapters bundle with esbuild, Vite or wrangler. There is no per-package build step.
`tsc --noEmit` is typecheck only.

## HTTP surface

**D5. URL layout.** The spec mixes `/uploads` and `/api/files/:id`. Canonical paths are:

| Path                                                  | Notes              |
| ----------------------------------------------------- | ------------------ |
| `GET /api/health`, `GET /api/health/deep`             | public             |
| `POST /api/uploads`, `POST /api/uploads/:id/complete` | authenticated      |
| `GET /api/files`, `GET/PATCH/DELETE /api/files/:id`   | authenticated      |
| `GET /api/files/:id/events`                           | authenticated, SSE |
| `GET /api/stats`                                      | authenticated      |
| `POST /api/debug/cpu?ms=`                             | admin only         |
| `POST /api/rum`                                       | public, see D18    |
| `/api/auth/*`                                         | Better Auth        |
| `GET /api/openapi.json`                               | generated document |
| `GET /f/:id`, `GET /media/:id/:size.webp`             | public, see D6     |

`PATCH /api/files/:id` with `{ "isPublic": boolean }` is new: the spec has an `is_public` column and no way
to set it.

**D6. Thumbnails.** Public thumbnails use `GET /media/:id/:size.webp`, which streams the variant through api
with `Cache-Control: public, max-age=31536000, immutable`, so the CDN caches it. It responds only for files
that are `ready`, public and not deleted; otherwise 404. The bucket stays private. The private panel uses
presigned GET URLs from the API.

Consequence: after a file is unpublished or deleted, the origin returns 404, but copies already on a CDN or in a
browser survive for up to a year, because `immutable` means they are never revalidated. Nothing purges them yet:
E3 adds a CDN purge on both paths, and a browser copy cannot be recalled at all. Neither unpublishing nor deleting
is an instant takedown.

**D7. Authentication and ownership.** A request is authenticated by a `Bearer` API key or a Better Auth
session cookie, resolving to a principal `{ userId, apiKeyId | null, isAdmin }`. Sessions have
`isAdmin = false`. The owner of a file is the user, so 404 checks, listing and deduplication are all per
user, never per key. The `files_key_created` index is dropped in favour of `files_user_created`.

Requests authenticated by cookie must pass a same-origin check on mutating methods (Hono `csrf()` or
equivalent, plus Better Auth `trustedOrigins`). Bearer requests skip it.

`AUTH_SIGNUP_ENABLED` controls registration. Deployed environments should disable it unless a run needs it,
because open signup plus public `/f/:id` pages is a free image host. Email verification is off.

**D8. Status codes beyond the spec.** 403 for a non-admin calling `/api/debug/cpu` or sending `x-chaos`; a
chaos test that silently did nothing would be worse than a loud failure. 503 from `/api/health/deep` when a
dependency is down. 429 is not implemented (it is optional).

**D9. Response headers.** `x-trace-id`, `x-platform` and `x-version` are set on every response produced by
api, including errors. Platform-served static files cannot carry them. When dependency resolution itself fails,
the 500 problem response still carries `x-trace-id` and the `x-platform` and `x-version` of the last successful
resolve (absent only if the very first request fails), and the failure is logged with `console.error`.
Every 401 also carries `WWW-Authenticate: Bearer` (RFC 9110).

**D10. Upload contract.** `POST /api/uploads` takes `{ contentType, bytes }` and returns
`{ fileId, uploadUrl, uploadHeaders, expiresAt }`.

- `contentType` not in the allowed list is 400; `bytes` above 10 MiB (10 485 760) is 413.
- A signed `Content-Length` pins the exact size, so the declared `bytes` value is signed and the client must
  PUT exactly that many bytes with exactly `uploadHeaders`. The `bytes` parameter of `presignPut` is
  therefore the exact length.
- `complete`: no object is 409; object above the limit is deleted and returns 413 (this covers platforms that
  ignore signed length); otherwise `files.bytes` is set from `head` and the status moves
  `pending_upload → queued`. If enqueueing fails, the status is reverted conditionally and the call returns
  503.

**D11. `/api/debug/cpu` cap.** `ms` is limited to 1..30000; anything else is 400.

**D12. `/api/stats`.** Reads the last 30 rows of `daily_stats` for the current platform. The spec's optional
stats service is not implemented.

## Data

**D13. Single initial migration.** The spec's `alter table` statements and the Better Auth tables are merged
into the first migration. The `user` table therefore exists from E0, even though login UI arrives in E1. `0001_files_api_key_set_null` followed it before the first release, when the seed rotation needed `files.api_key_id` to be `on delete set null`; `pnpm generate` names its output `initial`, so give later migrations an explicit `--name`. A deleted file keeps its row as a
tombstone (D19), so `uploads`, `ready` and `bytes_in` of daily-stats stay stable after a delete. `failed` is a
snapshot and may change when a failed file is deleted before a later recompute (D57).

Two columns are added to `files`:

- `last_activity_at timestamptz not null`: set on enqueue, requeue and processing start. Stuck detection needs
  it because `queued_at` must stay untouched: it anchors `upload_to_ready_ms`.
- `purged_at timestamptz`: set once objects are removed. `deleted` rows stay as tombstones so a same-day
  delete does not distort `uploads`, `ready` and `bytes_in` of `daily_stats` (not `failed`, see D57), and cleanup can tell what still needs purging.

**D14. Seed.** `api_keys.user_id` is `NOT NULL`, so the seed creates users first. Key values come from
`SEED_API_KEY` and `SEED_ADMIN_API_KEY`. A value that is set is the only key of its seed user afterwards
(rotation, D75). A value that is unset keeps the existing key of that user and generates nothing; only a user
without any key gets a generated key, printed once. Key values are never committed.

**D15. Storage keys** use `userId`, because `api_key_id` is nullable:

```
originals/{userId}/{fileId}
variants/{userId}/{fileId}/{size}.webp
```

**D16. Variants.** Every `ready` file has exactly three variants, labelled 128, 512 and 1600. A label is the
maximum longer side, and images are never upscaled, so a 300 px source produces `512` and `1600` variants at
300 px. That keeps `/media/:id/512.webp` valid for every ready file. Skipping sizes would leave small images
with no variant at all.

EXIF orientation must be applied to the pixels before re-encoding. Stripping the tag without rotating yields
wrongly oriented thumbnails. Originals keep their EXIF but are never served publicly.

## Queue, worker, scheduler

**D17. Port changes.** Compared to the spec:

```ts
export interface JobContext {
  attempt: number; // 1..maxAttempts, as the platform counts it; it can lag or restart (D63), so core's own bound is files.attempts (D72)
  maxAttempts: number;
  receivedAt: Date;
  crash(): Promise<never>; // chaos=crash; Node: process.exit, Workers: throw without ack
}

export interface Queue {
  send(msg: JobMessage, opts?: { delaySeconds?: number }): Promise<void>;
  sendBatch(msgs: JobMessage[]): Promise<void>; // adapters chunk to platform limits
  ping?(): Promise<void>; // absent when the platform cannot ping; reported as "unknown"
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>; // chaos=slow; makes it testable
}
```

`ObjectStorage.get` on a large object is the only way to read variants, including for `/media`. `ImageProcessor`
is unchanged. `InvalidImageError` is exported from core and thrown by processors for undecodable input.

Worker rules that follow from platform differences:

- `chaos=crash` keys off `files.attempts === 1` after the step 1 increment, not `ctx.attempt`, so it behaves the
  same on every platform whatever its counter does for a job that died with its worker.
- `chaos=fail` throws every time.
- On `ctx.attempt >= ctx.maxAttempts` the handler sets `failed`, records `jobs_dead_lettered`, then rethrows so
  the platform moves the message to the DLQ. If only the file's own counter made the job final
  (`files.attempts >= MAX_ATTEMPTS` while `ctx.attempt` is lower) and the row was updated to `failed`, it returns: the row and
  `jobs_dead_lettered` are the record, no DLQ copy is written, as for a scheduler-driven `failed` (D55, D72).
- `InvalidImageError` sets `failed` and returns normally: no retry.
- Step 6 is conditional on `status = 'processing'`, so a delete racing the job cannot resurrect the file.

Shared constants in `@hostmark/contract`: `MAX_ATTEMPTS = 5`, `BACKOFF_SECONDS = [10, 30, 90, 270]`,
`VARIANT_SIZES = [128, 512, 1600]`, `MAX_UPLOAD_BYTES`, `ALLOWED_CONTENT_TYPES`, TTLs.

**D19. Scheduler touches only the database and the queue,** as the architecture diagram shows; it has no
storage access.

- `cleanup-expired` marks expired files and `pending_upload` rows older than 1 h as `deleted`, then enqueues
  `delete_file` for `status = 'deleted' and purged_at is null`.
- The worker's `delete_file` handler removes the original and all three deterministic variant keys, deletes
  `file_variants` rows and sets `purged_at`. It computes keys rather than reading `file_variants`, so it also
  catches objects from an interrupted `process_image`.
- `requeue-stuck` claims rows with a conditional `update ... set last_activity_at = now() where
  last_activity_at < cutoff returning id`, so a double run claims each row once, then sends new messages. Rows
  with `attempts >= MAX_ATTEMPTS` become `failed` instead: otherwise a job that kills its worker loops forever.
- `daily-stats` upserts, so reruns are harmless.

Each query is bounded (1000 rows per run). The next run picks up the rest.

**D20. SSE.** `GET /api/files/:id/events` polls the database every second, because services do not call each
other. It emits a `status` event on change, closes on a terminal status, and closes after 60 s at most. The
client reconnects, and falls back to polling every 2 s if SSE fails. The server span and `http.server.request.duration`
of this route cover the setup only, not the stream, because the response is returned when the stream starts.

## Frontend

**D21. Pages.** `packages/pages` prerenders `/` and `/pricing` at build time, and `/f/:id` is rendered by api.
The SPA shell is built to `app/index.html`, with `/login`, `/signup`, `/app` and `/app/*` rewritten to it.
`apps/web/dist` is the single static directory that adapters serve. The local adapter serves it with the same
`Cache-Control` rules as a CDN so behaviour matches.

## Telemetry

**D18. `/api/rum`.** Public because landing page visitors have no session. Body size is limited, and every
attribute is validated against a closed list so that hostile input cannot create unbounded metric cardinality.

**D22. Telemetry boundary.** `packages/core` depends only on `@opentelemetry/api` and the helpers in
`@hostmark/telemetry`. Providers are installed by adapters: `@hostmark/telemetry/node` for Node, and whatever
current Cloudflare documentation recommends for Workers (decided in E3). Locally, `grafana/otel-lgtm` runs in
compose.

## Load testing

**D23. Tools.** k6 runs from the `grafana/k6` Docker image because it is not installed on the host and CI needs
the same image. Browser scenarios S10 and S13 use Playwright.

## Foundation details

**D24. Contract details left open by the spec.**

- Route definitions in `@hostmark/contract` use full paths including `/api` (`createRoute` path `/api/files/{id}`), so core registers them on an app without a base path. `GET /f/:id` and `GET /media/...` are not JSON and have no route definition.
- Success codes: `POST /api/uploads` is 201, `complete` is 200 and returns the file, `DELETE` and `POST /api/rum` are 204.
- `CreateUploadRequest.bytes` has no schema maximum: above 10 MiB the answer is 413 (D10), which a schema failure (400) would hide. This includes values beyond `Number.MAX_SAFE_INTEGER`: the schema is `positive().multipleOf(1)` rather than `int()`, because `int()` rejects unsafe integers with a 400.
- `GET /api/files` returns `{ items, nextCursor }`; `limit` is 1..100, default 50; the cursor is the last returned file id and opaque to clients. File objects carry presigned variant URLs in both list and detail.
- `POST /api/rum` takes one metric `{ name, value, rating?, platform, variant, topology, region }`. All string attributes come from closed lists in `constants.ts` (`RUM_*`); unknown keys are rejected (D18).
- RFC 9457 `type` defaults to `about:blank`; `Problem` also allows an `errors` array for 400 field details.
- The typed client lives at `@hostmark/contract/client` (also re-exported from the main entry). It parses responses with the schemas and throws `ApiError` carrying the problem document; `deepHealth()` resolves for 503.

**D25. Database details.**

- Columns are snake_case, properties camelCase. Better Auth tables keep the property names its Drizzle adapter looks up (`user`, `session`, `account`, `verification`).
- Two partial indexes beyond the spec back the scheduler queries of D19: `files_activity` (stuck detection) and `files_unpurged` (purge). `files_user_created` is `(user_id, id desc nulls first)`, matching a plain `order by id desc`.
- `Database` is `PgDatabase<PgQueryResultHKT, typeof schema>`; a compile-time test proves postgres-js and Neon databases, and their transactions, are assignable to it. The main entry of `@hostmark/db` imports no driver; `@hostmark/db/node` holds the `postgres` helpers (`createNodeDb`, `migrate`).
- `apiKeyHash` helpers (`hashApiKey`, `generateApiKey`) live in `@hostmark/db` so seed and core share one SHA-256 implementation (Web Crypto).
- The seed users `seed-user` and `seed-admin` have no credentials and cannot log in.

**D26. Core entry points.** `@hostmark/core/ports` has no runtime dependency except the dependency-free `InvalidImageError`, so `packages/image` and `packages/storage-s3` depend on it without pulling in core. `DomainError` subclasses carry `status`, `code` and `title`; `InvalidImageError` maps to 422.

**D30. WASM image processor.** `@hostmark/image` takes an injected `WasmLoader` that returns compiled `WebAssembly.Module`s, because Workers cannot compile WASM from bytes at runtime. The Node loader is `@hostmark/image/node`; the main entry imports no `node:*`. Codecs are initialised lazily and reused, but an instance that threw is dropped and created again from the compiled module: a libjpeg error exit or a Rust panic leaves wasm memory unusable (or leaking), and one bad upload must not damage the next. Calls into one codec are serialised for that reason. The PNG decoder is a vendored copy of the wasm-bindgen glue of `@jsquash/png` with per-instance state (`src/png.ts`), because the package keeps its instance and heap in module-level variables and cannot be re-initialised after a panic. Only errors that the input can cause (`ExitStatus`, `Decoding error`, a PNG decode panic) become `InvalidImageError`; loader and runtime failures stay ordinary errors and are retried (D55). The WebP encoder ships SIMD and non-SIMD binaries, so the loader receives `simd` (from the same validation probe jSquash uses) and must return the matching module.

**D31. Pixel limit.** Input is rejected with `InvalidImageError` when the header (JPEG SOF, PNG IHDR, WebP VP8/VP8L/VP8X) claims more than 50 megapixels, before any decoding. The JPEG header walk follows libjpeg's marker rules (`FF 00`, fill bytes, standalone markers, a lone EOI before the frame header all handled alike), so the size it sees is the size the decoder will allocate. Decoded RGBA costs 4 bytes per pixel, so the limit alone does not fit Workers memory (about 128 MB, which holds roughly 12 to 16 MP with a resize buffer); the limit is a constructor option so the Workers adapter can lower it. Anything above it is a decompression bomb candidate: a 10 MB PNG can claim far more than it holds.

**D32. Resize before rotate.** Variants are resized from the unrotated pixels, then the small result is rotated by the EXIF orientation. The pixels equal the rotate-first order, but no full-size rotated copy is made. Sizes are processed largest first and each resize starts from the previous result. Reported `width` and `height` are the upright dimensions. Malformed EXIF is treated as orientation 1.

**D40. Telemetry helpers.** The main entry of `@hostmark/telemetry` imports only `@opentelemetry/api` and parses `traceparent` itself, so propagation does not depend on a registered propagator and an invalid header yields `undefined`. The worker span gets a link, not a parent, so it starts its own trace. `tracestate` is relayed only as the link attribute `tracestate.raw`, because building a `TraceState` needs `@opentelemetry/core`. The logger writes one JSON line per call (reserved keys win over caller fields), never throws, and `createTelemetry` is a no-op without providers. The logs API lives in `@opentelemetry/api` 1.10; `@opentelemetry/api-logs` is not used.

**D41. Node SDK bootstrap.** `startNodeTelemetry` returns `{ shutdown, write }`. `write` is the sink for `createTelemetry(service, { write })`: it prints the line and forwards it as an OTLP log record, so logs reach the backend with the active trace context. With an empty `otlpEndpoint` a no-op span processor is installed, because NodeSDK creates no tracer provider from an empty processor list, and empty metric readers and log processors stop it from falling back to `OTEL_*` environment defaults.

**D42. S3 storage.** `@hostmark/storage-s3` presigns with `AwsV4Signer` (`signQuery`, `allHeaders` for PUT), so `content-type` and `content-length` are part of the signature; MinIO enforces both (403 otherwise). Presigned URLs use `publicEndpoint`, server calls use `endpoint`. One retry on 5xx/429 instead of the aws4fetch default of 10, to keep hidden retries out of benchmark latency. `delete` sends single DELETEs, four at a time. Object keys are percent-encoded per segment before signing (aws4fetch turns a literal `+` in the path into a space), and `.`/`..` segments are rejected. `get` throws on `NoSuchBucket` instead of returning `null`.

**D50. Upload response.** `uploadHeaders` carries only `content-type`; the signed length is implied by the body. `expiresAt` in the create response is the expiry of the presigned URL (now + 600 s), not of the file (now + 7 days, stored in `files.expires_at`).

**D51. Cookie CSRF check.** Mutating requests authenticated by session cookie must carry an `Origin` whose host equals the first entry of `x-forwarded-host` (a proxy chain appends) or `host`, compared case-insensitively; otherwise 403. Bearer requests are exempt. Sessions are never admin.

**D52. Completing an upload.** The object is checked with `head` at `complete`. A missing object is 409. An object larger than `MAX_UPLOAD_BYTES` is deleted, the file is marked `failed` and the response is 413. If `queue.send` fails the file returns to `pending_upload` and the response is 503. The `x-chaos` admin check runs first, on the mere presence of the header, so a non-admin gets 403 before validation or anything else happens (same for `/api/debug/*`, D8).

**D53. Pagination cursor.** The `cursor` of `GET /api/files` must be a UUID; anything else is a 400 problem response.

**D54. Worker steps.** `process_image` has the spans `claim`, `download`, `hash`, `dedup`, `transform`, `write_variants`, `commit`, `ack` (hash and dedup both belong to step 3). The commit is conditional on `status = 'processing'` and upserts `file_variants`. The commit transaction reports `committed`, `deleted` or `superseded`: when it affects no row it selects the status. Only `deleted` (a delete won the race) removes the variant objects the job wrote. `superseded` (the row is `ready` or `failed`: another delivery finished the file first, or `requeue-stuck` failed it) leaves the objects alone. For `ready` they are the same keys the winner uses. For `failed` they stay without `file_variants` rows until the purge removes them, which is bounded and accepted. A claim that misses on a `deleted` row also removes variants, covering objects written after `delete_file` ran (D74). Cleanup failures are not swallowed: the job fails and is retried. Dedup is per user: variants of an earlier ready file with the same hash are copied through `get`/`put`; if their objects are missing the job processes normally.

**D55. Failure bookkeeping.** `last_error` is written on every failed attempt. On the final attempt (`attempt >= maxAttempts`) the file becomes `failed`, `jobs_dead_lettered` is counted and the error is rethrown so the message reaches the DLQ; earlier attempts count `jobs_retried`. A job that is final only through `files.attempts >= MAX_ATTEMPTS` and updated the row records the failure and returns without rethrow and without a DLQ copy; when no row was updated (a delete won) it rethrows, and the retry acks on the claim miss (D17, D54, D72). `InvalidImageError` marks `failed` immediately and returns, so the message is acked without a retry or a dead-letter count.

**D56. Scheduler results.** `processed` of `cleanup-expired` is the number of `delete_file` messages enqueued (the number newly marked deleted is logged as `marked`). `processed` of `requeue-stuck` is requeued plus failed rows. Rows at `MAX_ATTEMPTS` are failed with `last_error` kept, or `gave up after 5 attempts` if empty, and counted in `jobs_dead_lettered`. A requeue resets `chaos` to `none` (D73). The metric attribute for the job name is `scheduler.job`. Claims use a conditional update that repeats the staleness test, so overlapping runs claim each row once.

**D57. daily-stats semantics.** Rows are cohorted by `created_at` within a UTC day. `uploads` counts files with `queued_at` set, `ready` those with `ready_at` set, `failed` those with `status = 'failed'` and `queued_at` set (so `failed <= uploads`), taken as a snapshot when the day is computed; `bytes_in` sums `bytes` of the uploads. Percentiles are of `ready_at - queued_at` in ms and are null for an empty day. The row is upserted per `(day, platform)`. Each run recomputes the previous two UTC days so late `ready_at` and failures are picked up, and the second pass can lower an earlier `failed` when the file was deleted meanwhile; `processed` of the run is the sum of `uploads` over those days.

**D58. createApp options.** `createApp(resolveDeps, { probeTimeoutMs })` takes an optional second argument; the default probe timeout for `/api/health/deep` is 2000 ms.

**D59. Contract suites.** `@hostmark/core/test/contract` exports `describeQueueContract`, `describeObjectStorageContract` and `describeImageProcessorContract`, each taking `(name, factory)`. The factory returns a harness: the queue one adds `receive(max, waitMs)` because delivery is platform specific; the image one carries fixtures (`large`, `small`, optional `withMetadata` and `rotated`). Optional capabilities are declared by the harness and skipped visibly when absent: `consume` (redelivery with attempt numbers, DLQ after `maxAttempts`) for queues, `capabilities` (`rejectsWrongLength`, `rejectsWrongContentType`, `expiresUrls`) for storage. Suites import nothing but vitest and core types.

**D60. Local runtime bundle.** Each service of `adapters/local` is one esbuild ESM bundle (`api`, `worker`, `scheduler`, `run-job`, `init-bucket`, `migrate`, `seed`) inside one Docker image. Only the four `@jsquash/*` packages stay external: they load their `.wasm` files relative to the module, so the runtime stage gets them from `pnpm deploy --prod --frozen-lockfile` at the locked versions (D68). The smoke test proves the wasm path inside the container.

**D61. Compose configuration.** `docker-compose.yml` reads `adapters/local/.env`, copied from the committed `.env.example` (local-only placeholders, never real secrets; D14 seed keys live there). All host ports bind to 127.0.0.1: api 58080, Postgres 55432, Redis 56379, MinIO 59000, Grafana 53000, OTLP/HTTP 54318. Presigned URLs use `S3_PUBLIC_ENDPOINT` (`http://127.0.0.1:59000`) because the host is part of the signature; the services use `S3_ENDPOINT` (`http://minio:9000`).

**D62. MinIO CORS.** The chainguard MinIO build answers the bucket CORS API with 501 NotImplemented. CORS is therefore set server-wide with `MINIO_API_CORS_ALLOW_ORIGIN=*` (verified: preflight for PUT with `Content-Type` is allowed). `init-bucket` still tries the bucket API first and logs the refusal. The lifecycle rules (`originals/` and `variants/` expire after 8 days, D74) are applied through the S3 API, which requires a `Content-MD5` header on this server.

**D63. BullMQ mapping.** `image-jobs` uses `attempts = MAX_ATTEMPTS` with a custom backoff strategy reading `BACKOFF_SECONDS`, `lockDuration` 60 s and no `jobId` (no deduplication, same as the other adapters). `ctx.attempt = max(job.attemptsStarted, job.attemptsMade + 1)`: BullMQ's `attemptsMade` counts only finished attempts, so a stalled attempt (worker died, lock expired) would be invisible, while `attemptsStarted` counts every start and tracks core's `attempts` column (claim) for a single message, which is why the crash smoke step ends with 2 attempts. The worker sets `maxStartedAttempts = MAX_ATTEMPTS` (a job that keeps killing its worker is failed after five starts) and `maxStalledCount = MAX_ATTEMPTS` (BullMQ's default of 1 failed a job after its second stall with `attemptsMade` still 1). The attempt that is the last by this count fails with `UnrecoverableError`, so BullMQ does not schedule a sixth start whatever `attemptsMade` says. The producer connection has no offline queue and one retry per command, and `send` gives up after 5 s, so a Redis outage makes `complete` answer 503 (D52) instead of hanging. `delaySeconds` is the job `delay`; `sendBatch` is `addBulk` in chunks of 100.

**D64. Dead-letter queue on BullMQ.** BullMQ has no native DLQ. The worker's `failed` listener copies the payload to the queue `image-jobs-dlq` when the job has `finishedOn`, which BullMQ sets only on terminal failure (exhausted attempts, `UnrecoverableError`, too many stalls or starts). A copy gated on `attemptsMade` missed jobs failed by the stall check. If the fifth start kills the process before core can mark the row, BullMQ fails the job on the next pickup and `requeue-stuck` marks the row `failed` (it has `attempts >= MAX_ATTEMPTS`). The copy is a second step: if the process dies between BullMQ's `moveToFailed` and the DLQ write, the job stays in BullMQ's failed set (kept 7 days) with no DLQ entry, and nothing reconciles it; the file row is still marked `failed` by `requeue-stuck`. A job that keeps killing its worker (poison input, out of memory) takes the other jobs in flight with it each time: they stall too and each loses one start, so an innocent sibling that runs longer than the killer can use up its five starts next to it. `close()` waits for pending copies. `InvalidImageError` returns without retry (D55) and is not dead-lettered.

**D65. Crash recovery latency.** `ctx.crash` is `process.exit(1)`; the worker service has `restart: unless-stopped`. A job held by the killed process is taken back by BullMQ's stalled check (lock 60 s, check every 30 s), so the file becomes `ready` roughly 60 to 90 s after the crash. This is a property of BullMQ, not a defect to fix. Each further crash of the same job costs the same again; after five starts the job is dead-lettered (D63, D64).

**D66. Retry scale for tests.** `QUEUE_BACKOFF_SCALE` (default 1) multiplies the backoff delays. The smoke test recreates the worker with `0.02` so five attempts finish in seconds, then restores the default.

**D67. Scheduler process.** `croner` runs `createSchedulerJobs` in UTC with `protect: true` (no overlap inside one process) and `catch`; cross-process safety remains the database claim of D19/D56. `run-job.js <job>` executes one job and exits, for verification and manual use.

**D68. Docker build.** The build stage uses pnpm 12 with `pnpm_config_strict_dep_builds=false`: the install scripts of esbuild, msgpackr-extract and protobufjs are ignored, not run (esbuild ships its binary as a platform package; the other two have JavaScript fallbacks), and an ignored script must not fail the install. The lockfile holds two releases younger than pnpm 12's default `minimumReleaseAge`; they are named in `minimumReleaseAgeExclude` of `pnpm-workspace.yaml` (`bullmq@6.5.3`, `set-cookie-parser@3.2.2`) instead of switching the check off. Drop the entries once a later bump moves past them. The runtime stage gets its `node_modules` from `pnpm deploy --prod --frozen-lockfile`, so it holds exactly the jSquash packages (the only external dependencies of the bundles, kept so the Node loader finds their `.wasm` files) at the locked versions, with no `npm install` and no unlocked resolution. The `# syntax=` directive is omitted because it needs Docker Hub access at build time. `APP_VERSION` is a build argument (the commit) and becomes `service.version` and `x-version`.

**D69. Local test layout.** The image contract runs always (it needs no service). The storage contract runs when `S3_TEST_ENDPOINT` is set, the queue contract when `REDIS_TEST_URL` is set; otherwise they are skipped. The queue harness reads with `startConsumer`. Trace linking is verified by the smoke test through the Grafana proxy to Tempo: producer and worker are two traces joined by a span link (D40), so criterion 3 is met as "linked", not as one parented tree.

## Platforms

**D70. Platform opt-in.** Every platform adapter lives in the repository and is off by default. `platforms.json` at the repository root lists each platform with `enabled`, its adapter directory, a `status` of `emulated` or `deployed`, and the names of its required secrets, never their values. Every platform starts with `enabled: false`. `pnpm platform list` shows the state, `pnpm platform check <name>` reports missing variables without printing values, and `pnpm platform deploy <name>` refuses unless the platform is enabled. The GitHub Actions deploy workflow runs only on `workflow_dispatch` and builds its matrix from enabled entries, so a merge to `main` deploys nothing. Disabled adapters still go through typecheck, lint and emulator tests in CI, so they do not rot.

**D71. Scope extension.** The owner extended the current effort to the portable variant of all seven platforms: Cloudflare, Google Cloud, AWS, Railway, Fly.io, Vercel and VPS. Idiomatic variants (E9), multi-region (E8) and the preview and rollback pipeline (E4) stay later: they depend on portable adapters that have run on the real platforms. Enabling a platform and deploying it are the owner's decisions, made per platform, because each one needs an account and costs money.

**D72. Stored errors.** `files.last_error` holds a generic `processing failed` for unexpected errors; only `InvalidImageError` messages and the deliberate chaos and missing-original messages are stored verbatim. The raw error goes to the log with the trace id. Stored text is shown to users, so internals must not leak into it. A job also treats `claimed.attempts >= MAX_ATTEMPTS` as final, because a platform counter can restart when a message is requeued (D63) and the file's own counter then bounds the retries. When that is the only reason it is final and the row was updated, the job records the failure and returns instead of rethrowing (without an updated row it rethrows, so a failed cleanup of a deleted file is retried), so the platform spends no retry and no DLQ copy exists (D17, D55). `jobs_dead_lettered` is counted only for rows actually updated. Kills do not run the failure handler, so `files.attempts` can exceed five (up to nine was measured) until `requeue-stuck` fails the row.

**D73. Requeue clears chaos.** `requeue-stuck` sends the requeued message with `chaos: 'none'`. Chaos is a field of the queue message, not of the row, so a requeue starts from a clean message. A chaos request describes one injected failure; keeping it on a requeue would make a stuck job fail again by design and hide whether the recovery path works.

**D74. Variant cleanup safety net.** Variants written by a job that lost the race are removed by the commit that finds the file `deleted`, and those written after `delete_file` ran by the claim miss (D54). As a second line of defence the bucket lifecycle rule that expires `originals/` after 8 days also covers `variants/`, so a leak that survives even the retry ends in expiry rather than in permanent storage cost. A lifecycle rule goes by object age and cannot see the database, so this is safe only because `expires_at` is set once, at creation, to 7 days: an object older than 8 days always belongs to an expired file. Anything that lengthens retention or lets a file outlive `FILE_RETENTION_DAYS` must move this rule first, on every adapter, or it deletes live thumbnails. The adapter owns the rule.

**D75. Seed key rotation.** The seed reads `SEED_API_KEY` and `SEED_ADMIN_API_KEY` (D14); when both are set they must differ, otherwise it refuses. A value that is set rotates: all other keys of that seed user are deleted, including keys added by hand, because the seed owns those two users. Their files are kept with `api_key_id` set to null (`files.api_key_id` is `on delete set null`, so a rotation during an upload cannot abort). A value that is unset keeps an existing key of that user and generates nothing only when one exists (a user without a key gets a generated one), so two runs without values leave the first keys working. Re-seeding also updates `is_admin`, `name` and the owning user of an existing key hash.

**D76. Periodic re-send of `queued` rows.** `requeue-stuck` runs every five minutes and re-sends rows that have been `queued` longer than the stuck threshold of ten minutes. During a long backlog this repeats messages for rows that are merely waiting. This is accepted: the conditional claim keeps a duplicate from corrupting a row (D54), and suppressing duplicates would need a per-row send timestamp that every adapter would have to maintain. Duplicates are not free: every start increments `files.attempts`, so duplicates share the five-attempt budget and a file can reach `failed` without the full backoff ladder.

**D77. Truncated JPEGs.** A JPEG cut off inside its scan data is accepted: libjpeg recovers the rows it has and fills the rest, as browsers show it, and the file is processed from that. A file cut before the scan, or with a broken table, is refused as `InvalidImageError`. A truncated PNG or WebP is refused (their decoders do not recover).

**D78. CMYK and YCCK JPEGs.** A JPEG with four colour components (CMYK, YCCK, usually Adobe) is refused with `InvalidImageError` before any decoder runs. The decoder cannot convert it to RGB (it exits with an error that used to damage the codec instance), and a dependable ICC-free conversion is out of scope for a benchmark app. Grayscale and three-component files are accepted.

**D79. Worker memory limit.** The worker service has `mem_limit: 4g` and the same `memswap_limit`, so the result does not depend on the swap of the host. Measured on the stack without swap, with maximum-size inputs (50 MP JPEG, 16-bit PNG, WebP, tall PNG) at the default concurrency 4: one 50 MP job peaks at 1.9 GB; four at once at 2.3 GB (JPEGs) and 3.4 GB (mixed formats); a sustained stream of 24 such jobs peaked at 3.7 GB, with no kernel kill and every file `ready` on its first attempt. Lower figures in earlier runs (12 MP 0.75 GB, 24 MP 1.6 GB, 48 MP 2.7 GB, 3.5 GB limit) were for one job or a batch only; the 3.5 GB limit held a sustained stream only with 352 MB of swap. The margin above the sustained peak is about 300 MB, so more concurrency or a higher pixel limit needs a new measurement. If the limit is reached, the kernel kills the worker (exit 137): the jobs in flight stall, are started again after the lock expires (D65) and are dead-lettered after five starts (D63, D64); a benchmark run that sees this measures retries, not the platform. Platforms with a smaller memory budget must lower the pixel limit or the concurrency instead (D31).

**D80. Session authentication.** `packages/auth` exports `createAuth({ db, secret, baseUrl, trustedOrigins, signupEnabled })`, which returns the `SessionAuth` port. It is Better Auth over the existing tables through its Drizzle adapter: email and password only, verification off (D7), sessions in Postgres, an `HttpOnly`, `SameSite=Lax` cookie that is `Secure` exactly when `baseUrl` is https, and no Node-only import. `signupEnabled: false` sets `disableSignUp`; existing accounts still log in. `seed@hostmark.test` and `admin@hostmark.test` cannot be registered, however they are spelled in case or surrounding whitespace: a real account with one of them would make every later seed fail on the unique email, and the seed must never adopt it, because that would hand out the admin role. The check runs in Better Auth's `databaseHooks.user.create.before`, so it holds for every route that creates a user, not only `/sign-up/email`. The two emails, `RESERVED_EMAILS` and `isReservedEmail` live in `packages/db` (`seed.ts`), the one source the seed uses too. The rate limiter never runs on a key a client can choose or that everyone shares. Better Auth keys it on `x-forwarded-for`, which a client can forge, and falls back to one shared `no-trusted-ip` bucket when the header is missing or holds a list: with the defaults, three wrong sign-ins from anyone locked every client out, and a rotating forged header was never limited. So `createAuth` takes an optional `clientIpHeader`. Set, it is the only header read (`advanced.ipAddress.ipAddressHeaders`), the limiter is on in every environment (3 attempts per 10 s on each of sign-in and sign-up, 100 requests per 10 s on any other path, per address), and an auth request whose header does not hold exactly one valid address is refused with 400 instead of being pooled into the shared bucket. Unset, the limiter is off (`rateLimit.enabled: false`): no trusted address means no limiter, and a burst gets no 429. Each deployed adapter sets `clientIpHeader` to a header its platform overwrites on every request before it is public (plan E3, E5 and E7); the local adapter leaves it unset. The counters are in memory, so the limit is per instance, and a load test must not use sign-in as a load path while the limiter is on. `trustedOrigins` entries are normalised with `new URL(entry).origin` and startup fails for one that is not an http(s) URL (`spa.test` is refused, `http://spa.test/` works). They pass Better Auth's own origin check on `/api/auth/*` only, not the same-origin check on API mutations (D51), and Better Auth checks any request that carries a cookie, `Origin` or `Referer`; a request with none of them passes. The auth route has a 64 KiB body limit, answering the same 413 as `/api/rum`, because sign-up is anonymous and stored a 30 MiB `name` before.

**D81. Public pages.** `packages/pages` holds pure functions that return HTML strings with Hono JSX and import no database or platform code: `renderLanding`, `renderPricing`, `renderPublicFile`, `renderNotFound`, `renderError`. The CSS is inlined (no stylesheet request), system fonts, one accent colour, no gradients, and the LCP element is the `h1` text on the landing and pricing pages and the image on `/f/:id`, so the text does not wait for JavaScript. Every page ends with `<script type="module" src="/rum.js" data-rum="" data-platform data-variant data-topology data-region>`; Hono writes the bare `data-rum` as `data-rum=""`, which is the same attribute in HTML. The values come from the closed `RUM_*` lists. `scripts/prerender.ts` writes `apps/web/dist/index.html` and `pricing/index.html` after the Vite build from `HOSTMARK_PLATFORM` (default `local`), `HOSTMARK_VARIANT`, `HOSTMARK_TOPOLOGY` and `HOSTMARK_REGION`, refuses a value outside the lists, and takes `HOSTMARK_DIST` as an alternative output directory. The contract is only a dev dependency, for the script and the tests, so the renderers stay free of it. Pricing shows example tiers and says so. Files have no stored name (the schema has no `original_name`), so the page title is generated from the dimensions; there is no user-controlled text on the page, but the renderers escape their input regardless and the tests feed them hostile strings.

**D82. `/f/:id` origin and caching.** Absolute URLs (`og:url`, `og:image`, canonical) are built from `AppConfig.publicUrl`, never from the request, when it is set, and then the page is sent with `Cache-Control: s-maxage=60, stale-while-revalidate=600`. A CDN keys that page by path, so building URLs from `Host` or `X-Forwarded-Host` would let one request with a hostile host plant a page that points every crawler at an attacker. Without `publicUrl` the origin comes from the first `x-forwarded-host` entry, else `host` (as in D51), and `x-forwarded-proto`; a host that is not a plain hostname with an optional port yields a page without absolute URLs; and the response is `private, no-store`. Deployed platforms must set `PUBLIC_URL`, and it should be the same value as the auth base URL. The page also sends a strict `Content-Security-Policy` (own origin only, inline styles, no frames), `nosniff` and `referrer-policy: same-origin`. Visibility is the rule of D6 (`ready`, public, not deleted). Consequence: after unpublishing or deleting, the origin answers 404 at once, but the page itself can still be served from a shared cache for up to 11 minutes (60 s fresh plus 600 s stale-while-revalidate); the images it points to follow D6 and can live far longer. `AppConfig` gains `publicUrl` and `rum` (partial overrides of the RUM attributes). The RUM platform and variant default from the platform key (`aws-portable` gives `aws` and `portable`); a value outside the closed lists falls back to `local`, `portable`, `single`, `local` instead of failing the request.

**D83. Failure handling of `/f/*`.** A missing, private, unfinished, deleted or malformed id, and any unmatched path below `/f/`, answers an HTML 404 from `packages/pages`; an unexpected error answers an HTML 500 with a generic message and logs the cause with the trace id, like the JSON routes. Every non-200 answer under `/f/` carries `Cache-Control: no-store`, including the 500 for a failed dependency resolution, which has no configuration to render with and stays a JSON problem document. The D9 headers are on all of them, and the route is recorded by its pattern `/f/:id`.

**D84. Cookie path verified.** With the real `createApp` and the real `createAuth` over Postgres, a session cookie runs upload, complete, get, list, patch, delete and the SSE stream of its own files (another user's file is a 404). Mutations without an `Origin`, with a foreign or lookalike one, or `null` get 403, while the host in `x-forwarded-host` is accepted and reads are not checked; Bearer requests skip the check and a bad Bearer is not rescued by a cookie. A session is never admin: `/api/debug/*` and `x-chaos` answer 403. No change to the ports was needed. Better Auth runs its own origin check on `/api/auth/*`, against `baseUrl` and `trustedOrigins`, so a dev setup that reaches the app through another host must list that origin. The session cookie is `better-auth.session_token`, with the `__Secure-` prefix over https. Packages that import `@hostmark/core` now typecheck its JSX dependency, so their tsconfig needs `"jsx": "react-jsx"` and `"jsxImportSource": "hono/jsx"`.

**D85. RUM script and build.** `src/rum.ts` is a second Vite entry written to the fixed path `dist/rum.js` and has no React. Hashed chunks would break a cached `rum.js` after a deploy, so the constants it imports are inlined into the file (it is self-contained, about 3.6 KB gzipped). It finds its tag with `document.querySelector('script[data-rum]')`, because a module script has no `document.currentScript`. It sends nothing unless `platform`, `variant`, `topology` and `region` are all present and in the closed `RUM_*` lists. Each metric goes in one request through `navigator.sendBeacon` with a `Blob` typed `application/json` (a string would be sent as `text/plain`), or through `fetch` with `keepalive` when `sendBeacon` refuses. The SPA shell gets the same tag from a Vite plugin after HTML processing, with values from `HOSTMARK_PLATFORM`, `HOSTMARK_VARIANT`, `HOSTMARK_TOPOLOGY` and `HOSTMARK_REGION` at build time, defaulting to `local`, `portable`, `single`, `local`. `@hostmark/contract` exports `./constants` so that the script can import the lists without pulling in zod.

**D86. Panel authentication and uploads.** The panel calls Better Auth with plain `fetch` (`sign-in/email`, `sign-up/email`, `sign-out`, `get-session`), not its client. Better Auth requires a `name` at signup, so the panel sends the part of the email before the `@`. Signed-out visits to `/app/*` redirect to `/login` through the session query in the router guard, and so does a 401 from any query, mutation or API call of an upload: one handler (`signedOut` in `session.ts`) removes every cached query except the session, sets the session to `null` and goes to `/login`. Uploads bypass the query cache, so `UploadError` marks a 401 from create or complete and the upload list calls the handler itself; any other upload error, including a refused PUT to storage, keeps its row and Retry. A session can also end with no 401 (the guard reads `null` when the cached session goes stale), so signing in removes the same queries, and the next user of the tab sees nothing of the previous one on either path. Every `fetch` to the API (the contract client and the Better Auth calls) carries a fresh `traceparent`, so the trace starts in the browser. `EventSource` cannot set headers, so the event stream and the PUT to storage carry none. The PUT to the presigned URL uses `XMLHttpRequest` (progress) with exactly `uploadHeaders` and no other header, so it adds no CORS preflight beyond what storage allows for that `Content-Type` (D62). A cancelled upload aborts the PUT and leaves its `pending_upload` row to the cleanup of D19; the client sends no DELETE. The gallery does not show `pending_upload` rows (a running upload is in the upload list above it), so a page may hold fewer tiles than rows, and "Load more" stays while a next page exists. Deduplication is invisible to the API (the worker does it, D54), so the gallery only marks a file as a duplicate when its `sha256` equals that of an older file in the loaded pages.

**D87. Live status and gallery polling.** The file page opens one `EventSource` once the file is known to be non-terminal, and closes it on a terminal event and on unmount. It falls back to polling every 2 s (`SSE_FALLBACK_POLL_MS`) when the browser gives up on the stream, after 3 consecutive errors without a successful open, or when no response headers arrive within 10 s (a buffering proxy). A close by the server's 60 s limit is an ordinary error followed by the browser's own reconnect, so it does not trigger the fallback. The page shows which of the two modes is active. The gallery never opens a stream per item, because browsers allow about six connections per host on HTTP/1.1: it refetches the list every 2 s only while a loaded file is `queued` or `processing`. The file page stops polling once its query is in error (for example 404). The usage panel is titled "Platform usage" because `/api/stats` is platform-wide (D12). The preview on the file page carries `width` and `height` computed from the file's dimensions and the variant size the way the worker does (longer side `min(size, longest)`), so the image reserves its space and causes no layout shift. Presigned thumbnail URLs change on every fetch, so each thumbnail keeps the first URL it saw and the image does not reload on each poll.

**D88. Static serving from the api process (local adapter).** `adapters/local/src/static.ts` is a platform-neutral handler (`createStaticHandler({ root })`, GET and HEAD) that runs before the app and returns `null` on a miss, so 404 handling stays in core, except under `/assets/`, which answers a `no-store` 404 itself so a CDN cannot keep it. `/api`, `/f`, `/media` and `/health` are never answered by it. `/login`, `/signup`, `/app` and `/app/*` serve `app/index.html`, with one trailing slash accepted on all three; `/` and `/pricing` resolve to the prerendered `index.html` and `pricing/index.html`; any path with a dot segment, a backslash or a NUL is a miss, and so is a symlink that leaves the root. Headers match what a CDN would apply: `/assets/*` `public, max-age=31536000, immutable`, everything else (HTML and the unhashed `/rum.js`) `public, max-age=300`. Files are read once and kept in memory, because the directory is immutable for the life of an image. The local adapter does not compress: there is no `Content-Encoding`, so the app script of about 740 KB goes over the wire as about 740 KB where a CDN sends Brotli or gzip (about 205 KB gzip). On loopback this costs little, but LCP and the transfer sizes in Web Vitals from `local` are not comparable with CDN-fronted platforms for the first load of `/app`; the landing and pricing pages are small. The api needs `BETTER_AUTH_SECRET` (32+ characters) and `PUBLIC_URL`, and exits at startup without them (`PUBLIC_URL` must be http or https and only its origin is used; the secret is trimmed before the 32 character check, and the `.env.example` placeholder passes because the local stack runs on it); `AUTH_CLIENT_IP_HEADER` is unset locally, so the limiter is off (D80); the worker and scheduler do not build the auth. There is one image for all services, so the worker and scheduler images also carry `/app/web` unused (about 750 KB). Extracting a shared Node runtime in E5/E7 moves `static.ts` and the secret check as they are.

**D89. End-to-end test in a browser.** `apps/web/e2e` runs Playwright against the running compose stack (`pnpm --filter @hostmark/web e2e` where a browser launches). On this sandbox Chromium cannot start on the host (Mach port rendezvous is denied), so the suite runs in `mcr.microsoft.com/playwright:v1.64.1-noble` with `e2e/forward.mjs` forwarding `127.0.0.1:58080` and `:59000` to `host.docker.internal`; the presigned URLs are not changed for the test. The journey holds the PUT back for 1.5 s so the progress bar can be observed, and answers the first read of the file as `processing` so the page always opens the event stream (the worker finishes in about a second, which would otherwise make the stream race with the first load). The journey also fails on console errors, page errors, failed requests (except an event stream aborted because the page was left) and 4xx or 5xx answers; the other three specs provoke errors on purpose and fail on page errors only. Web Vitals are checked by leaving each page for real after a click and asserting that the page recorded `LCP` and `CLS` beacons (a `sendBeacon` Blob body is invisible to Playwright, so the page records the names in `localStorage`) and that every beacon Playwright could see got a 2xx (it reports only some of those that leave with the unloading document), on a prerendered page and on `/f/:id`, the only page with a CSP. The reserved seed email is refused by Better Auth as "already exists" because the seed user is a real row; the reserved-email hook is covered in `packages/auth`.

## Open items

- The evaluation framework (criteria A, C, D, G, H) is referenced by the spec but not part of this repository.
