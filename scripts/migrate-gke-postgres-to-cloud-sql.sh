#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1 && [[ -x "${HOME}/.local/google-cloud-sdk/bin/gcloud" ]]; then
  export PATH="${HOME}/.local/google-cloud-sdk/bin:${PATH}"
fi

for required_command in gcloud kubectl; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "Missing required command: ${required_command}" >&2
    exit 1
  fi
done

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
NAMESPACE="${NAMESPACE:-household-hub}"
CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-famelo-postgres}"
DB_NAME="${DB_NAME:-household_hub}"
DB_USER="${DB_USER:-household_hub}"
BUCKET="${MIGRATION_BUCKET:-${PROJECT_ID}-famelo-migration}"
OBJECT="cloud-sql-import/famelo-$(date +%Y%m%d%H%M%S).sql"
LOCAL_DUMP="$(mktemp)"
trap 'rm -f "${LOCAL_DUMP}"' EXIT

echo "Exporting PostgreSQL data from Kubernetes..."
kubectl -n "${NAMESPACE}" exec postgres-0 -- \
  pg_dump -U household_hub -d household_hub --clean --if-exists --no-owner --no-privileges > "${LOCAL_DUMP}"

if ! gcloud storage buckets describe "gs://${BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --project "${PROJECT_ID}" \
    --location "${REGION}" \
    --uniform-bucket-level-access
fi

echo "Uploading dump to gs://${BUCKET}/${OBJECT}..."
gcloud storage cp "${LOCAL_DUMP}" "gs://${BUCKET}/${OBJECT}" --project "${PROJECT_ID}"

SERVICE_ACCOUNT="$(gcloud sql instances describe "${CLOUD_SQL_INSTANCE}" \
  --project "${PROJECT_ID}" \
  --format='value(serviceAccountEmailAddress)')"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" \
  --role roles/storage.objectViewer \
  --project "${PROJECT_ID}" >/dev/null

echo "Importing dump into Cloud SQL ${CLOUD_SQL_INSTANCE}/${DB_NAME}..."
gcloud sql import sql "${CLOUD_SQL_INSTANCE}" "gs://${BUCKET}/${OBJECT}" \
  --database "${DB_NAME}" \
  --user "${DB_USER}" \
  --project "${PROJECT_ID}" \
  --quiet

echo "Migration complete. Dump object retained at gs://${BUCKET}/${OBJECT}"
