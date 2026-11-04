# adapters/gcp

Portable runtime on Google Cloud: Cloud Run (api and worker as services, scheduled jobs as Cloud Run Jobs), Pub/Sub,
Cloud Storage, a global external Application Load Balancer with Cloud CDN, Secret Manager, Terraform. This is the
`gcp-portable` platform. Postgres is the shared database of the portable variants (D70), not Cloud SQL.
Status: `emulated` (no deployment has been made; nothing here has touched a Google Cloud project).

Decisions: D180 to D189 and D200 in `docs/decisions.md`.

## What runs where

| Part                | Google Cloud                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| api + web build     | Cloud Run service `hostmark-api`, ingress only from the load balancer, `run.app` URL disabled    |
| worker              | Cloud Run service `hostmark-worker`, instance-based billing, fixed 2 instances, concurrency 1    |
| scheduler           | Cloud Scheduler, three jobs, each runs the Cloud Run Job `hostmark-<name>` (`dist/run-job.js`)   |
| queue               | Pub/Sub topic `image-jobs`, subscription `image-jobs-worker`, dead letter topic `image-jobs-dlq` |
| storage             | Cloud Storage bucket over the XML API with an HMAC key (SigV4), lifecycle and CORS in Terraform  |
| CDN                 | Cloud CDN on the backend service of the load balancer (serverless NEG), `USE_ORIGIN_HEADERS`     |
| secrets             | Secret Manager: database URL, auth secret, HMAC key id and secret                                |
| migrations and seed | Cloud Run Jobs `hostmark-migrate` and `hostmark-seed` (seed keys from Secret Manager)            |

The code is `src/`: `queue.ts` (publisher), `consumer.ts` (pull consumer), `purge.ts` (Cloud CDN), `runtime.ts`
(wiring), `shutdown.ts` (the SIGTERM budget), and the entrypoints `api.ts`, `worker.ts`, `run-job.ts`, `seed.ts`. The image is built from `Dockerfile` (the local
image with this adapter's name and RUM defaults).

## Documentation findings (checked 2026-11-01)

- Cloud Run worker pools are in Preview, so the worker is a service. Instance-based billing keeps the CPU allocated
  outside requests, which a pull consumer needs. A service autoscales on requests only, so the count is fixed.
- Pub/Sub has no delayed delivery. The ack deadline can be set per message by `ModifyAckDeadline` up to 600 s; that
  is how the D17 backoff (10, 30, 90, 270 s) is applied, and why a delay above 600 s is refused.
- A dead letter policy forwards a message after `max_delivery_attempts` failed deliveries; `deliveryAttempt` is only
  set on subscriptions that have one, and counts are approximate. The Pub/Sub service agent needs publisher on the
  dead letter topic and subscriber on the subscription (both in `infra/main.tf`).
- The minimum ack deadline is 10 s; the subscription uses 60 s (D17).
- Cloud CDN invalidation (`urlMaps.invalidateCache`): one path per request, exact or a prefix ending in `*`; up to
  500 requests a minute; the documentation says it takes effect in about 10 seconds. Not measured here.
- Cloud Run sends SIGTERM to a service instance and SIGKILL 10 s later (checked 2026-11-04 through search results
  quoting the execution environment and billing pages; the container contract page itself could not be fetched from
  the session). The Terraform provider (7.46.2) has no setting for it; `template.timeout` is the request timeout.
- Cloud CDN in `USE_ORIGIN_HEADERS` mode: the expiry comes from `s-maxage`, `max-age` or `Expires`; above 30 days
  (2,592,000 s) it is treated as 30 days by default. `default_ttl`, `max_ttl` and `client_ttl` are refused by the API
  in this mode (the provider strips them on update for that reason, magic-modules #8910). `max_ttl` (up to 31,622,400 s)
  only applies to the other modes.
- A Pub/Sub subscription without `expiration_policy` is deleted after 31 days without activity; `ttl = ""` means never.
- Headers that the load balancer adds as custom request headers overwrite headers of the same name that the client
  sent (D182). `{client_ip_address}` is one of the variables available for them.
- Cloud Storage's XML API accepts SigV4 with an HMAC key (the S3 interoperability path), including presigned URLs.
  Its lifecycle API is Cloud Storage's own format, hence Terraform and no `init-bucket`.

## `clientIpHeader` (D80)

`X-Client-Ip`, set by the backend service as `X-Client-Ip: {client_ip_address}`. The load balancer overwrites a header
of that name on every request, and the api service accepts traffic from the load balancer only (`ingress =
INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, `default_uri_disabled`), so a client cannot choose it. `X-Forwarded-For` is
not used: the load balancer appends to what a client sends. The documentation settles the overwrite rule. That the
value is exactly one valid address on every viewer network (IPv6 clients, proxies) must be tested on a real
deployment. `platform.ts` sets `AUTH_CLIENT_IP_HEADER` to it, and `scripts/check-config.ts` checks the Terraform has it.

## Cache purge (D100)

Unpublishing or deleting a file calls `CachePurger.purge(publicPaths(id))`. The purger sends two invalidations on the
URL map `CDN_URL_MAP`, concurrently: the prefix `/media/<id>/*` for every variant and `/f/<id>`. At the documented 500
requests a minute that is 250 files a minute (four sequential calls allowed 125). `purge` settles after both calls and
rejects when either was refused, failed or ran past its 10 s timeout, so core answers 503 and the caller retries. The
access token comes from the metadata server with a 3 s timeout. The runtime service account has a custom role with
`compute.urlMaps.invalidateCache` only. Propagation time, a successful call against Google and the prefix match are
not measured.

## Bucket lifecycle (D74)

`originals/` and `variants/` expire after 8 days: the `lifecycle_rule` of `google_storage_bucket.media`. CORS for
PUT and GET is in the same resource.

## Worker shutdown

Cloud Run sends SIGKILL 10 s after SIGTERM. On SIGTERM the worker stops pulling (each `Pull` has a 1 s deadline), waits
up to 4 s for a running job, then sets the ack deadline of every message it still holds to 0, so Pub/Sub redelivers it
at once to the other instance instead of after the 60 s ack deadline. A batch that arrives while closing is handed back
the same way. It then closes the clients, the database and telemetry, and exits; if that has not finished 9 s after
SIGTERM it exits with code 1. The redelivery counts as a delivery attempt (`deliveryAttempt` and `files.attempts`), as
a lost lease always did; the job's own process may still run it for the remaining second or two, which the database
claim allows (D17). Measured on the emulator with the built bundle and a `chaos=slow` job: exit 4.0 s after SIGTERM,
the message redelivered with `deliveryAttempt` 2 at the same time.

## Seed

The `hostmark-seed` job runs `src/seed.ts`, not the `packages/db` CLI, which prints the keys it generates (D14). A job's
output goes to Cloud Logging, so the job refuses to run without `SEED_API_KEY` and `SEED_ADMIN_API_KEY`, never
generates a key and prints none. Both come from the Secret Manager secrets `hostmark-seed-api-key` and
`hostmark-seed-admin-api-key`, which `scripts/deploy.sh` fills: with the owner's value when set (a new version, so the
next seed rotates, D75), otherwise with a generated `hm_` key once, when the secret has no version. Read a key with
`gcloud secrets versions access latest --secret hostmark-seed-api-key`.

## Scheduler

Cloud Scheduler fires `cleanup-expired` (`*/15`), `requeue-stuck` (`*/5`) and `daily-stats` (`5 0`) in UTC, each as
one execution of a Cloud Run Job with no retries. The platform owns the schedule, so there is no scheduler replica to
limit; database claims keep an overlapping run safe (D19).

## Deploy

Needs `gcloud` (logged in, `gcloud auth application-default login`), `terraform` (1.6 or later), Docker, pnpm and Node,
and a project with billing. Nothing else is stored on disk; no key file.

```sh
GCP_PROJECT=my-project DOMAIN=bench.example.com \
DATABASE_URL='postgres://...' BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  pnpm --filter @hostmark/adapter-gcp platform-deploy
```

`scripts/deploy.sh` validates the config offline, creates the Artifact Registry repository, builds and pushes the
image, creates the two secrets and stores their values, runs `terraform apply` (it shows the plan and asks), and runs
the migration job. Then point the `A` record of `DOMAIN` at the `lb_ip` output; the managed certificate is issued
after DNS resolves. Seed with `gcloud run jobs execute hostmark-seed --wait` (see Seed). Resources that cost money:
the load balancer forwarding rule, two always-on worker instances, one always-on api instance, Cloud CDN egress,
Pub/Sub and storage. Do not run it without the owner's decision to deploy this platform.

## Required variables

| Variable                                   | Where                       | Meaning                                                                  |
| ------------------------------------------ | --------------------------- | ------------------------------------------------------------------------ |
| `GCP_PROJECT`                              | deploy, services            | Project id                                                               |
| `DOMAIN`                                   | deploy                      | Host name of the load balancer; becomes `PUBLIC_URL`                     |
| `DATABASE_URL`                             | deploy, then Secret Manager | Shared Postgres                                                          |
| `BETTER_AUTH_SECRET`                       | deploy, then Secret Manager | 32+ characters                                                           |
| `SEED_API_KEY`, `SEED_ADMIN_API_KEY`       | deploy (optional), then SM  | Seed keys (D14); generated by `deploy.sh` when unset and never printed   |
| `REGION`, `REPO`, `APP_VERSION`            | deploy (optional)           | Default `europe-west3`, `hostmark`, short git hash                       |
| `PUBSUB_TOPIC`, `PUBSUB_SUBSCRIPTION`      | services (set by Terraform) | Default `image-jobs`, `image-jobs-worker`                                |
| `CDN_URL_MAP`                              | services (set by Terraform) | URL map to invalidate; unset means no purge (a deployment without a CDN) |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`    | services (Terraform)        | `https://storage.googleapis.com`, the bucket, `auto`                     |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Secret Manager (Terraform)  | HMAC key of the runtime service account                                  |

The other variables are those of `packages/node-runtime` (`docs`: `WORKER_CONCURRENCY`, `WEB_DIST`, `OTLP_ENDPOINT`,
`AUTH_*`, `QUEUE_BACKOFF_SCALE`) without `REDIS_URL`. Terraform state holds the HMAC secret: keep the state private.

## Tests

```sh
pnpm --filter @hostmark/adapter-gcp typecheck
pnpm --filter @hostmark/adapter-gcp check        # infra/ against the contract constants and the env schema, offline
pnpm --filter @hostmark/adapter-gcp test         # purger, config, queue unit tests; contract suites skip without stand-ins
```

Contract suites need stand-ins in throwaway containers bound to localhost:

```sh
docker run -d --name hm-gcp-pubsub -p 127.0.0.1:55800:8085 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
  gcloud beta emulators pubsub start --project=hostmark-test --host-port=0.0.0.0:8085
docker run -d --name hm-gcp-minio -p 127.0.0.1:55801:9000 -e MINIO_ROOT_USER=hostmark \
  -e MINIO_ROOT_PASSWORD=hostmark-local-secret coollabsio/minio:latest server /data
PUBSUB_EMULATOR_HOST=127.0.0.1:55800 S3_TEST_ENDPOINT=http://127.0.0.1:55801 \
  pnpm --filter @hostmark/adapter-gcp test           # takes about two minutes
```

The queue suite covers delivery, batches above 100, a delayed message, redelivery with the next attempt number, the
backoff, redelivery after the ack deadline and the dead letter topic after five failures. `test/shutdown.test.ts` closes
a consumer with a job running past the grace and checks the next consumer gets it at once with attempt 2, and that a
job ending within the grace is acked. `test/seed.test.ts` needs `DATABASE_URL` (it creates and drops its own database).

## Not proven (needs a real project)

Any deployment; `terraform plan` (`terraform validate` passes in CI, D202); a successful
invalidation, its delay and the `/media/<id>/*` prefix match; the 10 s SIGTERM window on a real instance; presigned
PUT and `Content-Length` binding against Google; the load balancer header on a real request; the real Pub/Sub ack
deadline, `ModifyAckDeadline` and `deliveryAttempt`; the managed certificate; prices; the longest event loop block at the
smallest instance (not measured).

## Cache behaviour to check on a real deployment

Cloud CDN does not cache a response with `Set-Cookie`, nor a request with `Authorization` unless the response's
`Cache-Control` allows it, and a `Vary` outside its supported set can suppress caching. In `USE_ORIGIN_HEADERS` mode the
`Cache-Control` of `/media` and `/f` decides. The effective TTL of `/media` (`max-age=31536000, immutable`, D6) is 30 days
at the edge (the default cap; no TTL can be set in this mode) and one year in a browser, which receives the origin header
unchanged. The edge copy goes on unpublish or delete through the purge (D100); a browser copy cannot be purged, as on
every platform. Eviction before 30 days is possible and not measured. Prices were not retrieved and are not quoted here.
