#!/usr/bin/env bash
# One-command deploy of the Cloud Run adapter. NOT run by any agent or test: it creates billable resources in the project
# of the person who runs it, with their credentials. Read adapters/gcp/README.md first.
#
#   GCP_PROJECT=my-project DOMAIN=bench.example.com \
#   DATABASE_URL=postgres://... BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
#   bash adapters/gcp/scripts/deploy.sh
#
# SEED_API_KEY and SEED_ADMIN_API_KEY are optional: a value that is set is stored as a new version of its secret; an
# unset one is generated here, once, when its secret has no version yet. No key is printed; read one with
# `gcloud secrets versions access latest --secret hostmark-seed-api-key`.
#
# Needs: gcloud (logged in, `gcloud auth application-default login` done), terraform, docker, pnpm, node.
set -euo pipefail

: "${GCP_PROJECT:?GCP_PROJECT is required}"
: "${DOMAIN:?DOMAIN is required (the host name of the load balancer)}"
: "${DATABASE_URL:?DATABASE_URL is required (the shared Postgres, D70)}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET is required (32+ characters)}"
REGION="${REGION:-europe-west3}"
REPO="${REPO:-hostmark}"
APP_VERSION="${APP_VERSION:-$(git rev-parse --short HEAD)}"
IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT}/${REPO}/hostmark:${APP_VERSION}"
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"

echo "1/6 validating the configuration offline"
(cd "$here" && node --import tsx scripts/check-config.ts)

echo "2/6 enabling Artifact Registry and creating the repository"
gcloud services enable artifactregistry.googleapis.com --project "$GCP_PROJECT"
gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$GCP_PROJECT" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION" --project "$GCP_PROJECT"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "3/6 building and pushing ${IMAGE}"
docker build --platform linux/amd64 -f "$here/Dockerfile" --build-arg "APP_VERSION=${APP_VERSION}" -t "$IMAGE" "$root"
docker push "$IMAGE"

echo "4/6 creating the secrets that this script fills, then storing their values"
# Cloud Run refuses to deploy a service whose secret has no version yet, so the values go in before the services exist.
cd "$here/infra"
terraform init -input=false
tfvars=(-var "project=${GCP_PROJECT}" -var "region=${REGION}" -var "domain=${DOMAIN}" -var "image=${IMAGE}" -var "app_version=${APP_VERSION}")
terraform apply "${tfvars[@]}" -target=google_project_service.apis \
  -target=google_secret_manager_secret.database_url -target=google_secret_manager_secret.auth_secret \
  -target=google_secret_manager_secret.seed_api_key -target=google_secret_manager_secret.seed_admin_api_key
printf '%s' "$DATABASE_URL" | gcloud secrets versions add hostmark-database-url --data-file=- --project "$GCP_PROJECT"
printf '%s' "$BETTER_AUTH_SECRET" | gcloud secrets versions add hostmark-auth-secret --data-file=- --project "$GCP_PROJECT"
# The seed job reads both keys from these secrets and never generates or prints one (its output goes to Cloud Logging).
seed_key() { # <secret> <value or empty>
  if [ -n "$2" ]; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project "$GCP_PROJECT" >/dev/null
  elif [ -z "$(gcloud secrets versions list "$1" --project "$GCP_PROJECT" --limit 1 --format 'value(name)')" ]; then
    printf 'hm_%s' "$(openssl rand -hex 32)" | gcloud secrets versions add "$1" --data-file=- --project "$GCP_PROJECT" >/dev/null
  fi
}
seed_key hostmark-seed-api-key "${SEED_API_KEY:-}"
seed_key hostmark-seed-admin-api-key "${SEED_ADMIN_API_KEY:-}"

echo "5/6 terraform apply of everything else (shows the plan and asks before it changes anything)"
terraform apply "${tfvars[@]}"

echo "6/6 migrating the database"
gcloud run jobs execute hostmark-migrate --region "$REGION" --project "$GCP_PROJECT" --wait

echo "done. Point the A record of ${DOMAIN} at: $(terraform output -raw lb_ip)"
echo "The managed certificate is issued after DNS resolves (can take up to an hour)."
echo "Seed with: gcloud run jobs execute hostmark-seed --region ${REGION} --project ${GCP_PROJECT} --wait"
