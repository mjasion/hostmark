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

Start order: Redis and MinIO, then `minio-user` (the app's MinIO user), `minio-init` (bucket, lifecycle, CORS),
`migrate`, `seed`, then `api`, `worker`, `scheduler`, and Caddy last. Upgrades repeat the same command. The first start asks Let's Encrypt for two
certificates, so the domains must resolve before `up`.

## Deploy from GitHub Actions

`pnpm platform deploy vps` (D70, D121) runs `scripts/deploy.mjs` (D245). It writes the private key and the pinned
host key to `0600` files in a fresh `0700` directory, packs the checked-out commit with `git archive`, and sends it on
the standard input of one `ssh` call (`-F none`, `BatchMode=yes`, `IdentitiesOnly=yes`,
`StrictHostKeyChecking=yes` against the pinned file only, `GlobalKnownHostsFile=/dev/null`). The server unpacks it
into `~/hostmark/releases/<commit>` and, there:

1. copies the release's Caddyfile over `~/hostmark/Caddyfile` in place, the one path Caddy mounts for every release
   (`CADDYFILE`), so a deploy does not recreate the Caddy container (D285);
2. runs `docker compose --env-file ~/hostmark/.env up -d --build --wait --wait-timeout 600 --remove-orphans` with
   `APP_VERSION` set to 12 characters of the commit; a one-shot job or health check that takes longer than 600 s
   fails the deploy instead of hanging it (D286);
3. reloads Caddy (`caddy reload`, a no-op when the Caddyfile did not change);
4. points `~/hostmark/current` at the release, keeps the three newest releases and removes the `hostmark-vps:*`
   images of the others (D289); an image that a container still uses is kept with a note.

While `api` is replaced, Caddy retries the connection for up to 15 s (`lb_try_duration`) instead of answering 502
(D286); the single api container still restarts, so a deploy is a short pause, not zero downtime. The key files are
deleted afterwards, also on a failure. An unknown or changed host key stops the deploy before anything is sent. No server needs access to GitHub,
and the application secrets never leave the server. `--dry-run` prints the commands.

Once, on the server (the steps of "Deploy steps" except the clone):

1. A deploy user, for example `deploy`, in the `docker` group. That group is root-equivalent on the host, so the key
   below is a root key in effect; keep it for this server only.
2. A new key pair without a passphrase (`BatchMode` cannot ask for one), made on your machine:
   `ssh-keygen -t ed25519 -N '' -C hostmark-deploy -f hostmark-deploy`. Append the public key to
   `~deploy/.ssh/authorized_keys` with the `restrict` option (`restrict ssh-ed25519 AAAA... hostmark-deploy`), which
   turns off forwarding and the terminal; the script needs neither.
3. `~deploy/hostmark/.env` (mode `0600`) from `.env.example`, every placeholder replaced. It stays on the server.
4. Docker with a Compose v2 that has `up --wait-timeout`, `tar` and `gzip`; ports 80 and 443 open; DNS as above.
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
no line of the key appears in argv, in the environment of `ssh` or in the output (the fake prints the key). The remote
script itself runs in `sh` against a real archive and a fake `docker`: the compose and reload commands, the
`CADDYFILE` path, the Caddyfile rewritten in place (same inode), three releases kept, the images of the others
removed and those of the kept ones left, and no `current` link when compose fails.

Not proven (needs a server): the remote script with a real Docker (`--wait` and `--wait-timeout` with the one-shot
services, that Compose keeps the Caddy container across releases, `caddy reload` through `compose exec`, the length
of the pause while `api` is replaced), the first start with certificates, the OpenSSH behaviour of the options above
(run here only against the fake; no SSH client or server was available), the deploy time. Build cache and dangling
layers are not pruned (`docker builder prune` is left to the owner).

## Required variables (`.env`)

| Variable                                                         | Meaning                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `APP_DOMAIN`, `S3_DOMAIN`                                        | Host names for the app and for presigned S3 URLs                  |
| `PUBLIC_URL`                                                     | `https://` plus `APP_DOMAIN`; auth base URL and `/f/:id` links    |
| `DATABASE_URL`                                                   | Neon (or any Postgres) connection string                          |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_BUCKET`            | MinIO root pair (init jobs only) and bucket name                  |
| `MINIO_APP_USER`, `MINIO_APP_PASSWORD`                           | The app's MinIO user, limited to `S3_BUCKET` (D287)               |
| `SEED_API_KEY`, `SEED_ADMIN_API_KEY`                             | Seed keys (D14)                                                   |
| `BETTER_AUTH_SECRET`                                             | 32+ characters, signs session cookies (D80)                       |
| `VPS_HOST`, `VPS_SSH_USER`, `VPS_SSH_KEY`, `VPS_SSH_KNOWN_HOSTS` | Pipeline secrets, not in `.env`: see "Deploy from GitHub Actions" |
| `OTLP_ENDPOINT`, `AUTH_SIGNUP_ENABLED`                           | Optional                                                          |
| `WORKER_REPLICAS` (2), `WORKER_MEM_LIMIT` (`4g`), `APP_VERSION`  | Worker processes, memory per process, build stamp                 |

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

## Security headers (D310)

The app sends them, HSTS included because `PUBLIC_URL` is https (D311). The Caddyfile adds no response header, so
nothing is sent twice; a test keeps it that way. Answers Caddy makes itself (a 502 after the retry window) carry none.

## MinIO users (D287)

The app does not sign with the MinIO root pair. `minio-user` (the MinIO image, which ships `mc`) creates the policy
`hostmark-app` (get, put and delete objects of `S3_BUCKET`, list it, read its location) and the user
`MINIO_APP_USER` with it; `api`, `worker`, `scheduler`, `migrate` and `seed` get that pair. Only `minio-user` and
`minio-init` (create the bucket, set lifecycle and CORS) get the root pair. A leaked app key or a compromised app
container can then read and delete the benchmark's objects, but cannot create or remove buckets, change the
lifecycle or CORS, reach another bucket or administer MinIO. The job runs on every `up` and is idempotent; a new
`MINIO_APP_PASSWORD` in `.env` rotates the password on the next deploy. Checked against a MinIO container of the
pinned image: the job twice in a row, `init-bucket` with the root pair, then put, head (also of a missing key), get,
a presigned PUT and delete with the app pair, and 403 for the app pair on creating another bucket, setting or
reading the lifecycle and deleting the bucket.

## MinIO image

`minio` uses Chainguard's MinIO build, pinned by digest (the one `adapters/local` uses); MinIO's own community
builds became source-only in 2025 (recalled, not re-checked). **Check before enabling this platform** that Chainguard still builds and patches the
image, and move the digest to a current build (the same in both compose files); if it is no longer maintained, use R2
(below) or another S3 server. The digest was not re-checked for this change (D288).

## Bucket lifecycle (D74)

`minio-init` runs `dist/init-bucket.js`, which creates the bucket if it is missing, expires `originals/` and
`variants/` after 8 days and sets CORS (PUT and GET). MinIO answers the per-bucket CORS call with 501; the
server-wide `MINIO_API_CORS_ALLOW_ORIGIN` (set to `PUBLIC_URL`) covers it. With **Cloudflare R2** instead of MinIO:
delete the `minio` and `minio-user` services and the `depends_on` entry of `minio-init`, set `S3_ENDPOINT` to the
account's R2 endpoint and `S3_PUBLIC_ENDPOINT` likewise, give the app an R2 token limited to the bucket (Object Read
& Write) as `MINIO_APP_USER` and `MINIO_APP_PASSWORD` and `minio-init` an admin token as the root pair, and run
`docker compose run --rm minio-init` once. R2 accepts the lifecycle call; this is unverified here.

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
scheduler, worker limits, no published port besides Caddy, the app's MinIO user and the root pair only for the init
jobs, the Caddyfile mount), the Caddy retry settings, the Dockerfile against the local one and the deploy script
against a fake `git`, `ssh` and `docker`.
Queue and storage contracts need stand-ins: `REDIS_TEST_URL=redis://127.0.0.1:<port>` and
`S3_TEST_ENDPOINT=http://127.0.0.1:<port>` (see `adapters/local/README.md`).

## Platform documentation: checked and not checked

Checked (web search results, not the primary pages): nothing specific to VPS beyond the Caddy behaviour above,
which I ran. Not verified against documentation: Caddy `{remote_host}` semantics for IPv6 and for the PROXY
protocol (not used), the Let's Encrypt rate limits for the first start, MinIO image status (see "MinIO image"), R2
lifecycle and CORS support, Hetzner sizes and prices, Coolify and Kamal (the spec
mentions both; this adapter uses plain Compose, D155).
