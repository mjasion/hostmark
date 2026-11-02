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

**Not wired in `deploy.yml` yet:** a cloud login step and `id-token: write` (nothing assumes `AWS_ROLE_ARN`, and
`adapters/gcp/scripts/deploy.sh` needs Application Default Credentials), and a `platform-deploy` script in every adapter
except `aws` and `gcp`. A dispatch for such a platform ends in a failed job and deploys nothing.

Tests: `pnpm test:platform`.
