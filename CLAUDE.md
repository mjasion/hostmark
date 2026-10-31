# hostmark

Reference application for benchmarking hosting platforms. Read `docs/spec.md` for what it does and
`docs/decisions.md` for resolved ambiguities. `decisions.md` overrides the spec.

## Rules

- Code and documentation are in English.
- `packages/core` imports nothing platform-specific. Adapters stay thin: if something does not fit a port,
  change the port in core and record it in `docs/decisions.md`.
- Commit directly to `main`.
- No secrets in the repository. List required variables in the adapter README.
- Dependency major versions are recent. Read the types in `node_modules` or current docs rather than relying on
  memory.

## Sandbox notes

- npm cannot write its default cache here. Use `npm_config_cache="$TMPDIR/npm-cache"`.
- pnpm 12 `install` fails: its operation lock dir is hardcoded under `/private/tmp`. Install with pnpm 10 from
  `$TMPDIR/p10` (`npm i pnpm@10` there if missing):
  `npm_config_cache="$TMPDIR/npm-cache" $TMPDIR/p10/node_modules/.bin/pnpm install --config.manage-package-manager-versions=false`.
  Run only one install at a time.
- The pnpm 10 install strips the first YAML document of `pnpm-lock.yaml` whenever the lockfile changes, and the
  Docker build then fails with `ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE`. After changing dependencies,
  regenerate the lockfile with pnpm 12 in a container:
  `docker run --rm -v "$PWD":/repo -w /repo node:22.23.4-slim sh -c 'npm install --global pnpm@12.15.0 >/dev/null 2>&1 && pnpm install --lockfile-only'`.
- Every `docker compose` command that can build needs `BUILDX_CONFIG="$TMPDIR/buildx"`: `build`, and also `up`,
  `run` and the smoke test, because the app services use `pull_policy: build`. Without it they exit 1 with
  `failed to update builder last activity time`, and in the smoke test step 3 fails and takes step 9 with it.
- Running scripts with pnpm 12 works with `pnpm_config_verify_deps_before_run=false` exported.
- `tsx` as a CLI fails on its IPC pipe. Use `node --import tsx <file>`.
- Tests that need Postgres skip unless `DATABASE_URL` is set. Start a throwaway container bound to `127.0.0.1`.
- Port 8080 is in use. Do not touch containers you did not start.
- k6 is not installed on the host; run it from the `grafana/k6` image.
- Git commits are signed through 1Password. `failed to fill whole buffer` means signing is blocked: ask the owner
  to unblock it, then retry. Never bypass signing.
