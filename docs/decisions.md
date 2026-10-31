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

| Path | Notes |
| --- | --- |
| `GET /api/health`, `GET /api/health/deep` | public |
| `POST /api/uploads`, `POST /api/uploads/:id/complete` | authenticated |
| `GET /api/files`, `GET/PATCH/DELETE /api/files/:id` | authenticated |
| `GET /api/files/:id/events` | authenticated, SSE |
| `GET /api/stats` | authenticated |
| `POST /api/debug/cpu?ms=` | admin only |
| `POST /api/rum` | public, see D18 |
| `/api/auth/*` | Better Auth |
| `GET /api/openapi.json` | generated document |
| `GET /f/:id`, `GET /media/:id/:size.webp` | public, see D6 |

`PATCH /api/files/:id` with `{ "isPublic": boolean }` is new: the spec has an `is_public` column and no way
to set it.

**D6. Thumbnails.** Public thumbnails use `GET /media/:id/:size.webp`, which streams the variant through api
with `Cache-Control: public, max-age=31536000, immutable`, so the CDN caches it. It responds only for files
that are `ready`, public and not deleted; otherwise 404. The bucket stays private. The private panel uses
presigned GET URLs from the API.

Consequence: after a file is unpublished, the origin returns 404 but copies already on the CDN survive until
purged. Unpublishing is not an instant takedown.

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
api, including errors. Platform-served static files cannot carry them.

**D10. Upload contract.** `POST /api/uploads` takes `{ contentType, bytes }` and returns
`{ fileId, uploadUrl, uploadHeaders, expiresAt }`.

- `contentType` not in the allowed list is 400; `bytes` above 10 MiB (10 485 760) is 413.
- A signed `Content-Length` pins the exact size, so the declared `bytes` value is signed and the client must
  PUT exactly that many bytes with exactly `uploadHeaders`. The `maxBytes` parameter of `presignPut` is
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
into the first migration. The `user` table therefore exists from E0, even though login UI arrives in E1.

Two columns are added to `files`:

- `last_activity_at timestamptz not null`: set on enqueue, requeue and processing start. Stuck detection needs
  it because `queued_at` must stay untouched: it anchors `upload_to_ready_ms`.
- `purged_at timestamptz`: set once objects are removed. `deleted` rows stay as tombstones so a same-day
  delete does not distort `daily_stats`, and cleanup can tell what still needs purging.

**D14. Seed.** `api_keys.user_id` is `NOT NULL`, so the seed creates users first. Key values come from
`SEED_API_KEY` and `SEED_ADMIN_API_KEY`; if unset they are generated and printed once. Key values are never
committed.

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
  attempt: number;          // 1..maxAttempts, as reported by the platform
  maxAttempts: number;
  receivedAt: Date;
  crash(): Promise<never>;  // chaos=crash; Node: process.exit, Workers: throw without ack
}

export interface Queue {
  send(msg: JobMessage, opts?: { delaySeconds?: number }): Promise<void>;
  sendBatch(msgs: JobMessage[]): Promise<void>;  // adapters chunk to platform limits
  ping?(): Promise<void>;   // absent when the platform cannot ping; reported as "unknown"
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;  // chaos=slow; makes it testable
}
```

`ObjectStorage.get` on a large object is the only way to read variants, including for `/media`. `ImageProcessor`
is unchanged. `InvalidImageError` is exported from core and thrown by processors for undecodable input.

Worker rules that follow from platform differences:

- `chaos=crash` keys off `files.attempts === 1` after the step 1 increment, not `ctx.attempt`. BullMQ does not
  count a stalled job as an attempt, so `ctx.attempt` would stay 1 and crash forever.
- `chaos=fail` throws every time.
- On `ctx.attempt >= ctx.maxAttempts` the handler sets `failed`, records `jobs_dead_lettered`, then rethrows so
  the platform moves the message to the DLQ.
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
client reconnects, and falls back to polling every 2 s if SSE fails.

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

## Open items

- The evaluation framework (criteria A, C, D, G, H) is referenced by the spec but not part of this repository.
