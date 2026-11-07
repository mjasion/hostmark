# hostmark on Cloudflare (portable)

The portable variant runs the shared core (`packages/core`) on Workers with the Cloudflare services that replace
the self-run parts of `adapters/local`: R2 for objects, Queues for jobs, Cron Triggers for the scheduler and
Hyperdrive in front of the shared Neon Postgres (D71). The image work is the same WebAssembly codec as everywhere
(`@hostmark/image`), in the Worker.

Status: **emulated**. Everything below was run on `workerd` through Miniflare and with `wrangler` offline. Nothing
was deployed, no account was used. Deploying needs the owner's consent (Cloudflare and Neon accounts, a domain, it
costs money). `platforms.json` keeps `cloudflare` disabled.

## Layout

| Worker               | Config                     | Entry              | Role                                                                                                                                                         |
| -------------------- | -------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hostmark-api`       | `wrangler.api.jsonc`       | `src/api.ts`       | REST API, Better Auth, SSE, `/media`, `/f`, the web app as static assets (D88). Also exports the `Media` entrypoint that owns the cache and its purge (D100) |
| `hostmark-consumer`  | `wrangler.consumer.jsonc`  | `src/consumer.ts`  | Queue consumer for `image-jobs`, dead letters to `image-jobs-dlq`; reaches the purge through the `MEDIA` service binding                                     |
| `hostmark-scheduler` | `wrangler.scheduler.jsonc` | `src/scheduler.ts` | Cron triggers for the periodic jobs (D19)                                                                                                                    |

Each Worker builds its dependencies per request (`src/runtime.ts`): a Hyperdrive-backed `postgres` client that is
closed when the response ends, the R2 storage (`src/storage.ts`), the queue (`src/queue.ts`) and the purger.

## Variables and secrets

Set in the `vars` block of each `wrangler.*.jsonc` unless marked as a secret. Secrets are never in the repository;
set them on **all three** Workers.

| Name                                            | Kind   | Notes                                                                                                                            |
| ----------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT`                                   | var    | `production` (default when missing). `local` switches off the checks below and is refused in a deployable config by `pnpm check` |
| `PUBLIC_URL`                                    | var    | Origin of the deployment, also the auth base URL                                                                                 |
| `AUTH_TRUSTED_ORIGINS`                          | var    | Comma separated, optional                                                                                                        |
| `AUTH_SIGNUP_ENABLED`                           | var    | `true` or `false`                                                                                                                |
| `HOSTMARK_TOPOLOGY`, `HOSTMARK_REGION`          | var    | Optional, for the RUM attributes (D85)                                                                                           |
| `R2_ACCOUNT_ID`                                 | var    | Account id; the host of presigned URLs is `<id>.r2.cloudflarestorage.com`                                                        |
| `R2_BUCKET_NAME`                                | var    | Must equal the bucket of the `BUCKET` binding (`pnpm check` compares them)                                                       |
| `BETTER_AUTH_SECRET`                            | secret | 32 characters or more; the `.env.example` value is refused unless `ENVIRONMENT=local`                                            |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`      | secret | An R2 API token (S3 compatible, object read and write on the bucket). Used only to presign                                       |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secret | Pipeline only (`platforms.json`, `cloudflare-production.yml`): upload and deploy the Workers. Not a Worker secret                |

Bindings: `HYPERDRIVE` (id from `wrangler hyperdrive create`), `BUCKET` (R2), `QUEUE` (producer of `image-jobs`),
`MEDIA` (service binding `hostmark-api#Media`, consumer and scheduler only), `ASSETS` (api only).

The committed configs carry placeholders: `REPLACE_WITH_ACCOUNT_ID`, the all-zero Hyperdrive id and
`https://hostmark.example.com`. `pnpm check` accepts them (it runs offline on the committed files); `pnpm check --deploy`,
the production pipeline and the bootstrap refuse them (D255). Put your account id and `PUBLIC_URL` into the three files
and commit them (they are not secrets); the bootstrap writes the Hyperdrive id.

The client address header is fixed in code to `cf-connecting-ip`, which Cloudflare overwrites on every request
(D80), and `createAuth` validates it at startup. Nothing to configure.

## Deploy (not done; needs consent)

Needs the **Workers Paid** plan: on Free a request gets 10 ms of CPU (the image work needs seconds), and a queue keeps
messages 24 hours at most. The first deploy is one command from a clean clone (acceptance criterion 1, D256); later
releases go through `cloudflare-production.yml` with the gradual rollout (D142), which needs this first deploy.

```sh
pnpm install
# The values below in your own shell; nothing is written to disk except the Hyperdrive id (step 3)
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
export DATABASE_URL=...            # direct (unpooled) Neon endpoint: migrations, seed and Hyperdrive
export BETTER_AUTH_SECRET=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
pnpm --filter @hostmark/adapter-cloudflare bootstrap          # --dry-run prints the commands and runs none
```

`scripts/bootstrap.mjs` refuses to start while a variable or an owner value in the configs is missing, then:

1. creates the bucket, sets CORS from `r2/cors.json` with `origins` narrowed to the origin of `PUBLIC_URL`, and adds
   the 8 day expiry of `originals/` and `variants/` (D74);
2. creates `image-jobs` and `image-jobs-dlq` with `--message-retention-period-secs 1209600` (14 days, the maximum;
   an existing dead letter queue is updated to it);
3. creates the Hyperdrive config `hostmark` with `--caching-disabled` (D106) and writes its id into the three configs:
   **commit them**, the production pipeline deploys the committed files;
4. runs `pnpm check --deploy`, then migrates and seeds the database (a generated `SEED_API_KEY` is printed once);
5. builds the web assets, and for the api, the consumer and the scheduler, in that order (the others bind to
   `hostmark-api#Media`): `wrangler secret bulk` with the three secrets as JSON on standard input (a Worker that does
   not exist yet is created as a draft by it), then `wrangler deploy --var APP_VERSION:<sha>`;
6. runs `wrangler triggers deploy` for the scheduler.

A step that reports "already exists" counts as done, so a rerun after a failure continues. A rerun after the
pipeline has taken over redeploys every Worker at 100%; use the pipeline instead. Secrets reach wrangler only on
standard input, and the output is scrubbed of them, with one exception: `wrangler hyperdrive create` takes the
database origin only as arguments, so `DATABASE_URL` is in the process list for the life of that command (masked in
the output). Run the bootstrap on a machine you alone use. Not run against an account; tested with a fake wrangler
(`test/bootstrap.test.ts`). The CORS format is from the R2 documentation; the lifecycle, queue, Hyperdrive, secret and
trigger flags were read in the wrangler 4.157 source.

A route or custom domain for the api Worker is not in the config because it depends on your zone; add `routes`
before pointing `PUBLIC_URL` at it.

## Checks without an account

```sh
pnpm check      # parses the three wrangler configs and runs `wrangler deploy --dry-run` on each, offline
pnpm check --deploy   # the same, and refuses the committed placeholders (the production pipeline runs this)
pnpm typecheck
pnpm test       # Miniflare/workerd; the smoke test needs DATABASE_URL (a Postgres you started yourself)
pnpm run licenses   # regenerates licenses/THIRD-PARTY-LICENSES.txt
```

`pnpm check` also asserts the carry-over rules: the secrets are not in `vars`, `ENVIRONMENT` is not `local`, the
queue names and retry numbers equal `@hostmark/contract`, the cron triggers equal the scheduler jobs, the consumer has
a dead letter queue and the `MEDIA` binding, the Media cache is shared across versions (D252) and automatic traces
are on (D254). This is the deploy-time guard for the purge wiring; at run time
`createWorkersCachePurger` refuses a `MEDIA` binding without a `purge` method (D100).

## What was proven, and how

On `workerd` through Miniflare 4 (the real wrangler dry-run bundles, not test doubles):

- **Queue contract** (`test/queue.test.ts`): delivery, ack, retry with the D17 backoff, the dead letter queue after
  five attempts, a crash that redelivers, and `ping` through the binding's `metrics()` (D253). 10 passed, 2 skipped
  (see D101). The failing `ping` is tested with a fake binding (`test/consume.test.ts`).
- **Storage contract** (`test/storage.test.ts`): R2 binding reads and writes. Presigned URLs are served by a small
  S3 shim in front of the same bucket, because Miniflare does not serve presigned R2 URLs; the capabilities that need
  real R2 are off in the contract and show as skips.
- **Image contract** (`test/image.test.ts`): the wasm codecs through static imports inside workerd, and the pixel
  limit (D103).
- **End to end** (`test/smoke.test.ts`): the real `api` and `consumer` bundles with Hyperdrive to a Postgres, R2 and
  the queue. Presigned upload to `ready` with three variants, a junk image that ends `failed` at once because the
  failure is permanent (no retries), the fail-closed purge, and `/THIRD-PARTY-LICENSES.txt` served by the api.
- **`consumeBatch`** (`test/consume.test.ts`): ack, retry with the backoff, and the `chaos=crash` signal leaving the
  invocation without touching the message.
- **Configuration** (`test/env.test.ts`): the example secret is refused outside `local`, a missing `MEDIA` binding is
  refused by `createWorkersCachePurger`, a bad `clientIpHeader` is refused at startup.
- **Static asset headers** (`test/headers.test.ts`): the generated `_headers` served by workerd's asset server, one
  `Cache-Control` per file (D251), and the security headers of D310 once each: the common set and HSTS on every file,
  the HTML set on the prerendered pages only (D315). The panel shell gets its HTML set from the Worker
  (`test/smoke.test.ts`). `pnpm build` runs `node --import tsx scripts/build.mjs`; the pages' policy names the R2
  origin from `R2_ACCOUNT_ID`, `R2_BUCKET_NAME` and `R2_PUBLIC_ENDPOINT` of the environment, else of
  `wrangler.api.jsonc`. Keep the zone's own HSTS setting off: the Worker and `_headers` send it already (D311).
- **Trace id on cached paths** (`test/http.test.ts`): the gateway gives `/media` and `/f` responses their own
  `x-trace-id` (D257).
- **Deploy guards** (`test/check-config.test.ts`, `test/bootstrap.test.ts`): `check --deploy` refuses the
  placeholders; the bootstrap's commands, order, stdin secrets and refusals against a fake wrangler.
- The scheduler bundle is built and checked by `pnpm check` (cron triggers, `MEDIA` binding), but **no test runs it**.
- The licence texts (Apache-2.0, BSD-3-Clause) are in the bundle; the wasm modules are static imports and are
  emitted as separate modules.

## Image size limit on Workers (D103)

`src/limits.ts` sets `WORKERS_MAX_PIXELS = 1_500_000`. It was measured, not assumed, and it is **much lower than the
12 to 16 MP of the plan**. Method: `scripts/measure-pixels.mjs` starts a fresh Miniflare per image size, feeds a JPEG
of that size through the real bundle, and reads the size of every WebAssembly memory the codecs hold afterwards (wasm
memory only grows, so this is the high-water mark the isolate keeps) and the `VmRSS` of the workerd process, inside a
Linux container.

| Megapixels | Wasm memory |     | Megapixels | Wasm memory |
| ---------- | ----------- | --- | ---------- | ----------- |
| 0.25       | 13 MB       |     | 2          | 106 MB      |
| 0.5        | 19 MB       |     | 4          | 157 MB      |
| 1          | 31 MB       |     | 8          | 250 MB      |
| 1.5        | 42 MB       |     | 12         | 340 MB      |
| 1.9        | 51 MB       |     | 25         | 621 MB      |

About 23 bytes of wasm memory per pixel (decode, three resizes and encodes), with a step of about 50 MB between 1.9
and 2 MP. The 4000x3000 fixture of the load tests (12 MP) therefore needs 340 MB of wasm memory against the 128 MB
that an isolate gets. **Local workerd does not enforce the 128 MB limit**, so what happens above the limit in
production was not observed; the 1.5 MP value is derived from the numbers above (wasm under 45 MB plus the
JavaScript heap, with room for garbage in a warm isolate), not proven. Consequence for the benchmark: the portable
Cloudflare variant refuses the standard 12 MP image with `InvalidImageError`, which is not a comparable result. The
way out is a different image path, not a higher limit (E4 and the Cloudflare variants of the plan).

**Only `jpeg-tiny` passes on this variant.** `jpeg-1mb` (4000x3000), `png-10mb` (3.33 MP), `jpeg-50mp`, `png16-49mp`,
`webp-49mp` and `png-tall-49mp` are refused. Scenarios S4, S5, S9, S12, S13 and S15 therefore fail or cannot set up
(S4 fails `upload_ok`, S5 fails `drained`, S9 refuses every upload, S12 and S15 throw in setup because
`seedPublicFile` uses `jpeg-1mb`, S13 cannot reach ready). S1, S2, S3, S6, S7, S8, S10, S11 and S14 use no large
fixture. **Acceptance criterion 4 is not met by the portable variant**, and ordinary phone photos are refused while
`MAX_UPLOAD_BYTES` stays 10 MB. The fixtures are not shrunk and there is no per-platform override; this is an owner
decision (`docs/decisions.md`, Open items). The one exception is the production pipeline's consumer check: it runs
S4 `--short` with `UPLOAD_FIXTURE=jpeg-tiny.jpg`, a reduced run that proves the queue path works and is never a
benchmark result (D250).

To repeat the measurement: run `pnpm test` (it builds `.build/test/image-service`), copy that directory to
`.build/measure/bundle`, write the JPEGs with `pnpm measure:pixels`, and run `scripts/measure-pixels.mjs` as described
in its header (a `node:22` container with `miniflare` installed in the mounted directory).

## Findings and limits

- **No visibility timeout (D101).** Queues push consumers have none. The queue contract tests for visibility
  timeout are a visible skip for this adapter. Retry with backoff and the dead letter queue are tested. A handler
  that exceeds the invocation limit is cancelled and retried, which is the nearest equivalent.
- **The purge was not proven to work, only to fail closed (D100).** Local workerd has no Workers Caching: `ctx.cache`
  is undefined. The test proves that unpublish answers 503 and leaves the file private when the purge cannot run,
  and that a Worker without the `MEDIA` binding refuses to start. That `cache.purge({ pathPrefixes })` empties
  `/media` and `/f` on Cloudflare is **not measured; it needs a real account**. Until it is, do not run this
  deployment as a public shared one.
- **Presigned PUT.** How real R2 treats a presigned PUT whose length or content type differs from the signed one is
  not measured (the shim is not R2). Presigned URLs work only on `<account>.r2.cloudflarestorage.com`.
- **`HEAD` on a missing bucket** (R2, and S3 in `adapters/aws`): not measured. The documentation search was
  inconclusive and nothing may be called against R2 without an account.
- **Event loop block at the smallest instance** against the 60 s lock (D97): not measured. It needs a real
  deployment. The consumer sets `limits.cpu_ms` to 300000; whether that is accepted and enough is also unmeasured.
- **Rate limiter.** Better Auth's sign-in limiter counts in memory per isolate, so on Workers it limits per isolate
  and not per client globally (D80). Moving it to a shared store is not done.
- **Telemetry (D102, D254). Acceptance criterion 3 is not met and not proven.** There is no OpenTelemetry SDK
  provider on Workers here: the app's own spans and metrics are no-ops, logs are JSON lines on `console` and appear in
  Workers Logs. `observability.traces.enabled` turns on Cloudflare's automatic traces (handler, fetch, bindings, and
  service binding calls, which Cloudflare joins into one trace), which can be exported over OTLP by adding the name of
  a destination created in the dashboard to `observability.traces.destinations` in each config. Whether the queue
  hop from `POST /api/uploads/:id/complete` to the consumer's `process_image` lands in the same trace is not
  documented and not measured; the app's `traceparent` in the job message is not read by Cloudflare's tracing. The
  app's spans are not bridged to `cloudflare:workers` `tracing`, because nothing offline can show the result.
- **The dead letter queue has no consumer** in production. The bootstrap creates it with a retention of 14 days (the
  Queues default is 4); inspect dead letters within that time.
- **`x-trace-id` on `/media` and `/f` (D257).** Workers Caching stores a whole response and replays it without
  running the Worker, so the gateway gives every response of these paths a new trace id. On a hit that id belongs to
  no trace; on a miss it is not the id of the Media entrypoint's request. `no-store` responses (errors) keep theirs.
- **CPU limits.** The api sets no `limits.cpu_ms`, so it gets the Workers Paid default of 30 s per request, the same
  as the 30000 ms cap of `/api/debug/cpu` (D11): a call at the cap plus the request's own work can exceed it and end
  in Cloudflare's error 1102 instead of the app's answer. Raise the api's `cpu_ms` if that scenario is run at the
  cap. The consumer sets 300000 (the maximum); the scheduler keeps the default, which is 30 s for cron triggers.
- **Before any public deployment** (`docs/plan.md`, E3): the purge rate limit is 5 per minute per account (Workers
  Caching always gets the Free tier purge limits, whatever the plan), each unpublish costs 1 call and each delete 2,
  `PATCH` purges even a file that was never public, and `delete_file` purges every deleted file, so a burst is
  throttled and the jobs land in the dead letter queue (E). A failed purge in `PATCH` has no durable retry (F); E and
  F need a `purge_pending` marker and a migration. S12 and S15 purge through `POST /api/debug/purge/{id}` (D206),
  which calls the Media entrypoint's own purge, so `PURGE_URL` works here (C, the route half); a zone purge would not
  touch Workers Caching. S12 and S15 still cannot set up on this variant because their seed image is refused (D103).
  `?x=1` is answered 200 and cached, so a CDN keyed on the exact URL needs care (L). PNG headroom is 50 to 53 MB (JPEG
  42 MB at 1.5 MP), the consumer has no `max_concurrency` and the JavaScript heap is unmeasured (M). Tests run on
  workerd 1.20260730.1 (Miniflare 4.20260730.0, the newest 4.x, D248) while wrangler 4.157 deploys against
  1.20261103.1 (J). With `cross_version_cache` (D252) every version of the api reads and purges one cache, so a
  rollback serves the entries a newer version wrote until they are purged or expire; `/media` bodies do not depend on
  the version, but this is untested on Cloudflare (N).
- **Bundle size.** api 4.7 MiB (1.1 MiB gzip), consumer 4.4 MiB, scheduler 3.0 MiB as `wrangler deploy --dry-run`
  reports them. Since 2026-09-04 the only limit is 64 MiB uncompressed on every plan (there is no compressed limit
  any more), so size is no reason for a plan. Workers Paid is needed anyway, for CPU time (above) and queue
  retention.
- **Miniflare quirks.** The queue consumer option is spelled `maxRetires` in Miniflare. Computed `import()` in a
  dependency breaks its module scan, so `test/miniflare.ts` lists the bundle modules by hand.
- **`test/build.ts` uses the stable Miniflare 4**, pinned; the 5 beta has a different option shape.
