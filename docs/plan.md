# Implementation plan

Scope of the current effort is E0 to E3. Stages E4 to E10 stay in [`spec.md`](spec.md) for later.

Each stage is implemented by Sonnet agents, verified by Opus agents, fixed, then committed to `main`.

## E0. Core locally

1. Foundation: workspace, tooling, `packages/contract`, `packages/db`, ports and errors in `packages/core`.
2. In parallel: `packages/image`, `packages/telemetry` and `packages/storage-s3`, core use cases.
3. `adapters/local`: compose stack, BullMQ queue, api, worker and scheduler entrypoints, contract tests.

Done when unit tests pass and a real upload reaches `ready` through the compose stack.

## E1. Frontend locally

`apps/web`, `packages/pages`, Better Auth, SSE, Web Vitals, `/media`.

Done when a browser can sign up, upload, watch status and open a public page on the compose stack.

## E2. Load tests

`load/` with k6 scenarios S1 to S15 and Playwright S10 and S13, writing JSON to `load/results/`.

Done when every scenario runs against the local variant. S7, S12, S14 and S15 can only be partly meaningful
locally; that is recorded per scenario rather than hidden.

## E3. Cloudflare portable

`adapters/cloudflare`, after checking current Cloudflare documentation. Findings go in the adapter README.

Code, emulator tests and deploy instructions are done without an account. The deploy itself waits for the
owner's consent because it needs Cloudflare and Neon accounts and a domain, and it costs money.
