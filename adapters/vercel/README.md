# adapters/vercel

Portable adapter for Vercel (`vercel-portable`, status `emulated`). Nothing here was deployed: no Vercel account was
used, the `vercel` CLI is not installed, and everything below marked "not verified" needs a real project.

| Concern   | Service                                                          | Code                           |
| --------- | ---------------------------------------------------------------- | ------------------------------ |
| API       | Vercel Function (Node, Fluid compute), Hono `export default app` | `api/index.ts`, `src/app.ts`   |
| Worker    | Vercel Queues consumer (`queue/v2beta` trigger)                  | `api/queue.ts`, `src/queue.ts` |
| Scheduler | Vercel Cron Jobs calling `GET /api/cron?job=<name>`              | `api/cron.ts`, `src/cron.ts`   |
| Files     | Cloudflare R2 over S3 (`@hostmark/storage-s3`), D197             | `src/runtime.ts`               |
| CDN purge | `dangerouslyDeleteByTag` by file tag, D100 and D199              | `src/purge.ts`                 |
| Web app   | static build of `apps/web` served by Vercel                      | `vercel.json`                  |
| Images    | `@hostmark/image` wasm codecs, Node loader                       | `src/images.ts`                |

## Deploy

One command from the repository root, through the opt-in gate of D70 (refuses unless `platforms.json` enables
`vercel` and every secret it names is set):

```sh
pnpm platform deploy vercel
```

It runs this package's `platform-deploy` script (`scripts/deploy.mjs`, `--dry-run` prints the commands and runs none):
`check-config.ts`, then `vercel env add NAME production` for each variable (value on stdin), `vercel pull`,
`vercel build --prod`, `vercel deploy --prebuilt --prod`. Needs the `vercel` CLI (`npm i -g vercel`, not installed
here), `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` (the CLI reads them from the environment) and the
variables below. Once, from a machine that reaches the database: `DATABASE_URL=... pnpm --filter @hostmark/db migrate`.

Secrets: the script passes values only on the CLI's standard input or as environment, never in argv, and scrubs every
CLI output line of the secret values before showing it. `test/deploy.test.ts` runs the script with a fake `vercel`
that records argv and stdin and echoes what it receives, and asserts the values are in neither stdout, stderr nor argv.
`vercel pull` writes `.vercel/.env.production.local` on the machine that deploys; it is git-ignored. The flags
`--sensitive`, `--no-sensitive`, `--force` and `--yes` of `vercel env add`, and reading the value from stdin, are
recalled from the CLI and only `--no-sensitive` and `--yes` appeared in the documentation relayed to me: not verified.
The documentation example `--value "..."` would put a value in argv and is not used.

Check the configuration offline: `pnpm --filter @hostmark/adapter-vercel check`. It validates `vercel.json` against a
subset of `https://openapi.vercel.sh/vercel.json` (fetched 2026-11-01, kept in `scripts/vercel.schema.subset.json`;
draft 04 with numeric `exclusiveMinimum`) and checks that every `SCHEDULER_JOBS` entry is a cron with the same
schedule, that a queue trigger exists for `image-jobs`, and that the dead letter topic has no consumer. This is not
`vercel build`: the CLI was never run.

## Layout

The Vercel project's Root Directory is `adapters/vercel` (project setting, set once in the dashboard or the API; the
setting and "include source files outside of the Root Directory" are not verified). `vercel.json` and `api/` then sit
at the root of the project as zero-config functions require, and `installCommand` and `buildCommand` step up to the
monorepo root: they run `pnpm install --frozen-lockfile`, build `apps/web` with the RUM attributes (`vercel`,
`portable`, `single`, `frankfurt`) and copy `apps/web/dist` to `adapters/vercel/public` (git-ignored), which is the
`outputDirectory`. Whether `vercel build` from the repository root honours that Root Directory, and whether `public`
is served next to functions, is the first thing to prove on a real project.

## Required variables

| Variable                                                 | Secret    | Where used                                                                        |
| -------------------------------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `PUBLIC_URL`                                             | no        | auth base URL, links                                                              |
| `DATABASE_URL`                                           | yes       | Postgres (postgres.js, pool of 5 per instance)                                    |
| `BETTER_AUTH_SECRET`                                     | yes       | at least 32 characters                                                            |
| `CRON_SECRET`                                            | yes       | at least 16 characters; Vercel sends it as `Authorization: Bearer` to cron routes |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` (default `auto`) | no        | R2                                                                                |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`               | yes       | R2 token                                                                          |
| `S3_PUBLIC_ENDPOINT`                                     | no        | optional, host used in presigned URLs                                             |
| `QUEUE_TOPIC`                                            | no        | default `image-jobs`; `vercel.json` hard codes the same name                      |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`     | token yes | CLI in CI only                                                                    |

`platforms.json` and `deploy.yml` name exactly: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `DATABASE_URL`,
`BETTER_AUTH_SECRET`, `CRON_SECRET`, `PUBLIC_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. `@vercel/queue` and `@vercel/functions`
authenticate with the OIDC token Vercel injects into the deployment; no extra variable (not verified).

## Plan: Hobby is not enough

Hobby is for non-commercial use. Cron on Hobby runs once per day with a window of up to 59 minutes, and a schedule
more frequent than that is rejected at deploy. Hostmark needs `*/5` and `*/15`, so a measured deployment needs Pro.
Cron runs in UTC and may deliver the same run twice; the jobs tolerate that (D19, D199).

## Queue (D17, D198)

Vercel Queues is Beta. Facts from the documentation read on 2026-11-01: message retention 60 s to 7 days (default 24
h); visibility timeout 0 to 60 min (default 60 s); the first 32 retries use the configured delay; no built-in dead
letter queue ("handle poisoned messages at the application level using the SDK's `retry` handler"); consumer
functions have no public URL; trigger `{"type":"queue/v2beta","topic":...,"retryAfterSeconds":...}` under
`functions.<file>.experimentalTriggers` (also confirmed by the published schema, which additionally has `queue/v1beta`
with a `consumer` field and a `schedule/v1beta` trigger, both unused).

- Producer: `send` and `sendBatch` with `idempotencyKey` = job id (publish is safe to retry; delivery is still treated
  as at least once). Chunks of 100.
- Consumer: `attempt` = `deliveryCount`. A throw is retried after `BACKOFF_SECONDS` (10, 30, 90, 270 s) through the
  `retry` option. At attempt 5, or for a body that is no job message, the payload goes to `image-jobs-dlq` and the
  delivery returns normally (acknowledged). The core `process-image` marks the file failed on its last attempt.
- Not verified: delivery semantics and the exact idempotency key behaviour, the 60 s default visibility timeout
  against a large image (a longer run would be delivered twice; not configurable in `vercel.json` as far as the schema
  shows), `vercel dev` as a local queue, the maximum retention of the dead letter topic (7 days at most, then lost).

## CDN purge (D100, D199)

`/media/*` and `/f/*` answers are cached for a year by `Vercel-CDN-Cache-Control` and tagged `file-<uuid>` through
`Vercel-Cache-Tag`. Unpublish and delete call `dangerouslyDeleteByTag([...])` once for all affected tags. The SDK also
has `invalidateByTag`, which marks stale and revalidates in the background, so the old copy can be served once more;
for an unpublished file that is wrong, hence the delete. Documented limits: 256 UTF-8 bytes per tag, 128 tags per
response, 16 tags per bulk REST call, purge rate limits 50 (Hobby) and 200 (Pro) per second per team. Which call stops
the file being served on a real deployment, and how long the purge takes, is not measured. Whether the delete reaches every
CDN region at once is not verified.

## Client address header (D80)

`clientIpHeader` is `x-vercel-forwarded-for`. Vercel documents that it overwrites `x-forwarded-for` and does not forward
external addresses to prevent spoofing, and that `x-vercel-forwarded-for` and `x-real-ip` are identical to it. The
platform sets the header, so a client cannot choose it. Not verified on a real deployment: send a request with a forged
`x-vercel-forwarded-for` and confirm that the function sees the real address.

## Bucket lifecycle (D74)

The R2 bucket needs a lifecycle rule that expires objects under `originals/` and `variants/` after 8 days. R2 lifecycle
rules are set with the dashboard or the R2 API; this was not checked against the current R2 documentation: not verified.
There is no code in this adapter that sets it. CORS for GET and PUT from `PUBLIC_URL` is needed for direct uploads
(function bodies are capped at 4.5 MB, so uploads go to the bucket with a presigned URL).

## Images

The wasm codecs of `@jsquash/*` are loaded with the Node loader. `vercel.json` lists them in `includeFiles` of the
api and queue functions: not verified that the glob finds them in a pnpm layout. Function memory and the maximum
dimensions on Vercel were not measured (the Pro limit is 4 GB / 2 vCPU, Hobby 2 GB / 1 vCPU; `functions.memory` in
`vercel.json` is left unset because the documentation and the schema disagree on it).

## Routing

Rewrites send `/api/*` (except `/api/cron` and `/api/queue`), `/media/*` and `/f/*` to the Hono function and every
other path to `/index.html` for the single page app. Whether the function sees the original path after the rewrite,
whether `/index.html` rewrites are applied after the filesystem, and the regular expression sources, are not verified
(the rewrites page was not read).

## Tests

`pnpm --filter @hostmark/adapter-vercel test`: no container is needed.

- The image processor contract (always runs).
- The queue contract on `test/stand-in.ts`, a model of Vercel Queues written from the documentation: 15 pass, 3 are
  skipped (ping, first retry delay, visibility timeout; the model has no such parts). It exercises the real producer,
  consumer, backoff and dead letter code. It does not prove that the real service behaves like the model.
- `deploy.test.ts`: the deploy script against a fake `vercel` (no leak of secrets, exit code, refusal without variables).
- Unit tests: env, producer, consumer, purge tag mapping, cron authorisation, `vercel.json` checks.

Not covered: an HTTP test of `src/app.ts` on Postgres (cache headers on a public file), the storage contract against R2
(`@hostmark/storage-s3` has its own contract on MinIO in other adapters), and everything that needs a deployment.
