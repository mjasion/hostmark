# hostmark

hostmark is a reference application for benchmarking hosting platforms. It is an image upload and processing
service, deployed identically across platforms so they can be compared on latency, cold starts, queues, CDN
behaviour, CI/CD and maintenance effort.

It is deliberately small, but needs a queue, a database, object storage, cron and CPU work, because those are
what differ between platforms.

## Documentation

- [`docs/spec.md`](docs/spec.md): full specification
- [`docs/decisions.md`](docs/decisions.md): resolved ambiguities and deviations; takes precedence over the spec
- [`docs/plan.md`](docs/plan.md): implementation stages

## Status

Stages E0, E1 and E2 are done: the API, worker, scheduler, public pages and the React panel run locally on a Docker
Compose stack, see [`adapters/local/README.md`](adapters/local/README.md), and `load/` holds the k6 and Playwright
scenarios S1 to S15 against it (`node load/run.mjs all --short`, or `S1 S4 ...` for the full forms; see
[`load/README.md`](load/README.md)). Load results depend on the machine and are not committed. All adapters are still
`emulated`; nothing is deployed. The next stages are in the plan.

## Licence

GPL-3.0. See [`LICENSE`](LICENSE).
