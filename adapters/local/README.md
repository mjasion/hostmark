# adapters/local

Portable runtime on Docker Compose: Node 22, Hono, Postgres, Redis (BullMQ), MinIO and `grafana/otel-lgtm`.
This is the `local-portable` platform. The adapter only maps core ports to these services (see D60 to D69).

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

Static web assets (`apps/web/dist`) are not served yet; that arrives with E1.

## Environment variables

Compose-level (`.env`): `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `MINIO_ROOT_USER`,
`MINIO_ROOT_PASSWORD`, `S3_BUCKET`, `SEED_API_KEY`, `SEED_ADMIN_API_KEY`, `QUEUE_BACKOFF_SCALE`,
`WORKER_CONCURRENCY`, `APP_VERSION`. Nothing in `.env.example` is a secret.

Process-level (validated by `src/env.ts`, which exits with a readable message on error):

| Variable                                   | Default               | Meaning                                                      |
| ------------------------------------------ | --------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`                             | required              | Postgres connection string                                   |
| `REDIS_URL`                                | required              | BullMQ connection                                            |
| `S3_ENDPOINT`                              | required              | S3 endpoint used by the services                             |
| `S3_PUBLIC_ENDPOINT`                       | `S3_ENDPOINT`         | Host used in presigned URLs, must be reachable by the client |
| `S3_BUCKET`                                | required              | Bucket name                                                  |
| `S3_REGION`                                | `us-east-1`           | Signing region                                               |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | required              | S3 credentials                                               |
| `OTLP_ENDPOINT`                            | empty (telemetry off) | OTLP/HTTP base URL                                           |
| `PORT`, `HOST`                             | `8080`, `0.0.0.0`     | API listener (inside the container)                          |
| `APP_VERSION`, `ENVIRONMENT`               | `dev`, `local`        | Telemetry resource attributes                                |
| `WORKER_CONCURRENCY`                       | `4`                   | Parallel jobs per worker                                     |
| `QUEUE_BACKOFF_SCALE`                      | `1`                   | Multiplies the retry delays (D66)                            |
| `SEED_API_KEY`, `SEED_ADMIN_API_KEY`       | required by `seed`    | Seed keys (D14)                                              |

## Platform-specific APIs used

BullMQ (`Queue`, `Worker`, `addBulk`, custom backoff, `failed` event for the DLQ), ioredis (`ping`), `@hono/node-server`,
`croner`, S3 through `@hostmark/storage-s3`, jSquash wasm through `@hostmark/image/node`, and the
OpenTelemetry Node SDK through `@hostmark/telemetry/node`.

## Known limits

- Crash recovery takes 60 to 90 s: BullMQ waits for the lock (60 s) and the stalled check (30 s) (D65). A job that
  kills its worker five times is dead-lettered (D63, D64).
- The worker has `mem_limit: 4g` (and no swap). Measured with 50 MP inputs at concurrency 4: 3.7 GB peak over a
  stream of 24 jobs, no kernel kill. If the limit is hit the worker is killed and the jobs are retried (D79).
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

Without these variables the dependent tests are skipped, not failed. The storage test uses `MINIO_ROOT_USER` and
`MINIO_ROOT_PASSWORD` defaults from `.env.example`; override with `S3_TEST_ACCESS_KEY` and `S3_TEST_SECRET_KEY` when
you changed them. `stall.test.ts` (needs `REDIS_TEST_URL`) runs a child consumer that is killed and respawned: once
until the job fails after five starts, once with a stalled start counted as an attempt; both expect one DLQ copy.
`redis-down.test.ts` puts a TCP proxy in front of Redis.

## Smoke test

```sh
pnpm --filter @hostmark/adapter-local smoke
```

It reads `.env`, drives the stack through the typed client and checks: EXIF JPEG to `ready` with three WebP variants,
`chaos=fail` (5 attempts, DLQ), `chaos=crash` (container restart, recovery), invalid bytes (1 attempt), non-admin
`x-chaos` (403), `/media` headers and unpublish, trace link in Tempo, and the scheduler jobs on backdated rows. It
also covers: image orientation by corner pixels, retry gaps, DLQ payloads, a double worker kill (stall twice, still
`ready`), and deletion of variants. It recreates the worker with a small `QUEUE_BACKOFF_SCALE` for the chaos run and restores it, also on Ctrl-C. Takes about
five minutes, mostly the crash recoveries. `SMOKE_LONG=1` adds one run on the real 400 s backoff schedule. Run one job by hand with
`docker compose exec scheduler node dist/run-job.js requeue-stuck`.
