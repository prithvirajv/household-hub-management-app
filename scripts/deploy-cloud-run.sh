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
SERVICE_NAME="${SERVICE_NAME:-familyloop}"
REPOSITORY="${REPOSITORY:-household-hub}"
IMAGE_NAME="${IMAGE_NAME:-household-hub}"
TAG="${TAG:-$(date +%Y%m%d%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"
SETUP_ONLY="${SETUP_ONLY:-false}"

CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-familyloop-postgres}"
CLOUD_SQL_TIER="${CLOUD_SQL_TIER:-db-f1-micro}"
CLOUD_SQL_STORAGE_SIZE="${CLOUD_SQL_STORAGE_SIZE:-10GB}"
CLOUD_SQL_CREATE="${CLOUD_SQL_CREATE:-true}"
DB_NAME="${DB_NAME:-household_hub}"
DB_USER="${DB_USER:-household_hub}"
DB_PASSWORD="${DB_PASSWORD:-${POSTGRES_PASSWORD:-}}"
# Set DATABASE_URL to skip Cloud SQL entirely and connect to any external
# Postgres (e.g. Neon, Supabase) instead - the app already supports this
# connection path (see server/index.js), it just was never wired up here.
DATABASE_URL="${DATABASE_URL:-}"
DATABASE_SSL="${DATABASE_SSL:-false}"
USE_CLOUD_SQL="true"
if [[ -n "${DATABASE_URL}" ]]; then
  USE_CLOUD_SQL="false"
fi
CONNECTION_NAME=""

SESSION_SECRET="${SESSION_SECRET:?Set SESSION_SECRET}"
ADMIN_EMAIL="${ADMIN_EMAIL:?Set ADMIN_EMAIL for the private administrator}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD with at least 12 characters}"
ADMIN_NAME="${ADMIN_NAME:-FamilyLoop Administrator}"
APP_BASE_URL="${APP_BASE_URL:-}"
EMAIL_FROM="${EMAIL_FROM:-FamilyLoop <no_reply@familyloop.net>}"
SMTP_HOST="${SMTP_HOST:-smtp-relay.brevo.com}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_SECURE="${SMTP_SECURE:-false}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
REQUIRE_SMTP="${REQUIRE_SMTP:-true}"
NOTIFICATION_SECRET="${NOTIFICATION_SECRET:?Set NOTIFICATION_SECRET to authorize the scheduled notification worker}"
GCS_BUCKET="${GCS_BUCKET:-}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
FINNHUB_API_KEY="${FINNHUB_API_KEY:-}"
GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY:-}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
# Linked accounts (SimpleFIN Bridge / SnapTrade). LINK_ENCRYPTION_KEY encrypts the stored bank/brokerage credentials; if it is not set
# here it is read from Secret Manager, or generated once and stored there on the first deploy - losing it means linked accounts must be
# linked again. The SnapTrade values are optional: without them only the SimpleFIN side is available.
LINK_ENCRYPTION_KEY="${LINK_ENCRYPTION_KEY:-}"
SNAPTRADE_CLIENT_ID="${SNAPTRADE_CLIENT_ID:-}"
SNAPTRADE_CONSUMER_KEY="${SNAPTRADE_CONSUMER_KEY:-}"
SNAPTRADE_MODE="${SNAPTRADE_MODE:-personal}"
SNAPTRADE_PERSONAL_OWNER_EMAIL="${SNAPTRADE_PERSONAL_OWNER_EMAIL:-}"

# Every credential above is stored in Secret Manager, not passed to Cloud Run
# as a plaintext env var — this script only reads them from the environment
# once, to seed/update the corresponding secret.
DB_PASSWORD_SECRET="${DB_PASSWORD_SECRET:-familyloop-db-password}"
SESSION_SECRET_NAME="${SESSION_SECRET_NAME:-familyloop-session-secret}"
ADMIN_PASSWORD_SECRET="${ADMIN_PASSWORD_SECRET:-familyloop-admin-password}"
SMTP_PASS_SECRET="${SMTP_PASS_SECRET:-familyloop-smtp-pass}"
NOTIFICATION_SECRET_NAME="${NOTIFICATION_SECRET_NAME:-familyloop-notification-secret}"
FINNHUB_API_KEY_SECRET="${FINNHUB_API_KEY_SECRET:-familyloop-finnhub-api-key}"
GEMINI_API_KEY_SECRET="${GEMINI_API_KEY_SECRET:-familyloop-gemini-api-key}"
LINK_ENCRYPTION_KEY_SECRET="${LINK_ENCRYPTION_KEY_SECRET:-familyloop-link-encryption-key}"
SNAPTRADE_CONSUMER_KEY_SECRET="${SNAPTRADE_CONSUMER_KEY_SECRET:-familyloop-snaptrade-consumer-key}"

if [[ "${USE_CLOUD_SQL}" == "true" && -z "${DB_PASSWORD}" ]]; then
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
  secretmanager.googleapis.com \
  --project "${PROJECT_ID}"

RUNTIME_SERVICE_ACCOUNT="$(gcloud iam service-accounts list --project "${PROJECT_ID}" --filter="displayName:'Compute Engine default service account'" --format='value(email)')"

put_secret() {
  local secret_name="$1"
  local secret_value="$2"
  if ! gcloud secrets describe "${secret_name}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    printf '%s' "${secret_value}" | gcloud secrets create "${secret_name}" --project "${PROJECT_ID}" --data-file=-
  else
    # Secret Manager bills per active version per month, and every deploy
    # used to call `versions add` unconditionally even when the value was
    # unchanged, silently piling up hundreds of redundant versions. Only
    # write a new version when the value actually differs from `latest`.
    local current_value=""
    current_value="$(gcloud secrets versions access latest --secret="${secret_name}" --project "${PROJECT_ID}" 2>/dev/null || true)"
    if [[ "${current_value}" != "${secret_value}" ]]; then
      printf '%s' "${secret_value}" | gcloud secrets versions add "${secret_name}" --project "${PROJECT_ID}" --data-file=-
    fi
  fi
  gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project "${PROJECT_ID}" \
    --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
}

if ! gcloud artifacts repositories describe "${REPOSITORY}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="FamilyLoop application containers" \
    --project "${PROJECT_ID}"
fi

if [[ "${USE_CLOUD_SQL}" == "true" ]]; then
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
fi

if [[ "${SETUP_ONLY}" == "true" ]]; then
  echo "Cloud Run setup complete."
  if [[ "${USE_CLOUD_SQL}" == "true" ]]; then
    echo "Cloud SQL instance: ${CONNECTION_NAME}"
  else
    echo "Using external DATABASE_URL, no Cloud SQL instance provisioned."
  fi
  exit 0
fi

if [[ "${USE_CLOUD_SQL}" == "true" ]]; then
  put_secret "${DB_PASSWORD_SECRET}" "${DB_PASSWORD}"
fi
put_secret "${SESSION_SECRET_NAME}" "${SESSION_SECRET}"
put_secret "${ADMIN_PASSWORD_SECRET}" "${ADMIN_PASSWORD}"
put_secret "${NOTIFICATION_SECRET_NAME}" "${NOTIFICATION_SECRET}"
if [[ -n "${SMTP_PASS}" ]]; then
  put_secret "${SMTP_PASS_SECRET}" "${SMTP_PASS}"
fi
if [[ -n "${FINNHUB_API_KEY}" ]]; then
  put_secret "${FINNHUB_API_KEY_SECRET}" "${FINNHUB_API_KEY}"
fi
if [[ -n "${GEMINI_API_KEY}" ]]; then
  put_secret "${GEMINI_API_KEY_SECRET}" "${GEMINI_API_KEY}"
fi
if [[ -z "${LINK_ENCRYPTION_KEY}" ]]; then
  LINK_ENCRYPTION_KEY="$(gcloud secrets versions access latest --secret="${LINK_ENCRYPTION_KEY_SECRET}" --project "${PROJECT_ID}" 2>/dev/null || true)"
fi
if [[ -z "${LINK_ENCRYPTION_KEY}" ]]; then
  LINK_ENCRYPTION_KEY="$(openssl rand -base64 32)"
fi
put_secret "${LINK_ENCRYPTION_KEY_SECRET}" "${LINK_ENCRYPTION_KEY}"
if [[ -n "${SNAPTRADE_CONSUMER_KEY}" ]]; then
  put_secret "${SNAPTRADE_CONSUMER_KEY_SECRET}" "${SNAPTRADE_CONSUMER_KEY}"
fi

gcloud builds submit --tag "${IMAGE}" --project "${PROJECT_ID}" .

SECRET_REFS="SESSION_SECRET=${SESSION_SECRET_NAME}:latest,ADMIN_PASSWORD=${ADMIN_PASSWORD_SECRET}:latest,NOTIFICATION_SECRET=${NOTIFICATION_SECRET_NAME}:latest"
if [[ "${USE_CLOUD_SQL}" == "true" ]]; then
  SECRET_REFS="${SECRET_REFS},DB_PASSWORD=${DB_PASSWORD_SECRET}:latest"
fi
if [[ -n "${SMTP_PASS}" ]]; then
  SECRET_REFS="${SECRET_REFS},SMTP_PASS=${SMTP_PASS_SECRET}:latest"
fi
if [[ -n "${FINNHUB_API_KEY}" ]]; then
  SECRET_REFS="${SECRET_REFS},FINNHUB_API_KEY=${FINNHUB_API_KEY_SECRET}:latest"
fi
if [[ -n "${GEMINI_API_KEY}" ]]; then
  SECRET_REFS="${SECRET_REFS},GEMINI_API_KEY=${GEMINI_API_KEY_SECRET}:latest"
fi
SECRET_REFS="${SECRET_REFS},LINK_ENCRYPTION_KEY=${LINK_ENCRYPTION_KEY_SECRET}:latest"
if [[ -n "${SNAPTRADE_CONSUMER_KEY}" ]]; then
  SECRET_REFS="${SECRET_REFS},SNAPTRADE_CONSUMER_KEY=${SNAPTRADE_CONSUMER_KEY_SECRET}:latest"
fi

ENV_VARS="ADMIN_EMAIL=${ADMIN_EMAIL},ADMIN_NAME=${ADMIN_NAME},APP_BASE_URL=${APP_BASE_URL},EMAIL_FROM=${EMAIL_FROM},SMTP_HOST=${SMTP_HOST},SMTP_PORT=${SMTP_PORT},SMTP_SECURE=${SMTP_SECURE},SMTP_USER=${SMTP_USER},GCS_BUCKET=${GCS_BUCKET},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY}"
if [[ -n "${SNAPTRADE_CLIENT_ID}" ]]; then
  ENV_VARS="${ENV_VARS},SNAPTRADE_CLIENT_ID=${SNAPTRADE_CLIENT_ID},SNAPTRADE_MODE=${SNAPTRADE_MODE},SNAPTRADE_PERSONAL_OWNER_EMAIL=${SNAPTRADE_PERSONAL_OWNER_EMAIL}"
fi
DEPLOY_ARGS=(
  "${SERVICE_NAME}"
  --project "${PROJECT_ID}"
  --region "${REGION}"
  --image "${IMAGE}"
  --allow-unauthenticated
  --execution-environment gen2
  --cpu 1
  --memory 512Mi
  --concurrency 20
  --min-instances 0
  --max-instances 1
  --cpu-throttling
  --no-cpu-boost
  --set-secrets "${SECRET_REFS}"
)
if [[ "${USE_CLOUD_SQL}" == "true" ]]; then
  DEPLOY_ARGS+=(--add-cloudsql-instances "${CONNECTION_NAME}")
  ENV_VARS="CLOUD_SQL_CONNECTION_NAME=${CONNECTION_NAME},DB_NAME=${DB_NAME},DB_USER=${DB_USER},${ENV_VARS}"
else
  ENV_VARS="DATABASE_URL=${DATABASE_URL},DATABASE_SSL=${DATABASE_SSL},${ENV_VARS}"
fi
DEPLOY_ARGS+=(--set-env-vars "${ENV_VARS}")

gcloud run deploy "${DEPLOY_ARGS[@]}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"

if [[ -z "${APP_BASE_URL}" ]]; then
  gcloud run services update "${SERVICE_NAME}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --update-env-vars "APP_BASE_URL=${SERVICE_URL}"
fi


# Nightly linked-account sync (SimpleFIN / SnapTrade): fetches each active link and stages the result; clients apply it the next time the
# app is opened (see docs/SOPS.md). Created/updated idempotently here, like the other scheduler jobs but authenticated with the same
# NOTIFICATION_SECRET bearer token. A failure to manage the job is reported but never fails the deploy.
LINKED_SYNC_JOB="${LINKED_SYNC_JOB:-familyloop-linked-sync}"
LINKED_SYNC_SCHEDULE="${LINKED_SYNC_SCHEDULE:-30 3 * * *}"
LINKED_SYNC_TIME_ZONE="${LINKED_SYNC_TIME_ZONE:-America/New_York}"
LINKED_SYNC_URI="${APP_BASE_URL:-${SERVICE_URL}}/api/internal/linked-accounts/sync-all"
SCHEDULER_VERB="create"
if gcloud scheduler jobs describe "${LINKED_SYNC_JOB}" --project "${PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1; then
  SCHEDULER_VERB="update"
fi
if ! gcloud scheduler jobs "${SCHEDULER_VERB}" http "${LINKED_SYNC_JOB}" \
  --project "${PROJECT_ID}" --location "${REGION}" \
  --schedule "${LINKED_SYNC_SCHEDULE}" --time-zone "${LINKED_SYNC_TIME_ZONE}" \
  --uri "${LINKED_SYNC_URI}" --http-method POST \
  --headers "Authorization=Bearer ${NOTIFICATION_SECRET},Content-Type=application/json" \
  --message-body "{}" --attempt-deadline 540s --max-retry-attempts 1 >/dev/null 2>&1; then
  echo "Warning: could not ${SCHEDULER_VERB} the Cloud Scheduler job ${LINKED_SYNC_JOB}; the nightly linked-account sync will not run." >&2
fi

echo "Cloud Run URL: ${SERVICE_URL}"
if [[ "${USE_CLOUD_SQL}" == "true" ]]; then
  echo "Cloud SQL instance: ${CONNECTION_NAME}"
else
  echo "Database: external (DATABASE_URL)"
fi
