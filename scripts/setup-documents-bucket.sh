#!/usr/bin/env bash
# One-time (idempotent) setup for the Documents feature's GCS bucket: creates
# a private bucket, grants the Cloud Run service account just enough access
# to read/write objects and sign URLs, and configures CORS so the browser can
# PUT/GET directly against the bucket from the app's origin (without CORS,
# uploads fail in-browser with "Failed to fetch" even though the signed URL
# itself is valid — curl/native HTTP clients aren't subject to CORS, so this
# only shows up when testing from an actual browser).
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1 && [[ -x "${HOME}/.local/google-cloud-sdk/bin/gcloud" ]]; then
  export PATH="${HOME}/.local/google-cloud-sdk/bin:${PATH}"
fi

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
BUCKET="${GCS_BUCKET:?Set GCS_BUCKET to the bucket name}"
SERVICE_ACCOUNT="${GCS_SERVICE_ACCOUNT:?Set GCS_SERVICE_ACCOUNT to the Cloud Run runtime service account email}"
ALLOWED_ORIGINS="${GCS_CORS_ORIGINS:-https://familyloop.net,https://www.familyloop.net,https://famelo.net,https://www.famelo.net}"

gcloud services enable storage.googleapis.com iamcredentials.googleapis.com --project "${PROJECT_ID}"

if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --project="${PROJECT_ID}" --location="${REGION}" \
    --uniform-bucket-level-access --default-storage-class=STANDARD \
    --public-access-prevention
fi

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" --role="roles/storage.objectAdmin"

# Required for V4 signed URLs on Cloud Run without a downloaded key file:
# the storage client signs via the IAM Credentials API, which needs the
# service account to be able to mint tokens for itself.
gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT}" \
  --project="${PROJECT_ID}" --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/iam.serviceAccountTokenCreator"

CORS_FILE="$(mktemp)"
trap 'rm -f "${CORS_FILE}"' EXIT
python3 - "${ALLOWED_ORIGINS}" > "${CORS_FILE}" <<'PY'
import json
import sys

origins = [origin.strip() for origin in sys.argv[1].split(",") if origin.strip()]
print(json.dumps([
    {
        "origin": origins,
        "method": ["PUT", "GET"],
        "responseHeader": ["Content-Type"],
        "maxAgeSeconds": 3600
    }
]))
PY

gcloud storage buckets update "gs://${BUCKET}" --cors-file="${CORS_FILE}"

echo "Bucket gs://${BUCKET} is ready (public access prevented, uniform access, CORS for: ${ALLOWED_ORIGINS})."
