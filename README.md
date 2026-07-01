# Famelo

Famelo is a deployable household management SaaS: zero-based budgeting, shared notes and checklists, chores, birthdays, meals, groceries, goals, debt, net worth, and reports.

## Stack

- Frontend: plain HTML, CSS, and JavaScript
- Backend: Node.js and Express
- Database: PostgreSQL
- Auth: bcrypt password hashing and signed HttpOnly session cookies
- Local runtime: Docker Compose
- Deployment target: GKE on GCP

## Consumer Demo

Select **Try demo** on the sign-in screen. Demo access does not expose reusable credentials and never receives application administrator access.

Consumer documentation is available inside the application under **Help** and as [docs/consumer-guide.md](docs/consumer-guide.md).

The private administrator is provisioned separately with the `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_NAME` deployment secrets. Public signup cannot claim either the demo or administrator email.

The deployment password initializes a new administrator but does not overwrite an existing administrator on restart. Use **Forgot password?** to issue a database-backed, one-time reset link that expires after 30 minutes. This keeps password recovery compatible with rolling restarts and multiple application replicas.

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

Famelo sends a welcome email after signup and an invitation email when an owner shares a household. Configure an SMTP account with:

- `APP_BASE_URL`
- `EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`

Without `SMTP_HOST`, local development uses Nodemailer's JSON preview transport. The signup or invitation still succeeds, and the server logs that an email preview was created.

An SMTP success response means the provider accepted the message for delivery; it does not guarantee placement in the recipient's inbox. Production logs include the provider message ID so delivery can be traced in the SMTP provider's transactional activity.

Invitation emails include a direct acceptance link and a fallback invite code. A new recipient creates a login while accepting the invitation; an existing user confirms their current password. Invitation codes are bound to the invited email and become unusable after acceptance.

### Free Brevo SMTP

Brevo's free plan currently includes up to 300 email sends per day. Create a Brevo account, verify the sender address or domain, then create an SMTP key under **Transactional > Settings > SMTP & API**.

Use:

```bash
SMTP_HOST="smtp-relay.brevo.com"
SMTP_PORT="587"
SMTP_SECURE="false"
SMTP_USER="your-brevo-smtp-login"
SMTP_PASS="your-brevo-smtp-key"
EMAIL_FROM="Famelo <your-verified-sender@example.com>"
```

The SMTP key is a secret. Keep it in local environment variables or the Kubernetes Secret and never commit it.

## GKE Deployment

The deployment script creates a small one-node zonal GKE cluster when the named cluster does not exist. It deploys one Famelo pod and, by default, one PostgreSQL StatefulSet with a 10 Gi persistent volume. This is suitable for an initial MVP; migrate PostgreSQL to Cloud SQL before relying on multi-zone availability.

The application container runs as a non-root user with a read-only root filesystem, supports graceful termination, and uses separate liveness and database-aware readiness endpoints. The Deployment uses a rolling update strategy and can be scaled horizontally after PostgreSQL is moved to a managed, highly available service.

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
EMAIL_FROM="Famelo <your-verified-sender@example.com>" \
./scripts/deploy-gke.sh
```

The deploy script enables required Google APIs, creates the one-node cluster and Artifact Registry repository when needed, builds and pushes the container with Cloud Build, deploys PostgreSQL, updates Kubernetes secrets, applies the app manifests, waits for rollout, and prints the external URL.

Set `USE_IN_CLUSTER_POSTGRES=false` and provide `DATABASE_URL` plus `DATABASE_SSL=true` to use Cloud SQL or another managed PostgreSQL service. Set `CLUSTER_MODE=autopilot` to use a regional Autopilot cluster instead of the default zonal Standard cluster.

## Lower-Cost Cloud Run Deployment

For very low traffic, Cloud Run is cheaper than keeping a GKE node and GKE load balancer online. The Cloud Run script deploys the same container with `min-instances=0` and `max-instances=1`, and connects it to Cloud SQL for persistent PostgreSQL storage.

Recommended migration order from the current GKE deployment:

```bash
# 1. Create/prepare the small Cloud SQL PostgreSQL instance only.
set -a
source .env.deploy
set +a
SETUP_ONLY=true ./scripts/deploy-cloud-run.sh

# 2. Copy the existing in-cluster PostgreSQL data to Cloud SQL.
./scripts/migrate-gke-postgres-to-cloud-sql.sh

# 3. Deploy Famelo to Cloud Run using the migrated Cloud SQL database.
./scripts/deploy-cloud-run.sh
```

Important notes:

- Do not delete the GKE cluster until Cloud Run has been verified and DNS has been moved.
- Cloud SQL is still an always-on database cost. If traffic stays under a few visits per day, an external free-tier PostgreSQL provider can be cheaper; set `CLOUD_SQL_CREATE=false` and deploy with provider-specific database environment variables after adapting the connection settings.
- After Cloud Run is verified, point `famelo.net` and `www.famelo.net` to Cloud Run with a Cloud Run domain mapping or a small external HTTPS load balancer, then remove the old GKE ingress, static IP, and cluster.

### Production DNS and HTTPS

The transition deployment keeps the existing reserved global IP and hostname available:

`https://household-hub.8-233-48-73.sslip.io`

The target branded domain is:

`https://famelo.net`

To activate it:

1. Create an `A` record for `@` pointing to `8.233.48.73`.
2. Create either an `A` record for `www` pointing to `8.233.48.73` or a `CNAME` from `www` to `famelo.net`.
3. Apply `k8s/`; `famelo-certificate` provisions independently from the existing certificate.
4. Wait for the `ManagedCertificate` status to become `Active`.
5. Set `APP_BASE_URL=https://famelo.net` in the Kubernetes Secret so invitation and password-reset links use the branded domain.

Do not remove the existing hostname until the replacement certificate is active.
