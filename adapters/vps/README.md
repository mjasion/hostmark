# adapters/vps

Portable runtime on one virtual server: Docker Compose with Caddy (TLS and reverse proxy), Redis (BullMQ), MinIO and
the same Node image as `adapters/local`. This is the `vps-portable` platform. Postgres is the shared Neon database of
the portable variants (D71), not a container. Status: `emulated` (no deployment has been made).

The code is the shared runtime in `packages/node-runtime` (D150). This directory holds the entrypoints, the
`Dockerfile` (the local image with another adapter name and RUM defaults), the compose file and the Caddyfile.

## Deploy steps

On a fresh Linux server with Docker and Docker Compose v2, DNS `A`/`AAAA` records for `APP_DOMAIN` and `S3_DOMAIN`,
and ports 80 and 443 open:

```sh
git clone <this repository> && cd hostmark/adapters/vps
cp .env.example .env        # replace every placeholder; .env stays on the server and is gitignored
APP_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build --wait
```

Start order: Redis and MinIO, then `minio-init` (bucket, lifecycle, CORS), `migrate`, `seed`, then `api`, `worker`,
`scheduler`, and Caddy last. Upgrades repeat the same command. The first start asks Let's Encrypt for two
certificates, so the domains must resolve before `up`.

## Required variables (`.env`)

| Variable                                                        | Meaning                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `APP_DOMAIN`, `S3_DOMAIN`                                       | Host names for the app and for presigned S3 URLs                                                             |
| `PUBLIC_URL`                                                    | `https://` plus `APP_DOMAIN`; auth base URL and `/f/:id` links                                               |
| `DATABASE_URL`                                                  | Neon (or any Postgres) connection string                                                                     |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_BUCKET`           | MinIO credentials and bucket name; also used as the S3 credentials                                           |
| `SEED_API_KEY`, `SEED_ADMIN_API_KEY`                            | Seed keys (D14)                                                                                              |
| `BETTER_AUTH_SECRET`                                            | 32+ characters, signs session cookies (D80)                                                                  |
| `VPS_HOST`, `VPS_SSH_USER`, `VPS_SSH_KEY`                       | Pipeline secrets (`platforms.json`): host, SSH user and private key of the machine; no script reads them yet |
| `OTLP_ENDPOINT`, `AUTH_SIGNUP_ENABLED`                          | Optional                                                                                                     |
| `WORKER_REPLICAS` (2), `WORKER_MEM_LIMIT` (`4g`), `APP_VERSION` | Worker processes, memory per process, build stamp                                                            |

`WORKER_CONCURRENCY` is fixed at 1 in the compose file (D97). Nothing in `.env.example` is a secret, and the
repository holds no real values. The runtime variables are those of `adapters/local/README.md`.

## Client address header (D80)

`clientIpHeader` is **`X-Client-Ip`**, fixed in `src/platform.ts` (an `AUTH_CLIENT_IP_HEADER` in the environment is
overwritten). Caddy replaces it on every request with the TCP peer (`header_up X-Client-Ip {remote_host}`), the api
and MinIO publish no port, and Caddy is the only way in. A client-sent `X-Client-Ip` does not survive: this was run
against a Caddy 2.10 container with a spoofed value, and the upstream saw the peer address.

**Cloudflare in front** (spec: optional CDN for the VPS variant): the TCP peer is then a Cloudflare address, so every
visitor would share three sign-ins per 10 s. Change the Caddy line to
`header_up X-Client-Ip {http.request.header.CF-Connecting-IP}` and allow only Cloudflare's address ranges on ports 80
and 443 (firewall), because the header is otherwise client-controlled. Not tested here.

## Bucket lifecycle (D74)

`minio-init` runs `dist/init-bucket.js`, which creates the bucket if it is missing, expires `originals/` and
`variants/` after 8 days and sets CORS (PUT and GET). MinIO answers the per-bucket CORS call with 501; the
server-wide `MINIO_API_CORS_ALLOW_ORIGIN` (set to `PUBLIC_URL`) covers it. With **Cloudflare R2** instead of MinIO:
delete the `minio` service and its `depends_on` entry in `minio-init`, set `S3_ENDPOINT` to the account's R2 endpoint, `S3_PUBLIC_ENDPOINT`
likewise and the key pair, and run `docker compose run --rm minio-init` once. R2 accepts the lifecycle call; this is
unverified here.

## Scheduler

One `scheduler` container (a compose service has one instance unless `deploy.replicas` is set; a test fails if it
is). A second scheduler, on this server or another against the same database, only waits: the one that holds the
Postgres advisory lock runs the jobs (D204). The lock needs a direct or session-mode `DATABASE_URL`.

## Worker sizing

Two worker processes of 4 GiB each are the default and the sustained peak per process is 3.0 to 3.2 GiB (D79), so the
server needs well over 8 GiB of free memory. Hetzner plan names and sizes were not checked; pick a plan by memory
and set `WORKER_MEM_LIMIT` and `WORKER_REPLICAS` to fit. A smaller limit means kernel kills and retries (D63).
Longest event loop block against the 60 s lock: **not measured** (needs a real instance).

## Checked offline

`docker compose config` resolves with the placeholder values, `caddy validate` accepts the Caddyfile (Caddy 2.10
image), and `pnpm --filter @hostmark/adapter-vps test` covers the port contracts, the compose invariants (one
scheduler, worker limits, no published port besides Caddy) and the Dockerfile against the local one.
Queue and storage contracts need stand-ins: `REDIS_TEST_URL=redis://127.0.0.1:<port>` and
`S3_TEST_ENDPOINT=http://127.0.0.1:<port>` (see `adapters/local/README.md`).

## Platform documentation: checked and not checked

Checked (web search results, not the primary pages): nothing specific to VPS beyond the Caddy behaviour above,
which I ran. Not verified against documentation: Caddy `{remote_host}` semantics for IPv6 and for the PROXY
protocol (not used), the Let's Encrypt rate limits for the first start, MinIO image status (the digest is the one
`adapters/local` uses), R2 lifecycle and CORS support, Hetzner sizes and prices, Coolify and Kamal (the spec
mentions both; this adapter uses plain Compose, D155).
