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

- Cloud session of 2026-11-04 (pull request "Offline engineering items", one commit per item): CI installs again
  (D201), Terraform validated in CI (D202), the smoke test refuses a stale image (D203), a leader lock for the
  scheduler (D204), the open findings of AWS, GCP, Vercel and all platforms (D205 to D208, D210 to D214, D220 to
  D224, D230 to D234), the GCP runtime on the shared one (D185), OIDC logins and deploy scripts for every Node
  platform (D240 to D245, D247), every dependency updated and `pnpm audit` clean (D248, D249).
- Second part of that pull request, after a compliance review of every adapter against the spec and the platforms'
  documentation: forged deliveries refused on the Vercel queue route (D235), a keepalive on quiet event streams
  (D236), and the review's findings fixed for Cloudflare (D250 to D258), AWS (D260 to D269), Vercel (D270 to D279),
  Railway, Fly and VPS (D280 to D289) and GCP (D290 to D299). The panel's known gaps from E1 are fixed, with
  `robots.txt`, `noindex` on share pages, English dates and a favicon (D300 to D304).

Commits: 081b1f0 (E0, E3a), 0837930 (E3, E4), cdc92e1 (E5, E7), 15ad2d6 (E6), 744ec67 (example auth secret refused on
every Node platform, D104), then the pull request above (merged in 763365d).

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

Cloud session, 2026-11-04, at the start, on 7ebab6a with every stand-in running (Postgres 17, Redis, MinIO,
ElasticMQ, Pub/Sub emulator): vitest 925 tests, 901 passed and 24 skipped (20 capability skips of the queue and
storage contracts, 4 in `adapters/aws/test/e2e.test.ts`, which ignored `S3_TEST_SECRET_KEY` and is fixed).

Last full gate, same session, on 46af7fe (the last commit of the pull request), with every stand-in running:

- vitest 1199 tests: 1175 passed and 24 skipped (capability skips of the queue and storage contracts).
- load 78, platform 24, pipeline 133; typecheck; biome without errors or warnings; actionlint 1.7.12 clean.
- `terraform validate` and `fmt -check` of `adapters/gcp/infra`; `pnpm check` of aws, gcp, vercel and cloudflare.
- A clean `pnpm install --frozen-lockfile`; the local image builds; `pnpm audit` found nothing at D249.
- Smoke 16 of 16 on the compose stack, including the trace from `complete` to the worker; Playwright 4 of 4 in
  `mcr.microsoft.com/playwright:v1.64.1-noble` with `--network host`. Earlier in the session a second scheduler
  replica waited and took over 5 s after the leader stopped (D204).
- Not run: the load scenarios (E2), and anything against a cloud account.
- `ci` on GitHub green on every commit of the pull request after the first.

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
- The secrets each adapter README lists, entered as GitHub Environment secrets. New since the first part:
  `GCP_STATE_BUCKET` (a versioned bucket made by hand, D247), `SEED_API_KEY` and `SEED_ADMIN_API_KEY` for Vercel
  (D277), and optional OTLP endpoints and headers on AWS (D261), GCP (D290) and Vercel (D274).
- Vercel: Function CPU "Performance" (4 GB) on Pro for a measured deployment (D271).

## Open: engineering

1. Fix the "Open findings from verification" in `plan.md` for a platform before enabling it. They are listed per
   platform. All are fixed (AWS D210 to D214, GCP D220 to D224, Vercel D230 to D235, all platforms D205 to D208);
   what each fix could not prove without an account is in its decision.
2. The OIDC logins of AWS and GCP and the deploy scripts of Railway, Fly and VPS exist (D240 to D245, D247) but
   have not run against an account. Before the first dispatch the owner creates what the "Deploy from GitHub
   Actions" section of each adapter README lists.
3. Vercel: on the first deployment, check that a real push passes the lease check of D235 and a forged POST to
   `/api/queue` gets 403.
4. E2: rerun everything on a clean, quiet machine (about 47 minutes), then the behaviours and spot-checks under "Not
   verified after E2" in `plan.md`.
5. Preview cleanup for a missed `closed` event: no sweep exists (`adapters/cloudflare/pipeline/README.md`).
6. E8 to E10 need real deployments. The evaluation framework for criteria A, C, D, G and H is not in this repository.
7. Security response headers. Only `/f/:id` sends `Content-Security-Policy` (with `frame-ancestors 'none'`),
   `X-Content-Type-Options` and `Referrer-Policy` (D89, `packages/core/src/http/public.ts`). The panel and the
   prerendered pages, the JSON API, `/media`, `/rum.js` and the static assets send none, on every platform, and no
   decision covers them. The static files are served by each platform (Node static handler, Workers assets, Vercel,
   S3 behind CloudFront), so headers need a place in core and one per platform. A proposed approach is in the
   pull request of 2026-11-04; nothing is implemented. Owner's decision: HSTS `max-age=31536000` without
   `includeSubDomains` and without preload.
8. The known gaps after E1 are fixed (D302 to D304). Results must still account for the three behaviours of the E0
   review: worker memory under a sustained stream (D79), `files.attempts` over-counting after an abandoned send, and
   a repeat killer using up a sibling's attempts (D64).
9. Later after E2 (`plan.md`, E2): D79 still quotes concurrency 4 with a margin of about 300 MB (it was about
   400 MiB, and 3.7 GB was 3.6 GiB); D97 says a second process "doubles" throughput (it is 1.93 times, and the memory
   saved against concurrency 4 is small); `BASE_URL=http://[::1]:...` fails in setup with exit 107 because the
   sidecar listens on 127.0.0.1 only; a loopback `BASE_URL` on a port other than 58080 or 59000 has no route on the
   compose network and the result would still say `compose-network`.
10. Not verified after E2 (`plan.md`, E2): `pauseWatch.stop()` below `await deployDone` under a real pause; S5
    `drained` on a real partial failure; a real clamshell sleep with the current watcher; who holds the 5-tuple in
    Docker Desktop (D99), the cause of the S6 seed PUT timeout, the lower worker memory of the first full run and the
    one 238 ms S4 maximum; the full forms of S1 to S3, S6 to S8 and S10 to S14 on the new route. Item 4 covers the
    rerun.
11. Before any public deployment (`plan.md`, E3; E and F are under owner decisions):
    - C. A zone purge does not affect Workers Caching, and that `cache.purge` empties it is not proven. The purge
      route of S12 and S15 exists since D206 (`POST /api/debug/purge/{id}` with an admin key).
    - L. `?x=1` answers 200 and is cached as its own entry; an exact-URL CDN needs care.
    - M. PNG headroom on Workers is 50 to 53 MB (JPEG 42 MB at 1.5 MP); the consumer has no `max_concurrency`; the
      JavaScript heap is not measured.
    - J. Tests run on workerd 1.20260730.1 (miniflare 4, the newest stable), wrangler 4.157 deploys against
      1.20261103.1 (D248).
    - N. Rollback and old-version cache entries are untested.

12. Cloudflare does not meet acceptance criterion 3: Cloudflare's automatic traces are on, but the app's spans are
    not exported from Workers, so there is no single trace from `complete` to `process_image` (D254). AWS (D261),
    GCP (D290) and Vercel (D274) export OTLP when an endpoint is set; none of them has run on a platform.

Minor:

- The CLAUDE.md note that the smoke test needs `BUILDX_CONFIG` predates D132; it may be stale.

## Notes for a new session

- The "Sandbox notes" in `CLAUDE.md` describe the owner's Mac (pnpm 10 workaround, port 8080, 1Password signing,
  Chromium). On another machine use pnpm 12 directly; "Cloud session notes" in `CLAUDE.md` say how the stand-ins and
  image builds run in a cloud session. Check whether Docker exists before planning container work.
- Tests that need Postgres skip unless `DATABASE_URL` is set. Several contract tests need MinIO, ElasticMQ or the
  Pub/Sub emulator, and skip without them.
- Verification reports from the earlier sessions were not kept. What they found that is still open is in `plan.md`
  and in each adapter README under the facts that are not proven.
- Do not deploy, run `terraform apply`, create cloud resources or enable a platform in `platforms.json` without the
  owner's consent for that platform. On the owner's Mac commit to `main`; in a cloud session push to a branch and
  open a pull request. Never bypass commit signing.
- Parallel agents in git worktrees: `git stash` is shared by every worktree of a clone, so an agent must never
  `stash pop` without naming its own entry. Each worktree holds a full `node_modules` (about 1 GB); remove merged
  worktrees, and prune Docker build cache, before the disk fills. A full disk once stopped Tempo in the `lgtm`
  container from storing traces until it was restarted, which looked like a telemetry regression in the smoke test.
