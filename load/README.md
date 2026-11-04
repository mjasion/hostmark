# load

Load scenarios S1 to S15 for any hostmark variant. The scenario code is the same for every variant: only `BASE_URL`
and the API keys change, and no scenario names a platform. `load/` is not a workspace package and has no
dependencies; everything runs in containers (k6 is not installed on the host).

| Scenarios                                               | Tool                                                      |
| ------------------------------------------------------- | --------------------------------------------------------- |
| S1 to S9, S11, S12, S14, S15                            | k6 (`grafana/k6:2.3.0`)                                   |
| S10 (landing page), S13 (login, upload, ready, gallery) | Playwright (`mcr.microsoft.com/playwright:v1.64.1-noble`) |

## Run

```sh
node load/tools/fixtures.mjs        # once: generates the images the upload scenarios need (not committed)
node load/run.mjs S1                # one scenario against the local stack (http://127.0.0.1:58080)
node load/run.mjs all --short       # every scenario in its short form, for smoke use
node load/run.mjs --list            # scenarios, with what each needs
node load/run.mjs S4 --dry-run      # prints the docker commands, runs nothing
```

Options: `--short`, `--region NAME`, `--no-observe`, `--no-idle-wait`, `--dry-run`, `--list`. `all` runs S1 to S15 in
order and needs `--short` or `GAPS` (the full S7 takes 13 hours; without either it exits 2). The exit
code is the worst of the scenarios: 0 passed, 99 a threshold failed (k6), 107 setup failed, 2 refused by the guard, 3 invalid (the host was paused).

Local keys: with a loopback `BASE_URL` and no `API_KEY` / `ADMIN_API_KEY` in the environment, the keys are read from
the gitignored `adapters/local/.env` (`SEED_API_KEY`, `SEED_ADMIN_API_KEY`). Any other target needs them in the
environment. Keys are passed to the containers by name (`docker run -e NAME`), so they do not appear in the process
list or the repository.

### Against another variant

```sh
BASE_URL=https://example.test API_KEY=... ADMIN_API_KEY=... REGION=eu TOPOLOGY=single \
LOAD_ACK_REMOTE=example.test node load/run.mjs S1
# S5 and S6 additionally: LOAD_ACK_BUDGETS=yes
```

### The loopback forwarder (Docker Desktop)

Docker Desktop has no host network, so a container cannot reach `127.0.0.1:58080` of the host. For a loopback target
`run.mjs` starts a sidecar `hostmark-load-fwd-<pid>` (`node:22` slim, `tools/forward.mjs`) that listens on
`127.0.0.1:58080` and `:59000` (the object store) and runs k6 and Playwright with `--network container:<sidecar>`.
Inside that network the API and MinIO answer on the same addresses as on the host, so the presigned URLs, which are
signed for `127.0.0.1:59000`, work unchanged and are never rewritten. When the compose network exists
(`<HM_COMPOSE_PROJECT, default hostmark>_default`) the sidecar joins it and forwards to `api:8080` and `minio:9000`;
otherwise it falls back to `host.docker.internal`. The route over the published port is avoided on purpose: Docker
Desktop drops a new connection that reuses the 5-tuple of one the server closed first, for about 60 s (D99). The
sidecar is removed when the run ends. `HM_LOAD_NETWORK=host` uses the host network instead (Linux),
`HM_LOAD_NETWORK=sidecar` forces the sidecar. The forwarder is a TCP copy in one more process: it adds a little
latency, and it is part of what every local number includes.

## Safety guard

A non-loopback `BASE_URL` is refused until `LOAD_ACK_REMOTE=<host>` names the host (`host[:port]`, as in the URL).
S5 and S6 can cost real money on a metered platform, so they additionally need `LOAD_ACK_BUDGETS=yes` (set budgets
and billing alerts first). The check runs in `run.mjs` before any container starts and again at k6 and Playwright
init, so a scenario started by hand is also guarded. Only the literal loopback names (`localhost`, `127.x.y.z`,
`::1`) count as loopback; `127.0.0.1.example.com`, `0.0.0.0` and `127.1` do not. Credentials in the URL are refused.
`node --test load/test/*.test.mjs` covers the guard.

## Variables

All are optional locally unless noted.

| Variable                                                                                               | Meaning                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`                                                                                             | Target, default `http://127.0.0.1:58080`                                                                               |
| `API_KEY`, `ADMIN_API_KEY`                                                                             | Bearer keys. Admin is needed by S8 only. Required for a remote target                                                  |
| `LOAD_ACK_REMOTE`, `LOAD_ACK_BUDGETS`                                                                  | Guard acknowledgements (above)                                                                                         |
| `REGION`, `TOPOLOGY`, `VARIANT`, `NOTE`                                                                | Labels copied into the result. The region is an input: S10 to S15 run once per region                                  |
| `RPS`, `DURATION`                                                                                      | Arrival rate and length of S1, S2, S3, S4, S11, S12 (defaults below)                                                   |
| `PEAK_RPS`, `RAMP`, `HOLD`                                                                             | S6                                                                                                                     |
| `UPLOADS`, `BURST_SECONDS`, `DRAIN_TIMEOUT`, `POLL_S`                                                  | S5                                                                                                                     |
| `GAPS` (seconds, comma list), `REPEATS`                                                                | S7                                                                                                                     |
| `LEVELS` (ms, comma list), `ITERATIONS`, `MAX_FAILED`                                                  | S8                                                                                                                     |
| `PNG_UPLOADS`, `STREAM_UPLOADS`, `STREAM_WAIT`                                                         | S9                                                                                                                     |
| `POLL_MS`, `EXPECT_VERSION`, `DEPLOY_STARTED_AT`                                                       | S14 (`POLL_MS` also S15). `DEPLOY_STARTED_AT` (ISO time) is when your pipeline started the deploy                      |
| `PURGE_URL`, `PURGE_METHOD`, `PURGE_TOKEN`, `PURGE_BODY`, `PURGE_AT`                                   | S12 (purge before the first request) and S15                                                                           |
| `VISITS`, `TTFB_P95_MS`, `LCP_P95_MS`                                                                  | S10                                                                                                                    |
| `RUNS`, `FLOW_P95_MS`, `INP_MAX_MS`                                                                    | S13                                                                                                                    |
| `P95_MS`, `READY_P95_MS`                                                                               | Latency bounds of the k6 thresholds (a slower platform gets its own bound explicitly)                                  |
| `LOAD_ACK_PURGE_HOST`                                                                                  | A `PURGE_URL` host other than the target's needs this acknowledgement (a loopback target needs a loopback `PURGE_URL`) |
| `HM_LOCAL_DEPLOY`                                                                                      | `1`: S14 rebuilds and recreates the local api (below)                                                                  |
| `HM_LOAD_NETWORK`, `HM_COMPOSE_PROJECT`, `STORE_PORT`, `K6_IMAGE`, `PLAYWRIGHT_IMAGE`, `FORWARD_IMAGE` | Plumbing of `run.mjs`: network mode, compose project name (`hostmark`), object store port to forward (`59000`), images |
| `GRAFANA_URL`                                                                                          | `spotcheck.mjs` only, default `http://127.0.0.1:53000`                                                                 |
| `CONFIGS`, `RESENDS`, `FIXTURE`                                                                        | `behaviours.mjs abandoned-send` only (replicas x concurrency, resend counts, fixture)                                  |
| `CONCURRENCY`, `KILLS`, `SIBLINGS`, `FIXTURE`                                                          | `behaviours.mjs repeat-killer` only                                                                                    |

Every load parameter has the value of the specification and a smaller one for `--short`; an environment variable of
the same name overrides both. The result lists each parameter that differs from the specification under
`load.deviations` and sets `load.mode` to `reduced`, so a reduced run cannot be mistaken for the full scenario.

## Results

Each run writes `load/results/<id>-<region>-<timestamp>.json` (a few KB: metrics, never samples) with: `x-platform`
and `x-version` as the target answered them, date, `commit`, `treeSha` (the git tree of the working copy that was
tested, committed or not; `dirty` is true when it differs from `HEAD^{tree}`), `baseUrl`, the labels, `short`, the load
parameters and deviations, `status` (`passed`, `failed` or `skipped`), `passed` (`null` when skipped) and `failedThresholds`, every threshold and whether it held, the setup warm-up
(`/api/health/deep` retried until 200, then one request per route), the metrics, and `meaning`, a statement of what
the numbers mean for the local stack (only written for a loopback target). The gates of the steady scenarios read the
scenario's own requests (`{scenario:X}` sub-metrics), not the warm-up of `setup()`; `headline` carries them. Cache status headers (`cf-cache-status`, `x-vercel-cache`, `x-cache`)
are recorded unchanged under `cache` when the target sends them. On the local stack `run.mjs` adds `local`: what the
stack saw (database counts, `files.attempts`, worker memory peak, restarts, OOMKilled) read from `docker` and
Postgres.

Results are not committed: `load/results/*` is gitignored (only `.gitkeep` is tracked), as are the generated
fixtures in `load/fixtures/`. A result of a benchmark worth keeping is copied into the report that discusses it
(D90). Timings are never compared across machines.

Thresholds always include an error gate (`http_req_failed`, `checks`, and `dropped_iterations` for arrival-rate
scenarios: a generator that cannot hold the rate has not delivered the load) and a latency bound. Setting
`P95_MS=0.5` makes S1 exit 99.

## Scenarios and what they mean locally

The local stack is one Node process per role on one machine, Postgres, Redis and MinIO in the same Docker network,
no TLS, no CDN, no autoscaling. The load generator and the forwarder share the machine's CPU with the stack.

|     | Scenario                                   | Full form                                                           | What it measures                                                                                                                            | Locally                                                                                                                                                       |
| --- | ------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `GET /api/health`                          | 50 rps for 3 min                                                    | Floor of framework and platform edge                                                                                                        | The floor of the generator and one Node process, not a hosting platform                                                                                       |
| S2  | `GET /api/files/:id`                       | 50 rps for 3 min                                                    | A database read plus presign computations                                                                                                   | One query with no network distance to the database                                                                                                            |
| S3  | `GET /api/files?limit=50`                  | 20 rps for 3 min                                                    | One indexed query for 50 rows, 150 presigns                                                                                                 | Setup tops the seed user up to 50 files and records the page size                                                                                             |
| S4  | upload, 1 MB JPEG, to `ready`              | 2 rps for 5 min                                                     | create, PUT, complete, queue, process. `upload_to_ready_ms` is the API's own `ready_at - queued_at`, `ready_wait_ms` what a 250 ms poll saw | The PUT is a loopback copy, processing is the only real cost. The 12 MP fixture drains at about 1.3 files/s per worker process; two processes run (D97)       |
| S5  | burst of 1 MB uploads                      | 1000 in 60 s, then drain                                            | Burst acceptance and the time until every file is terminal                                                                                  | Two worker processes, one job each: drain time is queue length divided by that throughput. `drained` must be true                                             |
| S6  | spike on the S2 read                       | 0 to 500 rps in 10 s, hold 2 min                                    | Time until latency and errors settle (one-second buckets)                                                                                   | Saturation of one Node process plus generator, not platform stabilisation                                                                                     |
| S7  | cold start                                 | gaps of 5, 15, 60 min, 10 repeats each (about 13 h)                 | First request after silence, first database request, then a repeat                                                                          | Not meaningful: nothing is frozen or scaled to zero. Reduced form below                                                                                       |
| S8  | `POST /api/debug/cpu`                      | 100, 500, 1000, 5000 ms, 5 each                                     | Whether the platform's CPU limit lets the request finish                                                                                    | No limit applies; `cpu_iterations` shows the work done in that time                                                                                           |
| S9  | 10 MB PNG, then a stream                   | 5 PNGs one at a time, plus 24 mixed maximum-size files back to back | Large decode time, and the worker memory limit (D79)                                                                                        | Memory of the local worker (4 GB limit) under a mixed stream of 50 MP files; the stream is beyond the specification                                           |
| S10 | landing page in a browser                  | 20 visits, new context each                                         | TTFB, LCP, transfer size                                                                                                                    | No CDN, no compression (D88), loopback: cost of rendering, not delivery                                                                                       |
| S11 | S2 read from one region                    | 20 rps for 3 min                                                    | Per-region latency (one run per `REGION`)                                                                                                   | One region: a baseline for the three-region runs                                                                                                              |
| S12 | `/f/:id` first request and warm            | 50 rps for 2 min                                                    | Render cost and the cache header values                                                                                                     | No CDN: every request is rendered, hit ratio not measurable                                                                                                   |
| S13 | login, upload, ready, gallery in the panel | 10 runs                                                             | Time of the flow, SSE use, INP approximation                                                                                                | Local network and no TLS; sign-in is browser-driven and low volume (D80)                                                                                      |
| S14 | deploy propagation                         | poll `x-version` 1/s for 10 min                                     | Time from deploy to the new version being served                                                                                            | See below                                                                                                                                                     |
| S15 | cache purge                                | read 1/s, purge at 10 s                                             | Time until a response is no longer a hit                                                                                                    | Cannot run without `PURGE_URL`: no CDN and no purge API. SKIPPED, `passed: null`. With a `PURGE_URL` the page must be a hit before the purge or the run fails |

Notes that change how a number reads:

- **S4, S5, S9 count `pending_upload` rows.** Cancelled uploads leave their row until cleanup, so row counts and
  `daily_stats` include them. The result counts only files created after the run's boundary file (`window`), and
  lists `pending_upload` separately.
- **Worker processes.** The image codecs run on one JavaScript thread, so concurrency 1, 4 and 8 all drain 12 MP
  files at about 1.3 files/s, and two processes drain 2.49 files/s (D96). The local stack runs two worker replicas
  with `WORKER_CONCURRENCY=1` (`WORKER_REPLICAS`, D97). The specified S4 rate of 2 rps sits close to that capacity, so
  a failure of S4 is a statement about the queue (`ready_wait`, files still `queued`), which the result records.
  On 2026-11-01 (run before D99) S4 passed at 2 rps with two processes in one run (598 of 600 uploads `ready`,
  `upload_to_ready_ms` p95 803 ms) and failed in another with 17 requests that got no answer within k6's 60 s timeout;
  S5 drained 1001 files in 402 s (2.5 files/s). The hung requests were not the application (in an earlier run with two such
  requests the api's own p99 for `POST /api/uploads` was 22 ms): they come from the published-port path of Docker Desktop (D99), which the sidecar no
  longer uses when the compose network exists. These figures are not from the current load path; the next full run
  replaces them.
- **Fresh workers.** S4, S5 and S9 restart the worker replicas before they start, so a memory peak belongs to that
  run (the observer reads each replica's cgroup `memory.peak`, not a sample every few seconds).
- **Host sleep.** A laptop that sleeps (lid closed on battery) freezes Docker and `run.mjs` together, and the run then
  measures the sleep. A watcher process (`tools/pause-watch.mjs`, so a blocking call in `run.mjs` cannot delay it) ticks
  every second and reports gaps of more than 5 s. Every result has `host: {watcher, pauses, pausedS, keepAwake}`; a pause
  (or a watcher that did not report) marks the result `invalid` (`passed: null`, exit 3) and the run has to be repeated.
  `run.mjs` starts `caffeinate -i` on macOS, which does not stop a closed lid from sleeping the host: keep the lid open
  and the machine on power.
- **Idle queue wait.** On a local target `run.mjs` waits (up to 15 min) for the image queue to be empty before a
  scenario starts, so one scenario's backlog does not delay the next. The seconds waited are in
  `local.waitedForIdleQueueS`. `--no-idle-wait` skips it (needed when the worker is stopped on purpose).
- **S5 drain** is polled through the gallery every `POLL_S` seconds, so the drain time has that resolution. The
  `local` block lists the final statuses and `by_attempts` (below).
- **S7 full form** needs 13 hours and a platform that really goes cold. `GAPS=300,900,3600 REPEATS=10` is the
  specification; the reduced form used locally is `GAPS=5,15,60 REPEATS=3` (seconds), labelled `reduced` in the result
  with the gaps and total silence recorded. A local run only proves that there is no cold-start penalty.
- **S9** has two phases. `png` is the specification (a 10 MB PNG, one at a time). `stream` (D79) sends the files of
  the worker's 50 MP pixel limit back to back, cycling a 50 MP JPEG, a 16-bit PNG, a WebP and a tall PNG, so the
  worker never idles. Each file must reach `ready` within `STREAM_WAIT`, and the number that completed must equal the
  number planned, or the run fails.
- **S12** takes `Cache-Control` as received. It depends on `PUBLIC_URL` (D82): with it set the page asks a CDN to
  cache for 60 s; there is no CDN locally, so nothing caches it and the numbers are render cost, not cache behaviour.
- **S14** needs `x-version` to change. Without a deploy the run only proves the header is served. With
  `HM_LOCAL_DEPLOY=1` (loopback only) `run.mjs` builds the api image with `APP_VERSION=<sha>-redeploy-<time>` and
  recreates the api container 10 s into the run: the result shows how long the single container was unreachable and
  when the new version first answered. That is a process restart, not propagation to edge locations. For another
  variant, start `node load/run.mjs S14` and deploy from your pipeline; set `EXPECT_VERSION` to make the run fail if
  that version never appears.
- **S15** needs `PURGE_URL` (and `PURGE_METHOD`, `PURGE_TOKEN`, `PURGE_BODY`). Without it the result is `skipped`
  (`passed: null`, with `skipped.reason`); it exits 0 and the summary line says SKIPPED. With it, the page must be a
  cache hit before the purge; if it never was, the run aborts and fails (`aborted` event). A `PURGE_URL` on another
  host than the target needs `LOAD_ACK_PURGE_HOST`, and a loopback target accepts only a loopback `PURGE_URL`.
  Every platform with a purger offers the same purge API (D206): `PURGE_URL='{base}/api/debug/purge/{id}'`,
  `PURGE_METHOD=POST` and `PURGE_TOKEN` set to an admin API key. It answers 204, or 501 where the deployment has no
  CDN (local, VPS, Fly, Railway).
- **S10, S13** run in the Playwright image as the host user. The repository is mounted read-only; specs are copied
  to a scratch directory with `node_modules` linked to `apps/web/node_modules` (the browser is not launchable on the
  macOS host). INP is approximated from Event Timing: the worst interaction on the single page app.

## Fixtures

`node load/tools/fixtures.mjs` writes to `load/fixtures/` (gitignored) and a manifest with sizes and hashes:
`jpeg-tiny.jpg`, `jpeg-1mb.jpg` (about 1 MB, 12 MP), `png-10mb.png` (about 10 MB, 1826 x 1826), `jpeg-50mp.jpg`
(the worker's pixel limit), and three more 49 MP files for the S9 stream: `png16-49mp.png` (16-bit), `png-tall-49mp.png`
(1000 x 49000) and `webp-49mp.webp`. The files are generated, so they are reproducible and never committed.

## Independent checks of the local stack

Only against a loopback target; both read the compose project (`hostmark`).

```sh
# k6's request counts against the Prometheus counters the api exports (waits for the OTel export, about 80 s):
node load/tools/spotcheck.mjs load/results/S1-local-<ts>.json --settle 80 --route "/api/health 200" --expect <iterations+warm-up requests of the route>

# the two worker behaviours a benchmark cannot see from outside (they recreate, stop, kill and start the workers):
node load/tools/behaviours.mjs abandoned-send    # files.attempts after duplicate sends, one file per resend count (D76)
node load/tools/behaviours.mjs repeat-killer     # a repeat killer consuming its siblings' attempts, at CONCURRENCY=4 (D64)
```

The spot-check window ends `--settle` seconds after the run; when the next scenario follows at once, its requests fall
into that window (S1's `/api/files/:id` count included S2's), so for a series use a short `--settle` and compare only
the route the scenario owns. On 2026-11-01 S1 agreed (9002 `/api/health 200` = 9001 iterations + 1 warm-up) and S4
agreed with its database (599 `/api/uploads 201`, 598 `complete 200`).

Measured on 2026-11-01 (results in `load/results/B-*.json`): with one 50 MP file, `files.attempts` after 0, 3 and 6
re-sends is 1 on one process at concurrency 1, 2 with two processes and 4 with one process at concurrency 4. It counts
the duplicates that start while the first is processing, so it is bounded by the number of job slots, not by the
number of re-sends; a duplicate arriving later is skipped without a start (D76). The repeat killer (one chaos crash,
then four `docker kill`s while siblings were in flight; 8 siblings, concurrency 4) left the killer with 2 attempts and
its siblings with 3 of 5, every file `ready`: siblings do lose starts next to a killer (D64). The chaos crash fires once (D65), so kills 2 to 5 simulate a poison input by hand.

The third behaviour, the worker memory limit under a stream of maximum-size images (D79), is the `stream` phase of S9;
its `local` block holds each replica's cgroup memory peak, restarts and OOMKilled flag. `behaviours.mjs` writes
`load/results/B-<name>-<timestamp>.json` and restores the worker when it ends.

## Layout

```
run.mjs            entry point, guard, sidecar, observer, result merge
lib/               k6 modules: config, guard (also used by run.mjs and the specs), params, scenario, api, upload, ...
scenarios/         s01-health.js ... s15-purge.js
playwright/        s10-landing.spec.ts, s13-flow.spec.ts, result.ts
tools/             fixtures, forward, keys, observe-local, spotcheck, behaviours, tree, pause-watch,
                   bench-* and report (the benchmark workflow, BENCHMARK.md)
test/              node --test (glob): guard, params, tree, pause, bench-plan (the gate), bench-report, bench-publish, bench-workflow
```

Checks: `pnpm exec biome check .`, `node --test load/test/*.test.mjs`, and
`node node_modules/typescript/bin/tsc -p load/playwright --noEmit` from the repository root.

The benchmark workflow (all platforms, three regions, monthly) and its setup are in [BENCHMARK.md](BENCHMARK.md).
