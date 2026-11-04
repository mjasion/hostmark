# adapters/vercel

Portable adapter for Vercel (`vercel-portable`, status `emulated`). Nothing here was deployed: no Vercel account was
used, the `vercel` CLI is not installed, and everything below marked "not verified" needs a real project.

| Concern   | Service                                                           | Code                                     |
| --------- | ----------------------------------------------------------------- | ---------------------------------------- |
| API       | Vercel Function (Node, Fluid compute), `export default { fetch }` | `src/functions/api.ts`, `src/app.ts`     |
| Worker    | Vercel Queues consumer (`queue/v2beta` trigger)                   | `src/functions/queue.ts`, `src/queue.ts` |
| Scheduler | Vercel Cron Jobs calling `GET /api/cron/<name>`                   | `src/functions/cron.ts`, `src/cron.ts`   |
| Bundles   | esbuild, one per function, re-exported by `api/<name>.js`         | `scripts/build.ts`, `api/`               |
| Files     | Cloudflare R2 over S3 (`@hostmark/storage-s3`), D197              | `src/runtime.ts`                         |
| CDN purge | `dangerouslyDeleteByTag` by file tag, D100 and D199               | `src/purge.ts`, `src/app.ts`             |
| Web app   | static build of `apps/web` served by Vercel                       | `scripts/build.ts`, `vercel.json`        |
| Images    | `@hostmark/image` wasm codecs, read from `dist/wasm/`             | `src/images.ts`                          |
| Region    | `regions` of `vercel.json`, RUM region and version in the bundle  | `src/build-info.ts`                      |

## Deploy

One command from the repository root, through the opt-in gate of D70 (refuses unless `platforms.json` enables
`vercel` and every secret it names is set):

```sh
pnpm platform deploy vercel
```

It runs this package's `platform-deploy` script (`scripts/deploy.mjs`, `--dry-run` prints the commands and runs none):
`check-config.ts`, then `vercel env add NAME production` for each variable (value on stdin), `vercel pull`,
`scripts/security-headers.ts` (a temporary copy of `vercel.json` with the HTML Content-Security-Policy, whose storage
origin comes from `S3_PUBLIC_ENDPOINT` or `S3_ENDPOINT` and `S3_BUCKET`, D316), `vercel build --prod --local-config
<that copy>` (which runs `scripts/build.ts`, see "Layout"), `scripts/prepare-database.ts` (migrations and
seed, D277), `vercel deploy --prebuilt --prod`. Needs the `vercel` CLI, `VERCEL_TOKEN`, `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` (the CLI reads them from the environment) and the variables below. `deploy.yml` installs
`vercel@65.9.0` (an exact version, released 2026-10-31) in the vercel job after the dependency install and before any
secret is read (D270); on another machine install the same version with `npm install --global vercel@65.9.0`. It is not
installed here, and no command of it was run.

Database (D277): after a successful build and before `vercel deploy`, the script runs the migrations and the seed from
the machine that deploys (`DATABASE_URL` must reach the database from there, the GitHub runner in CI). The seed keys come
from `SEED_API_KEY` and `SEED_ADMIN_API_KEY`; the step refuses to run without both, so it never generates a key, and it
prints neither (the GitHub Actions log is kept). A value that differs from the stored key rotates it (D75). The keys are
not stored on the project: no function reads them. A failed build changes no table, and a failed migration or seed
stops the deploy. The same step alone: `pnpm --filter @hostmark/adapter-vercel prepare-database`.

Secrets: the script passes values only on the CLI's standard input or as environment, never in argv, and scrubs every
CLI output line of the secret values before showing it. `test/deploy.test.ts` runs the script with a fake `vercel`
that records argv and stdin and echoes what it receives, and asserts the values are in neither stdout, stderr nor argv.
`vercel pull` writes `.vercel/.env.production.local` on the machine that deploys; it is git-ignored. The flags
`--sensitive`, `--no-sensitive`, `--force` and `--yes` of `vercel env add`, and reading the value from stdin, are
recalled from the CLI and only `--no-sensitive` and `--yes` appeared in the documentation relayed to me: not verified.
The documentation example `--value "..."` would put a value in argv and is not used.

Check the configuration offline: `pnpm --filter @hostmark/adapter-vercel check`. It validates `vercel.json` against a
subset of `https://openapi.vercel.sh/vercel.json` (fetched 2026-11-01, kept in `scripts/vercel.schema.subset.json`;
draft 04 with numeric `exclusiveMinimum`) and checks that every `SCHEDULER_JOBS` entry is a cron of
`/api/cron/<job>` with the same schedule and that the first rewrite sends those paths to the cron function, that a queue
trigger exists for `image-jobs` with `maxDeliveries` 8, that the dead letter topic has no consumer, that `buildCommand`
runs `scripts/build.ts`, that `installCommand` uses pnpm 12.15.0, that `functions` names exactly the bundled
`api/<name>.js` files (the image functions with the codecs in `includeFiles`), that the api function's `maxDuration`
outlasts the 60 s event stream by 30 s, that the queue consumer sets `maxConcurrency` 1, that `headers` gives each
served path the `Cache-Control` of D88, that `regions` is one region with a RUM name, and that `package.json` pins
`engines.node` to `22.x`. This is not `vercel build`: the CLI was never run.

## Layout

The Vercel project's Root Directory is `adapters/vercel` (project setting, set once in the dashboard or the API; the
setting and "include source files outside of the Root Directory" are not verified). `vercel.json` and `api/` then sit
at the root of the project as zero-config functions require. `installCommand` steps up to the monorepo root and runs
`npx --yes pnpm@12.15.0 install --frozen-lockfile` (D273). `buildCommand` is `node --import tsx scripts/build.ts`,
which:

1. builds `apps/web` with the RUM attributes (`vercel`, `portable`, `single`, and the region of `regions`) and copies
   `apps/web/dist` to `adapters/vercel/public` (git-ignored), the `outputDirectory`;
2. bundles each function with esbuild into `dist/<name>.mjs` (git-ignored) and copies the wasm codecs to `dist/wasm/`.

The functions are `api/index.js`, `api/queue.js` and `api/cron.js`, one line each that re-exports its bundle. They
cannot be the TypeScript sources: `@vercel/node` 29.0.1 compiles each `.ts` file on its own and keeps the import
specifiers, and this package is `"type": "module"` with extensionless imports and workspace packages that are
TypeScript source (D4), so Node cannot resolve them (`ERR_MODULE_NOT_FOUND`). The re-export works only if the build
command runs before `@vercel/node` traces `api/`: the CLI (`vercel` 65.11.0, `sortBuilders`) runs the static build
first, read from the CLI source, not seen on a deployment. `vercel.json` `functions` names the `.js` files, and
`includeFiles: "dist/wasm/*.wasm"` ships the codecs, which are read by path at run time. `pnpm check` asserts this
layout; `test/bundle.test.ts` builds the bundles and runs `test/function-probe.mjs` under plain Node with only the
variables a deployment has: it loads each `api/<name>.js` the way the Vercel Node runtime does (default export
unwrapped, then `fetch` or per-method handlers), calls `/api/health` and a `/f` 404 page (version and region from the
build), the cron route (401, 400) and the queue route with a binary `queue/v2beta` CloudEvent of a sixth delivery
(dead letter send and acknowledgement go to a recording `fetch`, nothing leaves the machine), and compiles every
codec from `dist/wasm/`. Whether `vercel build` from the repository root honours the Root Directory, whether `public`
is served next to functions, and whether the function tracer keeps `dist/` are the first things to prove on a real
project.

### Node and pnpm versions

`package.json` sets `"engines": {"node": "22.x"}`, which Vercel takes for the functions and the build in place of the
project setting (D279); the repository tests with Node 22. pnpm: Vercel picks the pnpm of a build from the lockfile
version unless corepack is enabled, and `lockfileVersion: '9.0'` maps to pnpm 9 or 10 (as relayed from Vercel's
documentation, which could not be read here: not verified), while this repository needs pnpm 12 (`packageManager`,
`allowBuilds` of D201). `installCommand` therefore runs pnpm 12.15.0 through `npx`, which needs only the npm of the
build image. `scripts/build.ts` still calls `pnpm --filter @hostmark/web build` with the `pnpm` on `PATH`: in the
deploy path of this README `vercel build` runs on the GitHub runner, where that is the pnpm 12.15.0 `deploy.yml`
installs. A build on Vercel's own machines (a git integration, which this repository does not use) gets Vercel's pnpm
for that call; set the project variable `ENABLE_EXPERIMENTAL_COREPACK=1` there so `packageManager` decides. Not
verified: either path on a real build.

## Region and version

`vercel.json` `regions` is `["fra1"]` (Frankfurt), the region of the other adapters. Every function runs there; the
database must be in the same region or next to it, because every request and job queries it. `src/build-info.ts`
maps the region to the RUM region (`fra1` frankfurt, `iad1` us-east, `sin1` singapore; Vercel has no Warsaw) and
`pnpm check` refuses any other value or more than one region. The build bakes that RUM region into the web app and the
bundles, so `/f` and RUM report `frankfurt`, and the version: `APP_VERSION` if set at build time, else
`VERCEL_GIT_COMMIT_SHA` (a system variable of git deployments; its presence in a CLI `--prebuilt` build is not
verified), else `git rev-parse --short HEAD` of the checkout that runs `vercel build`, else `dev`. `HOSTMARK_REGION` or
`APP_VERSION` set on the project override the baked values at run time.

## Required variables

| Variable                                                 | Secret    | Where used                                                                                                             |
| -------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                                             | no        | auth base URL, links                                                                                                   |
| `DATABASE_URL`                                           | yes       | Postgres (postgres.js, pool of 5 per instance); also the deploy's migrations                                           |
| `BETTER_AUTH_SECRET`                                     | yes       | at least 32 characters                                                                                                 |
| `CRON_SECRET`                                            | yes       | at least 16 characters; Vercel sends it as `Authorization: Bearer` to cron routes                                      |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` (default `auto`) | no        | R2                                                                                                                     |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`               | yes       | R2 token                                                                                                               |
| `S3_PUBLIC_ENDPOINT`                                     | no        | optional, host used in presigned URLs; set it for the deploy, not only on the project (the HTML policy names it, D316) |
| `QUEUE_TOPIC`                                            | no        | default `image-jobs`; `vercel.json` hard codes the same name                                                           |
| `OTLP_ENDPOINT`                                          | no        | OTLP/HTTP collector; empty: JSON log lines only ("Telemetry")                                                          |
| `SEED_API_KEY`, `SEED_ADMIN_API_KEY`                     | yes       | deploy only, the seed keys (D14, D277); not stored on the project                                                      |
| `HOSTMARK_REGION`, `APP_VERSION`                         | no        | optional; override the region and version baked in by the build                                                        |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`     | token yes | CLI in CI only                                                                                                         |

`platforms.json` and `deploy.yml` name exactly: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `DATABASE_URL`,
`BETTER_AUTH_SECRET`, `CRON_SECRET`, `PUBLIC_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`SEED_API_KEY`, `SEED_ADMIN_API_KEY`. `OTLP_ENDPOINT` is optional and set on the project by hand. `@vercel/queue` and
`@vercel/functions` authenticate with the OIDC token Vercel injects into the deployment; no extra variable (not
verified).

Database connections (D278): each function instance holds a postgres.js pool of 5 (`idle_timeout` 20 s).
`attachDatabasePool` of `@vercel/functions` 3.10.6, which keeps a suspended instance alive until idle connections are
released, takes `pg`, `mysql2`, MariaDB, MongoDB, ioredis and Cassandra pools by duck typing; postgres.js has none of
the shapes it looks for, so the pool is not attached. An instance suspended with open connections keeps them until
Postgres or a pooler drops them; with many instances, put a pooler (PgBouncer, or the provider's) in front of the
database. Not measured.

## Plan: Hobby is not enough

Hobby is for non-commercial use. Cron on Hobby runs once per day with a window of up to 59 minutes, and a schedule
more frequent than that is rejected at deploy. Hostmark needs `*/5` and `*/15`, so a measured deployment needs Pro.
Cron runs in UTC and may deliver the same run twice; the jobs tolerate that (D19, D199).

On Pro, set Function CPU to Performance (4 GB, 2 vCPU) in the project settings (Functions, Advanced Settings), as the
4 GiB workers of the other platforms (D213, D271). The default Standard size is 2 GB and 1 vCPU, and Vercel does not take
the memory size from `vercel.json`, so this is a project setting `pnpm check` cannot see. The queue consumer sets
`maxConcurrency: 1`, so one instance decodes one image at a time, as one worker does elsewhere; the api function keeps
Fluid compute's concurrency. Not verified on a project.

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
- A failed dead letter send throws, so the delivery is not acknowledged. Deliveries 6 to 8 never run the job again;
  they only send the copy. Before, delivery 6 ran the job, which found the file already `failed`, returned and was
  acknowledged without a copy. The send carries `idempotencyKey: dlq-<messageId>`, so a retried send adds no second
  copy (if the idempotency key works as documented).
- The trigger sets `maxDeliveries: 8` (`MAX_DELIVERIES` = 5 attempts + 3 dead letter deliveries; the schema allows 1
  to 1048576, the default is unlimited). A killer job, one whose every delivery is killed (out of memory,
  `maxDuration`), starts 5 times and is dead-lettered on delivery 6; before, it was started again until its retention
  ran out (24 h by default). Only when the dead letter send fails on deliveries 5 to 8 is the message dropped by the
  platform, and the last failure is logged with the payload. `requeue-stuck` still marks such a file `failed` (D64).
  What the platform does after `maxDeliveries` is not documented in what was read: assumed to discard the message.
- Visibility (D275): the consumer runs under D17's 60 s. `handleCallback` of `@vercel/queue` 0.11.0 defaults to 300 s
  and takes `visibilityTimeoutSeconds`; `src/functions/queue.ts` passes `VISIBILITY_TIMEOUT_SECONDS` (60) to it and to
  the lease check of D235, which sets the lease first. The SDK renews the lease while the handler runs, so a job longer
  than 60 s is not delivered twice while its instance lives; a killed instance's message comes back after about 60 s.
  The option is in the SDK, not in `vercel.json`.
- Not verified: delivery semantics and the exact idempotency key behaviour, the lease renewal against a large image on
  a real deployment, `vercel dev` as a local queue, the maximum retention of the dead letter topic (7 days at most, then
  lost).
- Forged deliveries (D235): `handleCallback` takes the job from the request body (binary `queue/v2beta` mode) and
  checks no signature, so `src/verify.ts` first extends the delivery's lease with its receipt handle; the queue
  service refuses a handle it did not hand out, and the route answers 403 before any job code runs (5xx when the
  service cannot be asked, so a real delivery is pushed again). A delivery for another topic is refused. Not verified
  on a deployment: that the service accepts the lease call for every real push.

## Telemetry (D274)

Each function reports as the service it is on every other platform: `api/index.js` as `api`, the queue consumer as
`worker`, the cron route as `scheduler` (`service` of the JSON log lines and `service.name` of OTLP). With
`OTLP_ENDPOINT` set, the runtime starts `startNodeTelemetry` of `@hostmark/telemetry/node` (traces, metrics and logs
over OTLP/HTTP); without it, spans and metrics are no-ops and logs are JSON lines in Vercel's runtime logs. Vercel
suspends an instance between invocations, so a batch would wait for the next request or be lost: every handler hands
a flush to `waitUntil` of `@vercel/functions` once it has its response, so the answer is not delayed and the platform
keeps the invocation alive until the export ends. Flushes never overlap (Fluid compute runs many requests per
instance); a failed export never fails a request. An event stream returns its response at once, so its flush runs at
the start of the stream and what the stream records later goes out with the next flush of the instance. Tested with a
fake exporter and a fake `waitUntil` (`test/telemetry.test.ts`), and the flush itself against a local OTLP receiver in
`packages/telemetry`. Not verified: that `waitUntil` keeps a real invocation alive for the export.

## CDN purge (D100, D199)

A `200` of `/media/*` gets `Vercel-CDN-Cache-Control: public, max-age=31536000, immutable`, one of `/f/*` gets
`Vercel-CDN-Cache-Control: max-age=60, stale-while-revalidate=600` (core's `s-maxage` and `stale-while-revalidate` of
the page, D21), and both get `Vercel-Cache-Tag: file-<uuid>`. Before, `/f` got neither, because only a `Cache-Control`
with `public` was marked and core's page header has none: Vercel still cached the page from `s-maxage`, untagged, so
an unpublished page stayed public for up to 60 s plus 600 s. Unpublish and delete call `dangerouslyDeleteByTag([...])`
once for all affected tags.

`dangerouslyDeleteByTag` of `@vercel/functions` 3.10.6 resolves without doing anything when the invocation has no
request context (`globalThis[Symbol.for('@vercel/request-context')]`). The adapter reads that context itself and
throws `PurgeUnavailableError` when it has no purge API, so `PATCH` answers 503 and the `delete_file` job is retried
and dead-lettered instead of being recorded as done (D100). Whether the queue and cron invocations have a request
context with a purge API is not verified; if they have none, every `delete_file` ends in the dead letter topic and the
row keeps `purged_at` empty, which is visible. The SDK also
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

`scripts/build.ts` copies the wasm codecs of `@jsquash/*` to `dist/wasm/`, and the bundles read them from there (as on
AWS). `vercel.json` ships them with `includeFiles: "dist/wasm/*.wasm"` on the api and queue functions; the glob is
relative to the Root Directory (not verified on a build). Function memory and the maximum
dimensions on Vercel were not measured (the Pro limit is 4 GB / 2 vCPU, Hobby 2 GB / 1 vCPU; `functions.memory` in
`vercel.json` is left unset because the documentation and the schema disagree on it; the size is the Function CPU
setting, Performance on Pro, see "Plan").

## Routing

`@vercel/routing-utils` (as bundled in `vercel` 65.11.0) puts every rewrite after `{ "handle": "filesystem" }` with
`check: true`: a static file or function path wins, then the first matching rewrite. The first rewrite sends
`/api/cron/<job>` (one segment) to the cron function as `/api/cron?job=<job>` (D272); the function takes the job from the
path when it sees the original path, else from the one `job` parameter, and runs only a job of `SCHEDULER_JOBS` for a
caller with `CRON_SECRET`. The next rewrites send `/api/*` (except `/api/cron`, `/api/cron/*` and `/api/queue`),
`/media/*` and `/f/*` to the Hono function, `/login`, `/signup`, `/app` and
`/app/*` (one trailing slash accepted) to `/app/index.html`, the single page app shell (D88), and `/pricing` to
`/pricing/index.html`. `/` is `index.html` from the filesystem. Any other path is Vercel's 404. Before, every other
path was rewritten to `/index.html`, the landing page, which `/login`, `/signup` and `/app/files/<id>` then served
(S13 could not reach the panel), and a missing `/assets/*` file answered the landing page with a year of
`Cache-Control`. `test/routes.test.ts` compiles the sources with path-to-regexp 6.3.0 and the options of
routing-utils and pins the target of each path; the same table was checked once against `getTransformedRoutes` of
`@vercel/routing-utils` itself. Not verified: that the function sees the original path after a rewrite (the common
Express-on-Vercel rewrite to one function relies on it), and the headers of Vercel's own 404 under `/assets/`.

`Cache-Control` of the static output (D276) follows the static handler of D88: `/assets/*` gets
`public, max-age=31536000, immutable`; `/`, `/login`, `/signup`, `/pricing` (one trailing slash), `/app` and `/app/*`,
the `index.html` files and `/rum.js` get `public, max-age=300`. `headers` routes come before the filesystem and match
the path as requested, so the sources name the requested paths, not the files they are rewritten to. Function answers
and Vercel's 404s get none from `vercel.json`. `pnpm check` and `test/routes.test.ts` pin the header of each path.

## Tests

`pnpm --filter @hostmark/adapter-vercel test`. Only `e2e.test.ts` needs containers; it is skipped unless
`DATABASE_URL` and `S3_TEST_ENDPOINT` point at a Postgres and an S3 stand-in (MinIO, `S3_TEST_ACCESS_KEY` and
`S3_TEST_SECRET_KEY` default to `hostmark` and `hostmark-local-secret`).

- The image processor contract (always runs).
- The queue contract on `test/stand-in.ts`, a model of Vercel Queues written from the documentation, with
  `maxDeliveries`: 8 pass, 4 are skipped (ping, first retry delay, visibility timeout, lease renewal; the model has no
  such parts).
  It exercises the real producer, consumer, backoff and dead letter code. It does not prove that the real service
  behaves like the model.
- `bundle.test.ts`: builds the bundles and runs them under plain Node (see "Layout").
- `routes.test.ts`: the rewrites of `vercel.json` (see "Routing").
- `e2e.test.ts`: the api app, the cron route and the queue consumer on Postgres and MinIO, with the queue model and a
  fake request context: upload to ready; `/f` and `/media` carry the CDN header and the tag; unpublish without a
  request context answers 503 and purges on retry; `delete_file` from `cleanup-expired` fails without a request
  context, stays on the queue, and purges once the context is there.
- `deploy.test.ts`: the deploy script against a fake `vercel` and a stand-in for the database step preloaded through
  `NODE_OPTIONS` (no leak of secrets, the order build, database, deploy, exit codes, refusal without variables).
- `prepare-database.test.ts`: the database step refuses without both seed keys and prints no value; with
  `DATABASE_URL`, it migrates a fresh database, seeds both keys, prints neither, and rotates them on a second run.
- `telemetry.test.ts`: service names, the exporter only with `OTLP_ENDPOINT`, the flush through `waitUntil` (see
  "Telemetry").
- Unit tests: env, region and version, producer, consumer (dead letter deliveries, a killer job and `maxDeliveries`
  on the model), purge tag mapping and request context, CDN headers, cron authorisation, `vercel.json` checks.

Not covered: the storage contract against R2 (`@hostmark/storage-s3` has its own contract on MinIO in other adapters),
`vercel build` itself (the CLI is not installed), and everything that needs a deployment.
