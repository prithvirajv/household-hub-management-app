#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1 && [[ -x "${HOME}/.local/google-cloud-sdk/bin/gcloud" ]]; then
  export PATH="${HOME}/.local/google-cloud-sdk/bin:${PATH}"
fi

for required_command in gcloud; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "Missing required command: ${required_command}" >&2
    exit 1
  fi
done

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-famelo}"
REPOSITORY="${REPOSITORY:-household-hub}"
IMAGE_NAME="${IMAGE_NAME:-household-hub}"
TAG="${TAG:-$(date +%Y%m%d%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"
SETUP_ONLY="${SETUP_ONLY:-false}"

CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-famelo-postgres}"
CLOUD_SQL_TIER="${CLOUD_SQL_TIER:-db-f1-micro}"
CLOUD_SQL_STORAGE_SIZE="${CLOUD_SQL_STORAGE_SIZE:-10GB}"
CLOUD_SQL_CREATE="${CLOUD_SQL_CREATE:-true}"
DB_NAME="${DB_NAME:-household_hub}"
DB_USER="${DB_USER:-household_hub}"
DB_PASSWORD="${DB_PASSWORD:-${POSTGRES_PASSWORD:-}}"

SESSION_SECRET="${SESSION_SECRET:?Set SESSION_SECRET}"
ADMIN_EMAIL="${ADMIN_EMAIL:?Set ADMIN_EMAIL for the private administrator}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD with at least 12 characters}"
ADMIN_NAME="${ADMIN_NAME:-Famelo Administrator}"
APP_BASE_URL="${APP_BASE_URL:-}"
EMAIL_FROM="${EMAIL_FROM:-Famelo <no_reply@famelo.net>}"
SMTP_HOST="${SMTP_HOST:-smtp-relay.brevo.com}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_SECURE="${SMTP_SECURE:-false}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
REQUIRE_SMTP="${REQUIRE_SMTP:-true}"

if [[ -z "${DB_PASSWORD}" ]]; then
  echo "Set DB_PASSWORD or POSTGRES_PASSWORD for Cloud SQL" >&2
  exit 1
fi

if [[ "${REQUIRE_SMTP}" == "true" ]]; then
  SMTP_USER="${SMTP_USER:?Set SMTP_USER from Brevo SMTP credentials}"
  SMTP_PASS="${SMTP_PASS:?Set SMTP_PASS from Brevo SMTP credentials}"
fi

if [[ "${#ADMIN_PASSWORD}" -lt 12 ]]; then
  echo "ADMIN_PASSWORD must contain at least 12 characters" >&2
  exit 1
fi

gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  sqladmin.googleapis.com \
  --project "${PROJECT_ID}"

if ! gcloud artifacts repositories describe "${REPOSITORY}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Famelo application containers" \
    --project "${PROJECT_ID}"
fi

if ! gcloud sql instances describe "${CLOUD_SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  if [[ "${CLOUD_SQL_CREATE}" != "true" ]]; then
    echo "Cloud SQL instance ${CLOUD_SQL_INSTANCE} does not exist and CLOUD_SQL_CREATE is not true" >&2
    exit 1
  fi
  gcloud sql instances create "${CLOUD_SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --database-version POSTGRES_16 \
    --edition ENTERPRISE \
    --tier "${CLOUD_SQL_TIER}" \
    --availability-type zonal \
    --storage-size "${CLOUD_SQL_STORAGE_SIZE}" \
    --storage-type HDD \
    --no-storage-auto-increase \
    --no-backup
fi

if ! gcloud sql databases describe "${DB_NAME}" --instance "${CLOUD_SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud sql databases create "${DB_NAME}" --instance "${CLOUD_SQL_INSTANCE}" --project "${PROJECT_ID}"
fi

if ! gcloud sql users describe "${DB_USER}" --instance "${CLOUD_SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud sql users create "${DB_USER}" \
    --instance "${CLOUD_SQL_INSTANCE}" \
    --password "${DB_PASSWORD}" \
    --project "${PROJECT_ID}"
else
  gcloud sql users set-password "${DB_USER}" \
    --instance "${CLOUD_SQL_INSTANCE}" \
    --password "${DB_PASSWORD}" \
    --project "${PROJECT_ID}"
fi

CONNECTION_NAME="$(gcloud sql instances describe "${CLOUD_SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"

if [[ "${SETUP_ONLY}" == "true" ]]; then
  echo "Cloud Run setup complete."
  echo "Cloud SQL instance: ${CONNECTION_NAME}"
  exit 0
fi

gcloud builds submit --tag "${IMAGE}" --project "${PROJECT_ID}" .

gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --allow-unauthenticated \
  --execution-environment gen2 \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 20 \
  --min-instances 0 \
  --max-instances 1 \
  --cpu-throttling \
  --no-cpu-boost \
  --add-cloudsql-instances "${CONNECTION_NAME}" \
  --set-env-vars "CLOUD_SQL_CONNECTION_NAME=${CONNECTION_NAME},DB_NAME=${DB_NAME},DB_USER=${DB_USER},DB_PASSWORD=${DB_PASSWORD},SESSION_SECRET=${SESSION_SECRET},ADMIN_EMAIL=${ADMIN_EMAIL},ADMIN_PASSWORD=${ADMIN_PASSWORD},ADMIN_NAME=${ADMIN_NAME},APP_BASE_URL=${APP_BASE_URL},EMAIL_FROM=${EMAIL_FROM},SMTP_HOST=${SMTP_HOST},SMTP_PORT=${SMTP_PORT},SMTP_SECURE=${SMTP_SECURE},SMTP_USER=${SMTP_USER},SMTP_PASS=${SMTP_PASS}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"

if [[ -z "${APP_BASE_URL}" ]]; then
  gcloud run services update "${SERVICE_NAME}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --update-env-vars "APP_BASE_URL=${SERVICE_URL}"
fi

echo "Cloud Run URL: ${SERVICE_URL}"
echo "Cloud SQL instance: ${CONNECTION_NAME}"
