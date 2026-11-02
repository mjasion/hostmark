# Implementation plan

Scope of the current effort is E0 to E3 plus the portable adapters of E5 and E7, and the offline parts of E4 (the
Cloudflare pipeline and previews) and E6 (the benchmark workflow), all off by default (D70, D71, D140, D170).
Real deployments of E4 to E7 and stages E8 to E10 stay in [`spec.md`](spec.md) for later.

Each stage is implemented by Sonnet agents, verified by Opus agents, fixed, then committed to `main`.

## E0. Core locally

1. Foundation: workspace, tooling, `packages/contract`, `packages/db`, ports and errors in `packages/core`.
2. In parallel: `packages/image`, `packages/telemetry` and `packages/storage-s3`, core use cases.
3. `adapters/local`: compose stack, BullMQ queue, api, worker and scheduler entrypoints, contract tests.

Done when unit tests pass and a real upload reaches `ready` through the compose stack.

## E1. Frontend locally

`apps/web`, `packages/pages`, Better Auth, SSE, Web Vitals, `/media`.

Done when a browser can sign up, upload, watch status and open a public page on the compose stack.

Carried over from the E0 review:

- Signup refuses `seed@hostmark.test` and `admin@hostmark.test`. An account holding either address makes every
  later seed fail, and the seed must not adopt such an account, because that would hand out admin.
- `packages/contract` gets tests for the client and for schema edge cases.

Known gaps after E1:

- The event stream outlives sign-out by up to 60 s.
- Cancel during `complete` does nothing.
- `/app/files/not-a-uuid` shows raw text, and the friendly branch in `apps/web/src/auth.ts` is unreachable.
- "Retry" is offered on refused files.
- A lazy thumbnail first scrolled to after the presigned URL has expired is unproven.
- Generic 404s carry no `Cache-Control`.
- `/app/files/..%2f..%2fetc` shows a raw JSON 404 in the browser.
- The `.origin` and `AUTH_CLIENT_IP_HEADER` wiring in `adapters/local/src/runtime.ts` has no test of its own.
- A `complete` left running by a signed-out user can answer 401 after the next user signed in, which sends that
  user to `/login`. No data is shown and signing in again recovers.
- The test that upload errors other than a 401 keep the session covers a failed create only.

## E2. Load tests

`load/` with k6 scenarios S1 to S15 and Playwright S10 and S13, writing JSON to `load/results/`.

Done when every scenario runs against the local variant. S7, S12, S14 and S15 can only be partly meaningful
locally; that is recorded per scenario rather than hidden.

Sign-in cannot be a k6 load path if the limiter is on (3 per 10 s per address, D80); use Bearer keys or sessions
created in setup. `pending_upload` rows of cancelled uploads are hidden from the gallery and remain until cleanup,
so counts of rows and `daily_stats` include them.

Done in `load/` (D90 to D99). Two things differ from the plan: S7 runs in a reduced form (seconds instead of
minutes), and S15 is recorded as skipped: there is no CDN or purge API locally. The worker decodes images in
WebAssembly on one JavaScript thread, so a Node worker scales by process, not by concurrency: locally two replicas
with `WORKER_CONCURRENCY=1` (D96, D97). S4 at its specified rate is run against that default and passes or fails
for the reason its result records.

Results must account for three behaviours found in the E0 review: the worker memory limit under a sustained
stream of maximum-size images (D79), `files.attempts` over-counting after an abandoned send, and a repeat killer
using up an innocent sibling's attempts (D64).

Later after E2 (found in the E2 reviews, none blocks E3):

- D79 still quotes concurrency 4 with a margin of about 300 MB; it was about 400 MiB, and 3.7 GB was 3.6 GiB. It is
  no longer the default.
- D97 says a second process "doubles" throughput: it is 1.29 to 2.49 files/s (1.93 times), and the memory it saves
  against concurrency 4 is small (3.2 against 3.6 GiB).
- `BASE_URL=http://[::1]:...` fails in setup with exit 107, because the sidecar listens on 127.0.0.1 only (L3).
- A loopback `BASE_URL` on a port other than 58080 or 59000 has no route on the compose network, and the result
  would still say `compose-network`.

Not verified after E2:

- `pauseWatch.stop()` below `await deployDone` under a real pause in that window (read from the code only).
- S5 `drained` on a real partial failure (a fake all-failed run only).
- A real clamshell sleep with the current watcher.
- Who holds the 5-tuple in Docker Desktop (D99), the cause of the S6 seed PUT timeout, why the first full run's
  worker memory was lower (2.1 and 2.7 GiB against 3.0 to 3.2 GiB), and the one 238 ms S4 maximum.
- The full forms of S1 to S3, S6 to S8, S10 to S14 on the new route: they run once on the committed tree.

## E3. Cloudflare portable

`adapters/cloudflare`, after checking current Cloudflare documentation. Findings go in the adapter README.

Code, emulator tests and deploy instructions are done without an account. The deploy itself waits for the
owner's consent because it needs Cloudflare and Neon accounts and a domain, and it costs money.

Carried over from the E0 review:

- Workers needs a lower `maxPixels`, about 12 to 16 MP. Measure it rather than taking this range as given.
- The queue contract gets tests for visibility timeout and backoff, which the first platform-managed queue can
  exercise.
- Check what `HEAD` returns on a missing bucket on R2, and on S3 in `adapters/aws`.
- The Workers image loader imports the wasm modules statically, as `@hostmark/image` documents.
- A distributed bundle has no `node_modules`, so it must carry the Apache-2.0 and BSD-3-Clause texts of the
  codecs itself.
- `/media` is cached for a year as immutable, so unpublish and delete need a CDN purge (D6). This is the first
  stage with a CDN. Design it so that the other adapters can do the same, and do not leave public shared
  deployments running without it.
- Set `clientIpHeader` in `createAuth` before the deployment is public, to a header the platform overwrites on
  every request (`cf-connecting-ip` on Cloudflare). Without it the sign-in rate limiter is off (D80).
- `createAuth` should validate `clientIpHeader` at startup: an invalid header name passes startup, and then every
  `/api/auth/*` request answers 500.
- Refuse the `.env.example` value of `BETTER_AUTH_SECRET` when `ENVIRONMENT` is not `local`.
- Measure the longest event loop block of the worker at the smallest instance against the 60 s lock. One job per
  process (`WORKER_CONCURRENCY=1`) lowers it, because a block no longer waits for sibling jobs (D97).

Offline part of E3 (D100 to D105, `adapters/cloudflare/README.md`), status `emulated`:

- Done and tested on workerd: the three Workers, R2, Queues, Cron, Hyperdrive, the queue/storage/image contracts, an
  end-to-end upload, static wasm, bundled licence texts, `clientIpHeader` and the secret checks, the purge port with
  its fail-closed path. `maxPixels` measured: 1.5 MP, derived and not enforced locally (D103), so the 12 MP fixture is
  refused by this variant.
- Not proven without an account: that the purge empties the cache, real R2 presign and `HEAD` behaviour (R2 and S3),
  the 128 MB isolate limit, the event loop block at the smallest instance. The queue visibility timeout does not exist
  on this platform (D101).
- Not met: only `jpeg-tiny` passes on this variant (D103). S4, S5, S9, S12, S13 and S15 fail or cannot set up, so
  acceptance criterion 4 is not met by the portable Cloudflare variant, and ordinary phone photos are refused while
  `MAX_UPLOAD_BYTES` stays 10 MB. This is an owner decision (`docs/decisions.md`, Open items); the fixtures are not
  shrunk.
- Tests that ran: the Cloudflare adapter suite on Miniflare (the api and consumer bundles, the queue, storage and image
  contracts, an end-to-end upload, the licence route, `consumeBatch`), and `pnpm check`. The scheduler bundle is built
  and checked by `pnpm check` but no test runs it.
- Deploy waits for the owner's consent.

Before any public deployment (E3, none of it is done):

- E. Purge rate limit: 5 prefix purges a minute per account on the Free tier. An unpublish costs 1 call, a delete 2,
  `PATCH` purges even a file that was never public, and `delete_file` purges every deleted file, so a burst is
  throttled and the failing jobs land in the dead letter queue (deleted after four days).
- F. A failed purge in `PATCH` has no durable retry. E and F need a `purge_pending` marker and a migration; restricting
  the purge to a public to private transition would break the retry of the same `PATCH` after a 503.
- C. A purge route and `PURGE_URL` for S12 and S15; a zone purge does not affect Workers Caching.
- L. `?x=1` answers 200 and is cached; an exact-URL CDN needs care.
- M. PNG headroom is 50 to 53 MB (JPEG 42 MB at 1.5 MP); the consumer has no `max_concurrency`; the JavaScript heap is
  unmeasured.
- J. Tests run on workerd 1.20260730.1, wrangler 4.156 deploys against 1.20261023.1.
- N. Rollback and old-version cache entries are untested.

## E3a. Platform opt-in

`platforms.json`, the `pnpm platform` command and a manually triggered deploy workflow, as D70 describes.
Done when every platform is listed as disabled, and `pnpm platform deploy <name>` refuses to run for each.

Implemented (D120 to D122): `platforms.json`, `tools/platform`, `.github/workflows/deploy.yml` and `ci.yml`. Nothing has
been triggered on GitHub; the workflows run first when the owner pushes.

## E4. Cloudflare pipeline and previews (offline part)

`adapters/cloudflare/pipeline/` and `.github/workflows/cloudflare-*.yml`, after checking current Cloudflare, Neon and
GitHub Actions documentation. Findings, every secret and variable by name, and the limits are in
`adapters/cloudflare/pipeline/README.md`. Decisions: D140 to D144.

- A preview per pull request (api and consumer Workers, queues, Hyperdrive, a Neon branch with an expiry) and its
  cleanup on close.
- A production deploy from `main` in 10%, 50% and 100% steps with an automatic rollback when the health signal is bad
  or missing.
- Every job is skipped while `platforms.json` has `cloudflare.enabled` other than `true` (production also needs
  status `deployed`); only a secret-free gate job runs.

Done offline when the scripts pass their tests against fake HTTP and fake commands, `actionlint` reports nothing and
the workflow tests pin the gate. Not done, because it needs accounts and the owner's consent: the first run of any
workflow, the GitHub Environments and their secrets, the Neon project and the preview bucket with its lifecycle rule.

## E5 and E7. Remaining portable adapters

`adapters/gcp`, `adapters/aws`, `adapters/railway`, `adapters/fly`, `adapters/vercel` and `adapters/vps`, each
after checking current platform documentation, with findings in the adapter README. Adapters running as Node
processes share one runtime, extracted from `adapters/local` rather than copied.

Done when each adapter passes its port contract tests on an emulator or a stand-in, and its config validates
offline. Acceptance criteria 1 to 4 need a real deployment, so each adapter is recorded as `emulated` until it
has one. Deployments wait for the owner's consent, per platform.

Each adapter sets `clientIpHeader` in `createAuth` before public exposure, to a header its platform overwrites on
every request, and names it in its README (D80). Without it the sign-in rate limiter is off.

Each adapter owns the bucket lifecycle rule from D74. Database claims keep overlapping scheduler runs safe (D19,
D56, D67), but `protect: true` only stops overlap inside one process, so a platform that runs two scheduler
replicas does each run twice. Run one replica or the platform's own cron, or add a Postgres advisory lock.

Each Node worker adapter measures the longest event loop block at its smallest instance against the 60 s lock. One
job per process (`WORKER_CONCURRENCY=1`) lowers it, because a block no longer waits for sibling jobs (D97).

Status of the Node adapters (D150 to D159):

- Done: `packages/node-runtime` (shared runtime, `NodePlatform`, contract test helper), `adapters/local` on top of it
  (smoke test 15 of 15), and `adapters/vps`, `adapters/fly`, `adapters/railway` with Dockerfile, platform config,
  README, port contract tests on stand-ins and config tests. All three stay `emulated` and off in `platforms.json`;
  none has a `platform-deploy` script.
- Railway settings (D157) are entered by hand because Config as Code is deprecated, and its storage is R2 because Railway Buckets
  have no lifecycle rules (D74).
- Not done, needs an owner or a real instance: any deployment; `flyctl config validate` (needs a login); the check that
  Fly and Railway overwrite their client address header; Tigris and R2 lifecycle and CORS calls; the
  event loop block measurement (recorded as "not measured"); machine sizes and prices of the three platforms.
- Next: `adapters/gcp` keeps a copy of about 80 lines of `packages/node-runtime`, which could go if that package took
  an injectable queue. A Postgres advisory lock in the scheduler would remove the one-replica rule (D159).

Status of `adapters/aws` (D190 to D196): done offline. Lambda api (function URL, streaming), SQS worker with DLQ,
EventBridge Scheduler, S3 and CloudFront, a CloudFormation template, a two pass deploy script with `--dry-run`, and
`prepare-database`. The SQS queue contract (visibility timeout, backoff, DLQ) passes on ElasticMQ, the S3 storage
contract on MinIO, and an end to end run on Postgres, MinIO and ElasticMQ covers upload to ready, purge on unpublish
and delete, and the 403 without the origin secret. Stays `emulated`. Not done, needs an account: any deployment,
`cfn-lint` or `validate-template`, the Lambda event source mapping, function URL streaming through CloudFront, the
viewer-request client address function, invalidation timing, memory of a 50 MP image on Lambda.

Status of `adapters/vercel` (D197 to D199): done offline, thinner than `adapters/aws`. Functions (`api/index.ts` Hono,
`api/queue.ts` consumer, `api/cron.ts`), Vercel Queues with an own dead letter topic, Cron Jobs, R2 for files, tag
based purge, `vercel.json` validated by `pnpm check` against a subset of the published schema (the `vercel` CLI is not
installed and was not run). The core queue contract passes on an in-memory model of Vercel Queues, which proves the
adapter logic only. Stays `emulated`. Not done, needs an account: any deployment, the real queue (delivery, idempotency
keys, visibility timeout, `queue/v2beta` trigger), `includeFiles` for the wasm codecs, the rewrites, the purge call
against a real cache, client address header spoofing, R2 lifecycle, the web build with the platform name `vercel`
on a real build, and an end to end run on Postgres (the aws adapter has one, vercel does not).

Status of `adapters/gcp` (D180 to D189): done offline. Cloud Run services for the api and the worker (instance-based
billing, fixed count), Cloud Scheduler calling Cloud Run Jobs, Pub/Sub with a dead letter topic (own unary pull
consumer, D17 rules), Cloud Storage over the XML API, a global load balancer with Cloud CDN, the `X-Client-Ip` custom
header (D182), `urlMaps.invalidateCache` for D100, Terraform in `infra/`, `scripts/deploy.sh` (never run) and
`scripts/check-config.ts`. The queue contract (visibility, backoff, dead letter) passes on the Pub/Sub emulator, the
storage contract on MinIO, the image contract always. Stays `emulated`. Not done, needs an account: any deployment,
`terraform validate`, a successful invalidation and its delay, Google's SigV4 for presigned PUTs, the load balancer
header on a real request, the event loop block on a real instance (not measured), costs.

## E6. The benchmark in GitHub Actions

`.github/workflows/benchmark.yml` (manual dispatch and a monthly schedule), `load/tools/bench-*.mjs` and
`load/tools/report.mjs`: a gate that reads `platforms.json`, k6 from one runner per region, one merged record per run,
a report, and a `benchmark-results` branch. Owner setup is in `load/BENCHMARK.md`.

Done when the workflow does nothing, and reaches no secret, while no platform is enabled and deployed; load goes only
to an enabled, deployed platform; S5 and S6 need a per-platform budget confirmation; results of different trees or of
an invalid run are never averaged without a mark; skipped scenarios show as skipped.

Implemented (D170 to D179), offline: the gate, merging, the report, publishing to a bare repository and `actionlint`
are tested. Nothing has run on GitHub. Needs from the owner: a self-hosted runner per region with Docker and Node
(or the `github-hosted` fallback, which is one vantage point), an environment `bench-<platform>` per platform, and the
confirmations. Nothing runs until a platform is enabled and deployed.

## Open findings from verification

Opus verification of the adapters on 2026-11-02 found nothing that blocks a commit with every platform off (the two
GCP blockers are fixed, D200). All adapters stay `emulated`. These items are open and none is fixed yet.

Before enabling AWS:

- `/api/health/deep` always answers 503: the roles cover `originals/*` and `variants/*`, the probe key is
  `healthcheck/probe`. Load setup waits for a 200, so every scenario stops there.
- Every cookie mutation answers 403: Host is the function URL, Origin is CloudFront, nothing sets `x-forwarded-host`.
  One line in the viewer function fixes it.
- `rum.js` is cached for a year by `scripts/deploy.mjs`, and no deploy sets a version, so S14 sees `dev`.
- The 3008 MB of `template.yaml` is below the 3.0 to 3.2 GiB of D79. CloudFront allows 15 wildcard invalidations in
  progress, so a burst of purges fails with the row already private.
- The temporary secrets file of `scripts/deploy.mjs` survives SIGTERM and SIGINT. D193 overstates what ElasticMQ proves:
  the contract test passes without `ChangeMessageVisibility`, only unit tests catch it.

Before enabling Vercel:

- Functions may not load unbundled (`"type": "module"` with extensionless imports); prebundle like `adapters/aws`.
- `/login`, `/signup` and `/app/files/<id>` serve the landing page, so S13 cannot reach the panel.
- `/f` has no tag and no CDN header, against D199; the page stays public for 60 s plus 600 s after unpublish.
- No `regions` and no `HOSTMARK_REGION`: `/f` reports `local` and functions run away from the database. No version.
- A purge with no request context silently does nothing and `delete_file` records it as done. The DLQ copy can be lost
  when its send fails. The killer job has no `maxDeliveries`.
- `api/queue.ts` trusts every POST: `handleCallback` of `@vercel/queue` 0.10.0 checks no signature or token and takes the
  job from the request body. The only protection is the documented "no public URL" of consumer functions. Prove it on
  the first deployment: a forged `ce-type` POST to `/api/queue` must not reach the handler.

Before enabling Google Cloud:

- Add a Cloud login to `deploy.yml`. Run `terraform validate`; nothing has parsed `infra/` with the provider.
- Cloud Run kills 10 s after SIGTERM by its documentation, so the 55 s grace is wrong and a long job loses an attempt.
- The `hostmark-seed` job prints generated seed keys to Cloud Logging. The DLQ reader subscription has no
  `expiration_policy`, so it lapses after 31 idle days and dead letters are lost.
- Four sequential purge calls per file allow about 125 files a minute, the metadata token fetch has no timeout, and the
  effective Max TTL of `/media` is unresolved.

All platforms:

- `/media` is immutable for a year and VPS, Fly and Railway have no purger. A CDN in front of the VPS, as the spec plans,
  keeps an unpublished file for up to a year. `packages/core/src/ports.ts` says only `local` lacks a purger.
- The contract suite does not detect loss of renewal, ack or the failure deadline: three of five mutants passed.
- S13, S14 and S15 cannot run as written on AWS and Vercel, against acceptance criteria 4 and 6, and no decision says so.
- Not recorded as comparability limits: compression differs on GCP and VPS (S10), GCP autoscales the api while VPS, Fly
  and Railway run one, Fly `shared-cpu-*` throttles under load, and api memory differs between platforms.
