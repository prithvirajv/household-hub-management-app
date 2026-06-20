#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
CLUSTER_NAME="${CLUSTER_NAME:-household-hub}"
REPOSITORY="${REPOSITORY:-household-hub}"
IMAGE_NAME="${IMAGE_NAME:-household-hub}"
NAMESPACE="${NAMESPACE:-household-hub}"
DATABASE_URL="${DATABASE_URL:?Set DATABASE_URL}"
SESSION_SECRET="${SESSION_SECRET:?Set SESSION_SECRET}"
DATABASE_SSL="${DATABASE_SSL:-true}"
APP_BASE_URL="${APP_BASE_URL:-}"
EMAIL_FROM="${EMAIL_FROM:-Household Hub <no-reply@householdhub.app>}"
SMTP_HOST="${SMTP_HOST:-}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_SECURE="${SMTP_SECURE:-false}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
TAG="${TAG:-$(date +%Y%m%d%H%M%S)}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"

gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com container.googleapis.com --project "${PROJECT_ID}"

if ! gcloud artifacts repositories describe "${REPOSITORY}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Household Hub containers" \
    --project "${PROJECT_ID}"
fi

gcloud builds submit --tag "${IMAGE}" --project "${PROJECT_ID}" .
gcloud container clusters get-credentials "${CLUSTER_NAME}" --region "${REGION}" --project "${PROJECT_ID}"

kubectl apply -f k8s/namespace.yaml
kubectl -n "${NAMESPACE}" create secret generic household-hub-secrets \
  --from-literal=DATABASE_URL="${DATABASE_URL}" \
  --from-literal=SESSION_SECRET="${SESSION_SECRET}" \
  --from-literal=DATABASE_SSL="${DATABASE_SSL}" \
  --from-literal=APP_BASE_URL="${APP_BASE_URL}" \
  --from-literal=EMAIL_FROM="${EMAIL_FROM}" \
  --from-literal=SMTP_HOST="${SMTP_HOST}" \
  --from-literal=SMTP_PORT="${SMTP_PORT}" \
  --from-literal=SMTP_SECURE="${SMTP_SECURE}" \
  --from-literal=SMTP_USER="${SMTP_USER}" \
  --from-literal=SMTP_PASS="${SMTP_PASS}" \
  --dry-run=client -o yaml | kubectl apply -f -

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
cp -R k8s/. "${TMP_DIR}/"
(
  cd "${TMP_DIR}"
  kustomize edit set image "household-hub=${IMAGE}"
  kubectl apply -k .
)

kubectl -n "${NAMESPACE}" rollout status deployment/household-hub
kubectl -n "${NAMESPACE}" get service household-hub
