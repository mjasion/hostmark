# adapters/aws

Portable runtime on AWS: CloudFront in front of a Lambda function URL (api) and an S3 origin (web app), S3 for files,
SQS with a dead letter queue feeding a Lambda worker, EventBridge Scheduler for the three jobs, and the shared Neon
database (D71). This is the `aws-portable` platform (RUM platform `aws`). Status: `emulated`. Nothing has been
deployed, no AWS account or credential was used, and the `aws` CLI was never run against an account.

The adapter implements the core ports itself (there is no Node server here): `src/queue.ts` (SQS `Queue` plus the
Lambda event handler), `src/purge.ts` (CloudFront `CachePurger`, D100), `src/images.ts` (wasm codecs next to the
bundle), `src/runtime.ts` (wires the ports), the three entrypoints `src/api.ts`, `src/worker.ts`, `src/scheduler.ts`,
and `template.yaml` (CloudFormation, plain YAML, no SAM transform). Storage is `@hostmark/storage-s3` with the
function's role credentials (it gained an optional `sessionToken` for that, D192).

## Layout

| Part      | AWS service                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| edge      | CloudFront: default behavior = S3 origin (web app, OAC), `/api/*` = Lambda URL, `/media/*`, `/f/*` = Lambda URL cached |
| api       | Lambda (nodejs22.x, arm64, 1024 MB, 90 s) behind a function URL, `InvokeMode: RESPONSE_STREAM` (SSE)                   |
| worker    | Lambda (4096 MB, 60 s) from SQS, batch size 1, `ReportBatchItemFailures`, max concurrency 10                           |
| queue     | SQS standard queue, visibility timeout 360 s, redrive to a DLQ after 5 receives                                        |
| scheduler | EventBridge Scheduler: 3 schedules, each invokes the scheduler Lambda with `{"job":"<name>"}`                          |
| files     | one S3 bucket: `originals/`, `variants/` (8 day lifecycle, D74) and `site/` (the web app)                              |
| purge     | CloudFront `CreateInvalidation` (D100)                                                                                 |

## Deploy steps (owner, with an AWS account)

Prerequisites: AWS CLI v2 logged in to the target account, an existing S3 bucket for the packaged Lambda code
(`aws cloudformation package` uploads there), Node 22 and pnpm, the shared Neon `DATABASE_URL`.

```sh
export DATABASE_URL=...  BETTER_AUTH_SECRET=<32+ chars>  ORIGIN_SECRET=<32+ chars, random>
export AWS_REGION=eu-central-1
pnpm --filter @hostmark/adapter-aws platform-deploy -- --stack hostmark --code-bucket <packaging-bucket>
# once, and after schema changes (idempotent):
pnpm --filter @hostmark/adapter-aws prepare-database    # migrations + seed (SEED_API_KEY, SEED_ADMIN_API_KEY optional)
```

`platform-deploy` builds the web app (RUM attributes `aws`, `portable`, `single`, `frankfurt`) and the three Lambda
bundles, packages and deploys the stack twice (see Two passes) with `AppVersion` set, writes the empty
`healthcheck/probe` object (see Deep health check), syncs `apps/web/dist` to `s3://<bucket>/site/` with
`Cache-Control` (hashed `assets/*` immutable, `rum.js` and other unhashed files `public, max-age=300` as in D88, HTML
`max-age=0, must-revalidate`) and invalidates the distribution. The version, which the functions report as
`x-version` and S14 waits for, is `APP_VERSION`, else `git rev-parse --short HEAD` (as `adapters/gcp`), else the first
7 characters of `GITHUB_SHA`; with none of them the script refuses to deploy rather than report `dev`. `--dry-run`
prints every command and runs none of them. Secrets are read from the environment only, written to a `0600` file in a fresh `0700` temporary directory, handed to
`aws cloudformation deploy` as `--parameter-overrides file://<path>` (the CloudFormation-style JSON form that the AWS
CLI `deploy` reference documents) and deleted in a `finally`. They are never in argv, so not in the process list, and
the script prints only the file path. The directory is also removed on SIGINT, SIGTERM and SIGHUP: the commands run
asynchronously so the handler runs at once, passes the signal on to the running `aws` and exits with 128 + the signal
number. `test/deploy.test.ts` runs the script with a fake `aws` on `PATH` and known secret values and asserts they are
in neither stdout, stderr nor the fake's argv, that the file was `0600` in a `0700` directory, and that it is gone
afterwards, also when `aws` fails and when the script gets SIGTERM or SIGINT while `aws` holds the file (the fake
`aws` is gone too). They remain stored as `NoEcho` stack parameters and
in the Lambda configuration (readable by anyone who may call `lambda:GetFunctionConfiguration`); moving them to
Secrets Manager was not done. `prepare-database` prints the generated seed keys once, on purpose (D14), and only when
they were generated. The way in from the repository is `pnpm platform deploy aws` (E3a, D70): it refuses unless `platforms.json` enables
`aws` and sets every secret it names, then runs this package's `platform-deploy` script, which reads `AWS_CODE_BUCKET`
instead of `--code-bucket`. From GitHub Actions, see the next section.

### Deploy from GitHub Actions

`deploy.yml` logs in with OIDC (`aws-actions/configure-aws-credentials` v6.3.0, D241): the job's GitHub token is
exchanged for temporary credentials of `AWS_ROLE_ARN` in `AWS_REGION`; no access key is stored anywhere. The step
runs for `aws` only, after the install, and only the deploy job may request the token. Then
`pnpm platform deploy aws` runs `platform-deploy` with the `aws` CLI of the runner image.

Once, in the AWS account (with your own login):

1. IAM, Identity providers: add the OpenID Connect provider `https://token.actions.githubusercontent.com`, audience
   `sts.amazonaws.com`.
2. A role for the deploy whose trust policy admits this repository's `aws` environment only:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
             "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:environment:aws"
           }
         }
       }
     ]
   }
   ```

   A job that names an environment gets `sub` = `repo:<owner>/<repo>:environment:<name>`, without the branch. The
   branch is limited by the environment: give `aws` the deployment branch rule `main` only (below); `deploy.yml`
   also runs from `main` only.
3. The role's permissions: what `cloudformation deploy` of `template.yaml` needs with `CAPABILITY_IAM` (Lambda, SQS,
   S3, CloudFront, EventBridge Scheduler, IAM roles of the functions), `s3:PutObject` on the code bucket, `s3 sync` to
   the content bucket and `cloudfront:CreateInvalidation`. A least-privilege policy was not worked out; a dedicated
   account for the benchmark keeps the blast radius small.
4. The code bucket (`AWS_CODE_BUCKET`), as in the prerequisites above.

In GitHub, environment `aws` (deployment branches: `main` only):

| Secret               | Value                                              |
| -------------------- | -------------------------------------------------- |
| `AWS_ROLE_ARN`       | ARN of the role of step 2                          |
| `AWS_REGION`         | for example `eu-central-1`                         |
| `AWS_CODE_BUCKET`    | the packaging bucket of step 4                     |
| `DATABASE_URL`       | Neon connection string                             |
| `BETTER_AUTH_SECRET` | 32+ characters                                     |
| `ORIGIN_SECRET`      | 32+ characters, random                             |
| `PUBLIC_URL`         | optional; without it the CloudFront domain is used |

Not proven (needs an account): the trust policy against a real token, the permissions of step 3, a deploy from the
runner (the `aws` CLI version of the image, the two passes, the sync and the invalidation), the session length (one
hour by default) against the deploy time.

Tear down: empty `s3://<bucket>` (versions are not enabled) and `aws cloudformation delete-stack --stack-name hostmark`.
Cost: Lambda, SQS, Scheduler and the first 1000 invalidation paths a month are inside the free tiers; CloudFront data
transfer, S3 storage and CloudFront Functions requests are not free, and a 12 MP-class image worker at 4096 MB costs
real money at load. Each purge costs 4 invalidation paths (CDN purge, below). Nothing was priced against the current price list.

### Two passes

A Lambda environment cannot refer to the CloudFront distribution that refers to the same function (a dependency
cycle). Pass one creates everything with `DistributionId=''` and a placeholder `PublicUrl`; pass two sets both. Until
pass two, purging is off (the IAM statement is conditional on `HasDistribution`) and the api refuses to start outside
`ENVIRONMENT=local` without `CLOUDFRONT_DISTRIBUTION_ID` (a purge that silently does nothing would break D100).

## Required variables

Set by the template into the Lambda environments (`parseVars` in `src/env.ts` validates them at cold start; a missing
one fails the first request with a `ConfigError`, not silently).

| Variable                                                                                    | Source                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                              | CloudFormation parameter (`NoEcho`): Neon connection string                                     |
| `BETTER_AUTH_SECRET`                                                                        | parameter (`NoEcho`), 32+ characters                                                            |
| `ORIGIN_SECRET`                                                                             | parameter (`NoEcho`), 32+ characters; api only. CloudFront sends it, the api refuses without it |
| `PUBLIC_URL`                                                                                | second pass: `https://<distribution domain>`, or `PUBLIC_URL` from the deploy environment       |
| `CLOUDFRONT_DISTRIBUTION_ID`                                                                | second pass, from the stack output                                                              |
| `S3_BUCKET`, `SQS_QUEUE_URL`                                                                | the template                                                                                    |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`             | provided by the Lambda runtime from the function role                                           |
| `ENVIRONMENT`, `APP_VERSION`, `HOSTMARK_REGION`, `HOSTMARK_TOPOLOGY`, `AUTH_SIGNUP_ENABLED` | template parameters (defaults in the template; the deploy script sets `AppVersion`)             |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `SQS_ENDPOINT`, `QUEUE_BACKOFF_SCALE`                  | tests and stand-ins only; never set on AWS                                                      |
| `SEED_API_KEY`, `SEED_ADMIN_API_KEY`                                                        | only for `prepare-database` on the owner's machine                                              |

For the deploy workflow the secret names (`platforms.json` and `deploy.yml` agree) are `AWS_ROLE_ARN`, `AWS_REGION`,
`AWS_CODE_BUCKET`, `DATABASE_URL`, `BETTER_AUTH_SECRET` and `ORIGIN_SECRET`. Nothing secret is in the repository.

## Client address and forwarded host (D80, D51)

`clientIpHeader` is **`x-hostmark-client-ip`**, set by a CloudFront **viewer-request Function** (`ApiViewerFunction`
in the template, attached to `/api/*`, the only behavior that forwards viewer headers to the Lambda URL) from
`event.viewer.ip`, overwriting whatever the client sent. The same function sets `x-forwarded-host` from the viewer's
`Host` (and drops a client value when there is no `Host`): the origin request policy `AllViewerExceptHostHeader`
replaces `Host` with the function URL, and the cookie CSRF check of D51 compares `Origin` with the first
`x-forwarded-host` entry or `Host`, so without it every cookie mutation answered 403. This is the pattern of the AWS
knowledge center article on forwarding the host header under another name. `test/e2e.test.ts` signs up and uploads
with a session cookie through the function output, Host set to a function URL: 201, and 403 without the function. Reasoning: the api is only reachable through CloudFront (origin secret, below), so the function runs
on every request that gets past the secret check and the value cannot come from the client. `X-Forwarded-For` is not
usable (CloudFront appends to a client-supplied value), and `CloudFront-Viewer-Address` carries `ip:port`, which fails
D80's single-address check. The function output is run in `node:vm` by the template test (client value replaced,
IPv6 kept as is). Whether `event.viewer.ip` is the real client address behind every kind of viewer network was read
from the CloudFront Functions event structure documentation and **not tested on a real distribution**: after the first
deploy, `curl -H 'x-hostmark-client-ip: 6.6.6.6' https://<domain>/api/auth/get-session` repeatedly must be rate limited
by your own address, not 6.6.6.6.

### Why not OAC on the function URL

CloudFront origin access control for Lambda URLs signs requests, but POST and PUT then need the client to send
`x-amz-content-sha256`, which a browser does not. The function URL is therefore `AuthType: NONE` and protected by the
origin custom header `x-hostmark-origin-secret`; the api answers 403 without it (constant-time compare, `src/app.ts`).
Anyone who learns the function URL and the secret can bypass CloudFront, so rotate `OriginSecret` by redeploying with
a new value (both sides update in one stack update). The 403 and the 200 with the secret were run against the built
bundle with a stubbed `awslambda` global.

## Queue (D17)

SQS has no per-message delay on retry. The worker (`handleSqsEvent` in `src/queue.ts`) reads
`ApproximateReceiveCount` as the attempt, and for a failing job calls `ChangeMessageVisibility` with the D17 backoff
(10, 30, 90, 270 s) and returns the message in `batchItemFailures`. On the last attempt (5) it sets the visibility to 0
and reports the failure, so the redrive policy (`maxReceiveCount: 5`) moves the message to the DLQ. `crash()` (chaos)
throws out of the handler: the invocation fails, the message comes back only after the queue visibility timeout of
**360 s** (6 times the worker timeout, the AWS recommendation). That is the crash recovery latency on this platform,
about 6 minutes; it is long compared with the other platforms and should be named in any comparison.

`send` with a delay above 900 s throws (the SQS limit). The event source mapping uses batch size 1, so one slow job
cannot hold others, and `MaximumConcurrency` 10 bounds the Neon connections (each environment holds one).

## CDN purge (D100)

`src/purge.ts` implements `CachePurger` with `cloudfront:CreateInvalidation` (client in `us-east-1`, the CloudFront
control plane region). It sends the exact paths core hands over (`publicPaths`: `/media/<id>/128.webp`, `512.webp`,
`1600.webp` and `/f/<id>`), never a wildcard. CloudFront allows 15 wildcard paths in progress per distribution but
3000 exact paths, independently; with one wildcard per file, the 16th unpublish or delete within the propagation time
failed. Exact paths are complete because `/media` and `/f` cache only those URLs (any other spelling is a `no-store`
404, D107) and the cache key has no query string. A burst of about 750 purges within the propagation time still fails
with `TooManyInvalidationsInProgress`: the error is thrown, so `PATCH` answers 503 (the row is already private; the
same `PATCH` retries) and `delete_file` retries with the D17 backoff, then dead-letters. `test/units.test.ts` runs 700
concurrent purges against a model of the two quotas and expects all to pass, and the 751st to throw. Invalidation
takes seconds to minutes to propagate and **was not measured**; the first 1000 paths a month are free and each purge
now costs 4 paths instead of 2. The IAM role allows only `CreateInvalidation` on this distribution.

## Deep health check

`/api/health/deep` sends `HEAD healthcheck/probe` (core). Without `s3:ListBucket`, S3 answers 403, not 404, for a
missing key, and core reports 403 as storage down. The api role may therefore `s3:GetObject` that one key, and the
deploy script writes it as an empty object (`aws s3api put-object`) after the second pass; it has no lifecycle rule.
`scripts/template-check.ts` reads the key from `packages/core/src/http/app.ts` and fails when the api role cannot read
it, and `test/deploy.test.ts` checks that the script writes the same key. The worker and scheduler serve no health
route and get nothing. The 403 for a missing key without `s3:ListBucket` is from the `HeadObject` reference, not
tested (MinIO runs as root).

## Bucket lifecycle (D74)

In the template (`Bucket`): `originals/` and `variants/` expire after 8 days, `site/` never. The bucket also has CORS
(GET and PUT, `Content-Type`), SSE-S3 and a TLS-only policy. The CloudFront OAC can read `site/*` only; `/media` and
`/f` go through the api (which signs or streams), never straight from S3. The template test asserts the 8 day rules;
S3 lifecycle semantics were not tested (MinIO does not run the template).

## Scheduler

EventBridge Scheduler fires each schedule once per tick (`cron(*/15 * * * ? *)`, `cron(*/5 * * * ? *)`,
`cron(5 0 * * ? *)` for the three jobs of `SCHEDULER_JOBS`), `MaximumRetryAttempts: 0`, so there is no replica rule to
enforce: a platform cron replaces the in-process scheduler (D19). A tick can in principle be delivered twice by AWS;
the jobs are idempotent and `protect` guards the rest. The template test compares the schedules with
`SCHEDULER_JOBS`.

## Images

The wasm codecs are copied by `build.mjs` to `dist/<fn>/wasm/` and compiled with `WebAssembly.compile` at cold start
(cached per container). The worker has 4096 MB and the default 50 MP pixel limit (D31): D79 measured 3.0 to 3.2 GiB
per process at concurrency 1, and 4096 MB (Lambda's MB are MiB) is the 4 GiB of `mem_limit: 4g` and of the other
platforms, so the margin is the same 0.8 GiB. `WorkerMemory` has a `MinValue` of 4096; a smaller budget needs a lower
pixel limit instead. More memory also buys CPU (one vCPU at 1769 MB), so a job may also finish faster than at 3008 MB (not measured). A memory peak above the Lambda
memory ends the invocation (the job is retried and finally dead-lettered): **not measured on Lambda**; it was run only
in Node against the same codecs.

## AWS documentation: what was checked

Checked in the AWS documentation (search and read, not an account): Lambda with SQS (batch item failures, scaling and
maximum concurrency, visibility timeout of at least 6 times the function timeout), SQS redrive and
`ChangeMessageVisibility`, Lambda function URLs (response streaming, invoke mode, auth types), CloudFront origin custom
headers, CloudFront Functions (viewer request event, `cloudfront-js-2.0`), CloudFront invalidation pricing and
wildcard paths, EventBridge Scheduler cron and flexible time windows, S3 lifecycle and CORS. Not checked against the
current pages: the exact Lambda quotas (memory and timeout above), CloudFront price classes and prices, Lambda
streamed response size limits beyond the documented 20 MB soft limit, and every CloudFormation property name against
the resource reference. `cfn-lint` and `aws cloudformation validate-template` were **not run** (the second needs an
account). The template is validated by `scripts/template-check.ts` only: references, parameter names, contract values.

Hono's `hono/aws-lambda` `streamHandle` is used; it is marked deprecated in 4.13 in favour of `@hono/aws-lambda`
(D191 records the choice; switching changes only `src/api.ts`).

## Tests on stand-ins

```sh
docker run -d --name hm-aws-minio -p 127.0.0.1:55810:9000 -e MINIO_ROOT_USER=hostmark -e MINIO_ROOT_PASSWORD=hostmark-aws-secret cgr.dev/chainguard/minio:latest server /data
docker run -d --name hm-aws-elasticmq -p 127.0.0.1:55811:9324 -v "$PWD/elasticmq.conf:/opt/elasticmq.conf" softwaremill/elasticmq-native:1.6.11
docker run -d --name hm-aws-pg -p 127.0.0.1:55812:5432 -e POSTGRES_USER=hostmark -e POSTGRES_PASSWORD=hostmark -e POSTGRES_DB=hostmark postgres:17-alpine
SQS_TEST_ENDPOINT=http://127.0.0.1:55811 S3_TEST_ENDPOINT=http://127.0.0.1:55810 S3_TEST_SECRET_KEY=hostmark-aws-secret \
  DATABASE_URL=postgres://hostmark:hostmark@127.0.0.1:55812/hostmark pnpm --filter @hostmark/adapter-aws test
```

`elasticmq.conf` is:
`include classpath("application.conf")`, `node-address { protocol = http, host = "127.0.0.1", port = 55811, context-path = "" }`
(the published host port), `rest-sqs { enabled = true, bind-port = 9324, bind-hostname = "0.0.0.0", sqs-limits = strict }`
and `queues {}`; the tests create their queues. MinIO and ElasticMQ run as `hm-aws-minio` and `hm-aws-elasticmq` on
ports 55810 and 55811, Postgres as `hm-aws-pg` on 55812, all bound to 127.0.0.1. Without the endpoints the stand-in suites skip; the unit, template and image
contract tests always run.

What runs:

- the core queue contract (`packages/core/test/contract/queue.ts`: send, delay, visibility timeout, retry with backoff,
  dead letter after 5 attempts) against ElasticMQ, through `startEventSourceMapping` in `test/esm.ts`, a small poller
  that does what the Lambda event source mapping does (receive, build an `SQSEvent`, call the real `handler`, delete
  what succeeded). The backoff is scaled by `QUEUE_BACKOFF_SCALE=0.1` and the queue visibility timeout is 5 s there.
  The contract alone passes without `ChangeMessageVisibility` (a retry after the queue timeout is still a retry).
- `test/visibility.test.ts` against ElasticMQ: with a 30 s queue visibility timeout and a 1 s scaled backoff, attempt
  2 must arrive within 10 s, and after attempt 5 the message must reach the dead letter queue within 10 s. Both fail
  when the `ChangeMessageVisibility` call is removed (checked by removing it).
- the core storage contract against MinIO with `@hostmark/storage-s3` (path-style, static credentials).
- `test/e2e.test.ts`: the real api app and the real worker handler on Postgres, MinIO and ElasticMQ: upload to `ready`,
  purge on unpublish and delete, 403 without the origin secret, an undecodable image ending `failed`.
- unit tests for env parsing, the origin secret, the purge paths and the in-progress quotas, the SQS adapter (batch
  failure, visibility calls) and the scheduler event; `template.test.ts` for the template and the CloudFront
  functions; `deploy.test.ts` for the deploy script with a fake `aws`.

## Not proven (needs a real deployment)

Everything that depends on AWS itself: real `ApproximateReceiveCount` and redrive timing, the Lambda event source
mapping (ElasticMQ plus a poller stands in), `ChangeMessageVisibility` on a message at its last receive, function URL
streaming and the 6 MB / 20 MB payload limits through CloudFront, the viewer-request function, `event.viewer.ip` and
the `Host` it sees (so the cookie path), the origin secret header through CloudFront, the IAM grant for the health
probe and the 200 of `/api/health/deep`, the invalidation quotas, OAC reads of `site/*`, invalidation propagation time and
the CloudFormation template itself (never deployed or linted by AWS). Cold start, memory peak of a 50 MP image on
Lambda, p95 latencies and costs: **not measured**.
