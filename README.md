# Household Hub

Household Hub is a deployable SaaS MVP for household management: zero-based budgeting, shared notes and checklists, chores, birthdays, meals, groceries, goals, debt, net worth, and reports.

## Stack

- Frontend: plain HTML, CSS, and JavaScript
- Backend: Node.js and Express
- Database: PostgreSQL
- Auth: bcrypt password hashing and signed HttpOnly session cookies
- Local runtime: Docker Compose
- Deployment target: GKE on GCP

## Demo Account

- Email: `demo@householdhub.app`
- Password: `budget123`

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

## GKE Deployment

Create a GKE cluster and a reachable PostgreSQL database first. The app expects these environment variables in the Kubernetes Secret:

- `DATABASE_URL`
- `SESSION_SECRET`
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
CLUSTER_NAME="household-hub" \
DATABASE_URL="postgres://user:password@host:5432/household_hub" \
SESSION_SECRET="$(openssl rand -hex 32)" \
DATABASE_SSL="true" \
./scripts/deploy-gke.sh
```

The deploy script enables required Google APIs, creates the Artifact Registry repository when needed, builds and pushes the container with Cloud Build, updates the Kubernetes secret, applies `k8s/`, and waits for rollout.
