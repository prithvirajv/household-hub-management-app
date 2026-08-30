# FamilyLoop — Standard Operating Procedures

Day-2 operational runbook. If you're taking over this app, this is the file
to follow when shipping a change, when something breaks, or when you need to
touch infrastructure. Background/rationale lives in
[ARCHITECTURE.md](ARCHITECTURE.md); code-level detail lives in
[LLD.md](LLD.md).

**Environment**: GCP project `solid-coder-212120`, region `us-central1`,
Cloud Run service `familyloop`. Two live domains point at the same service —
`familyloop.net` and `famelo.net` — **both** must be checked after any
production change.

## Local development

```bash
npm install
npm run check   # node --check on server/index.js, server/default-state.js, app.js, test/auth.integration.test.js
npm test        # full suite, node --test, ~50s, 244 tests
```

Full local stack (app + real Postgres) via Docker Compose:

```bash
docker compose up -d --build
```

App: [http://localhost:4173/index.html](http://localhost:4173/index.html) ·
Health: `GET http://localhost:4173/healthz` · Postgres: `localhost:15432`
(`household_hub`/`household_hub`/`household_hub_dev`).

Lighter-weight preview without Docker/Postgres (uses the in-memory DB):

```bash
npm run preview   # PORT=4173 MEMORY_DB=true node server/index.js
```

## Standard change → ship workflow

This is the non-negotiable definition of "done" for any change, even a
one-line fix — several real production bugs in this app's history looked
obviously correct on code inspection alone and were only caught by actually
driving the flow.

1. Edit, then `node --check <file>` on anything touched.
2. `npm run check && npm test` — full suite must stay green (244 tests as of
   this writing).
3. **Browser-verify the actual change**, not just a generic smoke test.
   Start the preview (`npm run preview`, port 4173), log in via the **Try
   demo** button (no reusable credentials, never gets admin access), and
   reproduce the *specific* scenario the change addresses — same data shape,
   same action sequence a real report would involve. Use `fetch('/api/state',
   {credentials:'include'})` / a `PUT` to seed scenarios that are awkward to
   set up by hand.
4. Bump the `?v=YYYYMMDD-N` cache-busting query string on the
   `styles.css`/`lib/shared-logic.js`/`app.js` `<script>`/`<link>` tags in
   `index.html` (increment `N`; a new day resets to `-1`).
5. Write the commit message to a scratchpad file first, then
   `git commit -F <file>` — an inline heredoc
   (`git commit -m "$(cat <<'EOF' ... EOF)"`) reliably fails with a bash
   syntax error in this environment (cause never fully root-caused; the
   scratchpad-file route has been 100% reliable).
6. `git push origin main` — always, without waiting to be asked, once a
   change is committed to this repo.
7. Deploy (see below), then health-check both domains.
8. Prefer finishing/verifying every outstanding request in a session before
   deploying once, rather than deploying after each small fix.

## Deploying

```bash
cd /Users/home/Documents/Codex/2026-05-29/here-s-a-prompt-you-can
set -a
source .env.deploy
set +a
export NOTIFICATION_SECRET="$(gcloud secrets versions access latest --secret=familyloop-notification-secret --project=solid-coder-212120)"
bash scripts/deploy-cloud-run.sh
```

Run this in the background — it takes a few minutes (Cloud Build + Cloud Run
rollout). `.env.deploy` is gitignored and carries the real `DATABASE_URL`,
`DATABASE_SSL`, and other deploy-time secrets/config; never commit it or
echo its contents.

**Why this is safe to run even if something's wrong**: Cloud Run never
routes traffic to a new revision that fails its health check — the previous
good revision keeps serving. A bad deploy attempt fails loudly and rolls
back automatically; it does not cause an outage by itself.

### Health-check both domains

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://familyloop.net/readyz
curl -s -o /dev/null -w "%{http_code}\n" https://famelo.net/readyz
```

Both must return `200`. `/readyz` is DB-aware (unlike `/healthz`), so this
also confirms the app can actually reach Postgres.

## Rotating a secret

Secrets live in GCP Secret Manager, one enabled version kept per secret
(`scripts/deploy-cloud-run.sh`'s `put_secret()` diffs against `latest` and
skips redundant writes, then disables/destroys the prior version — this is
what keeps the enabled-version count, and therefore the Secret Manager bill,
low).

To rotate: set the new value as the corresponding `.env.deploy` variable (or
pass it as an env var to the deploy invocation) and re-run the deploy above —
`put_secret()` creates the new version and disables the old one
automatically. There is no separate manual rotation script.

## Database — Cloud SQL (was Neon until 2026-08-30)

**Production is currently on Cloud SQL** (`familyloop-postgres`, Postgres 16,
`us-central1-a`, database `household_hub`), reached via
`deploy-cloud-run.sh`'s default Cloud SQL path (Unix socket over
`--add-cloudsql-instances`, not a TCP `DATABASE_URL`). This is a switch made
during the 2026-08-30 incident below, not the original design - the app
still fully supports an external `DATABASE_URL` (Neon, Supabase, etc.) if
`.env.deploy` sets one, see `USE_CLOUD_SQL` in `scripts/deploy-cloud-run.sh`.
`.env.deploy` has Neon's old connection string commented out rather than
deleted, in case of a deliberate move back once Neon's plan/quota is sorted.

**Automated nightly backup**: Cloud Scheduler job `familyloop-backup-db`
(`us-central1`) hits `POST /api/internal/backup-db` every night at 11:50 PM
America/New_York, authenticated with the same `NOTIFICATION_SECRET` bearer
token as the notification worker. The endpoint runs `pg_dump` (via
`postgresql-client-16`, installed in the Dockerfile from the PGDG apt repo -
Debian bookworm's own repo only has v15, and pg_dump must be the same or
newer major version than whatever Postgres it's dumping from) and uploads
the dump to
`gs://familyloop-documents-solid-coder-212120/backups/familyloop-YYYY-MM-DD.dump`,
pruning anything older than 14 days. `runPgDump()` (server/index.js) builds
its `pg_dump` invocation the same way as the app's own connection pool -
Cloud SQL over the `/cloudsql/<connection-name>` Unix socket with
`-h`/`-U`/`-d`/`PGPASSWORD`, or a plain `DATABASE_URL` for an external
database - so this switched over automatically with the rest of the app
when production moved to Cloud SQL; it doesn't assume one provider.

**Manual backup/export** (same format, run it yourself anytime):

```bash
pg_dump "$DATABASE_URL" -Fc -f backup-$(date +%Y%m%d).dump
```

**Restore into a fresh Neon database** (e.g. disaster recovery, or spinning
up a staging copy):

```bash
pg_restore --no-owner --no-acl -d "$NEW_DATABASE_URL" backup-YYYYMMDD.dump
```

After any restore, verify row counts match the source across all tables
before treating it as authoritative:

```bash
psql "$DATABASE_URL" -c "SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"
```

Neon autosuspends the compute endpoint when idle and resumes on the next
connection (a few hundred ms of added latency on a cold request) — this is
expected behavior, not a bug, and is part of why Neon is cheaper than an
always-on Cloud SQL instance for this app's traffic level.

## Adding a new environment variable / secret

1. Add it to `.env.deploy` locally (gitignored, real value).
2. Add it to `scripts/deploy-cloud-run.sh`: if it's a secret, add a
   `put_secret()` call + grant the Compute Engine default service account
   accessor role, then reference it in the `DEPLOY_ARGS` array passed to
   `gcloud run deploy`; if it's non-secret config, add it directly to
   `DEPLOY_ARGS` as a plain `--set-env-vars` entry.
3. Update the README's environment-variable list (see
   [README.md](../README.md)) so the next person deploying from scratch
   knows it's required.
4. Redeploy.

## Incident playbooks

### GCS uploads silently failing (documents never persist)

**Symptom**: Documents upload UI reports failure for every file (a past
incident: "886 of 886 files failed").

**Root cause (last time)**: `GCS_BUCKET` was unset in `.env.deploy` — the
deploy script defaults it to an empty string rather than hard-failing, so
the app ran with no bucket configured since the bucket was created.

**Check first**:
```bash
grep GCS_BUCKET .env.deploy
gcloud storage buckets list --project=solid-coder-212120
```
Confirm the bucket name in `.env.deploy` matches an actual bucket, redeploy,
then verify with a real upload → `gcloud storage ls gs://<bucket>/` →
delete → verify it's gone.

### Neon compute-time quota exceeded (whole site down, both domains 500)

**Symptom**: `/readyz` and every page 500 on both `familyloop.net` and
`famelo.net`. Cloud Run logs show the container repeatedly exiting on
startup - `gcloud logging read` shows `Container called exit(1)` preceded
by a Postgres error `code: '53000'` and the literal text `Your account or
project has exceeded the compute time quota. Upgrade your plan to increase
limits.` This happened once already (2026-08-23) on Neon's free tier.

**Root cause**: Neon suspends the compute endpoint entirely once the
account's compute-hour quota is exceeded - it refuses *every* connection
(not just new/heavy ones), including a bare `psql` connection with nothing
else attached. The startup migration step in `server/index.js` can't
connect, throws, and `process.exit(1)`s, which fails Cloud Run's TCP
startup probe and takes down the whole service, not just slow requests.

**Fix**:
1. Upgrade the Neon plan (or wait for the monthly quota reset) from the
   [Neon dashboard](https://console.neon.tech) - this is the only way to
   unblock the compute endpoint; nothing on the app or Cloud Run side can
   work around it.
2. Confirm it's actually reachable again: `psql "$DATABASE_URL" -c "select now();"`.
3. Redeploy (`bash scripts/deploy-cloud-run.sh`) even though no code
   changed - Cloud Run backs off retrying a crash-looping revision, so a
   fresh deploy is the fastest way to force an immediate clean startup
   attempt rather than waiting out the backoff window.
4. Health-check both domains per the standard post-deploy step.

**If downgrading back to free tier on purpose** (e.g. to test the limits):
take a fresh manual backup first (`pg_dump "$DATABASE_URL" -Fc -f ...`,
or just trigger `POST /api/internal/backup-db` and check
`gs://familyloop-documents-solid-coder-212120/backups/`) *before* the
downgrade, while Neon is still reachable - once it blocks, you cannot
pull anything out until it's unblocked again.

### Neon connection fails at startup (`no schema has been selected to create in`, code `3F000`)

**Root cause**: `DATABASE_URL` is pointing at the **pooled** (`-pooler`)
Neon endpoint. PgBouncer does not apply `ALTER ROLE/DATABASE ... SET
search_path`, and rejects `options=-c search_path=...` in the connection
string outright with an explicit "unsupported startup parameter" error.

**Fix**: use the direct/unpooled hostname (no `-pooler` suffix) in
`DATABASE_URL`. Diagnose via `gcloud logging read` on the failed revision if
this recurs.

### Reset/verify/invite emails going to the wrong domain

**Check first**: `.env.deploy`'s `APP_BASE_URL` — it drives every emailed
link (password reset, email verification, household invite). A stale value
here is the first thing to check for any "the link in my email is broken/
wrong domain" report.

### Notification worker not firing / duplicate reminders

Check `GET /api/test/notification-jobs` (test-mode only) or query
`notification_jobs` directly for rows stuck with `claimed_at` set but
`sent_at` null (a crashed worker run) — `attempts`/`last_error` show why a
job failed. The unique constraint on
`(household_id, source_type, source_id, recipient_email, due_at)` is what
prevents duplicate reminders across repeated state saves; if duplicates are
seen, check whether that constraint was bypassed by a schema change.

## Known open risk

### Household-switch race condition

Switching the active household while a debounced `autosaveState()` write
from the *previous* household is still in flight can overwrite data — the
shared-blob sync model ([ARCHITECTURE.md §4](ARCHITECTURE.md#4-request-lifecycle--hybrid-sync-model))
is last-write-wins with no per-household write ordering guarantee client-side.
**Tracked as open, not yet fixed** — flush (`saveStateNow()`) before a
household switch completes, or add a server-side check, before closing this
out.

## Shared-modules pattern (for any future family-wide feature)

Any feature that should be shared across a user's households (like
Documents and Decisions) must sync via `user_shared_modules` (keyed by
`owner_user_id`), not just live inside the per-household `app_state` blob —
otherwise it will silently appear to "reset" or differ every time the user
switches households. See [ARCHITECTURE.md §6](ARCHITECTURE.md#6-data-isolation-model).
