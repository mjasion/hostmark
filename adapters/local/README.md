# adapters/local

Portable runtime on Docker Compose: Node 22, Hono, Postgres, Redis (BullMQ), MinIO and `grafana/otel-lgtm`.
This is the `local-portable` platform. The adapter only maps core ports to these services (see D60 to D69).

The queue, storage wiring, env schema, entrypoint bodies, static serving and build script are the shared Node runtime in
`packages/node-runtime` (D150), also used by `adapters/vps`, `adapters/fly` and `adapters/railway`. This directory keeps
the five entrypoints (each passes `src/platform.ts`), the Dockerfile, the compose stack and the smoke test.

## Start

```sh
cd adapters/local
cp .env.example .env        # local-only placeholders, edit the seed keys if you like
docker compose up --build   # add -d --wait to return once healthy
```

To stamp telemetry with the commit, build with `APP_VERSION=$(git rev-parse --short HEAD) docker compose build`
(default `local`; it is a build argument, D68).

Start order: Postgres, Redis, MinIO and Grafana LGTM, then `minio-init` (bucket, lifecycle, CORS), `migrate`, `seed`,
then `api`, `worker` and `scheduler`. Stop and wipe with `docker compose down -v`.

| Service                 | Address (127.0.0.1 only) |
| ----------------------- | ------------------------ |
| API                     | http://127.0.0.1:58080   |
| Grafana (admin / admin) | http://127.0.0.1:53000   |
| OTLP/HTTP               | http://127.0.0.1:54318   |
| Postgres                | 127.0.0.1:55432          |
| Redis                   | 127.0.0.1:56379          |
| MinIO                   | http://127.0.0.1:59000   |

The api also serves the web app (`apps/web/dist`, built into the image at `/app/web`): `/` and `/pricing` are
prerendered, `/login`, `/signup` and `/app/*` are the single page app, `/assets/*` is immutable and `/rum.js` is cached
for 5 minutes (D88). Nothing is compressed. Sign up at http://127.0.0.1:58080/signup.

## Environment variables

Compose-level (`.env`): `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `MINIO_ROOT_USER`,
`MINIO_ROOT_PASSWORD`, `S3_BUCKET`, `SEED_API_KEY`, `SEED_ADMIN_API_KEY`, `QUEUE_BACKOFF_SCALE`,
`WORKER_CONCURRENCY`, `APP_VERSION`, `BETTER_AUTH_SECRET`, `PUBLIC_URL`, `AUTH_SIGNUP_ENABLED` (also
`AUTH_TRUSTED_ORIGINS`, `AUTH_CLIENT_IP_HEADER`, `HOSTMARK_PLATFORM`, `HOSTMARK_VARIANT`, `HOSTMARK_TOPOLOGY`, `HOSTMARK_REGION`, all optional).
Nothing in `.env.example` is a secret.

Process-level (validated by `packages/node-runtime/src/env.ts`, which exits with a readable message on error):

| Variable                                                           | Default                                | Meaning                                                                                                               |
| ------------------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                     | required                               | Postgres connection string                                                                                            |
| `REDIS_URL`                                                        | required                               | BullMQ connection                                                                                                     |
| `S3_ENDPOINT`                                                      | required                               | S3 endpoint used by the services                                                                                      |
| `S3_PUBLIC_ENDPOINT`                                               | `S3_ENDPOINT`                          | Host used in presigned URLs, must be reachable by the client                                                          |
| `S3_BUCKET`                                                        | required                               | Bucket name                                                                                                           |
| `S3_REGION`                                                        | `us-east-1`                            | Signing region                                                                                                        |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`                         | required                               | S3 credentials                                                                                                        |
| `S3_VIRTUAL_HOST`                                                  | `false`                                | `true`: bucket in the host name (`https://<bucket>.<host>/`), for Tigris (D280); `false`: path-style, for MinIO       |
| `OTLP_ENDPOINT`                                                    | empty (telemetry off)                  | OTLP/HTTP base URL                                                                                                    |
| `PORT`, `HOST`                                                     | `8080`, `0.0.0.0`                      | API listener (inside the container)                                                                                   |
| `APP_VERSION`, `ENVIRONMENT`                                       | `dev`, `local`                         | Telemetry resource attributes                                                                                         |
| `WORKER_CONCURRENCY`                                               | `1`                                    | Parallel jobs per worker process. The image codecs run on one JS thread, so more only adds memory (D97)               |
| `WORKER_REPLICAS` (compose only)                                   | `2`                                    | Worker processes; throughput scales with them (D97)                                                                   |
| `QUEUE_BACKOFF_SCALE`                                              | `1`                                    | Multiplies the retry delays (D66)                                                                                     |
| `SEED_API_KEY`, `SEED_ADMIN_API_KEY`                               | required by `seed`                     | Seed keys (D14)                                                                                                       |
| `BETTER_AUTH_SECRET`                                               | required by `api`                      | Signs session cookies, 32+ characters, no default (D80)                                                               |
| `PUBLIC_URL`                                                       | required by `api`                      | Origin the browser uses: auth base URL and `/f/:id` links                                                             |
| `AUTH_TRUSTED_ORIGINS`                                             | empty                                  | Extra origins that pass Better Auth's origin check (`/api/auth/*`); cookie `POST /api/uploads` from them is still 403 |
| `AUTH_CLIENT_IP_HEADER`                                            | unset (no limiter)                     | See below                                                                                                             |
| `AUTH_SIGNUP_ENABLED`                                              | `true`                                 | `false` refuses registration                                                                                          |
| `HOSTMARK_TOPOLOGY`, `HOSTMARK_REGION`                             | `single`, `local`                      | RUM attributes of `/f/:id` (closed lists); platform and variant come from the platform key                            |
| `WEB_DIST`                                                         | `web`                                  | Directory the api serves                                                                                              |
| build args `HOSTMARK_PLATFORM`, `_VARIANT`, `_TOPOLOGY`, `_REGION` | `local`, `portable`, `single`, `local` | Baked into the prerendered pages and the SPA shell (D85)                                                              |

## Platform-specific APIs used

BullMQ (`Queue`, `Worker`, `addBulk`, custom backoff, `failed` event for the DLQ), ioredis (`ping`), `@hono/node-server`,
`croner`, S3 through `@hostmark/storage-s3`, jSquash wasm through `@hostmark/image/node`, and the
OpenTelemetry Node SDK through `@hostmark/telemetry/node`.

## Known limits

- Crash recovery takes 60 to 90 s: BullMQ waits for the lock (60 s) and the stalled check (30 s) (D65). A job that
  kills its worker five times is dead-lettered (D63, D64).
- Each worker replica has `mem_limit: 4g` (and no swap). Measured with `WORKER_CONCURRENCY=1`: a stream of 24
  maximum-size (49 to 50 MP) inputs peaked at 3.0 to 3.2 GiB per process, with one replica or two, no kernel kill; one
  process at concurrency 4 peaked at 3.6 GiB. If the limit is hit the worker is killed and the jobs are retried (D79).
- Scheduler runs may overlap (a slow run, a restart): database claims make that safe (D19), so there is no lock.
- Producer calls give up after 5 s when Redis is down, so `complete` answers 503 instead of hanging (D63).
- Trace link: the worker trace carries `link:traceID` of the producer. Find it in Grafana Explore (Tempo) with the
  TraceQL query `{ link:traceID = "<trace id of the upload>" }`.
- Lockfile: regenerate it with pnpm 12 in a container, which keeps both YAML documents:
  `docker run --rm -v "$PWD/../..":/repo -w /repo node:22.23.4-slim sh -c 'npm install --global pnpm@12.15.0 >/dev/null 2>&1 && pnpm install --lockfile-only'`
- The chainguard MinIO has no bucket CORS API (501) and no shell for a healthcheck; CORS is server-wide (D62).
- Producer and worker spans are two traces joined by a link, not one parented trace (D40, D69).
- Redis persistence is AOF on a named volume; it is not tuned for benchmarking.
- Images are pinned by tag (and digest for MinIO); update them deliberately.

## Tests

Run `pnpm install` from the repository root first. The image contract always runs; the others need the stack, and Postgres-backed tests in `packages/core` and
`packages/db` need `DATABASE_URL` and a database that exists (the stack only creates `hostmark`):

```sh
docker compose up -d --wait
docker compose exec postgres psql -U hostmark -d hostmark -c 'create database hostmark_test'
export S3_TEST_ENDPOINT=http://127.0.0.1:59000 REDIS_TEST_URL=redis://127.0.0.1:56379
export DATABASE_URL=postgres://hostmark:hostmark-local@127.0.0.1:55432/hostmark_test
pnpm test                                  # from the repository root: every package, 0 skipped with this env
pnpm --filter @hostmark/adapter-local test # this package only
```

Without these variables the dependent tests are skipped, not failed. The queue, storage and image contracts run here through `test/contract.test.ts`
(`describeNodePortContracts`, D152). The stall, Redis-down, env and static tests moved to `packages/node-runtime/test`:
`pnpm --filter @hostmark/node-runtime test`. The storage test uses `MINIO_ROOT_USER` and
`MINIO_ROOT_PASSWORD` defaults from `.env.example`; override with `S3_TEST_ACCESS_KEY` and `S3_TEST_SECRET_KEY` when
you changed them. `stall.test.ts` (needs `REDIS_TEST_URL`) runs a child consumer that is killed and respawned: once
until the job fails after five starts, once with a stalled start counted as an attempt; both expect one DLQ copy.
`redis-down.test.ts` puts a TCP proxy in front of Redis.

### Sign-in rate limit

`AUTH_CLIENT_IP_HEADER` names the header that holds the client address. Unset, as in compose and `.env.example`, Better
Auth's rate limiter is off (its default key, `x-forwarded-for`, can be forged and is shared when absent, D80). Set, the
limiter is on (3 sign-ins per 10 s per address) and any `/api/auth/*` request without exactly one valid address in that
header is answered 400. Name only a header that a proxy in front of the api overwrites; a header the client can send
itself gives no protection. `PUBLIC_URL` must be an http or https URL; only its origin is used.

## Browser test (Playwright)

`apps/web/e2e` drives a real browser against the running stack: sign up, upload with the file input, live status,
thumbnail, publish, public page and OG tags signed out, unpublish, redirect, refused signup, polling fallback and
a Web Vitals beacon (D89). With the stack up (`docker compose up -d --wait`), from the repository root:

```sh
docker run --rm --ipc=host -v "$PWD":/repo:ro -w /repo/apps/web mcr.microsoft.com/playwright:v1.64.1-noble \
  sh -c 'node e2e/forward.mjs & sleep 1; node node_modules/@playwright/test/cli.js test --output /tmp/pw-results'
```

The forward makes `127.0.0.1:58080` and `:59000` inside the container reach the host, which the presigned URLs
need. Where Chromium launches on the host, `PLAYWRIGHT_BROWSERS_PATH=... pnpm --filter @hostmark/web e2e` works too
(after `playwright install chromium`).

## Smoke test

```sh
pnpm --filter @hostmark/adapter-local smoke
```

The first step fails when the running stack does not match the tree: an `api`, `worker` or `scheduler` container
that runs another image than `hostmark-local:dev`, or a source file that goes into the image and is newer than it
(documentation, tests and `load/` do not count). Rebuild with `docker compose build && docker compose up -d`, or set
`SMOKE_ALLOW_STALE=1` to report the mismatch and go on (D203).

It reads `.env`, drives the stack through the typed client and checks: static pages and their `Cache-Control`, the
`/app` rewrite, signup and login with a cookie followed by an upload, publish and `/f/:id` with OG tags, `/rum.js` and
`POST /api/rum`, EXIF JPEG to `ready` with three WebP variants,
`chaos=fail` (5 attempts, DLQ), `chaos=crash` (container restart, recovery), invalid bytes (1 attempt), non-admin
`x-chaos` (403), `/media` headers and unpublish, trace link in Tempo, and the scheduler jobs on backdated rows. It
also covers: image orientation by corner pixels, retry gaps, DLQ payloads, a double worker kill (stall twice, still
`ready`), and deletion of variants. It recreates the worker with a small `QUEUE_BACKOFF_SCALE` for the chaos run and restores it, also on Ctrl-C (the exit code is then 130 or 143, and a restore that fails is printed). It never builds: it tests the stack that is up (`docker compose up -d --wait`, D132). Takes about
five minutes, mostly the crash recoveries. `SMOKE_LONG=1` adds one run on the real 400 s backoff schedule. Run one job by hand with
`docker compose exec scheduler node dist/run-job.js requeue-stuck`.
