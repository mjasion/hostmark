# Status and handoff

State on 2026-11-04, for whoever continues the work, including a Claude Code session on the web that sees only this
repository. [`plan.md`](plan.md) has the detail per stage; this file says what is done, what is open and where to look.

## Done

- E0 to E3 on the local compose stack: core, frontend, Better Auth, load tests S1 to S15, the Cloudflare adapter.
- E3a: `platforms.json` opt-in, `pnpm platform`, `deploy.yml` and `ci.yml`.
- E4 and E6 offline: the Cloudflare pipeline with previews, and the multi-region benchmark workflow.
- E5 and E7 offline: adapters for gcp, aws, vercel, railway, fly and vps on a shared `packages/node-runtime`.
- Every platform is `enabled: false` and `status: emulated`. With every platform off, no workflow reaches a secret or
  sends load; the workflows cost Actions minutes only.

Commits: 081b1f0 (E0, E3a), 0837930 (E3, E4), cdc92e1 (E5, E7), 15ad2d6 (E6), 744ec67 (example auth secret refused on
every Node platform, D104).

Last full gate, 2026-11-02, on the tree before 744ec67:

- vitest 878 passed and 26 skipped.
- load 77, platform 13, pipeline 128.
- Playwright 4 of 4 and smoke 15 of 15.
- actionlint 1.7.12 found nothing in 6 workflows, biome reported 0 errors, and the compose build passed with a frozen
  lockfile.

After 744ec67 these ran again and passed:

- vitest, without `DATABASE_URL`: 540 passed and 252 skipped.
- Typecheck of node-runtime, gcp and local.
- biome, GCP `check-config`, the compose build and smoke 15 of 15.

Load, platform and pipeline tests and Playwright were not rerun.

`ci` on GitHub failed on every run up to 7ebab6a: `pnpm install` stopped with `ERR_PNPM_IGNORED_BUILDS`, so lint
and tests never ran there. Fixed by the build script allowlist (D201).

Cloud session, 2026-11-04, on 7ebab6a with every stand-in running (Postgres 17, Redis, MinIO, ElasticMQ, Pub/Sub
emulator): vitest 925 tests, 901 passed and 24 skipped (20 are capability skips of the queue and storage contracts,
4 were `adapters/aws/test/e2e.test.ts`, which ignored `S3_TEST_SECRET_KEY` and is fixed); load 77, platform 13,
pipeline 128; the local and gcp images build with a frozen lockfile.

## Open: owner decisions

- Acceptance criterion 4 on Cloudflare (D103): Workers handle at most 1.5 MP. Only the `jpeg-tiny` fixture passes, so
  S4, S5, S9, S12, S13 and S15 fail and phone photos are refused. The options are in `decisions.md`, Open items.
- Railway: Buckets have no lifecycle rules, so the adapter stores files on R2. Whether to add an app-side expiry sweep
  in core instead is the owner's call (D157).
- Purge items E and F (`plan.md`, E3, "Before any public deployment") need a `purge_pending` marker and a migration
  before any public deployment.

## Open: things only the owner can supply

- Accounts, a domain and deploy consent, given per platform. Billing budgets and alerts on each platform before S5
  and S6 run.
- E6: a self-hosted runner in each of eu, us-east and ap-southeast, or the `github-hosted` fallback. A
  `bench-<platform>` environment limited to `main`, plus `BENCH_RUNNER_MODE` and `BENCH_BUDGETS_CONFIRMED`
  (`load/BENCHMARK.md`).
- E4: required reviewers on the preview environment, and a separate Cloudflare account for previews (D145).
- The secrets each adapter README lists, entered as GitHub Environment secrets.

## Open: engineering

1. Fix the "Open findings from verification" in `plan.md` for a platform before enabling it. They are listed per
   platform (Vercel and the GCP Cloud login); the AWS ones are fixed (D210 to D214), the other GCP ones (D220 to
   D224) and those for all platforms (D205 to D208) too.
2. `deploy.yml` has no cloud login step and no `id-token: write` (D123). Railway, Fly and VPS have no
   `platform-deploy` script.
3. Vercel: prove on the first deployment that a forged POST to `/api/queue` does not reach the handler.
4. E2: rerun everything on a clean, quiet machine (about 47 minutes), then the behaviours and spot-checks under "Not
   verified after E2" in `plan.md`.
5. Preview cleanup for a missed `closed` event: no sweep exists (`adapters/cloudflare/pipeline/README.md`).
6. E8 to E10 need real deployments. The evaluation framework for criteria A, C, D, G and H is not in this repository.

Minor:

- The CLAUDE.md note that the smoke test needs `BUILDX_CONFIG` predates D132; it may be stale.

## Notes for a new session

- The "Sandbox notes" in `CLAUDE.md` describe the owner's Mac (pnpm 10 workaround, port 8080, 1Password signing,
  Chromium). On another machine use pnpm 12 directly. Check whether Docker exists before planning container work.
- Tests that need Postgres skip unless `DATABASE_URL` is set. Several contract tests need MinIO, ElasticMQ or the
  Pub/Sub emulator, and skip without them.
- Verification reports from the earlier sessions were not kept. What they found that is still open is in `plan.md`
  and in each adapter README under the facts that are not proven.
- Do not deploy, run `terraform apply`, create cloud resources or enable a platform in `platforms.json` without the
  owner's consent for that platform. Commit to `main`, and never bypass commit signing.
