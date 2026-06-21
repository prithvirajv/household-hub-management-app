# Household Hub

Household Hub is a deployable SaaS MVP for household management: zero-based budgeting, shared notes and checklists, chores, birthdays, meals, groceries, goals, debt, net worth, and reports.

## Stack

- Frontend: plain HTML, CSS, and JavaScript
- Backend: Node.js and Express
- Database: PostgreSQL
- Auth: bcrypt password hashing and signed HttpOnly session cookies
- Local runtime: Docker Compose
- Deployment target: GKE on GCP

## Consumer Demo

Select **Try demo** on the sign-in screen. Demo access does not expose reusable credentials and never receives application administrator access.

The private administrator is provisioned separately with the `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_NAME` deployment secrets. Public signup cannot claim either the demo or administrator email.

## Local Development

Install dependencies and run the syntax checks:

```bash
npm install
npm run check
```

Start the app and database:

```bash
docker compose up -d --build
```

Open the app at [http://localhost:4173/index.html](http://localhost:4173/index.html).

Useful local endpoints:

- Health: [http://localhost:4173/healthz](http://localhost:4173/healthz)
- Postgres: `localhost:15432`

The Compose database uses:

- Database: `household_hub`
- User: `household_hub`
- Password: `household_hub_dev`

## API

- `GET /healthz`
- `GET /api/session`
- `POST /api/auth/signup`
- `POST /api/auth/signin`
- `POST /api/auth/demo`
- `POST /api/auth/signout`
- `POST /api/households/invitations`
- `GET /api/state`
- `PUT /api/state`

## Transactional Email

Household Hub sends a welcome email after signup and an invitation email when an owner shares a household. Configure an SMTP account with:

- `APP_BASE_URL`
- `EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`

Without `SMTP_HOST`, local development uses Nodemailer's JSON preview transport. The signup or invitation still succeeds, and the server logs that an email preview was created.

An SMTP success response means the provider accepted the message for delivery; it does not guarantee placement in the recipient's inbox. Production logs include the provider message ID so delivery can be traced in the SMTP provider's transactional activity.

### Free Brevo SMTP

Brevo's free plan currently includes up to 300 email sends per day. Create a Brevo account, verify the sender address or domain, then create an SMTP key under **Transactional > Settings > SMTP & API**.

Use:

```bash
SMTP_HOST="smtp-relay.brevo.com"
SMTP_PORT="587"
SMTP_SECURE="false"
SMTP_USER="your-brevo-smtp-login"
SMTP_PASS="your-brevo-smtp-key"
EMAIL_FROM="Household Hub <your-verified-sender@example.com>"
```

The SMTP key is a secret. Keep it in local environment variables or the Kubernetes Secret and never commit it.

## GKE Deployment

The deployment script creates a small one-node zonal GKE cluster when the named cluster does not exist. It deploys one Household Hub pod and, by default, one PostgreSQL StatefulSet with a 10 Gi persistent volume. This is suitable for an initial MVP; migrate PostgreSQL to Cloud SQL before relying on multi-zone availability.

The app expects these environment variables in the Kubernetes Secret:

- `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `ADMIN_NAME`
- `DATABASE_SSL`
- `APP_BASE_URL`
- `EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`

Deploy with:

```bash
PROJECT_ID="my-gcp-project" \
REGION="us-central1" \
ZONE="us-central1-a" \
CLUSTER_NAME="household-hub" \
SESSION_SECRET="$(openssl rand -hex 32)" \
ADMIN_EMAIL="owner@example.com" \
ADMIN_PASSWORD="$(openssl rand -base64 24)" \
ADMIN_NAME="Application Owner" \
POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
SMTP_USER="your-brevo-smtp-login" \
SMTP_PASS="your-brevo-smtp-key" \
EMAIL_FROM="Household Hub <your-verified-sender@example.com>" \
./scripts/deploy-gke.sh
```

The deploy script enables required Google APIs, creates the one-node cluster and Artifact Registry repository when needed, builds and pushes the container with Cloud Build, deploys PostgreSQL, updates Kubernetes secrets, applies the app manifests, waits for rollout, and prints the external URL.

Set `USE_IN_CLUSTER_POSTGRES=false` and provide `DATABASE_URL` plus `DATABASE_SSL=true` to use Cloud SQL or another managed PostgreSQL service. Set `CLUSTER_MODE=autopilot` to use a regional Autopilot cluster instead of the default zonal Standard cluster.

### Production DNS and HTTPS

The initial deployment uses a reserved global IP and Google-managed certificate at:

`https://household-hub.8-233-48-73.sslip.io`

For a branded domain:

1. Purchase or use an existing domain.
2. Create an `A` record such as `app.example.com` pointing to `8.233.48.73`.
3. Replace the `sslip.io` hostname in `k8s/managed-certificate.yaml` and `k8s/ingress.yaml`.
4. Set `APP_BASE_URL=https://app.example.com` in the Kubernetes Secret.
5. Apply `k8s/` and wait for the `ManagedCertificate` status to become `Active`.

Do not remove the existing hostname until the replacement certificate is active.
