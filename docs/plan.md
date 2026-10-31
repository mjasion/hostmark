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

## E2. Load tests

`load/` with k6 scenarios S1 to S15 and Playwright S10 and S13, writing JSON to `load/results/`.

Done when every scenario runs against the local variant. S7, S12, S14 and S15 can only be partly meaningful
locally; that is recorded per scenario rather than hidden.

Results must account for three behaviours found in the E0 review: the worker memory limit under a sustained
stream of maximum-size images (D79), `files.attempts` over-counting after an abandoned send, and a repeat killer
using up an innocent sibling's attempts (D64).

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

Each adapter owns the bucket lifecycle rule from D74. Database claims keep overlapping scheduler runs safe (D19,
D56, D67), but `protect: true` only stops overlap inside one process, so a platform that runs two scheduler
replicas does each run twice. Run one replica or the platform's own cron, or add a Postgres advisory lock.
