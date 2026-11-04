# pnpm platform

The opt-in registry of D70. `platforms.json` at the repository root lists every platform and whether it may be
deployed; all start disabled.

```
pnpm platform list            # state of every platform
pnpm platform check <name>    # missing secrets and adapter directory; values are never printed
pnpm platform deploy <name>   # refuses unless enabled, adapter present and secrets set
pnpm platform matrix [name] [--exclude <name>]   # GitHub Actions matrix of enabled platforms
```

`deploy` runs `pnpm --dir <adapter> run platform-deploy`, which an adapter provides. Enabling a platform means setting
`enabled` to `true` in `platforms.json`, which is the owner's decision. The deploy workflow
(`.github/workflows/deploy.yml`) is manual and reads its secrets from one GitHub Environment per platform, named as in
`platforms.json`.

**Cloudflare is deployed by `.github/workflows/cloudflare-production.yml` only.** It rolls out in steps and rolls back
by itself; `deploy.yml` leaves Cloudflare out (D123), so a `platform-deploy` script in `adapters/cloudflare` would not
open a second route. `deploy.yml` runs from `main` only, because a branch carries its own `platforms.json`.

**Logins and tools in `deploy.yml`** (D241, D242): AWS and GCP log in with OIDC (`id-token: write` on the deploy
job only); Railway CLI and flyctl are downloaded at a pinned version and checked against a pinned SHA-256; each of
these steps runs only in the job of its platform and after the install. Every adapter except `cloudflare` and `local`
has a `platform-deploy` script. The Railway, Fly and VPS scripts share `exec.mjs` (D240): required variables,
secrets passed as environment or as `0600` files, never as arguments, and output scrubbed line by line.

gcp keeps its Terraform state in `GCP_STATE_BUCKET` and applies without a prompt in CI (D247).

The READMEs of `aws`, `gcp`, `railway`, `fly` and `vps` have a "Deploy from GitHub Actions" section: the environment
secrets, the setup on the platform side and what is not proven.

Tests: `pnpm test:platform`.
