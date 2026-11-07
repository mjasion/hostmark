# adapters/railway

Portable runtime on Railway: three services (`api`, `worker`, `scheduler`) from this repository, one Docker image,
Railway Redis, **Cloudflare R2** for storage and the shared Neon database (D71). This is the `railway-portable`
platform. Status: `emulated`. Nothing has been deployed and no Railway account or token was used.

The code is the shared runtime in `packages/node-runtime` (D150). This directory holds the entrypoints,
`src/platform.ts` (the client address header), the `Dockerfile` (the local image with another adapter name and RUM
defaults) and `services.json`, the settings of the three services.

## Two things that shape this adapter (D157)

- **Config as Code is deprecated.** `railway.json` and `railway.toml` are not read by new services and stop being read
  by existing ones on 2026-12-01. The replacement, `.railway/railway.ts` applied with `railway config apply`, cannot
  express the cron, restart policy, draining and overlap, Dockerfile path or CPU and memory settings this adapter
  needs. Four of them Railway also reads from **service variables** (variables reference, "user-provided
  configuration variables"): `RAILWAY_DOCKERFILE_PATH`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`,
  `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` and `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`. `scripts/deploy.mjs` sets them from
  `services.json` before every upload (D283), so they are not dashboard-only. The rest (region, start command,
  pre-deploy command and its timeout, replicas, health check path, restart policy, memory) is set in the dashboard,
  with the `serviceInstanceUpdate` API call, or with `railway environment edit --service-config`. `services.json`
  lists every value; Railway does not read the file itself, and whether `config apply` resets dashboard settings is
  unconfirmed. There is no documented offline validation, and `railway config plan` needs a linked project, so nothing
  here is validated against Railway. A test guards the values.
- **Railway Buckets have no lifecycle configuration.** The D74 rule (originals/ and variants/ expire after 8 days)
  cannot be set there, and `init-bucket` stops on the failed call. The adapter therefore uses R2, which the spec allows.
  Railway Buckets (variables `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`, `ENDPOINT`; CORS through
  `put-bucket-cors`; no public buckets) would work only after Railway adds lifecycle rules, and then with
  `S3_VIRTUAL_HOST=true`: new Railway buckets use virtual-hosted URLs (`https://<bucket>.t3.storageapi.dev`, D280);
  the bucket's Credentials tab says which style an older bucket needs. Not implemented: an app-side expiry sweep,
  which would need a change in core.

The Config as Code facts and the Railway facts marked "relayed" below come from a documentation report relayed by the
team lead (docs.railway.com infrastructure-as-code, deployments/reference, networking/public-networking/specs-and-
limits, databases/redis). Read in the docs repository (railwayapp/docs, 2026-11-04): the variables reference, the
Dockerfile, health check, pre-deploy, teardown and regions pages, storage buckets, and the CLI pages of `up`,
`deployment` and `variable`.

## Deploy steps (owner, in the Railway dashboard)

1. New project from this GitHub repository. Create three services from it and name them `api`, `worker`, `scheduler`.
2. Per service, set the region to **EU West Metal, `europe-west4-drams3a`** (Amsterdam, `region` in `services.json`),
   and the start command, replicas, restart policy and memory from `services.json`; the `api` also gets the pre-deploy
   command with a **Pre-deploy Timeout of 600 s** (the field appears only once the command is entered; it accepts 1 to
   3600 s) and the `/api/health` check path. Set the service variables `RAILWAY_DOCKERFILE_PATH`
   (`adapters/railway/Dockerfile`; the root directory stays empty, because the build needs the whole workspace),
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` (scheduler) and
   `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` (api) from `services.json` (D283), and `APP_VERSION` to the commit; the deploy
   script sets these on every deploy.
3. Add the Redis template in the same region, without eviction (see Redis). Create an R2 bucket and an API token for
   it.
4. Set the variables below. Give `api` a public domain and set `PUBLIC_URL` to it. `worker` and `scheduler` get none.
5. Deploy. The pre-deploy command of `api` keeps or creates the bucket, applies the lifecycle rule and CORS, migrates
   and seeds, then the services start.

## Deploy from GitHub Actions

`pnpm platform deploy railway` (D70, D121) runs `scripts/deploy.mjs`. For `api`, `worker` and `scheduler`, in the
order of `services.json`:

```sh
railway variable set APP_VERSION=<version> RAILWAY_DOCKERFILE_PATH=adapters/railway/Dockerfile \
  RAILWAY_DEPLOYMENT_DRAINING_SECONDS=<s> [...] --service <name> --skip-deploys
railway up --ci --service <name>
railway deployment list --service <name> --json --limit 1     # repeated until SUCCESS
```

`<version>` is `APP_VERSION` when set, else the first 12 characters of the checked-out commit, so `x-version` changes
with every deploy (S14, D281); the script refuses to run without either. `--skip-deploys` stores the variables without
a deploy of its own; the upload that follows is the deploy that uses them. `railway up --ci` uploads the workspace
(`.gitignore` applies), builds the image and streams the build log; the CLI page says it "exits when the build
completes", and the exit code comes from the deployment's terminal status. Because those two statements leave room
for a deploy still in progress, the script then reads the newest deployment of the service until it is `SUCCESS`
(every 10 s, at most 900 s), and stops on any other terminal status (`FAILED`, `CRASHED`, `REMOVED`, ...) (D284). A
failure stops the rest, so `worker` and `scheduler` never start on a schema that `api` failed to migrate. Each service
builds the image again (three builds per deploy). `--dry-run` prints the commands. `deploy.yml` installs Railway CLI
5.71.0 from its GitHub release and checks a pinned SHA-256 first (D242).

Once, in Railway:

1. The project, the three services named exactly `api`, `worker`, `scheduler`, the Redis service, the R2 bucket and
   the variables, as in "Deploy steps" above. The script sets the Dockerfile path and the other `RAILWAY_*` service
   variables itself before the first upload.
2. Do not connect the services to the GitHub repository (or disconnect them). A connected service deploys on every
   push to `main`, which D70 forbids; with the workflow, `railway up` is the only way in.
3. Project settings, Tokens: create a **project token** for the environment to deploy (for example `production`).
   It is scoped to that project and environment, so the script needs no project or environment id.

In GitHub, environment `railway` (deployment branches: `main` only):

| Secret          | Value                     |
| --------------- | ------------------------- |
| `RAILWAY_TOKEN` | the project token, step 3 |

The application variables stay in Railway; the pipeline never sees them. The token reaches the CLI as its
environment only, and the script scrubs it from the output (`test/deploy.test.ts`, with a fake `railway` that
echoes it).

Not proven (needs an account): that a project token may run `variable set`, `up` and `deployment list` for each
service; that a variable set with `--skip-deploys` is used by the next `railway up` (rather than staged); that `--ci`
exits non-zero on a failed pre-deploy command or health check; the JSON shape of `deployment list --json` (the script
accepts a list or `{ deployments: [...] }` and reads `status` of the first entry, newest first as the CLI page says);
that the upload of the repository root stays under Railway's size limit; that the settings entered by hand apply to
deployments made by `railway up`; build and deploy times.

## Required variables

| Variable                                                               | Services           | Value                                                       |
| ---------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| `DATABASE_URL`                                                         | all                | Neon connection string                                      |
| `REDIS_URL`                                                            | all                | reference to the Redis service, e.g. `${{Redis.REDIS_URL}}` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | all                | R2 endpoint of the account, bucket and API token pair       |
| `S3_REGION`, `S3_PUBLIC_ENDPOINT`                                      | all (optional)     | default `us-east-1` (R2 accepts `auto`) and `S3_ENDPOINT`   |
| `BETTER_AUTH_SECRET`, `PUBLIC_URL`                                     | `api`              | 32+ characters; the public origin                           |
| `SEED_API_KEY`, `SEED_ADMIN_API_KEY`                                   | `api` (pre-deploy) | seed keys (D14)                                             |
| `WORKER_CONCURRENCY`                                                   | `worker`           | `1` (D97; also the default)                                 |
| `OTLP_ENDPOINT`, `AUTH_SIGNUP_ENABLED`                                 | optional           | signup `false` by default (D7, D335); `true` for S13        |
| `HOSTMARK_REGION` (build variable)                                     | all                | RUM region; defaults to `unknown`, see below                |
| `APP_VERSION`                                                          | all                | set by the deploy script (D281); by hand: the commit        |
| `RAILWAY_DOCKERFILE_PATH`                                              | all                | `adapters/railway/Dockerfile`, set by the deploy script     |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`                                  | all                | `drainingSeconds` of `services.json`, set by the script     |
| `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`                                   | `scheduler`        | `0`, set by the deploy script                               |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`                                      | `api`              | `60`, set by the deploy script                              |

Nothing secret is in the repository; the pipeline's secret name is `RAILWAY_TOKEN` (`platforms.json`).

Railway regions are `us-west2`, `us-east4-eqdc4a`, `europe-west4-drams3a` and `asia-southeast1-eqsg3a` (regions
page). The adapter uses `europe-west4-drams3a` (Amsterdam) for every service and Redis: it is the one nearest
Frankfurt and the shared database (Neon, eu-central-1), so database round trips stay short (D283).
None is Frankfurt or Warsaw, so the default `HOSTMARK_REGION` is `unknown`. Set `us-east` or `singapore` (closed list) only for
the matching region. Whether Railway passes service variables to a Dockerfile build as build arguments of the same
name (how `HOSTMARK_REGION` would reach the web build, D85) was not verified.

## Client address header (D80)

`clientIpHeader` is **`X-Real-IP`**, fixed in `src/platform.ts`. It is the header Railway documents for the client's
remote address; `X-Forwarded-For` is not documented. Whether the edge replaces a client-sent `X-Real-IP` is
**unconfirmed**: only Railway Station answers by staff say so, and Railway says the behaviour can change. D80 needs a
header the platform overwrites, so this is **must-test on the first deployment**:
`curl -H 'X-Real-IP: 6.6.6.6' https://<domain>/api/auth/get-session` must be rate limited by your own address, not
6.6.6.6 (send four sign-ins in 10 s from two addresses). Requests over the private network (`*.railway.internal`) are
not sanitised, so keep `api` off other services that run untrusted input. With Cloudflare in front, the header is not
the visitor's address.

## Bucket lifecycle (D74)

The pre-deploy command runs `dist/init-bucket.js`: the bucket is kept if it exists (HEAD 200); the lifecycle rule
(`originals/` and `variants/` expire after 8 days) and CORS (PUT and GET) are set through the S3 API. R2 documents
lifecycle rules in its S3 API, but this was not run against R2 here (the calls were run against MinIO only). Railway
Buckets cannot take the rule, see above.

## Scheduler

`numReplicas: 1` and `overlapSeconds: 0`. Neither is needed for correctness any more: only the scheduler that holds
the Postgres advisory lock runs the jobs, so the new deploy's scheduler waits until the old one stops (D204). They
keep one idle connection fewer. The lock needs a direct or session-mode `DATABASE_URL`, not a transaction-mode pooler.

## Worker sizing and shutdown

Two workers of 4 GiB each (peak 3.0 to 3.2 GiB per process, D79). Per-service CPU and memory have no config field;
a Pro replica can use up to 24 vCPU and 24 GB (relayed), and whether the plan allows 8 GiB across two replicas and the
prices were not checked. Railway's default is SIGTERM followed by SIGKILL after 0 seconds (teardown page), so
`drainingSeconds` is 70 for the worker (a job in flight can finish, lock 60 s), 30 for the scheduler and 10 for the
api, sent as `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`. The maximum value is undocumented. The api's health check timeout
is 60 s (`RAILWAY_HEALTHCHECK_TIMEOUT_SEC`; Railway's default is 300 s). The pre-deploy command has no time limit
unless one is set, hence 600 s (migrations on an empty schema and the seed take seconds). Longest event loop block against the 60 s lock: **not measured** (needs a real instance).

## Redis

Single node from the official template, `REDIS_URL`, private host `<service>.railway.internal`. BullMQ needs
`maxmemory-policy noeviction`; Railway's default is unconfirmed, so check `CONFIG GET maxmemory-policy` on the first
deploy, and never switch it to an evicting policy. Older environments resolve `*.railway.internal` over IPv6 only;
ioredis 6 resolves with `family: 0` (IPv4 and IPv6), so the URL needs no `?family=6`.

## Checked offline

`pnpm --filter @hostmark/adapter-railway test` checks `services.json` (known keys, one scheduler with no overlap,
worker memory and draining, the pre-deploy order bucket, migrate, seed, its 600 s timeout, the region, the health
path, no secret), the client address header, that the Dockerfile equals the local one apart from the adapter name,
and the deploy script against a fake `railway`: the variables and their values per service, `APP_VERSION` from the
variable or the commit, the order variables, upload, status check, waiting while a deployment is in progress, a stop
on any other non-success status and at the status timeout, stop on failure, token never in argv or output, refusal
without the token. The port contracts run with
stand-ins (`REDIS_TEST_URL`, `S3_TEST_ENDPOINT`, see `adapters/local/README.md`). The image builds.
No Railway tool or schema validates this adapter: the first version used `railway.json` files, which passed Railway's
published JSON schema, and were dropped because that format is deprecated.
