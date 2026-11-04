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

The client address header is fixed in code to `cf-connecting-ip`, which Cloudflare overwrites on every request
(D80), and `createAuth` validates it at startup. Nothing to configure.

## Deploy (not done; needs consent)

In this order, with `wrangler login` or `CLOUDFLARE_API_TOKEN` in your own shell:

```sh
cd adapters/cloudflare
# 1. Bucket, CORS for the browser upload, and the 8 day expiry (D74)
npx wrangler r2 bucket create hostmark-files
npx wrangler r2 bucket cors set hostmark-files --file r2/cors.json
npx wrangler r2 bucket lifecycle add hostmark-files expire-originals originals/ --expire-days 8
npx wrangler r2 bucket lifecycle add hostmark-files expire-variants variants/ --expire-days 8
# 2. Queues
npx wrangler queues create image-jobs
npx wrangler queues create image-jobs-dlq
# 3. Hyperdrive in front of the Neon database; put the printed id into the three configs.
#    Keep --caching-disabled: Hyperdrive's query cache is not invalidated by writes (D106)
npx wrangler hyperdrive create hostmark --connection-string "$DATABASE_URL" --caching-disabled
# 4. Migrate and seed the database from the repository root (packages/db), with the same DATABASE_URL
# 5. Web assets, then the Workers; the api first, because the others bind to hostmark-api#Media
pnpm build
npx wrangler secret put BETTER_AUTH_SECRET -c wrangler.api.jsonc    # also R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
npx wrangler deploy -c wrangler.api.jsonc
# repeat the secrets for the consumer and the scheduler, then
npx wrangler deploy -c wrangler.consumer.jsonc
npx wrangler deploy -c wrangler.scheduler.jsonc
```

`r2/cors.json` allows `GET` and `PUT` with `Content-Type` from any origin, like the other adapters; narrow `origins`
to `PUBLIC_URL` for a real deployment. The CORS file format is from the R2 documentation; the lifecycle commands
come from `wrangler r2 bucket lifecycle add --help`. None of them was run against R2.

Replace `REPLACE_WITH_ACCOUNT_ID`, the Hyperdrive id and `PUBLIC_URL`. A route or custom domain for the api Worker
is not in the config because it depends on your zone; add `routes` before pointing `PUBLIC_URL` at it.

## Checks without an account

```sh
pnpm check      # parses the three wrangler configs and runs `wrangler deploy --dry-run` on each, offline
pnpm typecheck
pnpm test       # Miniflare/workerd; the smoke test needs DATABASE_URL (a Postgres you started yourself)
pnpm run licenses   # regenerates licenses/THIRD-PARTY-LICENSES.txt
```

`pnpm check` also asserts the carry-over rules: the secrets are not in `vars`, `ENVIRONMENT` is not `local`, the
queue names and retry numbers equal `@hostmark/contract`, the cron triggers equal the scheduler jobs, the consumer has
a dead letter queue and the `MEDIA` binding. This is the deploy-time guard for the purge wiring; at run time
`createWorkersCachePurger` refuses a `MEDIA` binding without a `purge` method (D100).

## What was proven, and how

On `workerd` through Miniflare 4 (the real wrangler dry-run bundles, not test doubles):

- **Queue contract** (`test/queue.test.ts`): delivery, ack, retry with the D17 backoff, the dead letter queue after
  five attempts, and a crash that redelivers. 9 passed, 2 skipped (see D101).
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
decision (`docs/decisions.md`, Open items).

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
- **Telemetry (D102).** There is no OpenTelemetry SDK provider on Workers here: spans and metrics are no-ops, logs
  are JSON lines on `console` and appear in Workers Logs (`observability.enabled`).
- **The dead letter queue has no consumer** in production. Dead letter messages are deleted after four days, so
  inspect them within that time.
- **Before any public deployment** (`docs/plan.md`, E3): the purge rate limit is 5 per minute per account on the Free
  tier, each unpublish costs 1 call and each delete 2, `PATCH` purges even a file that was never public, and
  `delete_file` purges every deleted file, so a burst is throttled and the jobs land in the dead letter queue (E).
  A failed purge in `PATCH` has no durable retry (F); E and F need a `purge_pending` marker and a migration. There is
  no purge route or `PURGE_URL` for S12 and S15, and a zone purge does not affect Workers Caching (C). `?x=1` is
  answered 200 and cached, so a CDN keyed on the exact URL needs care (L). PNG headroom is 50 to 53 MB (JPEG 42 MB at
  1.5 MP), the consumer has no `max_concurrency` and the JavaScript heap is unmeasured (M). Tests run on workerd
  1.20260730.1 while wrangler 4.156 deploys against 1.20261023.1 (J). Rollback and old-version cache entries are
  untested (N).
- **Bundle size.** api 4.7 MiB (1.1 MiB gzip), consumer 4.4 MiB, scheduler 3.0 MiB as `wrangler deploy --dry-run`
  reports them. The paid plan allows 10 MiB compressed, the free plan 3 MiB, so the free plan is not enough for the
  api and the consumer.
- **Miniflare quirks.** The queue consumer option is spelled `maxRetires` in Miniflare. Computed `import()` in a
  dependency breaks its module scan, so `test/miniflare.ts` lists the bundle modules by hand.
- **`test/build.ts` uses the stable Miniflare 4**, pinned; the 5 beta has a different option shape.
