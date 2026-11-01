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

Stages E0 and E1 are done: the API, worker, scheduler, public pages and the React panel run locally on a Docker
Compose stack, see [`adapters/local/README.md`](adapters/local/README.md). Nothing is deployed. The next stages
are in the plan.

## Licence

GPL-3.0. See [`LICENSE`](LICENSE).
