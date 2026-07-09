#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1 && [[ -x "${HOME}/.local/google-cloud-sdk/bin/gcloud" ]]; then
  export PATH="${HOME}/.local/google-cloud-sdk/bin:${PATH}"
fi

for required_command in gcloud kubectl kustomize; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "Missing required command: ${required_command}" >&2
    exit 1
  fi
done

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
CLUSTER_NAME="${CLUSTER_NAME:-household-hub}"
CLUSTER_MODE="${CLUSTER_MODE:-standard}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"
REPOSITORY="${REPOSITORY:-household-hub}"
IMAGE_NAME="${IMAGE_NAME:-household-hub}"
NAMESPACE="${NAMESPACE:-household-hub}"
DATABASE_URL="${DATABASE_URL:-}"
USE_IN_CLUSTER_POSTGRES="${USE_IN_CLUSTER_POSTGRES:-true}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
SESSION_SECRET="${SESSION_SECRET:?Set SESSION_SECRET}"
ADMIN_EMAIL="${ADMIN_EMAIL:?Set ADMIN_EMAIL for the private administrator}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD with at least 12 characters}"
ADMIN_NAME="${ADMIN_NAME:-FamilyLoop Administrator}"
DATABASE_SSL="${DATABASE_SSL:-true}"
APP_BASE_URL="${APP_BASE_URL:-}"
EMAIL_FROM="${EMAIL_FROM:-FamilyLoop <no-reply@familyloop.net>}"
SMTP_HOST="${SMTP_HOST:-smtp-relay.brevo.com}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_SECURE="${SMTP_SECURE:-false}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
REQUIRE_SMTP="${REQUIRE_SMTP:-true}"
TAG="${TAG:-$(date +%Y%m%d%H%M%S)}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"

if [[ "${USE_IN_CLUSTER_POSTGRES}" == "true" ]]; then
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD for the in-cluster database}"
  DATABASE_URL="postgres://household_hub:${POSTGRES_PASSWORD}@postgres:5432/household_hub"
  DATABASE_SSL="false"
else
  DATABASE_URL="${DATABASE_URL:?Set DATABASE_URL or enable USE_IN_CLUSTER_POSTGRES}"
fi

if [[ "${REQUIRE_SMTP}" == "true" ]]; then
  SMTP_USER="${SMTP_USER:?Set SMTP_USER from Brevo SMTP credentials}"
  SMTP_PASS="${SMTP_PASS:?Set SMTP_PASS from Brevo SMTP credentials}"
fi

if [[ "${#ADMIN_PASSWORD}" -lt 12 ]]; then
  echo "ADMIN_PASSWORD must contain at least 12 characters" >&2
  exit 1
fi

gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com container.googleapis.com --project "${PROJECT_ID}"

if [[ "${CLUSTER_MODE}" == "autopilot" ]]; then
  CLUSTER_EXISTS_COMMAND=(gcloud container clusters describe "${CLUSTER_NAME}" --region "${REGION}" --project "${PROJECT_ID}")
else
  CLUSTER_EXISTS_COMMAND=(gcloud container clusters describe "${CLUSTER_NAME}" --zone "${ZONE}" --project "${PROJECT_ID}")
fi

if ! "${CLUSTER_EXISTS_COMMAND[@]}" >/dev/null 2>&1; then
  if [[ "${CLUSTER_MODE}" == "autopilot" ]]; then
    gcloud container clusters create-auto "${CLUSTER_NAME}" \
      --region "${REGION}" \
      --project "${PROJECT_ID}"
  else
    gcloud container clusters create "${CLUSTER_NAME}" \
      --zone "${ZONE}" \
      --machine-type "${MACHINE_TYPE}" \
      --num-nodes 1 \
      --enable-ip-alias \
      --project "${PROJECT_ID}"
  fi
fi

if ! gcloud artifacts repositories describe "${REPOSITORY}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="FamilyLoop application containers" \
    --project "${PROJECT_ID}"
fi

gcloud builds submit --tag "${IMAGE}" --project "${PROJECT_ID}" .
if [[ "${CLUSTER_MODE}" == "autopilot" ]]; then
  gcloud container clusters get-credentials "${CLUSTER_NAME}" --region "${REGION}" --project "${PROJECT_ID}"
else
  gcloud container clusters get-credentials "${CLUSTER_NAME}" --zone "${ZONE}" --project "${PROJECT_ID}"
fi

kubectl apply -f k8s/namespace.yaml

if [[ "${USE_IN_CLUSTER_POSTGRES}" == "true" ]]; then
  kubectl -n "${NAMESPACE}" create secret generic household-hub-postgres \
    --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f k8s/postgres.yaml
  kubectl -n "${NAMESPACE}" rollout status statefulset/postgres
fi

kubectl -n "${NAMESPACE}" create secret generic household-hub-secrets \
  --from-literal=DATABASE_URL="${DATABASE_URL}" \
  --from-literal=SESSION_SECRET="${SESSION_SECRET}" \
  --from-literal=ADMIN_EMAIL="${ADMIN_EMAIL}" \
  --from-literal=ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
  --from-literal=ADMIN_NAME="${ADMIN_NAME}" \
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

if [[ -z "${APP_BASE_URL}" ]]; then
  echo "Waiting for the external load balancer address..."
  for _attempt in $(seq 1 60); do
    EXTERNAL_ADDRESS="$(kubectl -n "${NAMESPACE}" get service household-hub -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
    if [[ -z "${EXTERNAL_ADDRESS}" ]]; then
      EXTERNAL_ADDRESS="$(kubectl -n "${NAMESPACE}" get service household-hub -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
    fi
    [[ -n "${EXTERNAL_ADDRESS}" ]] && break
    sleep 10
  done
  if [[ -n "${EXTERNAL_ADDRESS:-}" ]]; then
    APP_BASE_URL="http://${EXTERNAL_ADDRESS}"
    kubectl -n "${NAMESPACE}" create secret generic household-hub-secrets \
      --from-literal=DATABASE_URL="${DATABASE_URL}" \
      --from-literal=SESSION_SECRET="${SESSION_SECRET}" \
      --from-literal=ADMIN_EMAIL="${ADMIN_EMAIL}" \
      --from-literal=ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
      --from-literal=ADMIN_NAME="${ADMIN_NAME}" \
      --from-literal=DATABASE_SSL="${DATABASE_SSL}" \
      --from-literal=APP_BASE_URL="${APP_BASE_URL}" \
      --from-literal=EMAIL_FROM="${EMAIL_FROM}" \
      --from-literal=SMTP_HOST="${SMTP_HOST}" \
      --from-literal=SMTP_PORT="${SMTP_PORT}" \
      --from-literal=SMTP_SECURE="${SMTP_SECURE}" \
      --from-literal=SMTP_USER="${SMTP_USER}" \
      --from-literal=SMTP_PASS="${SMTP_PASS}" \
      --dry-run=client -o yaml | kubectl apply -f -
    kubectl -n "${NAMESPACE}" rollout restart deployment/household-hub
    kubectl -n "${NAMESPACE}" rollout status deployment/household-hub
  fi
fi

kubectl -n "${NAMESPACE}" get service household-hub
echo "FamilyLoop URL: ${APP_BASE_URL:-pending-load-balancer-address}"
