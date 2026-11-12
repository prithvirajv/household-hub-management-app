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

## Linked accounts (SimpleFIN Bridge / SnapTrade)

Code: `server/linked-accounts.js`; table `linked_accounts`; UI on the Wealth page. Stored credentials (a SimpleFIN access URL, a SnapTrade
user secret) are AES-256-GCM encrypted with `LINK_ENCRYPTION_KEY` and never returned to a client.

- `LINK_ENCRYPTION_KEY`: the deploy script reads it from `.env.deploy`, else from Secret Manager (`familyloop-link-encryption-key`), else
  generates one and stores it on the first deploy. **Losing it makes every stored link unreadable** — users would have to link again.
  Without it the feature reports "not configured".
- SimpleFIN needs nothing else (each user buys their own Bridge subscription). SimpleFIN URLs are pinned to `*.simplefin.org` to prevent
  server-side request forgery.
- SnapTrade (optional): `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` (secret `familyloop-snaptrade-consumer-key`), `SNAPTRADE_MODE`
  (`personal` = free single-user key, only `SNAPTRADE_PERSONAL_OWNER_EMAIL` may link; `commercial` = per-user registration, billed per
  connected user). Connections are always requested read-only.
- **Nightly sync:** Cloud Scheduler job `familyloop-linked-sync` (created/updated by `scripts/deploy-cloud-run.sh`, 03:30
  America/New_York) calls `POST /api/internal/linked-accounts/sync-all` with the `NOTIFICATION_SECRET` bearer token. It fetches every active
  link and **stages** the result in `linked_accounts.staged` (accumulating SimpleFIN transactions by id for up to 120 days), then **applies
  it to each household's state on the server** (`autoApplyHousehold` in `server/linked-accounts.js`, pipeline in `lib/linked-apply.js`:
  drafts, balance reconcile, salary detection, AI categorization via the same Gemini batch call as the app, safe rows into the ledger). Staged
  data is cleared only after the save lands. A household can switch it off (`linkedAutoApply: false` in its state, a checkbox on the Linked
  accounts card); then, or if an apply fails (the link shows the error), data stays staged and a client applies it when the app is next
  opened (`POST /:id/ack` clears it), as before. Manual syncs from the app still stage and apply client-side; both paths skip ids the household
  already has, so they never double up. The job pushes "N new bank transactions added to your ledger (M need a look)" (or "waiting to review"
  when it did not apply) and a one-time "needs signing in again". Links needing reconnection are skipped until relinked.
- **Proving the night's sync loaded:** every link records its run in `linked_accounts.last_run` (`{at, ok, stage: fetched|applied|waiting|fetch|apply,
  imported, added, left, error}`, returned by `GET /api/linked-accounts`); each bank-fed account carries `syncedFrom` / `syncedThrough` /
  `lastSyncedAt` in the household state. The apps show them (status line, "Synced through" tag, a Home card when something is off), the Home AI
  summary is given them, and a failed run sends a phone notification. A second Cloud Scheduler job `familyloop-linked-sync-retry` (06:30 ET,
  body `{"retry":true}`, created by `scripts/deploy-cloud-run.sh`) re-runs only links whose last run did not finish cleanly or is over 8 hours
  old.
- **State versioning (why the server can write household state safely):** `households.state_version` is bumped by every write to
  `app_state`; the overnight job reads it and writes only if it is unchanged (retrying up to 3 times, reusing AI answers already fetched), and
  re-lays the owner's shared modules at write time so a note edited from another household meanwhile is not lost. `households.applied_version`
  is bumped **only** when the server itself applies linked-account data. `GET /api/state` returns it in `X-State-Version` (`GET
  /api/state/version` is the cheap poll); the apps send it back on `PUT /api/state` as `X-Base-Version`, and a save based on an older value
  gets **409** ("updated elsewhere") instead of overwriting the overnight apply - the web app then reloads and tells the person. Ordinary saves
  from several tabs or devices never move it (they are last-writer-wins, as before: an earlier version of this check compared every write and
  threw away imports whenever a second tab saved). Clients that send no version (older mobile builds) save unconditionally, so until a mobile
  build that sends it ships, a stale phone save can erase an overnight apply (the next night's overlap window re-delivers the last ten days;
  use Import history for older rows).
- **Ledger entries are never removed automatically:** `PUT /api/state` also refuses (409) a save that would drop any stored ledger entry carrying a
  bank id (`externalId`) unless the request has `X-Allow-Shrink: 1`, which the apps send only for a person's own removal (delete, move to Transfers,
  split entirely with friends, Clean up; a 10-second window so the follow-up autosave carries it). Salary detection no longer removes ledger rows
  (it only skips deposits still waiting in Bank stream, and starts the paycheck at the next payday). The nightly catch-up (`retryWaitingDrafts`)
  re-decides every bank row still waiting in Bank stream, asking the AI at most once per row (`aiAskedAt`). The Bridge's own messages about a bank (e.g. "Auth required") are kept as `lastRun.notices` on the link (nightly and manual syncs) and shown on Home and to the AI summary; the fix is to re-authorise that bank in SimpleFIN Bridge. Per-account sync: `POST /:id/sync` accepts `accountIds` (remote ids, ignored unless mapped; all of them = a full sync), passes `account=` to SimpleFIN, marks the payload `subset`, and `mergeStagedPayload` then unions accounts and keeps `fullAt` (last full fetch) - `/ack` moves the link's `last_sync_at` to `staged.fullAt` only (never for a subset or when `discard:true`). Adding accounts to a link that already has some no longer nulls `last_sync_at`; the mappings response returns `addedRemoteIds` and the clients backfill just those from the first of last month. Sync anchoring: a link's `last_sync_at` (where the next SimpleFIN fetch starts, minus `SIMPLEFIN_OVERLAP_DAYS` = 10 days) moves only when its data is loaded - the nightly run sets it after `autoApplyHousehold` applied the link's rows, a manual sync sets it on `/ack` - never at fetch time; each run records `lastRun.sinceDate`. The nightly fetch also reaches back to the oldest `syncedThrough` of the link's mapped accounts that are 2+ days behind (a bank connection that stopped refreshing; `behindAccountsSince`, capped at `SIMPLEFIN_CATCH_UP_MAX_DAYS` = 50 so it stays one request) so rows a recovered connection delivers late are made up. Per-account `syncedFrom/syncedThrough/lastSyncedAt` are stamped at the end of `applyLinkedPayload`, and not at all when a window failed. A third scheduler job (`familyloop-linked-sync-catchup`, 14:30 ET, `{"retry":true,"maxAgeHours":20}`) syncs links whose last clean run is over 20 hours old; Home warns when a link has had no run for 30 hours. Ask FamilyLoop: `POST /api/assistant/plan` (session required, 500-char request, 20 KB id summary from `assistantContext`, optional 12 KB `facts` text from `assistantFacts` - the household's own numbers, which the model must answer questions from, returned as `answer`) asks Gemini for actions from the fixed `ASSISTANT_ACTIONS` set; `parseAssistantPlan` drops anything unknown or naming an id not in the summary, the client re-checks with `assistantActionProblem`, writes the confirmation with `describeAssistantAction`, and applies with `applyAssistantActions` (returns a patch plus an undo patch; nothing is deleted, no transactions are touched). Mobile: `src/assistantLogic.ts`. Category learning: a hand-picked Subcategory sets `transactionCategorizationRules` (exact key + loose `payeeLearnKey`, with display labels in `transactionCategorizationRuleLabels`; `setCategorizationRule`, `lookupCategorizationRule`, `planCategoryRelearn` in `lib/shared-logic.js`), rules beat history, and the server apply (`lib/linked-apply.js`) uses the same lookup. Web Bank stream also offers confirm-first bulk actions over every month (`planBulkTransfers`, `planBulkDuplicateSkips` in `lib/shared-logic.js`): pairs of waiting rows between own accounts become one transfer each, and certain duplicates are dropped; `planBulkLedgerTransfers` (web + mobile) also offers, after a confirm that lists them, pairs of one waiting row and one unsplit ledger entry that are each other's only candidate: it records the transfer, clears the row and removes that ledger entry (sent with the one-off shrink allowance). Repeat guards (web + mobile), counted by bank rows: one outgoing + one incoming row = one transfer, two of each = two. Transfers made from rows store `sourceIds` (`transferSourceIds`); `planDuplicateTransferRemoval` flags identical transfers (`transferKey`) only when they lack distinct `sourceIds`, and backs a confirm-first "Remove N extras" button. `findDuplicateTransfer` asks before a typed transfer, and before moving a row with no other half, that matches an existing transfer. `rowsCoveredByTransfers` lets a recorded transfer cover one statement row per side (a transfer's rows are cleared, so a re-import would bring them back); a known bank id is also left out. Web also asks before a manual Ledger entry identical to one already there. Learning (web + mobile): `learnedExamples`/`learnedAccountExamples` (shared-logic.js, `bankStreamLogic.ts`) send the household's rules and recent categorized ledger rows as `examples` on `/api/transactions/suggest-batch|suggest-subcategory|suggest-account` and in the overnight apply (`linked-apply.js` passes them as the fifth `suggest` argument); the server (`cleanLearnedExamples`) keeps only offered line/account ids, strips line breaks and `|` from payees and adds a "Decisions this household has already made" section the model must follow. Bulk ledger category changes learn every payee (`learnPayeeLine` / `learnFromBulkLineChange`); deleting a Ledger row or skipping a Bank stream row stores `removedRowSignatures` (date|cents|direction|payee, capped at 3000) and statement imports leave matching rows out one per removal (`rowsAlreadyRemoved`); deleting/reassigning a Subcategory retargets or drops its rules. Paycheck learning (web + mobile): deleting a Ledger deposit or skipping a Bank stream deposit calls `planPaycheckLearning` (payer key from `depositPayerKey`, the paycheck's deposit account, pay wording, closest amount) and `applyPaycheckLearning`, which stores the payer in `paycheck.depositPayeeKeys` and, only after a confirm when the amount differs, sets the paycheck amount plus the nearest and later occurrences still at the old amount (past ones untouched). `matchesRecordedPaycheck(draft, occurrences, paychecks)` then holds a learned payer's deposit near a payday whatever its amount, on the client and in the server's overnight apply. A client AI pass over `AI_IMPORT_PASS_TIMEOUT_MS` (4 min) is marked stale and the button re-enabled.
- **Shrink guard (why a stale tab cannot wipe the ledger):** `PUT /api/state` refuses (409, "updated elsewhere ... would have removed most of your
  ledger") a save whose `transactions` has fewer than half the rows currently stored when the stored ledger has 40 or more, unless the request
  carries `X-Allow-Shrink: 1` (sent only by the Clean up tool, web and mobile). The case it exists for: a second tab or device that loaded the
  household before an import keeps autosaving its older copy (the live-price refresh saves every 5 minutes) and each save replaced the imported
  ledger - visible in the logs as `PUT /api/state` request sizes dropping back to the pre-import size at :x3:35 every five minutes. Old mobile
  builds do not send the Clean up header, so Clean up from an old build is refused until updated.
- **AI categorization limits:** `geminiBatchSuggest` goes to the next model (`GEMINI_FALLBACK_MODELS`, default `gemini-2.5-flash,gemini-2.5-flash-lite`)
  on a 429/5xx/404, then once more round the list after a pause, and logs each failed attempt (`Gemini batch suggest <model> attempt N failed:
  HTTP ...`). "This model is currently experiencing high demand" 503s from the main model are common and last minutes. Rows the AI could not
  categorize still go into the ledger as "Needs a category"; after each night's apply, `fillUncategorizedLedgerRows` asks the AI again for those
  (up to 75 a night, high-confidence answers only) and marks them "Categorized by AI".
- **Reading what a night did:** each household's apply logs `Overnight linked apply: household <id> {applied, imported, added, left, uncategorized,
  reasons, aiNote}` (counts only) and `Overnight AI fill-in: ... categorized N`; the sync-all request itself is logged with its latency.

### Investment accounts that hold their own holdings (`account.holdingsGroupId`)

An Investment account can point at a holdings group inside it. `accountBalance` = `accountCashBalance` (opening + ledger + transfers, the old formula) + `holdingsGroupTotal`. The account's net worth line (`netWorthAssetId`) carries only the **cash** (`accountNetWorthValue`), because the holdings are net worth lines of their own - using the full balance there double-counts. Any code that builds an `accountBalance` context must pass `assets` (`state.goals.netWorth.assets`), or a backed account silently reads as cash only. A SimpleFIN sync of such an account does not rewrite the opening balance: it sets the group's "balance adjustment" holding to `bank balance - cash - listed holdings` (never negative). Web only has the UI (Track holdings / Stop tracking); mobile has the logic but no control yet. In the web UI every account with `type === "investment"` or a `holdingsGroupId` (`isInvestmentAccount`) is listed in the Net worth **Investments** group using `netWorthStockGroupCard` (the same card as a loose holding) via `investmentAccountCard`; its account fields live behind an Edit account toggle (`wealthEditingAccounts`), and other account types keep `accountItemRow`.

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

### Investments page

A page of its own (`renderInvestments` in `app.js`, numbers from `lib/investments-logic.js`, loaded as a third classic script, so its top-level
names start `investments` / `INVESTMENT`). It reads the holding-class net-worth assets (stock and retirement, one group per account) and
changes none of them except `price`, `value` and `priceUpdatedAt` when Refresh prices runs (one `/api/stock-quote` per distinct ticker). Its own
choices are saved in `state.goals.investmentsView` (`{ targets: {us,intl,bond,cash}, groups: {groupId: {owner, tax}}, classes: {TICKER: type} }`,
cleaned by `investmentsSanitizeMeta`), inside the existing `goals` object so no new top-level state key is needed. A ticker's fund type is the
household's choice, else a built-in guess (`INVESTMENT_KNOWN`, target-date and money-market names, a 5-letter ticker ending in X as a broad
index, no ticker as "Other / not sure", otherwise a single stock). Alerts: one non-broad position over 10%, employer stock over 10%, sector funds
over 8% together. The page is a grid item with auto margins, so `.inv` needs `width: 100%` and `min-width: 0` or a wide table widens the whole
page. The phone app does not have this page yet.

### Recipe import from a video or photos

`POST /api/recipes/import` (`lib/recipe-import.js`, route in `server/index.js`) sends a public YouTube link (rebuilt from its 11-character
id, so no other address reaches the AI) and/or up to four photos to Gemini as one request (`geminiGenerate`, the same fallback models as the
text helper, 150 s per attempt) and returns a cleaned DRAFT: name, ingredients, steps, tips (all `important: true`), calories, protein, source
link. It saves nothing; the Recipes page shows a review form and only "Add recipe" writes the recipe (`state.meals.recipes[]` now also holds
`steps`, `tips[{text, important}]` and `sourceUrl`; older recipes without them still render). Each person may start 10 imports an hour
(in-memory, per instance; Cloud Run runs one). Errors: 400 bad link/photo, 422 no recipe found, 429 hourly limit, 502 the AI failed (its message
is passed on, for example a private video), 503 no `GEMINI_API_KEY`, 504 timeout. A long video is expensive: one 19-minute video was about 75,000
prompt tokens and 50 seconds. Ingredient items never contain commas (the recipe form stores ingredients as a comma-separated list).

### A card or bank shows "synced" but its newest charges are missing

Credit cards (Citi, Apple Card) list new purchases as *pending* for a day or more, and a pending row can still change or vanish, so no
sync imports it. Every sync (overnight, or in the app) now keeps each account's pending rows on the account (`account.pendingRows`, newest
first, at most 25, replaced on every sync that the bank answered for; `markAccountsPending` in `lib/shared-logic.js`). The Transactions page shows them
in a read-only "Pending at your banks" card above Bank stream, and the Linked accounts line says how many are waiting. They are never in
the ledger, budget or balances, and each leaves the list when the bank posts it. The nightly log line now carries `"pending": N` next to
`"imported"`: `imported 0` with `pending > 0` means the bank sent the rows but they have not posted yet; `imported 0` with `pending 0` means
the bank sent nothing (check the SimpleFIN Bridge messages for an "Auth required" connection).

### Database data transfer (Neon, or any host that bills egress)

The worker's 30-minute refresh (`refreshAllHouseholdNotificationJobs`) runs for every household, so it reads only what the reminders use
(`NOTIFICATION_STATE_SQL`: time zone, the calendar, and notes that carry a reminder), about 12% of a household's stored state. Before this it
downloaded every whole state, 48 times a day. If `notificationCandidates` ever reads another part of the state, add it to that query
(`test/notification-refresh-query.test.js` fails when they drift apart). Cloud SQL's own `network/sent_bytes_count` metric is dominated by
the instance's housekeeping traffic (a flat ~141 MB an hour) and is not the figure Neon would bill.

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

### Debt and liability pairing (self-healing)

Each debt in `state.goals.debts` shares its id with a liability in `state.goals.netWorth.liabilities`. `ensureDebtNetWorthSync` (app.js) runs on every Wealth render and calls `pairDebtsWithLiabilities` (lib/shared-logic.js): a debt without a liability gets one at the debt's balance, or adopts an unclaimed liability with the same name (accounts pointing at it follow the new id). It never deletes anything, and liabilities with no debt are left alone. An activity entry "Paired a debt with its liability in Wealth" marks a repair.

### Re-categorised debt payments

`ensureDebtPaymentsAppliedFromLedger` first calls `unapplyOrphanedDebtPayments` (lib/shared-logic.js) for each debt linked to a category. A remembered `appliedPaymentSignatures` entry (`date|amount`) with no transaction left in that category means the transaction was moved or deleted: the matching payment (same `date|amount`) is removed from the debt's history, its principal is added back to the balance and liability, and the signature is forgotten so the transaction applies to its new debt. Signatures with no payment (bank-matched or removed by hand) are only forgotten. Runs when Wealth renders and saves on change. Mobile does not apply ledger payments to debts, so it needs no counterpart.

### Scroll position of inner lists

`render()` rebuilds the whole page on every edit. Lists with their own scrollbar (`INNER_SCROLL_SELECTORS` in app.js: the ledger list and the tag transaction list) have their `scrollTop` captured before the rebuild and restored after it, as long as the page and month are unchanged. Add any new scrollable list to that array.

### Same bank transaction through two connections

Re-authorising a bank in SimpleFIN Bridge can return its accounts with new ids, and a joint account can be visible through two logins; the same transaction then arrives with a different transaction id and the id check misses it. `selectNewLinkedTransactions` (lib/shared-logic.js) takes the existing ledger and Bank stream rows and skips an incoming row that matches one from a *different* remote account on the same app account, same date, same amount and same payee text (digits and masking ignored); skipped ids are remembered in `linkedImportedIds`. Equal purchases from the same remote account are kept. `findCrossConnectionDuplicates` finds copies already in the ledger (the copy with a category, split or tags is kept); Transactions shows a note with a one-click "Remove the extra copies" button. Mobile's in-app sync does not have the guard yet (the overnight server sync does).

`crossConnectionTwinsOf` makes a row split entirely with a friend take its twin (same bank transaction under another remote account) out of the ledger with it. `findRowsAlreadyShared` finds a bank-fed ledger row that matches Shared Expenses records for the same account, date and payee text and adds up to its amount (a leftover twin from before that change); Transactions offers to remove it.

### Paycheck choice when a deposit is removed

`rankPaychecksForDeposit` (lib/shared-logic.js) orders the "Which paycheck" list: paychecks matching both the payer's name (a learned payer key beats a shared word) and a payday within 7 days of the deposit date come first, then name match, payday nearness, the account paid into, and amount closeness. `paydayNear` finds the payday from the paycheck's own schedule; the dropdown shows it as "· payday Nov 6". `planPaycheckLearning` also prefers a payday within a week before falling back to the closest amount.

### Partners page (shared rental properties)

`state.partners` = `{ properties: [{id,name}], partners: [{id,name}], shares: {propertyId: {partnerId: pct}}, defaultShares: {partnerId: pct}, rules: [{id, match, kind, propertyId, partnerId}], accountIds: [] }`. Nothing is derived into state; `buildPartnersStatement` (lib/partners-logic.js, a classic script loaded after shared-logic.js and before app.js, every top-level name prefixed `partners`/`PARTNER`) reads the ledger on each render. A rule matches when all its words appear as whole words in the payee (`partnersRuleMatches`); the first match wins; kinds are in `PARTNER_KINDS` (`personal` rows are excluded). Money in is a negative transaction amount, so rent, interest and contributions are `-amount`. Per partner: `share` = sum over properties of (their normalised % of that property) x (its result); `balance` = contributed + share; `toSquare` = effective % x total contributions - contributed (sums to zero); `suggested` = effective % x average shortfall over the last three months with costs. `partnersSanitizeConfig` cleans an imported setup (caps list sizes, drops unknown kinds and dangling property/partner ids). Mobile has no Partners page yet.

**Partners-only account.** A bank link account mapped to `accountId: "partners-pool"` (`PARTNERS_POOL_ID`, the "Partners page only (not in Wealth)" choice) is not a Wealth account: `applySimplefinPayload` (lib/linked-apply.js) and `applySimplefinSync` (app.js) take its posted rows out before Bank stream/ledger handling and merge them into `state.partnerTransactions` (`partnersMergeBankRows`: skips known ids; a bank row matching an unmatched CSV row by date and amount adopts that row instead of duplicating), remember the ids in `linkedImportedIds`, and keep its bank balance in `state.partnerPoolBalance`. Rows from a CSV go through `partnersParseCsv` (money in positive by default; M/D/YY accepted) and `partnersMergeCsvRows` (adds only as many rows per date and amount as the file has beyond what is already kept). The Partners page reads `partnerTransactions` plus the ledger rows of any ticked account. Nothing from this account reaches the budget, reports or net worth. SimpleFIN names and payees have U+FFFD replacement characters stripped (`cleanBankText`).

### Partners groups (sharing the Partners page by email)

Tables `partner_groups` (name, `owner_user_id`, `setup` JSONB = the Partners config, `tx_rows` JSONB = the shared account's rows, `pool_balance`, `version`) and `partner_group_members` (`group_id`, lowercase `email`, `role` owner|edit|view) in server/schema.sql; routes and storage (in memory for tests/demo, Postgres otherwise) in server/partner-groups.js. A group belongs to no household. A person can open it when they own it (by user id) or their **verified** login email is in `partner_group_members` (`PARTNER_GROUPS_ALLOW_UNVERIFIED_EMAIL=true` relaxes that for tests only); someone who is not a member gets 404, a view member gets 403 on writes, only the owner manages members, clears rows, renames or deletes. Routes: `GET/POST /api/partner-groups`, `GET/PATCH/DELETE /api/partner-groups/:id`, `PUT .../setup` (sanitised with `partnersSanitizeConfig`, optimistic `version`, 409 on a stale save), `POST/DELETE .../rows` (`mode: "csv"` or `"bank"`, merged without duplicates, capped at 20,000 rows), `POST/PATCH/DELETE .../members[/:memberId]` (adding sends an email). Group data is not part of any household state, so it is not in `PUT /api/state` and not limited by its 1 MB cap.

Feeding a group: a household's bank link maps the shared account to `accountId: "partners-pool"`; `applySimplefinPayload` keeps those rows in that household's `state.partnerTransactions` (the inbox). `state.partnerGroupId` names the group this household feeds. The overnight job (`autoApplyHousehold` in server/linked-accounts.js) calls `forwardHouseholdPartnerRows`, which checks the household's owner owns the group, merges the rows (bank mode) and balance into the group, and only then empties the inbox; the app does the same when the owner opens the Partners page. A household can never write into a group it does not own. In the app, `partnersGroup` holds the open group; setup edits go through `partnersSave()` (one PUT after another, each with the version it was based on).

The overnight forward (`forwardHouseholdPartnerRows`) also runs `assignNewRowsWithAi` when the AI is configured: new rows no rule matches (and which carry no choice of their own) are sent in one batch with the decisions already made as examples; only `confidence: "high"` answers are stored, as per-row `overrides` in the group setup (version-checked, retried on conflict). An AI failure never stops the rows from landing.

### Partners: categories, withdrawals, amounts, report link

`PARTNER_KINDS` (lib/partners-logic.js) carries a `group` (income, cost, partner, leave); `setup.customKinds` ([{id, label, group: "income"|"cost"}], max 30) adds the group's own, merged by `partnersKindList`. Costs other than loan/HOA/repair share the "other" column; `byKind` gives the by-category totals. A `withdrawal` row (with a partner) counts in that partner's `withdrawn`: balance = sent in - withdrawn + share of the result; `toSquare` uses sent in minus withdrawn; pool `cash` = sent in - withdrawn + result. A row's amount can be corrected with `overrides[rowId].amount` (money IN; negative flips it to money out): it is stored apart from the kind/property/partner choice (`partnersSetChoice` / `partnersSetAmount` in app.js keep them independent) and the bank's own figure stays on the row (`originalMoney`). Rows added by hand (`POST /api/partner-groups/:id/rows/manual`, source `manual`, id `m-...`) are the only rows `DELETE .../rows/:rowId` removes.

Report link: table `partner_group_shares` (`group_id` primary key, unique `token` = 24 random bytes base64url, `show_transactions`). Owner-only `GET/POST/DELETE /api/partner-groups/:id/share` (POST again only changes the option; DELETE then POST makes a new token). `GET /partners/share/:token` (no session) renders `renderPartnerReportHtml` (server/partner-report.js): a script-free page with `noindex`, `no-store` and `no-referrer`, the figures only (never emails, rules or the household), `?period=all|12|3|month`. An invalid or revoked token is a 404.

Ask FamilyLoop (`askAssistant` in app.js) appends `partnersAssistantFacts()` - a plain-text digest of the open Partners group (all time and last 3 months, properties, partners, categories, recent months; at most 3000 characters, the household facts cut to 8800 so the total stays under the server's 12000) - to the facts it sends; the group goes first when the question is asked from the Partners page. Groups are loaded on first use if the person has not opened Partners yet.

### Partners: tenant deposits

Kinds `deposit_in`, `deposit_out`, `deposit_kept` (group `deposit`). Per property: `depositIn`, `depositOut`, `depositKept`, `depositHeld` = in - out - kept; `deposit_in/out` are neither income nor cost (cash only), `deposit_kept` moves the amount from held to income with no cash movement, so `pool.cash` = sent in - withdrawn + result + `pool.depositsHeld`. Properties carry optional `tenant` and `leaseEnd` (setup, sanitised); the page raises a notice when held > 0 and the lease ends within 60 days or has ended. The shared report shows held amounts and lease status, never `tenant`. The Setup section is rendered even before any rows exist (`partners-statement-wrap` is hidden instead).

### Partners: agreed monthly contribution

`setup.monthlyContribution = { amount, startMonth: "YYYY-MM" }` (both required; `partnersSanitizeConfig` drops it when the amount is not positive or the month is invalid, so the Setup fields in app.js save only when both make sense, or delete it when the amount is cleared). `partnersContributionPlan(config, transactions, nowMonth)` (lib/partners-logic.js) reads ALL of the group's rows, not the period the page shows: per partner and month from `startMonth` to `nowMonth` it sums the rows classified as `contribution` for that partner (an edited row amount counts; contributions naming no known partner are summed in `unassigned`). A cell is `paid` (that month's own money >= amount), `covered` (an earlier month's surplus paid it; only a surplus carries into later cells, a month missed earlier stays `missing` in the grid), `partial` (with `short`), `missing` (nothing, month already ended) or `pending` (the current month). Per partner: `sent`, `expected` = amount x months, `behind` = max(0, amount x completed months - sent) so extra sent earlier carries forward, `dueNow`, `ahead`, `monthsBehind`, `status` behind|due|paid. The Partners page renders it as the Monthly contribution card (notice when anyone is behind, summary table, grid of the latest 36 months), the shared report renders the same, and `partnersAssistantFacts` adds an AGREED MONTHLY CONTRIBUTION line. Nothing is stored beyond the two setup fields.

### Import parity (overnight vs in-app)

The overnight pipeline (lib/linked-apply.js) and the in-app import (app.js `addBankStreamRows` + `runAiImportPassOnce`) apply the same rules in the same order: skip ids already imported or twins of a row from another remote account, skip rows covered by a recorded transfer (`rowsCoveredByTransfers`) or like ones deleted before (`rowsAlreadyRemoved`), skip rows a removal rule says to skip, then per row refund match, the household's category rule, history, salary detection, AI for the gaps (high confidence only), then `autoAcceptDecision` (duplicate, transfer, refund, removal-rule hold, closed account, paycheck match). `buildDrafts` previously lacked the transfer-covered and deleted-before checks; it has them now. Partners groups follow the same idea: rows the rules read count at once, and `assignNewRowsWithAi` (high confidence only, chunks of 60, up to 120 rows) runs for rows from the overnight forward and from a CSV import alike. Keep the two Bank stream pipelines in step when changing either.
