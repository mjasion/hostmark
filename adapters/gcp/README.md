# adapters/gcp

Portable runtime on Google Cloud: Cloud Run (api and worker as services, scheduled jobs as Cloud Run Jobs), Pub/Sub,
Cloud Storage, a global external Application Load Balancer with Cloud CDN, Secret Manager, Terraform. This is the
`gcp-portable` platform. Postgres is the shared database of the portable variants (D70), not Cloud SQL.
Status: `emulated` (no deployment has been made; nothing here has touched a Google Cloud project).

Decisions: D180 to D189 in `docs/decisions.md`.

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
| migrations and seed | Cloud Run Jobs `hostmark-migrate` and `hostmark-seed`                                            |

The code is `src/`: `queue.ts` (publisher), `consumer.ts` (pull consumer), `purge.ts` (Cloud CDN), `runtime.ts`
(wiring), and the entrypoints `api.ts`, `worker.ts`, `run-job.ts`. The image is built from `Dockerfile` (the local
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

Unpublishing or deleting a file calls `CachePurger.purge(publicPaths(id))`, which invalidates `/media/<id>/<size>.webp`
for every size and `/f/<id>` on the URL map `CDN_URL_MAP`. The runtime service account has a custom role with
`compute.urlMaps.invalidateCache` only. A refused call rejects, so core answers 503 and the caller retries.
Propagation time and a successful call against Google are not measured.

## Bucket lifecycle (D74)

`originals/` and `variants/` expire after 8 days: the `lifecycle_rule` of `google_storage_bucket.media`. CORS for
PUT and GET is in the same resource.

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
after DNS resolves. Seed demo data with `gcloud run jobs execute hostmark-seed --wait`. Resources that cost money:
the load balancer forwarding rule, two always-on worker instances, one always-on api instance, Cloud CDN egress,
Pub/Sub and storage. Do not run it without the owner's decision to deploy this platform.

## Required variables

| Variable                                   | Where                       | Meaning                                                                  |
| ------------------------------------------ | --------------------------- | ------------------------------------------------------------------------ |
| `GCP_PROJECT`                              | deploy, services            | Project id                                                               |
| `DOMAIN`                                   | deploy                      | Host name of the load balancer; becomes `PUBLIC_URL`                     |
| `DATABASE_URL`                             | deploy, then Secret Manager | Shared Postgres                                                          |
| `BETTER_AUTH_SECRET`                       | deploy, then Secret Manager | 32+ characters                                                           |
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
backoff, redelivery after the ack deadline and the dead letter topic after five failures.

## Not proven (needs a real project)

Any deployment; `terraform plan` against a real project (`terraform validate` passes in CI, D202); a successful invalidation and its delay; presigned
PUT and `Content-Length` binding against Google; the load balancer header on a real request; the real Pub/Sub ack
deadline, `ModifyAckDeadline` and `deliveryAttempt`; the managed certificate; prices; the longest event loop block at the
smallest instance (not measured).

## Cache behaviour to check on a real deployment

Cloud CDN does not cache a response with `Set-Cookie`, nor a request with `Authorization` unless the response's
`Cache-Control` allows it, and a `Vary` outside its supported set can suppress caching. In `USE_ORIGIN_HEADERS` mode the
`Cache-Control` of `/media` and `/f` decides, but the documentation caps expiry (about 30 days), so a one year
`immutable` will not hold as written; record the effective TTL. Prices were not retrieved and are not quoted here.
