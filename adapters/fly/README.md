# adapters/fly

Portable runtime on Fly.io: one Docker image run as three process groups (`api`, `worker`, `scheduler`) of one
app, Redis from Upstash, storage on Tigris and the shared Neon database (D71). This is the `fly-portable` platform.
Status: `emulated`. Nothing has been deployed, and `flyctl` was never logged in from this repository.

The code is the shared runtime in `packages/node-runtime` (D150). This directory holds the entrypoints, `src/platform.ts`
(the Tigris variable mapping and the client address header), the `Dockerfile` (the local image with another adapter
name and RUM defaults) and `fly.toml`.

## Deploy steps (owner, with a Fly account)

Run from the repository root; the build context must contain the workspace.

```sh
fly apps create <your-app-name>                  # edit app = "..." in fly.toml to match: app names are global
fly storage create -a <your-app-name>            # Tigris: sets AWS_*, AWS_ENDPOINT_URL_S3 and BUCKET_NAME as secrets
fly redis create                                 # Upstash Redis; copy its URL
fly secrets set -a <your-app-name> \
  DATABASE_URL=... REDIS_URL=... BETTER_AUTH_SECRET=... \
  SEED_API_KEY=... SEED_ADMIN_API_KEY=... PUBLIC_URL=https://<your-app-name>.fly.dev
fly deploy -a <your-app-name> --config adapters/fly/fly.toml --dockerfile adapters/fly/Dockerfile --ha=false .
fly scale count api=1 worker=2 scheduler=1 -a <your-app-name>
fly status -a <your-app-name>                    # scheduler must list exactly one machine
```

`--ha=false` keeps one machine per process group; a second scheduler machine only waits on the leader lock (see
Scheduler). `release_command` runs the bucket setup (lifecycle), the migrations and the seed in a
temporary machine before the machines are replaced. Optional: `OTLP_ENDPOINT` and `AUTH_SIGNUP_ENABLED`.

## Deploy from GitHub Actions

`pnpm platform deploy fly` (D70, D121) runs `scripts/deploy.mjs` from the repository root:

```sh
flyctl deploy --config adapters/fly/fly.toml --dockerfile adapters/fly/Dockerfile --ha=false --yes .
flyctl scale count api=1 worker=2 scheduler=1 --config adapters/fly/fly.toml --yes
flyctl status --config adapters/fly/fly.toml
```

So the D159 rule is applied by every deploy: `--ha=false`, and the counts set again with exactly one scheduler. A
failed deploy stops before the scale. `--dry-run` prints the commands. `deploy.yml` installs flyctl 0.5.3 from its
GitHub release after checking the SHA-256 that the release publishes (D242).

Once, with your own login: the steps above up to `fly secrets set` (app, Tigris, Upstash, secrets; `app` in
`fly.toml` set to the app name), then a deploy token for that app only:

```sh
fly tokens create deploy -a <your-app-name> -x 2160h    # 90 days; prints the token once
```

In GitHub, environment `fly` (deployment branches: `main` only):

| Secret          | Value                                           |
| --------------- | ----------------------------------------------- |
| `FLY_API_TOKEN` | the deploy token, including its `FlyV1 ` prefix |

The application secrets stay in Fly (`fly secrets set`); the pipeline never sees them. flyctl reads the token from
its environment; it is never an argument, and the script scrubs it from the output (`test/deploy.test.ts`, with a
fake `flyctl` that echoes it).

Not proven (needs an account): that a deploy token (`fly tokens create deploy`, "limited to managing a single app and
its resources" in the flyctl help) may use the remote builder and run `scale count`; that `--dockerfile` with
`--config` from another directory builds `adapters/fly/Dockerfile` with the repository root as context; that
`--ha=false` and `scale count` leave exactly one scheduler machine after a redeploy (check `fly status`); build and
release command times.

## Required variables

| Variable                                                                                         | Source                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                   | secret: Neon connection string                                                                                               |
| `REDIS_URL`                                                                                      | secret: Upstash URL from `fly redis create`                                                                                  |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `BUCKET_NAME`, `AWS_REGION` | secrets set by `fly storage create`; `src/platform.ts` maps them to `S3_*` (explicit `S3_*` wins; region defaults to `auto`) |
| `BETTER_AUTH_SECRET`, `PUBLIC_URL`                                                               | secret: 32+ characters; the public origin                                                                                    |
| `SEED_API_KEY`, `SEED_ADMIN_API_KEY`                                                             | secret: seed keys (D14)                                                                                                      |
| `OTLP_ENDPOINT`                                                                                  | optional: OTLP/HTTP base URL                                                                                                 |

`WORKER_CONCURRENCY=1`, `ENVIRONMENT`, `HOSTMARK_REGION` and `HOSTMARK_TOPOLOGY` are in `fly.toml`; the build args
carry the RUM attributes (`fly`, `portable`, `single`, `frankfurt`). Nothing secret is in the repository. The
required secret names for the pipeline are in `platforms.json` (`FLY_API_TOKEN`).

## Client address header (D80)

`clientIpHeader` is **`Fly-Client-IP`**, fixed in `src/platform.ts`. Fly's documentation describes it as the client
address from the Fly Proxy's point of view. Whether the proxy overwrites a client-sent value was **not verified**
against Fly documentation: a community reply says a client cannot forge it, the same thread also shows that
`X-Forwarded-*` headers can be overridden by clients, and I found no official statement. Test it after the first
deploy: `curl -H 'Fly-Client-IP: 6.6.6.6' https://<app>.fly.dev/api/auth/get-session` must be rate limited by your
own address. Other limits: with Cloudflare or another proxy in front, the header holds that proxy's address; machines
on the private network (`.internal`, Flycast) reach `:8080` without the proxy and could set the header, so keep the
org's private network trusted.

## Bucket lifecycle (D74)

The release command runs `dist/init-bucket.js`: if the bucket exists (HEAD answers 200, as for the bucket that `fly
storage create` makes) it is kept, then the lifecycle rule (`originals/` and `variants/` expire after 8 days) and CORS
(PUT and GET) are applied with the S3 API. Tigris documents object expiration rules by days on the last modified time
(up to 10 rules per bucket) and the standard S3 `PutBucketLifecycleConfiguration` call. Not run against Tigris here;
the S3 calls were run against MinIO only. Tigris and the standard CORS call: no walkthrough found, treat as unverified.

## Scheduler

One machine in the `scheduler` group is enough: `--ha=false` on deploy and `fly scale count scheduler=1`.
`scripts/deploy.mjs` does both on every deploy (tested against a fake `flyctl`); a manual deploy must do them by hand.
A second machine is safe: only the scheduler that holds the Postgres advisory lock runs the jobs, the other takes over
when that session ends (D204). The lock needs a direct or session-mode `DATABASE_URL`, not a transaction-mode pooler.

## Worker sizing

The worker group uses `shared-cpu-2x` with 4 GB (peak 3.0 to 3.2 GiB per process, D79) and two machines. Valid
size and memory combinations, prices and Fly's regions were not checked against the current documentation; `fly
deploy` rejects an invalid combination. Longest event loop block against the 60 s lock: **not measured** (needs a real
instance). `kill_timeout = 70` gives a job time to finish on stop.

## Checked offline

`pnpm --filter @hostmark/adapter-fly test` parses `fly.toml` with `smol-toml` and checks: three process groups, only
`api` behind `http_service`, a machine size per group with 4 GB for the worker, `WORKER_CONCURRENCY=1`, the release
command order (bucket, migrate, seed), RUM build args from the closed lists and no secret in `[env]`; it also checks
the Tigris variable mapping and that the Dockerfile equals the local one apart from the adapter name. The deploy
script runs against a fake `flyctl`: the commands, `--ha=false`, a count for exactly the process groups of `fly.toml`
with one scheduler, stop on failure, the token never in argv or output, refusal without the token. The port
contracts run with stand-ins (`REDIS_TEST_URL`, `S3_TEST_ENDPOINT`, see `adapters/local/README.md`).
`flyctl config validate` was **not run**: it needs `flyctl auth login`, and this work uses no account. TOML syntax and
the keys above are checked by the test, not against Fly's schema.

## Platform documentation: checked and not checked

Checked (search result summaries, not the primary pages): `Fly-Client-IP` meaning (Fly request headers page);
Tigris variables set by `fly storage create`, Tigris expiration rules; process groups (`[processes]` with services
targeting a group). Not verified: `kill_timeout`, `[[restart]]`, `[[vm]] processes` and `auto_stop_machines = "off"`
against the current reference, `--dockerfile` with `--config` from another directory, Upstash Redis behaviour with
BullMQ (it needs `maxmemory-policy noeviction` and polls constantly, so pay-per-command plans can cost a lot; the
internal address may be IPv6-only and need `?family=6`), the Tigris endpoint with signing region `auto`, free
allowances and prices.
