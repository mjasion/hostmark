# Implementation plan

Scope of the current effort is E0 to E3 plus the portable adapters of E5 and E7, all off by default (D70, D71).
Stages E4, E6 and E8 to E10 stay in [`spec.md`](spec.md) for later.

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

## E3a. Platform opt-in

`platforms.json`, the `pnpm platform` command and a manually triggered deploy workflow, as D70 describes.
Done when every platform is listed as disabled, and `pnpm platform deploy <name>` refuses to run for each.

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
