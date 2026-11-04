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
  needs. They are set in the dashboard, with the `serviceInstanceUpdate` API call, or with `railway environment edit
  --service-config`. `services.json` lists the values; Railway does not read it, and whether `config apply` resets
  dashboard settings is unconfirmed. There is no documented offline validation, and `railway config plan` needs a
  linked project, so nothing here is validated against Railway. A test guards the values.
- **Railway Buckets have no lifecycle configuration.** The D74 rule (originals/ and variants/ expire after 8 days)
  cannot be set there, and `init-bucket` stops on the failed call. The adapter therefore uses R2, which the spec allows.
  Railway Buckets (variables `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`, `ENDPOINT`; CORS through
  `put-bucket-cors`; no public buckets) would work only after Railway adds lifecycle rules. Not implemented: an
  app-side expiry sweep, which would need a change in core.

The facts above, and the Railway ones below, come from a documentation report relayed by the team lead (sources:
docs.railway.com infrastructure-as-code, deployments/reference, networking/public-networking/specs-and-limits,
storage-buckets, databases/redis, reference/regions). I did not read those pages myself.

## Deploy steps (owner, in the Railway dashboard)

1. New project from this GitHub repository. Create three services from it and name them `api`, `worker`, `scheduler`.
2. Per service, set the Dockerfile path to `adapters/railway/Dockerfile` (the root directory stays empty, because the
   build needs the whole workspace; the variable `RAILWAY_DOCKERFILE_PATH` is another way, unverified), the start
   command, replicas, restart policy, draining time and memory from `services.json`; the `api` also gets the
   pre-deploy command and the `/api/health` check.
3. Add the Redis template. Create an R2 bucket and an API token for it.
4. Set the variables below. Give `api` a public domain and set `PUBLIC_URL` to it. `worker` and `scheduler` get none.
5. Deploy. The pre-deploy command of `api` keeps or creates the bucket, applies the lifecycle rule and CORS, migrates
   and seeds, then the services start.

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
| `OTLP_ENDPOINT`, `AUTH_SIGNUP_ENABLED`                                 | optional           |                                                             |
| `HOSTMARK_REGION` (build variable)                                     | all                | RUM region; defaults to `unknown`, see below                |

Nothing secret is in the repository; the pipeline's secret name is `RAILWAY_TOKEN` (`platforms.json`).

Railway regions are `us-west2`, `us-east4-eqdc4a`, `europe-west4-drams3a` and `asia-southeast1-eqsg3a`: none is
Frankfurt or Warsaw, so the default `HOSTMARK_REGION` is `unknown`. Set `us-east` or `singapore` (closed list) only for
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
prices were not checked. Railway's default is SIGTERM followed by SIGKILL after 0 seconds, so `drainingSeconds` is 70
for the worker (a job in flight can finish, lock 60 s), 30 for the scheduler and 10 for the api. The maximum value
is undocumented. Longest event loop block against the 60 s lock: **not measured** (needs a real instance).

## Redis

Single node from the official template, `REDIS_URL`, private host `<service>.railway.internal`. BullMQ needs
`maxmemory-policy noeviction`; Railway's default is unconfirmed, so check `CONFIG GET maxmemory-policy` on the first
deploy. Older environments resolve `*.railway.internal` over IPv6 only, which would need `?family=6` on the URL
(unverified).

## Checked offline

`pnpm --filter @hostmark/adapter-railway test` checks `services.json` (known keys, one scheduler with no overlap,
worker memory and draining, the pre-deploy order bucket, migrate, seed, the health path, no secret), the client
address header, and that the Dockerfile equals the local one apart from the adapter name. The port contracts run with
stand-ins (`REDIS_TEST_URL`, `S3_TEST_ENDPOINT`, see `adapters/local/README.md`). The image builds.
No Railway tool or schema validates this adapter: the first version used `railway.json` files, which passed Railway's
published JSON schema, and were dropped because that format is deprecated.
