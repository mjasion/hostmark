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
- k6 is not installed on the host; run it from the `grafana/k6` image.
