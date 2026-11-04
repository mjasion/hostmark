#!/usr/bin/env bash
# One-command deploy of the Cloud Run adapter. NOT run by any agent or test: it creates billable resources in the project
# of the person who runs it, with their credentials. Read adapters/gcp/README.md first.
#
#   GCP_PROJECT=my-project DOMAIN=bench.example.com \
#   DATABASE_URL=postgres://... BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
#   bash adapters/gcp/scripts/deploy.sh
#
# SEED_API_KEY and SEED_ADMIN_API_KEY are optional: a value that is set is stored when it differs from the latest version
# of its secret; an unset one is generated here, once, when its secret has no version yet. No key is printed; read one
# with `gcloud secrets versions access latest --secret hostmark-seed-api-key`.
#
# AUTH_SIGNUP_ENABLED, optional, `false` by default: D7 keeps signup off on a deployment unless a run needs it. Scenario
# S13 signs up, so a run that includes it deploys with AUTH_SIGNUP_ENABLED=true (D291).
#
# OTLP_ENDPOINT, optional: the OTLP/HTTP base URL telemetry is exported to; unset, nothing is exported. OTLP_HEADERS,
# optional: the collector's headers (`Authorization=Basic%20...`, the OTEL_EXPORTER_OTLP_HEADERS format), stored in
# Secret Manager and never passed as a plain variable (D290).
#
# Every secret is written only when its value changed, and the older versions are then disabled, so exactly one version
# is enabled. The services read `latest` when an instance starts: a new value reaches them with the next revision (each
# deploy of a new commit makes one) or the next instance start (D299).
#
# GCP_STATE_BUCKET, optional on a workstation and required in CI: an existing Cloud Storage bucket that keeps the
# Terraform state (prefix hostmark/gcp) instead of the local file. In CI (`CI=true`, as GitHub Actions sets it) the
# apply runs without asking; the workflow's environment is the approval (D247).
#
# Needs: gcloud (logged in, `gcloud auth application-default login` done), terraform, docker, pnpm, node.
set -euo pipefail

: "${GCP_PROJECT:?GCP_PROJECT is required}"
: "${DOMAIN:?DOMAIN is required (the host name of the load balancer)}"
: "${DATABASE_URL:?DATABASE_URL is required (the shared Postgres, D70)}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET is required (32+ characters)}"
if [ "${CI:-}" = true ] && [ -z "${GCP_STATE_BUCKET:-}" ]; then
  echo "GCP_STATE_BUCKET is required in CI: the Terraform state on the runner is lost after the job (D247)" >&2
  exit 2
fi
AUTH_SIGNUP_ENABLED="${AUTH_SIGNUP_ENABLED:-false}"
if [ "$AUTH_SIGNUP_ENABLED" != true ] && [ "$AUTH_SIGNUP_ENABLED" != false ]; then
  echo "AUTH_SIGNUP_ENABLED must be true or false" >&2
  exit 2
fi
REGION="${REGION:-europe-west3}"
REPO="${REPO:-hostmark}"
APP_VERSION="${APP_VERSION:-$(git rev-parse --short HEAD)}"
IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT}/${REPO}/hostmark:${APP_VERSION}"
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"

echo "1/7 validating the configuration offline"
(cd "$here" && node --import tsx scripts/check-config.ts)

echo "2/7 enabling Artifact Registry and creating the repository"
gcloud services enable artifactregistry.googleapis.com --project "$GCP_PROJECT"
gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$GCP_PROJECT" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION" --project "$GCP_PROJECT"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "3/7 building and pushing ${IMAGE}"
docker build --platform linux/amd64 -f "$here/Dockerfile" --build-arg "APP_VERSION=${APP_VERSION}" -t "$IMAGE" "$root"
docker push "$IMAGE"

echo "4/7 creating the secrets that this script fills, then storing the values that changed"
# Cloud Run refuses to deploy a service whose secret has no version yet, so the values go in before the services exist.
cd "$here/infra"
backend=()
if [ -n "${GCP_STATE_BUCKET:-}" ]; then
  # An override file switches the backend for this run only; infra/ itself keeps the local default (D247).
  override="$here/infra/state_backend_override.tf"
  printf 'terraform {\n  backend "gcs" {}\n}\n' >"$override"
  trap 'rm -f "$override"' EXIT
  backend=(-backend-config "bucket=${GCP_STATE_BUCKET}" -backend-config "prefix=hostmark/gcp")
fi
terraform init -input=false ${backend[@]+"${backend[@]}"}
approve=()
if [ "${CI:-}" = true ]; then approve=(-auto-approve); fi
otlp_headers=false
if [ -n "${OTLP_HEADERS:-}" ]; then otlp_headers=true; fi
tfvars=(-var "project=${GCP_PROJECT}" -var "region=${REGION}" -var "domain=${DOMAIN}" -var "image=${IMAGE}"
  -var "app_version=${APP_VERSION}" -var "auth_signup_enabled=${AUTH_SIGNUP_ENABLED}"
  -var "otlp_endpoint=${OTLP_ENDPOINT:-}" -var "otlp_headers=${otlp_headers}")
terraform apply -input=false ${approve[@]+"${approve[@]}"} "${tfvars[@]}" -target=google_project_service.apis \
  -target=google_secret_manager_secret.database_url -target=google_secret_manager_secret.auth_secret \
  -target=google_secret_manager_secret.seed_api_key -target=google_secret_manager_secret.seed_admin_api_key \
  -target=google_secret_manager_secret.otlp_headers

# Stores <value> as the new version of <secret> unless the latest version already holds it, then disables every older
# enabled version. A value travels in shell variables and on gcloud's standard input only: never on a command line, never
# on standard output.
put_secret() { # <secret> <value>
  local current new version
  current="$(gcloud secrets versions access latest --secret "$1" --project "$GCP_PROJECT" 2>/dev/null)" || current=""
  if [ -n "$current" ] && [ "$current" = "$2" ]; then
    echo "  $1: unchanged"
    return 0
  fi
  new="$(printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project "$GCP_PROJECT" --format 'value(name)')"
  new="${new##*/}"
  for version in $(gcloud secrets versions list "$1" --project "$GCP_PROJECT" --filter 'state=ENABLED' --format 'value(name)'); do
    version="${version##*/}"
    if [ "$version" != "$new" ]; then
      gcloud secrets versions disable "$version" --secret "$1" --project "$GCP_PROJECT" --quiet >/dev/null
    fi
  done
  echo "  $1: stored as version ${new}, older versions disabled"
}
put_secret hostmark-database-url "$DATABASE_URL"
put_secret hostmark-auth-secret "$BETTER_AUTH_SECRET"
if [ -n "${OTLP_HEADERS:-}" ]; then put_secret hostmark-otlp-headers "$OTLP_HEADERS"; fi
# The seed job reads both keys from these secrets and never generates or prints one (its output goes to Cloud Logging).
seed_key() { # <secret> <value or empty>
  if [ -n "$2" ]; then
    put_secret "$1" "$2"
  elif [ -z "$(gcloud secrets versions list "$1" --project "$GCP_PROJECT" --limit 1 --format 'value(name)')" ]; then
    put_secret "$1" "hm_$(openssl rand -hex 32)"
  fi
}
seed_key hostmark-seed-api-key "${SEED_API_KEY:-}"
seed_key hostmark-seed-admin-api-key "${SEED_ADMIN_API_KEY:-}"

# The migration runs before the services move to the new image, so new code never meets an old schema; the services of
# the previous deploy keep running against the migrated one, so a migration must stay compatible with them (D298).
echo "5/7 applying the migrate job on the new image and migrating the database"
terraform apply -input=false ${approve[@]+"${approve[@]}"} "${tfvars[@]}" '-target=google_cloud_run_v2_job.operator["migrate"]'
gcloud run jobs execute hostmark-migrate --region "$REGION" --project "$GCP_PROJECT" --wait

echo "6/7 terraform apply of everything else (shows the plan; asks before it changes anything, except in CI)"
terraform apply -input=false ${approve[@]+"${approve[@]}"} "${tfvars[@]}"

echo "7/7 done. Point the A record of ${DOMAIN} at: $(terraform output -raw lb_ip)"
echo "The managed certificate is issued after DNS resolves (can take up to an hour)."
echo "Seed with: gcloud run jobs execute hostmark-seed --region ${REGION} --project ${GCP_PROJECT} --wait"
