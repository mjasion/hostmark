# Cloudflare pipeline and per-PR previews (E4)

Scripts and workflows that preview every pull request on Cloudflare and roll `main` out to production in steps.
Decisions: D140 to D148 in `docs/decisions.md`. **Everything here is off until `platforms.json` enables Cloudflare.**
Nothing in this directory has run against GitHub, Cloudflare or Neon: it is written and tested offline.

## Off by default

`.github/workflows/cloudflare-preview.yml`, `cloudflare-preview-cleanup.yml` and `cloudflare-production.yml` are
live on GitHub once pushed. Each starts with a job `gate` (no secret, no environment, `contents: read`) that runs
`gate.mjs` on `platforms.json`; every other job has `needs: gate` and `if: needs.gate.outputs.enabled == 'true'`.

| `platforms.json` entry `cloudflare`                                  | preview                                              | cleanup                   | production                |
| -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------- | ------------------------- |
| `enabled: false` (committed state)                                   | gate only, others skipped                            | gate only, others skipped | gate only, others skipped |
| `enabled: true`, `status: emulated`                                  | runs for trusted same-repo pull requests into `main` | runs                      | gate only, others skipped |
| `enabled: true`, `status: deployed`                                  | runs for trusted same-repo pull requests into `main` | runs                      | runs on push to `main`    |
| entry missing, duplicated, unreadable, `enabled` not the JSON `true` | skipped                                              | skipped                   | skipped                   |

A skipped job never evaluates `environment:`, so no GitHub Environment is created, no secret is read, and no
Cloudflare or Neon call is made. The gate reads the **base** of a pull request, not its head, so a pull request
cannot switch the platform on or change the gate. Both preview workflows trigger only for pull requests **into
`main`** (the base can be any branch, and a branch has its own `platforms.json`). Pull requests from forks are
skipped, and the preview and teardown jobs run only for a pull request whose author association is `OWNER`, `MEMBER`
or `COLLABORATOR`: Dependabot, Renovate and outside contributors get no preview (D145).
`gate.mjs` exits 0 for any decision; only a usage error exits 2 (the outputs then say disabled).

Proven offline: `test/gate.test.mjs` (the decision), `test/workflows.test.mjs` (the workflow rules and the gate run
on disabled, missing, string-valued and fork inputs), `actionlint` 1.7.12 on the three files.

## Security model

- `pull_request`, never `pull_request_target`. A fork pull request gets no secrets from GitHub and is also skipped by
  the gate.
- Top-level `permissions: {}`; each job asks for the least: the gate `contents: read`, the preview jobs
  `contents: read` and `pull-requests: write` (for the comment), production `contents: read`.
- Actions are pinned to full commit SHAs. The tag next to each SHA is a note; the SHAs were taken from the actions'
  release pages. They were checked against the tags later by e3a-platforms (`actions/checkout` v7.0.1, `actions/setup-node`
  v7.1.0; not by me, no network here). Keep them current with Dependabot (`github-actions` ecosystem).
- Nothing a pull request controls (title, branch name, commit message) is placed in a `run:` script: values reach
  scripts through `env:`, and a test fails on `${{ }}` in any `run:`. The pull request number is numeric, the head
  sha is a hash, and `cli.mjs` validates both again. Comment text is rendered from validated shapes only.
- Secrets are set in the `env:` of the single step that needs them. `pnpm install` and `build`, which run the pull
  request's own scripts, get none. The pipeline gives `wrangler` only `CLOUDFLARE_*` and the migration and load run
  none of them (`scrubbed` in `cli.mjs`).
- The cleanup job runs the **base** checkout, so closing a pull request does not run the pull request's code with the
  preview secrets.
- The preview job checks out the base into `trusted/` and the head into `head/`. The pipeline scripts run from
  `trusted/` and are pointed at `head/` through `HOSTMARK_ROOT`, so a pull request that edits `cli.mjs` or another
  script in this directory does not change what those scripts do with the secrets. Install and build of the head
  run in steps with no secret.
- Previews have their own secrets, database branch, queues and bucket. They have no access to the production
  database, queue or bucket by construction: the renderer rewrites queue names, refuses the production bucket and
  service bindings outside the preview set, and the preview environment holds no production value.

### What this does not protect against

- **The preview deploys the pull request's own code with a Cloudflare token.** That is what a preview is, and it
  stays so: `wrangler deploy` uploads the Worker the head built, started through the head's `node_modules`, and that
  Worker (or a changed install script, or a changed workflow file in the branch: GitHub runs the workflow of the merge
  result) can use the token in the preview account. The base checkout, the author check and the `main` filter narrow
  who and what reaches the secrets; they do not make head code harmless. **The real answer is a separate Cloudflare
  account for previews** (D143), so the token can reach nothing but previews. Do not point the preview environment
  at the production account. The steps without secrets are no boundary either: an install script of the head runs on
  the same runner and can change what later steps execute, so treat `NEON_API_KEY`, the `PREVIEW_*` secrets and the
  job's `pull-requests: write` token as reachable by the pull request too.
- **Required reviewers on `cloudflare-preview` are required.** Without them every push of a trusted author deploys
  immediately. With them each run waits for an approval, which is the only point where a person looks at the head
  before it gets a token. Configure them before setting `enabled: true`.
- **Same-account token.** A Cloudflare API token cannot be limited to one Worker, one queue or one R2 bucket by
  name in an account (permission documentation, searched). If previews and production share an account, the
  preview token can reach production resources. Use a **separate Cloudflare account** for previews, or accept this.
- **A missed `closed` event** (workflow disabled, outage) leaves the preview Workers, queues and Hyperdrive until
  they are removed by hand. The Neon branch has a 7-day `expires_at`. No sweep workflow was written.
- **Production migrations must be expand-only.** The previous version serves 100% while the migration runs, and a
  rollback returns to it. Durable Object migrations cannot be part of a gradual deployment.
- **The first production deploy is manual** (`wrangler deploy` by the owner, with the production secrets set by
  `wrangler secret put`). `deployments list` fails for a Worker that does not exist and the rollout then refuses to start.

## Required GitHub configuration

Environments are created by the owner when enabling Cloudflare. Names are exact. `cloudflare-preview` **must have
required reviewers** and, preferably, point at a separate Cloudflare account (see "What this does not protect
against"). `cloudflare-production` should be limited to the `main` branch and have required reviewers.

### Environment `cloudflare-preview`

Used by `cloudflare-preview.yml` and `cloudflare-preview-cleanup.yml`. Credentials for preview resources only.
Required reviewers are mandatory (D145).

| Name                            | Kind     | Meaning                                                                                                                             |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`          | secret   | Token with Workers Scripts edit, Queues edit, Hyperdrive edit (and R2 if you add cleanup). Prefer a separate account.               |
| `CLOUDFLARE_ACCOUNT_ID`         | secret   | Account id of the preview account                                                                                                   |
| `NEON_API_KEY`                  | secret   | Neon API key that can create and delete branches of the project                                                                     |
| `PREVIEW_BETTER_AUTH_SECRET`    | secret   | `BETTER_AUTH_SECRET` of previews. A random value, never the production one                                                          |
| `PREVIEW_R2_ACCESS_KEY_ID`      | secret   | R2 S3 API key limited to the preview bucket                                                                                         |
| `PREVIEW_R2_SECRET_ACCESS_KEY`  | secret   | Its secret                                                                                                                          |
| `NEON_PROJECT_ID`               | variable | Neon project id (`^[a-z0-9-]+$`)                                                                                                    |
| `NEON_PREVIEW_PARENT_BRANCH_ID` | variable | Id (`br-...`) of the branch each preview is copied from. Not the production branch                                                  |
| `NEON_DATABASE`                 | variable | Database name on that branch                                                                                                        |
| `NEON_ROLE`                     | variable | Role name used for the connection strings                                                                                           |
| `PREVIEW_R2_BUCKET`             | variable | Name of the one shared preview bucket. Give it a lifecycle rule that expires objects (about 7 days): the pipeline does not empty it |
| `WORKERS_SUBDOMAIN`             | variable | The account's `workers.dev` subdomain, a plain DNS label. The preview URL is `https://hostmark-api-pr-N.<subdomain>.workers.dev`    |

`GITHUB_TOKEN` is the built-in one; no setup.

### Environment `cloudflare-production`

Used by `cloudflare-production.yml`. Restrict it to the `main` branch and add required reviewers.

| Name                      | Kind     | Meaning                                                                                  |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`    | secret   | Token that can upload and deploy the three Workers                                       |
| `CLOUDFLARE_ACCOUNT_ID`   | secret   | Account id of the production account                                                     |
| `PRODUCTION_DATABASE_URL` | secret   | Direct (not pooled) Postgres URL used only by the migration step                         |
| `LOAD_API_KEY`            | secret   | API key of the production app for the post-deploy load run (`API_KEY` of `load/run.mjs`) |
| `PRODUCTION_URL`          | variable | `https://` origin of production, no path                                                 |

Worker secrets (`BETTER_AUTH_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) of the production Workers are set
once by the owner with `wrangler secret put` and survive `versions upload` and deployments. They are not in GitHub.

`cloudflare-production.yml` is the only way to deploy Cloudflare. `deploy.yml` (platform opt-in) leaves `cloudflare`
out on purpose (D123): its choice does not offer it and `all` skips it, because a direct deploy would bypass the
gradual rollout and the automatic rollback. The `CLOUDFLARE_*` secrets are read here, from the
`cloudflare-production` environment, not by `deploy.yml`.

## What a preview does

On `opened`, `synchronize`, `reopened` of a trusted same-repo pull request into `main`, in this order (`cli.mjs provision`):

1. Neon: find or create branch `preview/pr-N` of `NEON_PREVIEW_PARENT_BRANCH_ID` with `expires_at` = now + 7 days
   and a read-write endpoint; fetch a direct and a pooled connection string, both masked in the log. A partial
   create (a branch without an endpoint) is deleted again.
2. Migrate that branch with `pnpm --filter @hostmark/db run migrate` (`DATABASE_URL` = the direct string).
3. Create queues `image-jobs-pr-N` and `image-jobs-dlq-pr-N` ("already exists" is fine).
4. Create or update Hyperdrive `hostmark-pr-N` on the direct endpoint (Hyperdrive pools by itself).
5. Write `wrangler.api.pr-N.generated.jsonc` and `wrangler.consumer.pr-N.generated.jsonc` (git-ignored) from the
   committed configs: names `hostmark-api-pr-N` and `hostmark-consumer-pr-N`, the Hyperdrive id, the preview
   bucket, `PUBLIC_URL` and `APP_VERSION` = the head sha, the service binding pointed at the preview api,
   `workers_dev: true` on the api; triggers, routes, `env` and `account_id` dropped. Unknown keys are refused.
6. `secrets-file` writes the three Worker secrets from `PREVIEW_*` (mode 600); `wrangler deploy --secrets-file`
   uploads them with the api, then the consumer. The file is removed afterwards.
7. Poll `/api/health` for up to a minute, then comment on the pull request (one comment per pull request,
   found by a marker and by `github-actions[bot]` as author, updated in place). A failure comments `failed`.

On `closed` (`cli.mjs teardown`): delete consumer Worker, api Worker, queues, Hyperdrive, Neon branch, in that
order. "Not found" counts as done; every step runs even if one fails and the job ends red listing what is left.
The scheduler is not previewed.

## What a production run does

On push to `main` (and manual dispatch from `main`), only if the gate says enabled **and** `status` is `deployed`:

1. `verify`: pipeline tests, `pnpm --filter @hostmark/adapter-cloudflare check` and `build`, no secrets.
2. `deploy`: install and build, `node load/tools/fixtures.mjs` (the load scenarios read fixtures it generates; no
   secret), then `cli.mjs snapshot`: the version serving 100% of the api and of the consumer is recorded. If it is
   unclear the job stops here, before anything changed.
3. Migrate the production database (expand-only).
4. For the api, then the consumer (`cli.mjs rollout`):
   1. `wrangler deployments list --json`: the version serving 100% is the rollback target. Not exactly one version at
      100% means refuse and stop; nothing was uploaded.
   2. `wrangler versions upload --tag <sha> --var APP_VERSION:<sha>`; the id comes from the
      `WRANGLER_OUTPUT_FILE_PATH` file (`version-upload` entry). No id means stop.
   3. Api only: probe the candidate at 0%, pinned with `Cloudflare-Workers-Version-Overrides: hostmark-api="<id>"`
      and unpinned. A non-200 or a wrong `x-version` is an error.
   4. `wrangler versions deploy <candidate>@10 <stable>@90 --config ... --yes`, soak 2 minutes, probe, decide; then 50%,
      then 100%.
   5. After 100%: `node load/run.mjs S1,S2 --short` (api) or `S4 --short` (consumer, `--no-probe`) with the guard
      variables set (`BASE_URL`, `API_KEY`, `REGION=cloudflare-global`, `VARIANT=<sha>`, `LOAD_ACK_REMOTE=<host>`).
      This needs Docker for k6, which the runner has.
5. Scheduler: plain `wrangler deploy` (cron triggers have no percentage).
6. Last step, `if: always() && job.status != 'success' && steps.snapshot.outcome == 'success'`: `cli.mjs restore`
   puts the consumer, then the api, back to the recorded versions. See below.

**Rollback decision** (`rollout.mjs`, `decide`): roll back unless the signal is a well-formed
`{ samples, errors, p95Ms }` with at least 20 samples, an error rate of at most 1% and p95 of at most 1500 ms. A missing
signal, a thrown error, a failed upload step or a failed `versions deploy` also roll back. Rollback is
`versions deploy <stable>@100`. If it fails the outcome is `rollback-failed` and the run is red.
`cli.mjs decide --signal-file F` exposes the decision (exit 1 on a missing file).

### Restore after a failed, cancelled or timed-out run (D146)

A rollout rolls itself back on a bad signal, but a failure of the consumer used to leave the api on the new version,
and a cancelled or timed-out job left whatever split it had reached. The final `restore` step covers both: on any
non-success it deploys each recorded version at 100% (consumer first, then api), skips a Worker that already serves it,
tries both even if one fails, and exits 1 if either failed. Consequence: when only the scheduler deploy fails after
both Workers were promoted, the api and the consumer also go back to the previous version. The database stays
migrated, which is why migrations must be expand-only. The scheduler is not restored.

### Manual recovery

If the restore step fails too, or the runner is gone, find the previous versions in the failed run's log (the
`snapshot` step prints `wrangler.api.jsonc: <id> serves 100%`) or with `wrangler deployments list` and
`wrangler versions list`, then from `adapters/cloudflare` with the production token:

```sh
pnpm exec wrangler versions deploy <previous-consumer-id>@100 --config wrangler.consumer.jsonc --yes
pnpm exec wrangler versions deploy <previous-api-id>@100 --config wrangler.api.jsonc --yes
```

`wrangler rollback --config wrangler.api.jsonc` also returns a Worker to its previous deployment. Check
`wrangler deployments list --config <config>` afterwards: exactly one version must hold 100%, or the next rollout
refuses to start.

## Not implemented from the spec

The spec lists "Preview tests: smoke test upload to `ready`, browser test S13" for every preview (L12 of the review,
D148). **They are absent.** A preview run ends with a health poll of `/api/health` and the pull request comment; no
workflow runs a smoke test or a browser test against a preview. Production does run S1, S2 and S4 after the rollout.
Adding the preview tests needs a preview whose consumer and queue work end to end, which was not tried.

## Findings from current documentation and `wrangler --help` (wrangler 4.156.0, read 1 Nov 2026)

Cloudflare (Workers docs, gradual deployments and `wrangler versions`):

- `wrangler versions upload` creates a version that serves no traffic; `--tag`, `--message`, `--var` and
  `--secrets-file` exist on it and on `wrangler deploy` (confirmed by `--help`, offline). `--secrets-file` takes JSON or
  .env, applies additively, and a dotenv file expands variables and can read the process environment: this pipeline
  writes JSON.
- `wrangler versions deploy <id>@<pct> ... --yes --message` splits traffic between up to two versions; percentages sum to 100.
- Version overrides: a request header `Cloudflare-Workers-Version-Overrides: <worker-name>="<version-id>"` routes that
  request to the named version while a gradual deployment is active. The probe uses it. A Worker called through a
  service binding is not overridden by the caller's header (unverified here; the consumer is not probed).
- Gradual deployments cannot include a Durable Object migration,. A change of secrets or variables creates a new version.
- `WRANGLER_OUTPUT_FILE_PATH` makes wrangler append newline-delimited JSON; `version-upload` entries carry `version_id`.
- `wrangler deployments list --json` exists (confirmed by `--help`). The exact output shape is unverified, so
  `activeVersionId` accepts an array or `{ deployments }` and refuses anything with other than one version at 100%.
- Hyperdrive: `wrangler hyperdrive create|update|list|delete`. Hyperdrive pools connections itself, so it is created on
  the direct Neon endpoint, not the pooled one. Both calls pass `--caching-disabled` (D106).
- `wrangler delete --force`, `queues create|delete`: confirmed by `--help`. Wording of "does not exist" messages is
  unverified; the code matches several phrasings and treats anything else as an error.
- A Cloudflare API token cannot be limited to a single Worker or queue by name (permission groups are by account or zone).

Neon (API reference, branching):

- Branches: `POST /projects/{id}/branches` with `branch.name`, `branch.parent_id`, `branch.expires_at` (RFC 3339,
  automatic deletion) and `endpoints: [{type: read_write}]`; `GET /projects/{id}/branches?search=`;
  `DELETE /projects/{id}/branches/{branch}`; `GET /projects/{id}/connection_uri` with `branch_id`, `endpoint_id`,
  `database_name`, `role_name`, `pooled`. A branch with children, or the default branch, cannot be deleted.
  Found through a web search, not read page by page: the details (especially the connection URI endpoint and
  `expires_at`) are **unverified**; `neon.mjs` says so in its header.

GitHub Actions:

- A job skipped by `if:` does not evaluate `environment:` and so does not create or touch the environment.
- `pull_request` from a fork has a read-only token and no secrets; `pull_request_target` would have both and is not used.
- `GITHUB_OUTPUT`, `::add-mask::`, `concurrency` groups, `timeout-minutes` and job-level `permissions` work as used here.
  Concurrency keeps at most one pending run per group; a newer pending run replaces an older pending one.

## Cannot be proven without a real deployment

- The Neon connection-URI and `expires_at` behaviour, branch deletion with a running endpoint.
- The shape of `wrangler deployments list --json`, of `hyperdrive create` and `list` output, and the not-found messages.
- That `wrangler deploy --secrets-file` on a never-deployed Worker creates it and sets the secrets in one step.
- That `wrangler delete --force` does not prompt in CI; that `versions deploy` works with the service binding and
  the `exports` entrypoint; that `x-version` on live traffic equals `APP_VERSION`.
- The workers.dev URL form with a per-account subdomain; that the preview comment is posted by `github-actions[bot]`.
- That `load/run.mjs` S1, S2 and S4 pass against a deployed Worker from a GitHub runner.
- That the `restore` step runs when the job is cancelled or times out (documented GitHub behaviour for `always()`,
  not exercised), and that `wrangler versions deploy <id>@100` is accepted for a version that is not the newest.
- That `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` for the people who should get previews, and
  something else for Renovate and Dependabot, on this repository.
- That the pipeline scripts run from `trusted/` find the head's `adapters/cloudflare` through `HOSTMARK_ROOT` on a
  real runner (proven by a unit test of the path and by reading, not by a run).

First real run: enable Cloudflare with `status: emulated`, open a pull request, check the comment, close it and check
that Neon, the Workers, queues and Hyperdrive are gone. Only then set `status: deployed`.

## Files

| File                        | Role                                                                           |
| --------------------------- | ------------------------------------------------------------------------------ |
| `gate.mjs`                  | Reads `platforms.json`; fail closed; `--require-deployed`, `--same-repo`       |
| `neon.mjs`                  | Neon client with an injected `fetch`; create, find, delete, connection strings |
| `preview-config.mjs`        | Renders per-PR wrangler configs from the committed ones; names; allowlist      |
| `provision.mjs`             | Provision and teardown order, idempotency                                      |
| `comment.mjs`, `github.mjs` | Comment text and its upsert                                                    |
| `probe.mjs`                 | HTTP health probe (error rate, p95) with the version override header           |
| `rollout.mjs`               | Rollback decision, rollout orchestration, wrangler output parsing              |
| `cli.mjs`                   | Entry point used by the workflows; `snapshot`, `restore`, `HOSTMARK_ROOT`      |
| `test/`                     | `pnpm test:pipeline`: fake `fetch`, fake `exec`, no network, no dependency     |
