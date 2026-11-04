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

## Deploy from GitHub Actions

`pnpm platform deploy vps` (D70, D121) runs `scripts/deploy.mjs` (D245). It writes the private key and the pinned
host key to `0600` files in a fresh `0700` directory, packs the checked-out commit with `git archive`, and sends it on
the standard input of one `ssh` call (`-F none`, `BatchMode=yes`, `IdentitiesOnly=yes`,
`StrictHostKeyChecking=yes` against the pinned file only, `GlobalKnownHostsFile=/dev/null`). The server unpacks it
into `~/hostmark/releases/<commit>` and runs, there,
`APP_VERSION=<commit> docker compose --env-file ~/hostmark/.env up -d --build --wait --remove-orphans`, then points
`~/hostmark/current` at it and keeps the three newest releases. The key files are deleted afterwards, also on a
failure. An unknown or changed host key stops the deploy before anything is sent. No server needs access to GitHub,
and the application secrets never leave the server. `--dry-run` prints the commands.

Once, on the server (the steps of "Deploy steps" except the clone):

1. A deploy user, for example `deploy`, in the `docker` group. That group is root-equivalent on the host, so the key
   below is a root key in effect; keep it for this server only.
2. A new key pair without a passphrase (`BatchMode` cannot ask for one), made on your machine:
   `ssh-keygen -t ed25519 -N '' -C hostmark-deploy -f hostmark-deploy`. Append the public key to
   `~deploy/.ssh/authorized_keys` with the `restrict` option (`restrict ssh-ed25519 AAAA... hostmark-deploy`), which
   turns off forwarding and the terminal; the script needs neither.
3. `~deploy/hostmark/.env` (mode `0600`) from `.env.example`, every placeholder replaced. It stays on the server.
4. Docker with Compose v2, `tar` and `gzip`; ports 80 and 443 open; DNS as above.
5. The host key: on your machine `ssh-keyscan -t ed25519 <host>`, and compare its fingerprint
   (`ssh-keygen -lf <file>`) with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the server console. Only
   then use the line.

In GitHub, environment `vps` (deployment branches: `main` only):

| Secret                | Value                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| `VPS_HOST`            | host name or IP address, without user or port (port 22)                     |
| `VPS_SSH_USER`        | the deploy user of step 1                                                   |
| `VPS_SSH_KEY`         | the private key of step 2, the whole file                                   |
| `VPS_SSH_KNOWN_HOSTS` | the checked `ssh-keyscan` line of step 5; its host field must be `VPS_HOST` |

The script refuses a host or user that `ssh` could read as an option, a key that is not a private key, and known
hosts lines without a key. `test/deploy.test.ts` runs it with a fake `git` and `ssh`: the exact options, the remote
script, the archive on standard input, the files' content and modes, their removal on success and failure, and that
no line of the key appears in argv, in the environment of `ssh` or in the output (the fake prints the key).

Not proven (needs a server): the remote script on a real shell and Docker, `--wait` with the one-shot services, the
first start with certificates, the OpenSSH behaviour of the options above (run here only against the fake; no SSH
client or server was available), disk use of old images (`docker image prune` is left to the owner), the deploy time.

## Required variables (`.env`)

| Variable                                                         | Meaning                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `APP_DOMAIN`, `S3_DOMAIN`                                        | Host names for the app and for presigned S3 URLs                   |
| `PUBLIC_URL`                                                     | `https://` plus `APP_DOMAIN`; auth base URL and `/f/:id` links     |
| `DATABASE_URL`                                                   | Neon (or any Postgres) connection string                           |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_BUCKET`            | MinIO credentials and bucket name; also used as the S3 credentials |
| `SEED_API_KEY`, `SEED_ADMIN_API_KEY`                             | Seed keys (D14)                                                    |
| `BETTER_AUTH_SECRET`                                             | 32+ characters, signs session cookies (D80)                        |
| `VPS_HOST`, `VPS_SSH_USER`, `VPS_SSH_KEY`, `VPS_SSH_KNOWN_HOSTS` | Pipeline secrets, not in `.env`: see "Deploy from GitHub Actions"  |
| `OTLP_ENDPOINT`, `AUTH_SIGNUP_ENABLED`                           | Optional                                                           |
| `WORKER_REPLICAS` (2), `WORKER_MEM_LIMIT` (`4g`), `APP_VERSION`  | Worker processes, memory per process, build stamp                  |

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
scheduler, worker limits, no published port besides Caddy), the Dockerfile against the local one and the deploy
script against a fake `git` and `ssh`.
Queue and storage contracts need stand-ins: `REDIS_TEST_URL=redis://127.0.0.1:<port>` and
`S3_TEST_ENDPOINT=http://127.0.0.1:<port>` (see `adapters/local/README.md`).

## Platform documentation: checked and not checked

Checked (web search results, not the primary pages): nothing specific to VPS beyond the Caddy behaviour above,
which I ran. Not verified against documentation: Caddy `{remote_host}` semantics for IPv6 and for the PROXY
protocol (not used), the Let's Encrypt rate limits for the first start, MinIO image status (the digest is the one
`adapters/local` uses), R2 lifecycle and CORS support, Hetzner sizes and prices, Coolify and Kamal (the spec
mentions both; this adapter uses plain Compose, D155).
