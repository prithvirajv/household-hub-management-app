const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const nodemailer = require("nodemailer");
let bcrypt;
try {
  bcrypt = require("bcrypt");
} catch (_error) {
  bcrypt = require("bcryptjs");
}
const { Pool } = require("pg");
const { OAuth2Client } = require("google-auth-library");
const { countries } = require("countries-list");
const { defaultState } = require("./default-state");
const { validateJournalPayload, buildDocumentObjectPath, wouldCreateFolderCycle, SMS_CARRIERS, smsGatewayAddress, rollAnnualNotifyAtForward } = require("../lib/shared-logic");

const ANNUAL_EVENT_TYPES = ["birthday", "anniversary"];
const { createSignedUploadUrl, createSignedDownloadUrl, deleteObject } = require("./gcs");

const PORT = Number(process.env.PORT || 8080);
const SESSION_COOKIE = "hh_session";
const HOUSEHOLD_COOKIE = "hh_household";
const SESSION_SECRET = process.env.SESSION_SECRET || "local-dev-session-secret-change-me";
const DATABASE_URL = process.env.DATABASE_URL || "postgres://household_hub:household_hub_dev@localhost:15432/household_hub";
const DATABASE_SSL = String(process.env.DATABASE_SSL || "false").toLowerCase() === "true";
const CLOUD_SQL_CONNECTION_NAME = String(process.env.CLOUD_SQL_CONNECTION_NAME || "").trim();
const DB_USER = String(process.env.DB_USER || "").trim();
const DB_PASSWORD = String(process.env.DB_PASSWORD || "");
const DB_NAME = String(process.env.DB_NAME || "").trim();
const MEMORY_DB = String(process.env.MEMORY_DB || "false").toLowerCase() === "true";
const DEMO_EMAIL = "demo@familyloop.net";
const LEGACY_DEMO_EMAIL = "demo@householdhub.app";
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const ADMIN_NAME = String(process.env.ADMIN_NAME || "FamilyLoop Administrator").trim();
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
// No client secret needed here: the browser's "Sign in with Google" button
// returns a signed ID token directly, which this verifies against Google's
// public keys (fetched automatically by the library) and our client ID.
const googleAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// The single source of truth for "is this the platform administrator" --
// checked directly against the configured email rather than trusting the
// is_admin DB column in isolation, so admin access can never depend on that
// column being in a state it shouldn't be (it's already kept in sync with
// this same email on every schema migration and blocked from being toggled
// via the API, but this makes the actual policy explicit at the point of use).
function isPlatformAdminEmail(email) {
  return Boolean(ADMIN_EMAIL) && String(email || "").trim().toLowerCase() === ADMIN_EMAIL;
}
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const EMAIL_FROM = String(process.env.EMAIL_FROM || "FamilyLoop <no_reply@familyloop.net>").trim();
const APP_BASE_URL = String(process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const NOTIFICATION_SECRET = String(process.env.NOTIFICATION_SECRET || "").trim();
const NOTIFICATION_LEASE_MS = Math.max(50, Number(process.env.NOTIFICATION_LEASE_MS || "") || 10 * 60 * 1000);
const NOTIFICATION_MAX_ATTEMPTS = Math.max(1, Number(process.env.NOTIFICATION_MAX_ATTEMPTS || "") || 5);
const EXPO_PUSH_URL = String(process.env.NOTIFICATION_TEST_EXPO_URL || "").trim() || "https://exp.host/--/api/v2/push/send";
const SESSION_IDLE_MS = Math.max(
  1000,
  Number(process.env.SESSION_IDLE_MS || "") || Number(process.env.SESSION_IDLE_MINUTES || 30) * 60 * 1000
);
const TEST_EXPOSE_RESET_TOKEN = process.env.NODE_ENV === "test"
  && MEMORY_DB
  && String(process.env.TEST_EXPOSE_RESET_TOKEN || "false").toLowerCase() === "true";
const TEST_EXPOSE_NOTIFICATIONS = process.env.NODE_ENV === "test"
  && MEMORY_DB
  && String(process.env.TEST_EXPOSE_NOTIFICATIONS || "false").toLowerCase() === "true";
const TEST_FORCE_EMAIL_FAILURE = process.env.NODE_ENV === "test"
  && MEMORY_DB
  && String(process.env.NOTIFICATION_TEST_FORCE_EMAIL_FAILURE || "false").toLowerCase() === "true";
// Lets integration tests exercise the Google sign-in account-creation/linking
// logic by supplying already-"verified" claims directly, instead of a real
// signed Google credential -- avoids making real network calls to Google
// (or mocking a third-party library) just to test our own account logic.
const TEST_BYPASS_GOOGLE_AUTH = process.env.NODE_ENV === "test"
  && MEMORY_DB
  && String(process.env.TEST_BYPASS_GOOGLE_AUTH || "false").toLowerCase() === "true";

const pool = MEMORY_DB
  ? null
  : new Pool(CLOUD_SQL_CONNECTION_NAME
      ? {
          user: DB_USER || "household_hub",
          password: DB_PASSWORD,
          database: DB_NAME || "household_hub",
          host: `/cloudsql/${CLOUD_SQL_CONNECTION_NAME}`
        }
      : {
          connectionString: DATABASE_URL,
          ssl: DATABASE_SSL ? { rejectUnauthorized: false } : false
        });

const memoryDb = {
  users: [],
  households: [],
  memberships: [],
  invitations: [],
  sharedModules: [],
  loginEvents: [],
  passwordResetTokens: [],
  notificationJobs: [],
  pushDevices: [],
  privateData: [],
  documentFolders: [],
  documents: []
};

const app = express();
app.disable("x-powered-by");
app.use("/api/private-data/journal", express.json({ limit: "10mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(SESSION_SECRET));
app.use(express.static(path.join(__dirname, ".."), {
  setHeaders(res, filePath) {
    if (/\.(html|css|js)$/.test(filePath)) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

const mailTransport = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
    })
  : nodemailer.createTransport({ jsonTransport: true });

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendTransactionalEmail({ to, subject, text, html }) {
  try {
    const info = await mailTransport.sendMail({ from: EMAIL_FROM, to, subject, text, html });
    const accepted = Array.isArray(info.accepted) ? info.accepted.map(String) : [];
    const rejected = Array.isArray(info.rejected) ? info.rejected.map(String) : [];
    const queued = Boolean(SMTP_HOST) && accepted.some((address) => address.toLowerCase() === to.toLowerCase());
    const delivery = {
      queued,
      preview: !SMTP_HOST,
      messageId: info.messageId || "",
      accepted,
      rejected
    };
    if (!SMTP_HOST) {
      console.log(`[email preview] ${subject} -> ${to}`);
    } else {
      console.log(`[email queued] ${subject} -> ${to}; messageId=${delivery.messageId}; response=${info.response || "accepted"}`);
    }
    return delivery;
  } catch (error) {
    console.error(`Email delivery failed for ${to}:`, error.message);
    return { queued: false, preview: false, accepted: [], rejected: [], error: "Email delivery failed" };
  }
}

// A chore/event can now be assigned to several household members at once;
// every one of them with a known email gets their own reminder. Falls back
// to the household's own email only when there are no assignees at all
// (e.g. data saved before multi-assignee support, not yet migrated by the
// client's ensureAssigneesData()).
function recipientEmails(item, fallbackEmail) {
  const assignees = Array.isArray(item.assignees) ? item.assignees : [];
  const emails = [...new Set(assignees.map((assignee) => String(assignee?.email || "").trim()).filter(Boolean))];
  if (emails.length) return emails;
  return fallbackEmail ? [fallbackEmail] : [];
}

function notificationCandidates(appState, fallbackEmail) {
  // Reminder emails display "Due <date/time>" using this timezone (captured
  // from whichever browser last rendered the app, see app.js's render()) so
  // the displayed time matches what the household actually typed in, instead
  // of whatever timezone the server container happens to be running in.
  const timeZone = appState?.household?.timeZone || "UTC";
  const candidates = [];
  for (const event of appState?.calendar?.events || []) {
    if (!event.id) continue;
    // Birthdays/anniversaries recur every year, so a stale notifyAt (e.g. from
    // an event nobody has revisited since it was added) needs to keep rolling
    // forward. Rather than recomputing the due date from scratch here — which
    // would re-derive the hour/minute using the server's own ambient timezone
    // (typically UTC on Cloud Run) and silently disagree with whatever the
    // client correctly localized to the user's real timezone — we only
    // advance the client's already-correct instant by whole years.
    if (ANNUAL_EVENT_TYPES.includes(event.type)) {
      if (Number(event.reminderDays || 0) < 0) continue;
      const dueAt = rollAnnualNotifyAtForward(event.notifyAt);
      if (!dueAt) continue;
      for (const email of recipientEmails(event, fallbackEmail)) {
        candidates.push({ sourceType: `calendar-${event.type}`, sourceId: event.id, title: event.title || "Calendar reminder", email, dueAt, timeZone });
      }
      continue;
    }
    if (!event.notifyAt) continue;
    for (const email of recipientEmails(event, fallbackEmail)) {
      candidates.push({ sourceType: `calendar-${event.type || "event"}`, sourceId: event.id, title: event.title || "Calendar reminder", email, dueAt: event.notifyAt, timeZone });
    }
  }
  for (const chore of appState?.calendar?.chores || []) {
    if (!chore.notifyAt || !chore.id) continue;
    for (const email of recipientEmails(chore, fallbackEmail)) {
      candidates.push({ sourceType: "calendar-chore", sourceId: chore.id, title: chore.title || "Chore reminder", email, dueAt: chore.notifyAt, timeZone });
    }
  }
  for (const note of appState?.notes?.entries || []) {
    if (!note.reminderAt || !note.id || note.trashed) continue;
    candidates.push({ sourceType: "note", sourceId: note.id, title: note.title || "Note reminder", email: fallbackEmail, dueAt: note.reminderAt, timeZone });
  }
  return candidates.filter((item) => item.email && !Number.isNaN(new Date(item.dueAt).getTime()));
}

async function syncNotificationJobs({ householdId, appState, user }) {
  const candidates = notificationCandidates(appState, user.email);
  if (MEMORY_DB) {
    memoryDb.notificationJobs = memoryDb.notificationJobs.filter((job) => job.household_id !== householdId || job.sent_at);
    for (const item of candidates) {
      const recipient = memoryDb.users.find((candidate) => candidate.email.toLowerCase() === item.email.toLowerCase());
      memoryDb.notificationJobs.push({ id: crypto.randomUUID(), household_id: householdId, user_id: recipient?.id || null, source_type: item.sourceType, source_id: item.sourceId, title: item.title, recipient_email: item.email, due_at: item.dueAt, time_zone: item.timeZone, sent_at: null, claimed_at: null, attempts: 0, last_error: null });
    }
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM notification_jobs WHERE household_id = $1 AND sent_at IS NULL", [householdId]);
    for (const item of candidates) {
      await client.query(
        `INSERT INTO notification_jobs (household_id, user_id, source_type, source_id, title, recipient_email, due_at, time_zone)
         VALUES ($1, (SELECT id FROM users WHERE lower(email) = lower($2) LIMIT 1), $3, $4, $5, $2, $6, $7)
         ON CONFLICT (household_id, source_type, source_id, recipient_email, due_at) DO NOTHING`,
        [householdId, item.email, item.sourceType, item.sourceId, item.title, item.dueAt, item.timeZone]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function sendExpoPush(tokens, title) {
  if (!tokens.length) return { sentCount: 0, invalidTokens: [] };
  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tokens.map((token) => ({ to: token, title: "FamilyLoop reminder", body: title, sound: "default" })))
    });
    const body = await response.json().catch(() => ({}));
    const tickets = Array.isArray(body.data) ? body.data : [];
    let sentCount = 0;
    const invalidTokens = [];
    tokens.forEach((token, index) => {
      const ticket = tickets[index];
      if (ticket?.status === "ok") sentCount += 1;
      else if (ticket?.details?.error === "DeviceNotRegistered") invalidTokens.push(token);
    });
    return { sentCount, invalidTokens };
  } catch (error) {
    console.error("Expo push send failed:", error.message);
    return { sentCount: 0, invalidTokens: [] };
  }
}

async function prunePushDevices(tokens) {
  if (!tokens.length) return;
  if (MEMORY_DB) {
    memoryDb.pushDevices = memoryDb.pushDevices.filter((device) => !tokens.includes(device.token));
    return;
  }
  await pool.query("DELETE FROM push_devices WHERE token = ANY($1)", [tokens]);
}

// Formats an absolute UTC instant in the household's own timezone (captured
// from the browser, see app.js's render()) so the displayed due time matches
// what was actually typed in, rather than the server container's timezone.
function formatDueLabel(dueAt, timeZone, dateStyle) {
  try {
    return new Date(dueAt).toLocaleString("en-US", { dateStyle, timeStyle: "short", timeZone: timeZone || "UTC" });
  } catch (_error) {
    return new Date(dueAt).toLocaleString("en-US", { dateStyle, timeStyle: "short", timeZone: "UTC" });
  }
}

function sendReminderEmail({ email, title, dueAt, timeZone }) {
  if (TEST_FORCE_EMAIL_FAILURE) {
    return Promise.resolve({ queued: false, preview: false, accepted: [], rejected: [], error: "Forced test failure" });
  }
  const dueLabel = formatDueLabel(dueAt, timeZone, "medium");
  return sendTransactionalEmail({
    to: email,
    subject: `Reminder: ${title}`,
    text: `FamilyLoop reminder: ${title}, due ${dueLabel}. Open ${APP_BASE_URL} for details.`,
    html: `<h2>FamilyLoop reminder</h2><p>${escapeHtml(title)}</p><p>Due ${escapeHtml(dueLabel)}</p><p><a href="${escapeHtml(APP_BASE_URL)}">Open FamilyLoop</a></p>`
  });
}

function sendReminderSms({ phone, carrier, title, dueAt, timeZone }) {
  const gatewayAddress = smsGatewayAddress(phone, carrier);
  if (!gatewayAddress) return Promise.resolve({ skipped: true });
  if (TEST_FORCE_EMAIL_FAILURE) {
    return Promise.resolve({ queued: false, preview: false, accepted: [], rejected: [], error: "Forced test failure" });
  }
  const dueLabel = formatDueLabel(dueAt, timeZone, "short");
  const body = `FamilyLoop: ${title} - due ${dueLabel}`;
  return sendTransactionalEmail({ to: gatewayAddress, subject: "", text: body, html: body });
}

function claimDueNotificationJobsMemory(limit) {
  const now = Date.now();
  const eligible = memoryDb.notificationJobs.filter((job) => {
    if (job.sent_at) return false;
    if (new Date(job.due_at).getTime() > now) return false;
    if (!job.claimed_at) return true;
    return new Date(job.claimed_at).getTime() < now - NOTIFICATION_LEASE_MS;
  });
  eligible.sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
  const claimed = eligible.slice(0, limit);
  const claimedAtIso = new Date(now).toISOString();
  claimed.forEach((job) => {
    job.claimed_at = claimedAtIso;
    job.attempts = Number(job.attempts || 0) + 1;
  });
  return claimed;
}

async function claimDueNotificationJobsDb(limit) {
  const result = await pool.query(
    `UPDATE notification_jobs
     SET claimed_at = now(), attempts = attempts + 1
     WHERE id = ANY(
       SELECT id FROM notification_jobs
       WHERE due_at <= now() AND sent_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < now() - ($1 || ' milliseconds')::interval)
       ORDER BY due_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, household_id, user_id, source_type, source_id, title, recipient_email, due_at, time_zone, attempts`,
    [String(NOTIFICATION_LEASE_MS), limit]
  );
  return result.rows;
}

async function markNotificationJobSent(jobId) {
  if (MEMORY_DB) {
    const job = memoryDb.notificationJobs.find((item) => item.id === jobId);
    if (job) job.sent_at = new Date().toISOString();
    return;
  }
  await pool.query("UPDATE notification_jobs SET sent_at = now() WHERE id = $1", [jobId]);
}

async function markNotificationJobGivenUp(jobId, errorMessage) {
  if (MEMORY_DB) {
    const job = memoryDb.notificationJobs.find((item) => item.id === jobId);
    if (job) {
      job.sent_at = new Date().toISOString();
      job.last_error = errorMessage;
    }
    return;
  }
  await pool.query("UPDATE notification_jobs SET sent_at = now(), last_error = $2 WHERE id = $1", [jobId, errorMessage]);
}

async function recordNotificationJobError(jobId, errorMessage) {
  if (MEMORY_DB) {
    const job = memoryDb.notificationJobs.find((item) => item.id === jobId);
    if (job) job.last_error = errorMessage;
    return;
  }
  await pool.query("UPDATE notification_jobs SET last_error = $2 WHERE id = $1", [jobId, errorMessage]);
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireNotificationSecret(req, res, next) {
  if (!NOTIFICATION_SECRET) return res.status(503).json({ error: "Notification worker is not configured" });
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !timingSafeEqualStrings(token, NOTIFICATION_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function sendWelcomeEmail({ email, name, householdName }) {
  const safeName = escapeHtml(name);
  const safeHousehold = escapeHtml(householdName);
  return sendTransactionalEmail({
    to: email,
    subject: "Welcome to FamilyLoop",
    text: `Hi ${name}, your FamilyLoop login has been created for ${householdName}. Open ${APP_BASE_URL} to get started.`,
    html: `<h2>Welcome to FamilyLoop</h2><p>Hi ${safeName},</p><p>Your login has been created for <strong>${safeHousehold}</strong>.</p><p><a href="${escapeHtml(APP_BASE_URL)}">Open FamilyLoop</a> to get started.</p>`
  });
}

function sendPasswordResetEmail({ email, name, token }) {
  const resetUrl = `${APP_BASE_URL}/index.html?resetToken=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  return sendTransactionalEmail({
    to: email,
    subject: "Reset your FamilyLoop password",
    text: `Hi ${name}, use this one-time link within 30 minutes to reset your FamilyLoop password: ${resetUrl}`,
    html: `<h2>Reset your FamilyLoop password</h2><p>Hi ${escapeHtml(name)},</p><p>This one-time link expires in 30 minutes.</p><p><a href="${escapeHtml(resetUrl)}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`
  });
}

function sendHouseholdInvitesEmail({ email, name, inviterName, invites }) {
  const blocks = invites.map(({ householdName, inviteCode, role, scopes }) => {
    const scopeText = scopes.length ? scopes.join(", ") : "household workspace";
    const acceptUrl = `${APP_BASE_URL}/index.html?inviteCode=${encodeURIComponent(inviteCode)}&email=${encodeURIComponent(email)}`;
    return {
      householdName,
      text: `${householdName} as ${role}. Invite code: ${inviteCode}. Shared areas: ${scopeText}. Accept: ${acceptUrl}`,
      html: `<p><strong>${escapeHtml(householdName)}</strong> as ${escapeHtml(role)}.<br>Invite code: <strong>${escapeHtml(inviteCode)}</strong><br>Shared areas: ${escapeHtml(scopeText)}<br><a href="${escapeHtml(acceptUrl)}">Accept invitation</a></p>`
    };
  });
  const subject = invites.length > 1
    ? `${inviterName} shared ${invites.length} households with you`
    : `${inviterName} shared ${invites[0].householdName} with you`;
  return sendTransactionalEmail({
    to: email,
    subject,
    text: `Hi ${name}, ${inviterName} invited you to FamilyLoop:\n\n${blocks.map((block) => block.text).join("\n\n")}\n\nEach household needs its own invite code accepted separately.`,
    html: `<h2>You have been invited to FamilyLoop</h2><p>Hi ${escapeHtml(name)},</p><p><strong>${escapeHtml(inviterName)}</strong> invited you to:</p>${blocks.map((block) => block.html).join("")}${invites.length > 1 ? "<p>Each household needs its own invite code accepted separately.</p>" : ""}`
  });
}

function sendHouseholdAccessRevokedEmail({ email, name, ownerName, householdName }) {
  return sendTransactionalEmail({
    to: email,
    subject: `Your access to ${householdName} was removed`,
    text: `Hi ${name}, ${ownerName} removed your access to ${householdName} in FamilyLoop. Contact the household owner if you believe this was a mistake.`,
    html: `<h2>Household access removed</h2><p>Hi ${escapeHtml(name)},</p><p><strong>${escapeHtml(ownerName)}</strong> removed your access to <strong>${escapeHtml(householdName)}</strong> in FamilyLoop.</p><p>Contact the household owner if you believe this was a mistake.</p>`
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function sharedModulesFromState(appState) {
  return {
    notes: cloneJson(appState?.notes || {}),
    meals: cloneJson(appState?.meals || {}),
    calendar: cloneJson(appState?.calendar || { events: [], chores: [] })
  };
}

function applySharedModules(appState, sharedModules) {
  const merged = cloneJson(appState || {});
  if (sharedModules?.notes) merged.notes = cloneJson(sharedModules.notes);
  if (sharedModules?.meals) merged.meals = cloneJson(sharedModules.meals);
  if (sharedModules?.calendar) merged.calendar = cloneJson(sharedModules.calendar);
  return merged;
}

function defaultPrivateData() {
  return { journal: { entries: [] }, plans: { tasks: [] } };
}

function memoryPrimaryOwnerId(householdId) {
  return memoryDb.memberships.find((item) => item.household_id === householdId && item.role === "owner")?.user_id
    || memoryDb.memberships.find((item) => item.household_id === householdId)?.user_id;
}

async function databasePrimaryOwnerId(client, householdId) {
  const result = await client.query(
    `SELECT user_id FROM household_memberships
     WHERE household_id = $1
     ORDER BY (role = 'owner') DESC, created_at ASC
     LIMIT 1`,
    [householdId]
  );
  return result.rows[0]?.user_id;
}

function publicUser(row) {
  return row ? { id: row.id, email: row.email, name: row.name, isAdmin: isPlatformAdminEmail(row.email), phone: row.phone || "", carrier: row.carrier || "" } : null;
}

function normalizePhoneAndCarrier(rawPhone, rawCarrier) {
  const phone = String(rawPhone || "").replace(/\D/g, "");
  const carrier = String(rawCarrier || "").trim().toLowerCase();
  if (!phone && !carrier) return { phone: "", carrier: "" };
  if (carrier && !SMS_CARRIERS.some((item) => item.value === carrier)) {
    throw Object.assign(new Error("Choose a valid mobile carrier"), { statusCode: 400 });
  }
  return { phone, carrier };
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    signed: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production"
  };
}

function sessionPayload(userId, now = Date.now()) {
  return Buffer.from(JSON.stringify({ userId, lastSeenAt: now }), "utf8").toString("base64url");
}

function readSessionPayload(req) {
  const raw = req.signedCookies[SESSION_COOKIE];
  if (!raw) return null;
  try {
    const payload = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    const lastSeenAt = Number(payload.lastSeenAt);
    if (!payload.userId || !Number.isFinite(lastSeenAt)) return null;
    if (Date.now() - lastSeenAt > SESSION_IDLE_MS) return null;
    return { userId: String(payload.userId), lastSeenAt };
  } catch (_error) {
    return null;
  }
}

function signSession(res, userId) {
  res.cookie(SESSION_COOKIE, sessionPayload(userId), sessionCookieOptions());
}

function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  res.clearCookie(HOUSEHOLD_COOKIE);
}

function refreshSession(res, userId) {
  signSession(res, userId);
}

function selectHousehold(res, householdId) {
  res.cookie(HOUSEHOLD_COOKIE, householdId, {
    httpOnly: true,
    signed: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 14
  });
}

async function migrate() {
  if (MEMORY_DB) return;
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  await pool.query(
    "UPDATE users SET email = $1 WHERE email = $2 AND NOT EXISTS (SELECT 1 FROM users WHERE email = $1)",
    [DEMO_EMAIL, LEGACY_DEMO_EMAIL]
  );
  await pool.query(
    "UPDATE households SET app_state = replace(app_state::text, $1, $2)::jsonb WHERE app_state::text LIKE $3",
    [LEGACY_DEMO_EMAIL, DEMO_EMAIL, `%${LEGACY_DEMO_EMAIL}%`]
  );
  if (ADMIN_EMAIL) {
    await pool.query("UPDATE users SET is_admin = (email = $1)", [ADMIN_EMAIL]);
  } else {
    await pool.query("UPDATE users SET is_admin = false WHERE email = $1", [DEMO_EMAIL]);
  }
}

function makeInviteCode() {
  return `HUB-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function countryCatalog() {
  return Object.entries(countries)
    .map(([code, country]) => ({
      code,
      name: country.name,
      currency: country.currency.find((value) => /^[A-Z]{3}$/.test(value)) || "USD"
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function countryDetails(code) {
  const normalized = String(code || "").toUpperCase();
  const country = countries[normalized];
  if (!country) return null;
  return {
    code: normalized,
    name: country.name,
    currency: country.currency.find((value) => /^[A-Z]{3}$/.test(value)) || "USD"
  };
}

function householdState(name, country = "US", currency = "USD", seededDemo = false) {
  const state = JSON.parse(JSON.stringify(defaultState));
  state.household.name = name;
  state.household.country = country;
  state.household.currency = currency;
  state.household.inviteCode = makeInviteCode();
  if (!seededDemo) {
    const now = new Date();
    state.household.members = [];
    state.household.activity = [];
    state.budget.month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    state.budget.income = 0;
    state.budget.categories = [];
    state.budget.setupStarted = false;
    state.budgetHistory = [];
    state.transactions = [];
    state.paychecks = [];
    state.calendar = { events: [], chores: [] };
    state.notes = {
      initialized: true,
      activeView: "notes",
      activeLabel: "",
      labels: [],
      entries: []
    };
    state.decisions = [];
    state.meals.selectedWeekByMonth = { [state.budget.month]: 1 };
    state.meals.plannedWeek = [];
    state.meals.recipes = [];
    state.meals.savedWeeks = [];
    state.goals = {
      sinkingFunds: [],
      debts: [],
      debtNetWorthLinked: true,
      netWorth: { assets: [], liabilities: [] }
    };
    state.accounts = [];
    state.transfers = [];
  } else if (country === "IN") {
    state.budget.income = 320000;
    state.paychecks = [
      { date: "2026-05-03", name: "Monthly salary", amount: 320000, assignedLineIds: ["rent", "power-water", "groceries"] }
    ];
    state.budget.categories.forEach((category) => {
      category.lines.forEach((line) => {
        line.planned = Math.round(Number(line.planned || 0) * 40);
      });
    });
    state.transactions = [];
    state.goals.netWorth.assets = [
      { id: "india-bank", name: "India bank account", value: 450000 },
      { name: "India property", value: 8500000 },
      { name: "EPF", value: 1200000 }
    ];
    state.goals.netWorth.liabilities = [
      { id: "india-home-loan", name: "India home loan", value: 3200000 }
    ];
    state.goals.debts = [
      { name: "India home loan", balance: 3200000, rate: 8.5, minimum: 32000 }
    ];
    state.accounts = [
      { id: "india-bank-account", name: "India bank account", type: "checking", openingBalance: 450000, netWorthAssetId: "india-bank", netWorthLiabilityId: "", createdAt: "2026-05-01" }
    ];
    state.transfers = [];
  }
  return state;
}

function duplicateCurrencyMessage(currency) {
  return `You already belong to a household using ${currency}`;
}

function memoryUserHasCurrency(userId, currency, excludeHouseholdId = "") {
  return memoryDb.memberships
    .filter((membership) => membership.user_id === userId && membership.household_id !== excludeHouseholdId)
    .some((membership) => {
      const household = memoryDb.households.find((item) => item.id === membership.household_id);
      return (household?.app_state?.household?.currency || "USD") === currency;
    });
}

async function databaseUserHasCurrency(client, userId, currency, excludeHouseholdId = "") {
  const result = await client.query(
    `SELECT 1
     FROM household_memberships hm
     JOIN households h ON h.id = hm.household_id
     WHERE hm.user_id = $1
       AND COALESCE(h.app_state->'household'->>'currency', 'USD') = $2
       AND ($3 = '' OR h.id::text <> $3)
     LIMIT 1`,
    [userId, currency, excludeHouseholdId]
  );
  return result.rowCount > 0;
}

async function createHouseholdForUser(client, userId, name, state = defaultState) {
  const inviteCode = makeInviteCode();
  state.household.inviteCode = inviteCode;
  const household = await client.query(
    "INSERT INTO households (name, invite_code, app_state) VALUES ($1, $2, $3) RETURNING *",
    [name, inviteCode, state]
  );
  await client.query(
    "INSERT INTO household_memberships (user_id, household_id, role) VALUES ($1, $2, 'owner')",
    [userId, household.rows[0].id]
  );
  await client.query(
    "UPDATE users SET default_household_id = COALESCE(default_household_id, $2) WHERE id = $1",
    [userId, household.rows[0].id]
  );
  return household.rows[0];
}

async function seedDemoUser() {
  if (MEMORY_DB) {
    const existingUser = memoryDb.users.find((user) => user.email === DEMO_EMAIL);
    if (existingUser) {
      existingUser.is_admin = false;
      return;
    }
    const user = {
      id: crypto.randomUUID(),
      email: DEMO_EMAIL,
      name: "Demo User",
      password_hash: await bcrypt.hash("budget123", 12),
      is_admin: false,
      login_count: 0,
      last_login_at: null,
      disabled_at: null,
      created_at: new Date().toISOString()
    };
    const usState = householdState("US Household", "US", "USD", true);
    const household = {
      id: crypto.randomUUID(),
      name: "US Household",
      invite_code: usState.household.inviteCode,
      app_state: usState,
      created_at: new Date().toISOString()
    };
    const indiaState = householdState("India Household", "IN", "INR", true);
    const indiaHousehold = {
      id: crypto.randomUUID(),
      name: "India Household",
      invite_code: indiaState.household.inviteCode,
      app_state: indiaState,
      created_at: new Date().toISOString()
    };
    memoryDb.users.push(user);
    memoryDb.households.push(household, indiaHousehold);
    memoryDb.memberships.push({ user_id: user.id, household_id: household.id, role: "owner" });
    memoryDb.memberships.push({ user_id: user.id, household_id: indiaHousehold.id, role: "owner" });
    user.default_household_id = household.id;
    return;
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [DEMO_EMAIL]);
  if (existing.rowCount > 0) {
    const userId = existing.rows[0].id;
    const memberships = await pool.query(
      `SELECT h.id, h.name,
              COALESCE(h.app_state->'household'->>'country', 'US') AS country,
              COALESCE(h.app_state->'household'->>'currency', 'USD') AS currency
       FROM households h
       JOIN household_memberships hm ON hm.household_id = h.id
       WHERE hm.user_id = $1`,
      [userId]
    );
    const names = new Set(memberships.rows.map((row) => row.name));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const household of memberships.rows.filter((row) => row.name === "US Household")) {
        if (household.country !== "US" || household.currency !== "USD") {
          await client.query(
            `UPDATE households
             SET app_state = $1
             WHERE id = $2`,
            [householdState("US Household", "US", "USD", true), household.id]
          );
        }
      }
      if (!names.has("US Household")) {
        const existingHousehold = memberships.rows.find((row) => row.name !== "India Household");
        if (existingHousehold) {
          await client.query(
            `UPDATE households
             SET name = 'US Household',
                 app_state = $1
             WHERE id = $2`,
            [householdState("US Household", "US", "USD", true), existingHousehold.id]
          );
        } else {
          await createHouseholdForUser(client, userId, "US Household", householdState("US Household", "US", "USD", true));
        }
      }
      if (!names.has("India Household")) {
        await createHouseholdForUser(client, userId, "India Household", householdState("India Household", "IN", "INR", true));
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hash = await bcrypt.hash("budget123", 12);
    const user = await client.query(
      "INSERT INTO users (email, password_hash, name, is_admin) VALUES ($1, $2, $3, false) RETURNING id",
      [DEMO_EMAIL, hash, "Demo User"]
    );
    await createHouseholdForUser(client, user.rows[0].id, "US Household", householdState("US Household", "US", "USD", true));
    await createHouseholdForUser(client, user.rows[0].id, "India Household", householdState("India Household", "IN", "INR", true));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedAdminUser() {
  if (!ADMIN_EMAIL || ADMIN_PASSWORD.length < 12) {
    console.warn("Private admin provisioning skipped: set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters");
    return;
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  if (MEMORY_DB) {
    let user = memoryDb.users.find((item) => item.email === ADMIN_EMAIL);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        email: ADMIN_EMAIL,
        name: ADMIN_NAME,
        password_hash: passwordHash,
        is_admin: true,
        login_count: 0,
        last_login_at: null,
        disabled_at: null,
        created_at: new Date().toISOString()
      };
      const state = householdState("Administrator Household", "US", "USD");
      const household = {
        id: crypto.randomUUID(),
        name: "Administrator Household",
        invite_code: state.household.inviteCode,
        app_state: state,
        created_at: new Date().toISOString()
      };
      memoryDb.users.push(user);
      memoryDb.households.push(household);
      memoryDb.memberships.push({ user_id: user.id, household_id: household.id, role: "owner" });
    }
    user.name = ADMIN_NAME;
    user.is_admin = true;
    user.disabled_at = null;
    user.default_household_id ||= memoryDb.memberships.find((item) => item.user_id === user.id)?.household_id;
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let user = await client.query(
      `INSERT INTO users (email, password_hash, name, is_admin)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (email)
       DO UPDATE SET name = EXCLUDED.name, is_admin = true, disabled_at = NULL
       RETURNING id`,
      [ADMIN_EMAIL, passwordHash, ADMIN_NAME]
    );
    const membership = await client.query(
      "SELECT 1 FROM household_memberships WHERE user_id = $1 LIMIT 1",
      [user.rows[0].id]
    );
    if (membership.rowCount === 0) {
      await createHouseholdForUser(
        client,
        user.rows[0].id,
        "Administrator Household",
        householdState("Administrator Household", "US", "USD")
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getSession(req) {
  const activeSession = readSessionPayload(req);
  const userId = activeSession?.userId;
  const selectedHouseholdId = req.signedCookies[HOUSEHOLD_COOKIE];
  if (!userId) return null;
  if (MEMORY_DB) {
    const user = memoryDb.users.find((item) => item.id === userId);
    const memberships = memoryDb.memberships.filter((item) => item.user_id === userId);
    const membership = memberships.find((item) => item.household_id === selectedHouseholdId)
      || memberships.find((item) => item.household_id === user?.default_household_id)
      || memberships[0];
    const household = memoryDb.households.find((item) => item.id === membership?.household_id);
    if (!user || !household) return null;
    return { ...user, household_id: household.id, household_name: household.name };
  }

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.is_admin, u.disabled_at, u.default_household_id,
            h.id AS household_id, h.name AS household_name
     FROM users u
     JOIN household_memberships hm ON hm.user_id = u.id
     JOIN households h ON h.id = hm.household_id
     WHERE u.id = $1
     ORDER BY (h.id::text = $2) DESC, (h.id = u.default_household_id) DESC, hm.created_at ASC
     LIMIT 1`,
    [userId, selectedHouseholdId || ""]
  );
  return result.rows[0] || null;
}

async function requireAdmin(req, res, next) {
  try {
    const session = await getSession(req);
    if (!session) {
      clearSession(res);
      return res.status(401).json({ error: "Authentication required" });
    }
    if (!session.is_admin || !isPlatformAdminEmail(session.email)) return res.status(403).json({ error: "Admin access required" });
    refreshSession(res, session.id);
    req.sessionUser = session;
    return next();
  } catch (error) {
    return next(error);
  }
}

function adminUserRow(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: isPlatformAdminEmail(user.email),
    disabled: Boolean(user.disabled_at),
    loginCount: Number(user.login_count || 0),
    lastLoginAt: user.last_login_at || null,
    createdAt: user.created_at || null
  };
}

async function recordLogin(userId) {
  const now = new Date().toISOString();
  if (MEMORY_DB) {
    const user = memoryDb.users.find((item) => item.id === userId);
    if (user) {
      user.login_count = Number(user.login_count || 0) + 1;
      user.last_login_at = now;
      memoryDb.loginEvents.push({ id: crypto.randomUUID(), user_id: userId, created_at: now });
    }
    return;
  }

  await pool.query("UPDATE users SET login_count = login_count + 1, last_login_at = now() WHERE id = $1", [userId]);
  await pool.query("INSERT INTO login_events (user_id) VALUES ($1)", [userId]);
}

function monthKey(value) {
  const date = value ? new Date(value) : new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabelFromKey(value) {
  const [year, month] = value.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function recentMonthKeys(count = 12) {
  const now = new Date();
  return Array.from({ length: count }, (_item, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (count - 1 - index), 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
}

async function requireSession(req, res, next) {
  try {
    const session = await getSession(req);
    if (!session) {
      clearSession(res);
      return res.status(401).json({ error: "Authentication required" });
    }
    refreshSession(res, session.id);
    req.sessionUser = session;
    return next();
  } catch (error) {
    return next(error);
  }
}

app.get("/healthz", (_req, res) => {
  res.type("text/plain").send("ok");
});

app.get("/readyz", async (_req, res) => {
  try {
    if (!MEMORY_DB) await pool.query("SELECT 1");
    res.type("text/plain").send("ready");
  } catch (_error) {
    res.status(503).type("text/plain").send("not ready");
  }
});

app.get("/api/countries", (_req, res) => {
  res.json(countryCatalog());
});

app.get("/api/session", async (req, res, next) => {
  try {
    const session = await getSession(req);
    if (session) {
      refreshSession(res, session.id);
    } else {
      clearSession(res);
    }
    res.json({
      authenticated: Boolean(session),
      user: publicUser(session),
      household: session ? { id: session.household_id, name: session.household_name } : null,
      googleClientId: GOOGLE_CLIENT_ID
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/signup", async (req, res, next) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const name = String(req.body.name || "Household Owner").trim();
  const householdName = String(req.body.householdName || "My Household").trim();
  const countryInfo = countryDetails(req.body.country || "US");
  const country = countryInfo?.code;
  const currency = countryInfo?.currency;

  if (!email || password.length < 8 || !countryInfo) {
    return res.status(400).json({ error: "Email and an 8+ character password are required" });
  }
  if (email === DEMO_EMAIL || email === LEGACY_DEMO_EMAIL || (ADMIN_EMAIL && email === ADMIN_EMAIL)) {
    return res.status(409).json({ error: "That email is reserved" });
  }
  let phone, carrier;
  try {
    ({ phone, carrier } = normalizePhoneAndCarrier(req.body.phone, req.body.carrier));
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }

  if (MEMORY_DB) {
    if (memoryDb.users.some((user) => user.email === email)) {
      return res.status(409).json({ error: "That email is already registered" });
    }
    const user = {
      id: crypto.randomUUID(),
      email,
      name,
      password_hash: await bcrypt.hash(password, 12),
      is_admin: false,
      login_count: 0,
      last_login_at: null,
      disabled_at: null,
      phone,
      carrier,
      created_at: new Date().toISOString()
    };
    const state = householdState(householdName, country, currency);
    const household = {
      id: crypto.randomUUID(),
      name: householdName,
      invite_code: state.household.inviteCode,
      app_state: state,
      created_at: new Date().toISOString()
    };
    memoryDb.users.push(user);
    memoryDb.households.push(household);
    memoryDb.memberships.push({ user_id: user.id, household_id: household.id, role: "owner" });
    user.default_household_id = household.id;
    const emailDelivery = await sendWelcomeEmail({ email, name, householdName });
    signSession(res, user.id);
    selectHousehold(res, household.id);
    return res.status(201).json({ user: publicUser(user), email: emailDelivery });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hash = await bcrypt.hash(password, 12);
    const user = await client.query(
      "INSERT INTO users (email, password_hash, name, is_admin, phone, carrier) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, name, is_admin, phone, carrier",
      [email, hash, name, false, phone || null, carrier || null]
    );
    const state = householdState(householdName, country, currency);
    const household = await createHouseholdForUser(client, user.rows[0].id, householdName, state);
    await client.query("COMMIT");
    const emailDelivery = await sendWelcomeEmail({ email, name, householdName });
    signSession(res, user.rows[0].id);
    selectHousehold(res, household.id);
    res.status(201).json({ user: publicUser(user.rows[0]), email: emailDelivery });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return res.status(409).json({ error: "That email is already registered" });
    next(error);
  } finally {
    client.release();
  }
});

app.post("/api/auth/signin", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (email === DEMO_EMAIL) {
      return res.status(400).json({ error: "Use Try demo to open the consumer demo" });
    }
    if (MEMORY_DB) {
      const user = memoryDb.users.find((item) => item.email === email);
      if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      if (user.disabled_at) return res.status(403).json({ error: "This login has been disabled" });
      await recordLogin(user.id);
      signSession(res, user.id);
      const defaultHouseholdId = user.default_household_id
        || memoryDb.memberships.find((membership) => membership.user_id === user.id)?.household_id;
      if (defaultHouseholdId) selectHousehold(res, defaultHouseholdId);
      return res.json({ user: publicUser(user) });
    }

    const result = await pool.query("SELECT id, email, name, password_hash, is_admin, disabled_at, default_household_id FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    if (user.disabled_at) return res.status(403).json({ error: "This login has been disabled" });
    await recordLogin(user.id);
    signSession(res, user.id);
    const defaultResult = await pool.query(
      `SELECT hm.household_id
       FROM household_memberships hm
       WHERE hm.user_id = $1
       ORDER BY (hm.household_id = $2) DESC, hm.created_at ASC
       LIMIT 1`,
      [user.id, user.default_household_id]
    );
    if (defaultResult.rows[0]) selectHousehold(res, defaultResult.rows[0].household_id);
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/google", async (req, res, next) => {
  try {
    if (!googleAuthClient && !TEST_BYPASS_GOOGLE_AUTH) return res.status(503).json({ error: "Google sign-in is not configured" });

    let payload;
    if (TEST_BYPASS_GOOGLE_AUTH) {
      payload = req.body.testPayload || null;
      if (!payload) return res.status(400).json({ error: "Missing Google credential" });
    } else {
      const credential = String(req.body.credential || "");
      if (!credential) return res.status(400).json({ error: "Missing Google credential" });
      try {
        const ticket = await googleAuthClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
        payload = ticket.getPayload();
      } catch (_error) {
        return res.status(401).json({ error: "Invalid Google credential" });
      }
    }
    if (!payload?.email || !payload.email_verified) {
      return res.status(401).json({ error: "Google account email is not verified" });
    }

    const email = String(payload.email).trim().toLowerCase();
    const googleId = String(payload.sub);
    const name = String(payload.name || payload.given_name || email.split("@")[0]);

    if (email === DEMO_EMAIL || email === LEGACY_DEMO_EMAIL || (ADMIN_EMAIL && email === ADMIN_EMAIL)) {
      return res.status(409).json({ error: "That email is reserved" });
    }

    if (MEMORY_DB) {
      const existingUser = memoryDb.users.find((item) => item.email === email);
      // Deliberately not linked: a password account and a Google account never
      // merge just because the email matches, so signing in one way never
      // silently grants access to data created the other way.
      if (existingUser && !existingUser.google_id) {
        return res.status(409).json({ error: "An account with this email already exists. Sign in with your password instead." });
      }
      if (existingUser) {
        if (existingUser.disabled_at) return res.status(403).json({ error: "This login has been disabled" });
        await recordLogin(existingUser.id);
        signSession(res, existingUser.id);
        const defaultHouseholdId = existingUser.default_household_id
          || memoryDb.memberships.find((membership) => membership.user_id === existingUser.id)?.household_id;
        if (defaultHouseholdId) selectHousehold(res, defaultHouseholdId);
        return res.json({ user: publicUser(existingUser) });
      }
      const user = {
        id: crypto.randomUUID(),
        email,
        name,
        password_hash: null,
        google_id: googleId,
        is_admin: false,
        login_count: 1,
        last_login_at: new Date().toISOString(),
        disabled_at: null,
        phone: "",
        carrier: "",
        created_at: new Date().toISOString()
      };
      const state = householdState(`${name}'s Household`, "US", "USD");
      const household = {
        id: crypto.randomUUID(),
        name: state.household.name,
        invite_code: state.household.inviteCode,
        app_state: state,
        created_at: new Date().toISOString()
      };
      memoryDb.users.push(user);
      memoryDb.households.push(household);
      memoryDb.memberships.push({ user_id: user.id, household_id: household.id, role: "owner" });
      user.default_household_id = household.id;
      signSession(res, user.id);
      selectHousehold(res, household.id);
      return res.status(201).json({ user: publicUser(user) });
    }

    const existingResult = await pool.query(
      "SELECT id, email, name, google_id, is_admin, disabled_at, default_household_id FROM users WHERE email = $1",
      [email]
    );
    const existingUser = existingResult.rows[0];
    if (existingUser && !existingUser.google_id) {
      return res.status(409).json({ error: "An account with this email already exists. Sign in with your password instead." });
    }
    if (existingUser) {
      if (existingUser.disabled_at) return res.status(403).json({ error: "This login has been disabled" });
      await recordLogin(existingUser.id);
      signSession(res, existingUser.id);
      const defaultResult = await pool.query(
        `SELECT hm.household_id
         FROM household_memberships hm
         WHERE hm.user_id = $1
         ORDER BY (hm.household_id = $2) DESC, hm.created_at ASC
         LIMIT 1`,
        [existingUser.id, existingUser.default_household_id]
      );
      if (defaultResult.rows[0]) selectHousehold(res, defaultResult.rows[0].household_id);
      return res.json({ user: publicUser(existingUser) });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const insertedUser = await client.query(
        "INSERT INTO users (email, name, google_id, is_admin) VALUES ($1, $2, $3, false) RETURNING id, email, name, is_admin",
        [email, name, googleId]
      );
      const state = householdState(`${name}'s Household`, "US", "USD");
      const household = await createHouseholdForUser(client, insertedUser.rows[0].id, state.household.name, state);
      await client.query("COMMIT");
      signSession(res, insertedUser.rows[0].id);
      selectHousehold(res, household.id);
      res.status(201).json({ user: publicUser(insertedUser.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") return res.status(409).json({ error: "That Google account is already linked to another user" });
      next(error);
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/password-reset/request", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const response = { ok: true, message: "If that login exists, a password reset email has been queued." };
    let user;
    if (MEMORY_DB) {
      user = memoryDb.users.find((item) => item.email === email && !item.disabled_at);
    } else {
      const result = await pool.query(
        "SELECT id, email, name FROM users WHERE email = $1 AND disabled_at IS NULL",
        [email]
      );
      user = result.rows[0];
    }
    if (!user) return res.status(202).json(response);

    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    if (MEMORY_DB) {
      const recentRequest = memoryDb.passwordResetTokens.some((item) =>
        item.user_id === user.id && Date.now() - new Date(item.created_at).getTime() < 60 * 1000
      );
      if (recentRequest) return res.status(202).json(response);
      memoryDb.passwordResetTokens.forEach((item) => {
        if (item.user_id === user.id && !item.used_at) item.used_at = new Date().toISOString();
      });
      memoryDb.passwordResetTokens.push({
        id: crypto.randomUUID(),
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: expiresAt.toISOString(),
        used_at: null,
        created_at: new Date().toISOString()
      });
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const recentRequest = await client.query(
          "SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND created_at > now() - interval '60 seconds' LIMIT 1",
          [user.id]
        );
        if (recentRequest.rowCount > 0) {
          await client.query("ROLLBACK");
          return res.status(202).json(response);
        }
        await client.query(
          "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
          [user.id]
        );
        await client.query(
          "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
          [user.id, tokenHash, expiresAt]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    await sendPasswordResetEmail({ email: user.email, name: user.name, token });
    if (TEST_EXPOSE_RESET_TOKEN) response.resetToken = token;
    return res.status(202).json(response);
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/password-reset/confirm", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const tokenHash = hashResetToken(req.body.token || "");
    const password = String(req.body.password || "");
    if (!email || password.length < 12) {
      return res.status(400).json({ error: "Enter the account email and a password of at least 12 characters" });
    }

    let user;
    if (MEMORY_DB) {
      user = memoryDb.users.find((item) => item.email === email && !item.disabled_at);
      const resetToken = memoryDb.passwordResetTokens.find((item) =>
        item.user_id === user?.id
        && item.token_hash === tokenHash
        && !item.used_at
        && new Date(item.expires_at).getTime() > Date.now()
      );
      if (!user || !resetToken) return res.status(400).json({ error: "That reset link is invalid or expired" });
      resetToken.used_at = new Date().toISOString();
      user.password_hash = await bcrypt.hash(password, 12);
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `SELECT u.id
           FROM password_reset_tokens prt
           JOIN users u ON u.id = prt.user_id
           WHERE u.email = $1
             AND u.disabled_at IS NULL
             AND prt.token_hash = $2
             AND prt.used_at IS NULL
             AND prt.expires_at > now()
           FOR UPDATE`,
          [email, tokenHash]
        );
        user = result.rows[0];
        if (!user) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "That reset link is invalid or expired" });
        }
        await client.query(
          "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND token_hash = $2",
          [user.id, tokenHash]
        );
        await client.query(
          "UPDATE users SET password_hash = $1 WHERE id = $2",
          [await bcrypt.hash(password, 12), user.id]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    clearSession(res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/invitations/accept", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const inviteCode = String(req.body.inviteCode || "").trim().toUpperCase();
    const password = String(req.body.password || "");
    const requestedName = String(req.body.name || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !inviteCode) {
      return res.status(400).json({ error: "Enter the invited email address and invite code" });
    }
    if (email === DEMO_EMAIL) {
      return res.status(400).json({ error: "The consumer demo cannot accept household invitations" });
    }
    let phone, carrier;
    try {
      ({ phone, carrier } = normalizePhoneAndCarrier(req.body.phone, req.body.carrier));
    } catch (error) {
      return res.status(error.statusCode || 400).json({ error: error.message });
    }

    let user;
    let household;
    if (MEMORY_DB) {
      const invitation = memoryDb.invitations.find((item) =>
        item.email === email && item.invite_code === inviteCode && item.status === "pending"
      );
      if (!invitation) return res.status(400).json({ error: "That invitation is invalid or has already been used" });
      household = memoryDb.households.find((item) => item.id === invitation.household_id);
      user = memoryDb.users.find((item) => item.email === email);
      if (user) {
        if (user.disabled_at) return res.status(403).json({ error: "This login has been disabled" });
        if (!(await bcrypt.compare(password, user.password_hash))) {
          return res.status(401).json({ error: "Enter the password for the existing account" });
        }
        const invitedCurrency = household?.app_state?.household?.currency || "USD";
        if (memoryUserHasCurrency(user.id, invitedCurrency, invitation.household_id)) {
          return res.status(409).json({ error: duplicateCurrencyMessage(invitedCurrency) });
        }
      } else {
        if (password.length < 12) {
          return res.status(400).json({ error: "Create a password of at least 12 characters" });
        }
        user = {
          id: crypto.randomUUID(),
          email,
          name: requestedName || invitation.name || "Household member",
          password_hash: await bcrypt.hash(password, 12),
          is_admin: false,
          login_count: 0,
          last_login_at: null,
          disabled_at: null,
          phone,
          carrier,
          created_at: new Date().toISOString()
        };
        memoryDb.users.push(user);
      }
      const membershipRole = /co-owner/i.test(invitation.role) ? "owner" : "member";
      const membership = memoryDb.memberships.find((item) =>
        item.user_id === user.id && item.household_id === invitation.household_id
      );
      if (membership) {
        membership.role = membershipRole;
        membership.scopes = invitation.scopes;
      } else {
        memoryDb.memberships.push({
          user_id: user.id,
          household_id: invitation.household_id,
          role: membershipRole,
          scopes: invitation.scopes
        });
      }
      user.default_household_id ||= invitation.household_id;
      invitation.status = "accepted";
      invitation.accepted_at = new Date().toISOString();
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const invitationResult = await client.query(
          `SELECT hi.*, h.name AS household_name
           FROM household_invitations hi
           JOIN households h ON h.id = hi.household_id
           WHERE hi.email = $1 AND hi.invite_code = $2 AND hi.status = 'pending'
           FOR UPDATE`,
          [email, inviteCode]
        );
        const invitation = invitationResult.rows[0];
        if (!invitation) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "That invitation is invalid or has already been used" });
        }
        household = { id: invitation.household_id, name: invitation.household_name };
        const userResult = await client.query(
          "SELECT id, email, name, password_hash, is_admin, disabled_at FROM users WHERE email = $1",
          [email]
        );
        user = userResult.rows[0];
        if (user) {
          if (user.disabled_at) {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: "This login has been disabled" });
          }
          if (!(await bcrypt.compare(password, user.password_hash))) {
            await client.query("ROLLBACK");
            return res.status(401).json({ error: "Enter the password for the existing account" });
          }
          const currencyResult = await client.query(
            "SELECT COALESCE(app_state->'household'->>'currency', 'USD') AS currency FROM households WHERE id = $1",
            [invitation.household_id]
          );
          const invitedCurrency = currencyResult.rows[0]?.currency || "USD";
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [user.id]);
          if (await databaseUserHasCurrency(client, user.id, invitedCurrency, String(invitation.household_id))) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: duplicateCurrencyMessage(invitedCurrency) });
          }
        } else {
          if (password.length < 12) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Create a password of at least 12 characters" });
          }
          const created = await client.query(
            `INSERT INTO users (email, password_hash, name, is_admin, phone, carrier)
             VALUES ($1, $2, $3, false, $4, $5)
             RETURNING id, email, name, is_admin, disabled_at, phone, carrier`,
            [email, await bcrypt.hash(password, 12), requestedName || invitation.name || "Household member", phone || null, carrier || null]
          );
          user = created.rows[0];
        }
        const membershipRole = /co-owner/i.test(invitation.role) ? "owner" : "member";
        await client.query(
          `INSERT INTO household_memberships (user_id, household_id, role, scopes)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, household_id)
           DO UPDATE SET role = EXCLUDED.role, scopes = EXCLUDED.scopes`,
          [user.id, invitation.household_id, membershipRole, JSON.stringify(invitation.scopes || [])]
        );
        await client.query(
          "UPDATE users SET default_household_id = COALESCE(default_household_id, $2) WHERE id = $1",
          [user.id, invitation.household_id]
        );
        await client.query(
          "UPDATE household_invitations SET status = 'accepted', updated_at = now() WHERE id = $1",
          [invitation.id]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    await recordLogin(user.id);
    signSession(res, user.id);
    selectHousehold(res, household.id);
    res.json({
      user: publicUser(user),
      household: { id: household.id, name: household.name }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/demo", async (_req, res, next) => {
  try {
    let user;
    let household;
    if (MEMORY_DB) {
      user = memoryDb.users.find((item) => item.email === DEMO_EMAIL);
      const memberships = memoryDb.memberships.filter((item) => item.user_id === user?.id);
      household = memberships
        .map((membership) => memoryDb.households.find((item) => item.id === membership.household_id))
        .find((item) => item?.app_state?.household?.country === "US" && item?.app_state?.household?.currency === "USD");
    } else {
      const result = await pool.query(
        "SELECT id, email, name, is_admin, disabled_at FROM users WHERE email = $1",
        [DEMO_EMAIL]
      );
      user = result.rows[0];
      if (user) {
        const householdResult = await pool.query(
          `SELECT h.id, h.name
           FROM households h
           JOIN household_memberships hm ON hm.household_id = h.id
           WHERE hm.user_id = $1
             AND COALESCE(h.app_state->'household'->>'country', 'US') = 'US'
             AND COALESCE(h.app_state->'household'->>'currency', 'USD') = 'USD'
           ORDER BY (h.name = 'US Household') DESC, hm.created_at ASC
           LIMIT 1`,
          [user.id]
        );
        household = householdResult.rows[0];
      }
    }
    if (!user || user.disabled_at || !household) {
      return res.status(503).json({ error: "Demo access is temporarily unavailable" });
    }
    await recordLogin(user.id);
    signSession(res, user.id);
    selectHousehold(res, household.id);
    res.json({ user: publicUser(user), household: { id: household.id, name: household.name } });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/session", requireAdmin, (req, res) => {
  res.json({ authorized: true, user: publicUser(req.sessionUser) });
});

app.get("/api/admin/stats", requireAdmin, async (_req, res, next) => {
  try {
    if (MEMORY_DB) {
      const users = memoryDb.users;
      return res.json({
        users: users.length,
        activeUsers: users.filter((user) => !user.disabled_at).length,
        admins: users.filter((user) => user.is_admin).length,
        households: memoryDb.households.length,
        totalLogins: users.reduce((sum, user) => sum + Number(user.login_count || 0), 0),
        recentLogins: new Set(memoryDb.loginEvents.filter((event) => Date.now() - new Date(event.created_at).getTime() <= 1000 * 60 * 60 * 24 * 30).map((event) => event.user_id)).size
      });
    }

    const result = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM users WHERE disabled_at IS NULL) AS active_users,
        (SELECT count(*)::int FROM users WHERE is_admin) AS admins,
        (SELECT count(*)::int FROM households) AS households,
        (SELECT COALESCE(sum(login_count), 0)::int FROM users) AS total_logins,
        (SELECT count(DISTINCT user_id)::int FROM login_events WHERE created_at > now() - interval '30 days') AS recent_logins
    `);
    const row = result.rows[0];
    res.json({
      users: row.users,
      activeUsers: row.active_users,
      admins: row.admins,
      households: row.households,
      totalLogins: row.total_logins,
      recentLogins: row.recent_logins
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/monthly-stats", requireAdmin, async (_req, res, next) => {
  try {
    if (MEMORY_DB) {
      const rows = recentMonthKeys().map((month) => {
        const loginEvents = memoryDb.loginEvents.filter((event) => monthKey(event.created_at) === month);
        return {
          month,
          label: monthLabelFromKey(month),
          usersCreated: memoryDb.users.filter((user) => monthKey(user.created_at) === month).length,
          householdsCreated: memoryDb.households.filter((household) => monthKey(household.created_at) === month).length,
          logins: loginEvents.length,
          uniqueLoginUsers: new Set(loginEvents.map((event) => event.user_id)).size
        };
      });
      return res.json(rows);
    }

    const result = await pool.query(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', now()) - interval '11 months',
          date_trunc('month', now()),
          interval '1 month'
        ) AS month_start
      )
      SELECT
        to_char(months.month_start, 'YYYY-MM') AS month,
        to_char(months.month_start, 'FMMonth YYYY') AS label,
        COALESCE(users_created.count, 0)::int AS users_created,
        COALESCE(households_created.count, 0)::int AS households_created,
        COALESCE(logins.count, 0)::int AS logins,
        COALESCE(logins.unique_users, 0)::int AS unique_login_users
      FROM months
      LEFT JOIN (
        SELECT date_trunc('month', created_at) AS month_start, count(*) AS count
        FROM users
        GROUP BY 1
      ) users_created ON users_created.month_start = months.month_start
      LEFT JOIN (
        SELECT date_trunc('month', created_at) AS month_start, count(*) AS count
        FROM households
        GROUP BY 1
      ) households_created ON households_created.month_start = months.month_start
      LEFT JOIN (
        SELECT date_trunc('month', created_at) AS month_start, count(*) AS count, count(DISTINCT user_id) AS unique_users
        FROM login_events
        GROUP BY 1
      ) logins ON logins.month_start = months.month_start
      ORDER BY months.month_start DESC
    `);
    res.json(result.rows.map((row) => ({
      month: row.month,
      label: row.label,
      usersCreated: row.users_created,
      householdsCreated: row.households_created,
      logins: row.logins,
      uniqueLoginUsers: row.unique_login_users
    })));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/users", requireAdmin, async (_req, res, next) => {
  try {
    if (MEMORY_DB) {
      return res.json(memoryDb.users.map(adminUserRow).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
    }

    const result = await pool.query(
      "SELECT id, email, name, is_admin, login_count, last_login_at, disabled_at, created_at FROM users ORDER BY created_at DESC"
    );
    res.json(result.rows.map(adminUserRow));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/users/:id", requireAdmin, async (req, res, next) => {
  try {
    const userId = req.params.id;
    const { disabled, isAdmin, name, password } = req.body || {};
    if (typeof isAdmin === "boolean") {
      return res.status(403).json({ error: "Administrator access is managed by the private deployment secret" });
    }
    if (userId === req.sessionUser.id && disabled === true) {
      return res.status(400).json({ error: "You cannot disable your own admin login" });
    }
    if (userId === req.sessionUser.id && isAdmin === false) {
      return res.status(400).json({ error: "You cannot remove your own admin access" });
    }

    if (MEMORY_DB) {
      const user = memoryDb.users.find((item) => item.id === userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (typeof disabled === "boolean") user.disabled_at = disabled ? new Date().toISOString() : null;
      if (typeof name === "string" && name.trim()) user.name = name.trim();
      if (typeof password === "string" && password.length >= 8) user.password_hash = await bcrypt.hash(password, 12);
      return res.json(adminUserRow(user));
    }

    const updates = [];
    const values = [];
    if (typeof disabled === "boolean") {
      values.push(disabled);
      updates.push(`disabled_at = CASE WHEN $${values.length} THEN now() ELSE NULL END`);
    }
    if (typeof name === "string" && name.trim()) {
      values.push(name.trim());
      updates.push(`name = $${values.length}`);
    }
    if (typeof password === "string" && password.length >= 8) {
      values.push(await bcrypt.hash(password, 12));
      updates.push(`password_hash = $${values.length}`);
    }
    if (updates.length === 0) return res.status(400).json({ error: "No supported user changes supplied" });
    values.push(userId);
    const result = await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${values.length}
       RETURNING id, email, name, is_admin, login_count, last_login_at, disabled_at, created_at`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "User not found" });
    res.json(adminUserRow(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/signout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get("/api/households", requireSession, async (req, res, next) => {
  try {
    if (MEMORY_DB) {
      const households = memoryDb.memberships
        .filter((membership) => membership.user_id === req.sessionUser.id)
        .map((membership) => {
          const household = memoryDb.households.find((item) => item.id === membership.household_id);
          return {
            id: household.id,
            name: household.name,
            role: membership.role,
            country: household.app_state?.household?.country || "US",
            currency: household.app_state?.household?.currency || "USD",
            selected: household.id === req.sessionUser.household_id,
            isDefault: household.id === req.sessionUser.default_household_id
          };
        });
      return res.json(households);
    }

    const result = await pool.query(
      `SELECT h.id, h.name, hm.role, (h.id = u.default_household_id) AS is_default,
              COALESCE(h.app_state->'household'->>'country', 'US') AS country,
              COALESCE(h.app_state->'household'->>'currency', 'USD') AS currency
       FROM households h
       JOIN household_memberships hm ON hm.household_id = h.id
       JOIN users u ON u.id = hm.user_id
       WHERE hm.user_id = $1
       ORDER BY hm.created_at ASC`,
      [req.sessionUser.id]
    );
    res.json(result.rows.map((household) => ({
      ...household,
      isDefault: household.is_default,
      selected: household.id === req.sessionUser.household_id
    })));
  } catch (error) {
    next(error);
  }
});

app.post("/api/households", requireSession, async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const countryInfo = countryDetails(req.body.country || "US");
    if (!name) return res.status(400).json({ error: "Household name is required" });
    if (!countryInfo) return res.status(400).json({ error: "Select a valid country" });
    const country = countryInfo.code;
    const currency = countryInfo.currency;
    const state = householdState(name, country, currency);

    if (MEMORY_DB) {
      if (memoryUserHasCurrency(req.sessionUser.id, currency)) {
        return res.status(409).json({ error: duplicateCurrencyMessage(currency) });
      }
      const household = {
        id: crypto.randomUUID(),
        name,
        invite_code: state.household.inviteCode,
        app_state: state,
        created_at: new Date().toISOString()
      };
      memoryDb.households.push(household);
      memoryDb.memberships.push({ user_id: req.sessionUser.id, household_id: household.id, role: "owner" });
      selectHousehold(res, household.id);
      return res.status(201).json({ id: household.id, name, country, currency, selected: true });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [req.sessionUser.id]);
      if (await databaseUserHasCurrency(client, req.sessionUser.id, currency)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: duplicateCurrencyMessage(currency) });
      }
      const household = await createHouseholdForUser(client, req.sessionUser.id, name, state);
      await client.query("COMMIT");
      selectHousehold(res, household.id);
      return res.status(201).json({ id: household.id, name, country, currency, selected: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/households/select", requireSession, async (req, res, next) => {
  try {
    const householdId = String(req.body.householdId || "");
    let allowed = false;
    if (MEMORY_DB) {
      allowed = memoryDb.memberships.some((membership) =>
        membership.user_id === req.sessionUser.id && membership.household_id === householdId
      );
    } else {
      const result = await pool.query(
        "SELECT 1 FROM household_memberships WHERE user_id = $1 AND household_id::text = $2",
        [req.sessionUser.id, householdId]
      );
      allowed = result.rowCount > 0;
    }
    if (!allowed) return res.status(404).json({ error: "Household not found" });
    selectHousehold(res, householdId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/households/default", requireSession, async (req, res, next) => {
  try {
    const householdId = String(req.body.householdId || "");
    let allowed = false;
    if (MEMORY_DB) {
      allowed = memoryDb.memberships.some((membership) =>
        membership.user_id === req.sessionUser.id && membership.household_id === householdId
      );
      if (allowed) {
        const user = memoryDb.users.find((item) => item.id === req.sessionUser.id);
        user.default_household_id = householdId;
      }
    } else {
      const result = await pool.query(
        `UPDATE users u
         SET default_household_id = $2::uuid
         WHERE u.id = $1
           AND EXISTS (
             SELECT 1 FROM household_memberships hm
             WHERE hm.user_id = u.id AND hm.household_id = $2::uuid
           )`,
        [req.sessionUser.id, householdId]
      );
      allowed = result.rowCount > 0;
    }
    if (!allowed) return res.status(404).json({ error: "Household not found" });
    res.json({ ok: true, defaultHouseholdId: householdId });
  } catch (error) {
    next(error);
  }
});

app.post("/api/households/invitations", requireSession, async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const name = String(req.body.name || "Household member").trim();
    const role = String(req.body.role || "Member").trim();
    const scopes = Array.isArray(req.body.scopes)
      ? req.body.scopes.map((scope) => String(scope).trim()).filter(Boolean).slice(0, 50)
      : [];

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid invitation email" });
    }

    const requestedHouseholdIds = Array.isArray(req.body.householdIds)
      ? [...new Set(req.body.householdIds.map((id) => String(id).trim()).filter(Boolean))].slice(0, 20)
      : [];
    const targetHouseholdIds = requestedHouseholdIds.length ? requestedHouseholdIds : [req.sessionUser.household_id];

    const invites = [];

    if (MEMORY_DB) {
      for (const householdId of targetHouseholdIds) {
        const membership = memoryDb.memberships.find((item) =>
          item.user_id === req.sessionUser.id && item.household_id === householdId
        );
        if (!membership || membership.role !== "owner") continue;
        const household = memoryDb.households.find((item) => item.id === householdId);
        if (!household) continue;
        const inviteCode = household.invite_code || makeInviteCode();
        household.invite_code = inviteCode;
        const existing = memoryDb.invitations.find((item) =>
          item.household_id === household.id && item.email === email
        );
        const invitation = existing || { id: crypto.randomUUID(), household_id: household.id, email };
        Object.assign(invitation, {
          name,
          role,
          scopes,
          invite_code: inviteCode,
          status: "pending",
          invited_by: req.sessionUser.id,
          updated_at: new Date().toISOString()
        });
        if (!existing) memoryDb.invitations.push(invitation);
        invites.push({ householdName: household.name, inviteCode, role, scopes });
      }
    } else {
      for (const householdId of targetHouseholdIds) {
        const result = await pool.query(
          `SELECT h.id, h.name, h.invite_code, hm.role
           FROM households h
           JOIN household_memberships hm ON hm.household_id = h.id
           WHERE h.id = $1 AND hm.user_id = $2`,
          [householdId, req.sessionUser.id]
        );
        const household = result.rows[0];
        if (!household || household.role !== "owner") continue;
        const inviteCode = household.invite_code;
        await pool.query(
          `INSERT INTO household_invitations
            (household_id, invited_by, email, name, role, scopes, invite_code, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           ON CONFLICT (household_id, email)
           DO UPDATE SET
             invited_by = EXCLUDED.invited_by,
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             scopes = EXCLUDED.scopes,
             invite_code = EXCLUDED.invite_code,
             status = 'pending',
             updated_at = now()`,
          [household.id, req.sessionUser.id, email, name, role, JSON.stringify(scopes), inviteCode]
        );
        invites.push({ householdName: household.name, inviteCode, role, scopes });
      }
    }

    if (!invites.length) {
      return res.status(403).json({ error: "Only the household owner can send invitations" });
    }

    const emailDelivery = await sendHouseholdInvitesEmail({
      email,
      name,
      inviterName: req.sessionUser.name,
      invites
    });

    const inviteCode = invites[0].inviteCode;
    res.status(201).json({
      invitation: { email, name, role, scopes, inviteCode, status: "pending" },
      invitations: invites.map((invite) => ({ email, name, role, scopes, householdName: invite.householdName, inviteCode: invite.inviteCode, status: "pending" })),
      email: emailDelivery
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/households/access", requireSession, async (req, res, next) => {
  try {
    if (MEMORY_DB) {
      const ownerId = memoryPrimaryOwnerId(req.sessionUser.household_id);
      const activeMembers = memoryDb.memberships
        .filter((item) => item.household_id === req.sessionUser.household_id)
        .map((membership) => {
          const user = memoryDb.users.find((item) => item.id === membership.user_id);
          return {
            name: user?.name || "Household member",
            email: user?.email || "",
            role: membership.role,
            status: "active",
            isOwner: membership.user_id === ownerId
          };
        });
      const activeEmails = new Set(activeMembers.map((member) => member.email));
      const pendingMembers = memoryDb.invitations
        .filter((item) => item.household_id === req.sessionUser.household_id && item.status === "pending" && !activeEmails.has(item.email))
        .map((item) => ({ name: item.name, email: item.email, role: item.role, status: "pending", isOwner: false }));
      return res.json({ canManage: req.sessionUser.id === ownerId, members: [...activeMembers, ...pendingMembers] });
    }

    const ownerId = await databasePrimaryOwnerId(pool, req.sessionUser.household_id);
    const [activeResult, pendingResult] = await Promise.all([
      pool.query(
        `SELECT u.name, u.email, hm.role, hm.user_id
         FROM household_memberships hm
         JOIN users u ON u.id = hm.user_id
         WHERE hm.household_id = $1
         ORDER BY hm.created_at ASC`,
        [req.sessionUser.household_id]
      ),
      pool.query(
        `SELECT hi.name, hi.email, hi.role
         FROM household_invitations hi
         WHERE hi.household_id = $1 AND hi.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM household_memberships hm
             JOIN users u ON u.id = hm.user_id
             WHERE hm.household_id = hi.household_id AND lower(u.email) = lower(hi.email)
           )
         ORDER BY hi.created_at ASC`,
        [req.sessionUser.household_id]
      )
    ]);
    res.json({
      canManage: req.sessionUser.id === ownerId,
      members: [
        ...activeResult.rows.map((item) => ({ ...item, status: "active", isOwner: item.user_id === ownerId })),
        ...pendingResult.rows.map((item) => ({ ...item, status: "pending", isOwner: false }))
      ]
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/calendar/members", requireSession, async (req, res, next) => {
  try {
    if (MEMORY_DB) {
      const householdIds = new Set(memoryDb.memberships
        .filter((membership) => membership.user_id === req.sessionUser.id)
        .map((membership) => membership.household_id));
      const seen = new Set();
      const members = memoryDb.memberships
        .filter((membership) => householdIds.has(membership.household_id))
        .map((membership) => memoryDb.users.find((user) => user.id === membership.user_id))
        .filter((user) => user && !user.disabled_at && !seen.has(user.email) && seen.add(user.email))
        .map((user) => ({ id: user.id, name: user.name, email: user.email, status: "active" }));
      return res.json(members);
    }

    const result = await pool.query(
      `SELECT DISTINCT u.id, u.name, u.email
       FROM household_memberships visible
       JOIN household_memberships mine ON mine.household_id = visible.household_id
       JOIN users u ON u.id = visible.user_id
       WHERE mine.user_id = $1 AND u.disabled_at IS NULL
       ORDER BY u.name, u.email`,
      [req.sessionUser.id]
    );
    res.json(result.rows.map((user) => ({ ...user, status: "active" })));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/households/access", requireSession, async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email" });
    let removedName = "Household member";
    let householdName = "your household";

    if (MEMORY_DB) {
      const ownerId = memoryPrimaryOwnerId(req.sessionUser.household_id);
      if (req.sessionUser.id !== ownerId) return res.status(403).json({ error: "Only the household owner can revoke access" });
      const targetUser = memoryDb.users.find((item) => item.email === email);
      if (targetUser?.id === ownerId) return res.status(400).json({ error: "The household owner's access cannot be revoked" });
      const household = memoryDb.households.find((item) => item.id === req.sessionUser.household_id);
      householdName = household?.name || householdName;
      const membershipIndex = targetUser
        ? memoryDb.memberships.findIndex((item) => item.user_id === targetUser.id && item.household_id === req.sessionUser.household_id)
        : -1;
      const invitation = memoryDb.invitations.find((item) => item.household_id === req.sessionUser.household_id && item.email === email && ["pending", "accepted"].includes(item.status));
      if (membershipIndex < 0 && !invitation) return res.status(404).json({ error: "Household access not found" });
      if (membershipIndex >= 0) memoryDb.memberships.splice(membershipIndex, 1);
      if (invitation) invitation.status = "revoked";
      removedName = targetUser?.name || invitation?.name || removedName;
      if (targetUser?.default_household_id === req.sessionUser.household_id) {
        targetUser.default_household_id = memoryDb.memberships.find((item) => item.user_id === targetUser.id)?.household_id || null;
      }
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const ownerId = await databasePrimaryOwnerId(client, req.sessionUser.household_id);
        if (req.sessionUser.id !== ownerId) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "Only the household owner can revoke access" });
        }
        const householdResult = await client.query("SELECT name FROM households WHERE id = $1", [req.sessionUser.household_id]);
        householdName = householdResult.rows[0]?.name || householdName;
        const userResult = await client.query("SELECT id, name FROM users WHERE lower(email) = $1", [email]);
        const targetUser = userResult.rows[0];
        if (targetUser?.id === ownerId) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "The household owner's access cannot be revoked" });
        }
        let membershipRemoved = false;
        if (targetUser) {
          const deleted = await client.query(
            "DELETE FROM household_memberships WHERE household_id = $1 AND user_id = $2 RETURNING user_id",
            [req.sessionUser.household_id, targetUser.id]
          );
          membershipRemoved = deleted.rowCount > 0;
          if (membershipRemoved) {
            await client.query(
              `UPDATE users SET default_household_id = (
                 SELECT household_id FROM household_memberships WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1
               ) WHERE id = $1 AND default_household_id = $2`,
              [targetUser.id, req.sessionUser.household_id]
            );
          }
        }
        const revoked = await client.query(
          `UPDATE household_invitations SET status = 'revoked', updated_at = now()
           WHERE household_id = $1 AND lower(email) = $2 AND status IN ('pending', 'accepted')
           RETURNING name`,
          [req.sessionUser.household_id, email]
        );
        if (!membershipRemoved && revoked.rowCount === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Household access not found" });
        }
        removedName = targetUser?.name || revoked.rows[0]?.name || removedName;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const emailDelivery = await sendHouseholdAccessRevokedEmail({
      email,
      name: removedName,
      ownerName: req.sessionUser.name,
      householdName
    });
    res.json({ ok: true, email: emailDelivery });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/households/:id", requireSession, async (req, res, next) => {
  try {
    const householdId = String(req.params.id || "");
    if (MEMORY_DB) {
      const memberships = memoryDb.memberships.filter((membership) => membership.user_id === req.sessionUser.id);
      const membership = memberships.find((item) => item.household_id === householdId);
      if (!membership) return res.status(404).json({ error: "Household not found" });
      if (membership.role !== "owner") return res.status(403).json({ error: "Only the household owner can remove it" });
      if (memberships.length <= 1) return res.status(400).json({ error: "You must keep at least one household" });
      const memberCount = memoryDb.memberships.filter((item) => item.household_id === householdId).length;
      if (memberCount > 1) return res.status(400).json({ error: "Remove other members before deleting this household" });
      memoryDb.memberships = memoryDb.memberships.filter((item) => item.household_id !== householdId);
      memoryDb.households = memoryDb.households.filter((item) => item.id !== householdId);
      const nextHouseholdId = memoryDb.memberships.find((item) => item.user_id === req.sessionUser.id)?.household_id;
      const user = memoryDb.users.find((item) => item.id === req.sessionUser.id);
      if (user.default_household_id === householdId) user.default_household_id = nextHouseholdId;
      selectHousehold(res, nextHouseholdId);
      return res.json({ ok: true, selectedHouseholdId: nextHouseholdId });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const membershipResult = await client.query(
        `SELECT hm.role,
                (SELECT count(*)::int FROM household_memberships WHERE user_id = $1) AS user_household_count,
                (SELECT count(*)::int FROM household_memberships WHERE household_id::text = $2) AS household_member_count
         FROM household_memberships hm
         WHERE hm.user_id = $1 AND hm.household_id::text = $2`,
        [req.sessionUser.id, householdId]
      );
      const membership = membershipResult.rows[0];
      if (!membership) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Household not found" });
      }
      if (membership.role !== "owner") {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Only the household owner can remove it" });
      }
      if (membership.user_household_count <= 1) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "You must keep at least one household" });
      }
      if (membership.household_member_count > 1) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Remove other members before deleting this household" });
      }
      await client.query("DELETE FROM households WHERE id::text = $1", [householdId]);
      const nextResult = await client.query(
        "SELECT household_id FROM household_memberships WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
        [req.sessionUser.id]
      );
      await client.query(
        "UPDATE users SET default_household_id = $2 WHERE id = $1 AND default_household_id::text = $3",
        [req.sessionUser.id, nextResult.rows[0].household_id, householdId]
      );
      await client.query("COMMIT");
      const nextHouseholdId = nextResult.rows[0].household_id;
      selectHousehold(res, nextHouseholdId);
      res.json({ ok: true, selectedHouseholdId: nextHouseholdId });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get("/api/state", requireSession, async (req, res, next) => {
  try {
    if (MEMORY_DB) {
      const household = memoryDb.households.find((item) => item.id === req.sessionUser.household_id);
      const ownerId = memoryPrimaryOwnerId(req.sessionUser.household_id);
      let shared = memoryDb.sharedModules.find((item) => item.owner_user_id === ownerId);
      if (!shared) {
        shared = { owner_user_id: ownerId, app_state: sharedModulesFromState(household.app_state) };
        memoryDb.sharedModules.push(shared);
      }
      return res.json(applySharedModules(household.app_state, shared.app_state));
    }

    const result = await pool.query("SELECT app_state FROM households WHERE id = $1", [req.sessionUser.household_id]);
    const ownerId = await databasePrimaryOwnerId(pool, req.sessionUser.household_id);
    let sharedResult = await pool.query("SELECT app_state FROM user_shared_modules WHERE owner_user_id = $1", [ownerId]);
    if (sharedResult.rowCount === 0) {
      sharedResult = await pool.query(
        `INSERT INTO user_shared_modules (owner_user_id, app_state) VALUES ($1, $2)
         ON CONFLICT (owner_user_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id
         RETURNING app_state`,
        [ownerId, sharedModulesFromState(result.rows[0].app_state)]
      );
    }
    res.json(applySharedModules(result.rows[0].app_state, sharedResult.rows[0].app_state));
  } catch (error) {
    next(error);
  }
});

app.put("/api/state", requireSession, async (req, res, next) => {
  try {
    if (MEMORY_DB) {
      const household = memoryDb.households.find((item) => item.id === req.sessionUser.household_id);
      household.app_state = req.body;
      const ownerId = memoryPrimaryOwnerId(req.sessionUser.household_id);
      const shared = memoryDb.sharedModules.find((item) => item.owner_user_id === ownerId);
      if (shared) shared.app_state = sharedModulesFromState(req.body);
      else memoryDb.sharedModules.push({ owner_user_id: ownerId, app_state: sharedModulesFromState(req.body) });
      await syncNotificationJobs({ householdId: req.sessionUser.household_id, appState: req.body, user: req.sessionUser });
      return res.json({ ok: true });
    }

    const ownerId = await databasePrimaryOwnerId(pool, req.sessionUser.household_id);
    await Promise.all([
      pool.query("UPDATE households SET app_state = $1, updated_at = now() WHERE id = $2", [req.body, req.sessionUser.household_id]),
      pool.query(
        `INSERT INTO user_shared_modules (owner_user_id, app_state, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (owner_user_id) DO UPDATE SET app_state = EXCLUDED.app_state, updated_at = now()`,
        [ownerId, sharedModulesFromState(req.body)]
      )
    ]);
    await syncNotificationJobs({ householdId: req.sessionUser.household_id, appState: req.body, user: req.sessionUser });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/private-data", requireSession, async (req, res, next) => {
  try {
    if (MEMORY_DB) {
      let record = memoryDb.privateData.find((item) => item.user_id === req.sessionUser.id);
      if (!record) {
        record = { user_id: req.sessionUser.id, ...defaultPrivateData() };
        memoryDb.privateData.push(record);
      }
      return res.json({ journal: record.journal, plans: record.plans });
    }

    const defaults = defaultPrivateData();
    const result = await pool.query(
      `INSERT INTO user_private_data (user_id, journal, plans) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING journal, plans`,
      [req.sessionUser.id, defaults.journal, defaults.plans]
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.put("/api/private-data/journal", requireSession, async (req, res, next) => {
  try {
    const validationError = validateJournalPayload(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    if (MEMORY_DB) {
      let record = memoryDb.privateData.find((item) => item.user_id === req.sessionUser.id);
      if (record) record.journal = req.body;
      else memoryDb.privateData.push({ user_id: req.sessionUser.id, journal: req.body, plans: defaultPrivateData().plans });
      return res.json({ ok: true });
    }

    await pool.query(
      `INSERT INTO user_private_data (user_id, journal, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET journal = EXCLUDED.journal, updated_at = now()`,
      [req.sessionUser.id, req.body]
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.put("/api/private-data/plans", requireSession, async (req, res, next) => {
  try {
    if (MEMORY_DB) {
      let record = memoryDb.privateData.find((item) => item.user_id === req.sessionUser.id);
      if (record) record.plans = req.body;
      else memoryDb.privateData.push({ user_id: req.sessionUser.id, journal: defaultPrivateData().journal, plans: req.body });
      return res.json({ ok: true });
    }

    await pool.query(
      `INSERT INTO user_private_data (user_id, plans, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET plans = EXCLUDED.plans, updated_at = now()`,
      [req.sessionUser.id, req.body]
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/push-devices", requireSession, async (req, res, next) => {
  try {
    const token = String(req.body?.token || "").trim();
    const platform = String(req.body?.platform || "unknown").trim() || "unknown";
    if (!token) return res.status(400).json({ error: "A push token is required" });

    if (MEMORY_DB) {
      const existing = memoryDb.pushDevices.find((device) => device.token === token);
      if (existing) {
        existing.user_id = req.sessionUser.id;
        existing.platform = platform;
        existing.updated_at = new Date().toISOString();
      } else {
        memoryDb.pushDevices.push({ id: crypto.randomUUID(), user_id: req.sessionUser.id, token, platform, updated_at: new Date().toISOString() });
      }
      return res.json({ ok: true });
    }

    await pool.query(
      `INSERT INTO push_devices (user_id, token, platform, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()`,
      [req.sessionUser.id, token, platform]
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

const ALLOWED_DOCUMENT_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
  "image/gif",
  "application/msword",
  "application/vnd.ms-excel",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);
const MAX_DOCUMENT_SIZE_BYTES = 500 * 1024 * 1024;

async function loadHouseholdFolders(householdId) {
  if (MEMORY_DB) {
    return memoryDb.documentFolders.filter((item) => item.household_id === householdId);
  }
  const result = await pool.query("SELECT * FROM document_folders WHERE household_id = $1", [householdId]);
  return result.rows;
}

async function loadHouseholdDocuments(householdId) {
  if (MEMORY_DB) {
    return memoryDb.documents.filter((item) => item.household_id === householdId);
  }
  const result = await pool.query("SELECT * FROM documents WHERE household_id = $1", [householdId]);
  return result.rows;
}

function toClientFolder(folder) {
  return {
    id: folder.id,
    householdId: folder.household_id,
    parentId: folder.parent_id,
    name: folder.name,
    wealthItemType: folder.wealth_item_type,
    wealthItemId: folder.wealth_item_id,
    createdAt: folder.created_at
  };
}

function toClientDocument(document) {
  return {
    id: document.id,
    householdId: document.household_id,
    uploadedBy: document.uploaded_by,
    folderId: document.folder_id,
    noteId: document.note_id,
    wealthItemType: document.wealth_item_type,
    wealthItemId: document.wealth_item_id,
    name: document.name,
    description: document.description,
    contentType: document.content_type,
    sizeBytes: document.size_bytes,
    status: document.status,
    createdAt: document.created_at,
    updatedAt: document.updated_at
  };
}

async function loadHouseholdAppState(householdId) {
  if (MEMORY_DB) {
    return memoryDb.households.find((item) => item.id === householdId)?.app_state;
  }
  const result = await pool.query("SELECT app_state FROM households WHERE id = $1", [householdId]);
  return result.rows[0]?.app_state;
}

async function findHouseholdNoteById(householdId, noteId) {
  if (!noteId) return null;
  const appState = await loadHouseholdAppState(householdId);
  return appState?.notes?.entries?.find((item) => item.id === noteId) || null;
}

async function findHouseholdWealthItemById(householdId, wealthItemType, wealthItemId) {
  if (!wealthItemType || !wealthItemId) return null;
  if (!["asset", "liability"].includes(wealthItemType)) return null;
  const appState = await loadHouseholdAppState(householdId);
  const collection = wealthItemType === "asset" ? appState?.goals?.netWorth?.assets : appState?.goals?.netWorth?.liabilities;
  return collection?.find((item) => item.id === wealthItemId) || null;
}

app.get("/api/documents", requireSession, async (req, res, next) => {
  try {
    const [folders, documents] = await Promise.all([
      loadHouseholdFolders(req.sessionUser.household_id),
      loadHouseholdDocuments(req.sessionUser.household_id)
    ]);
    res.json({ folders: folders.map(toClientFolder), documents: documents.map(toClientDocument) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/documents/folders", requireSession, async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const parentId = req.body?.parentId || null;
    if (!name) return res.status(400).json({ error: "A folder name is required" });

    const folders = await loadHouseholdFolders(req.sessionUser.household_id);
    if (parentId && !folders.some((item) => item.id === parentId)) {
      return res.status(404).json({ error: "Parent folder not found" });
    }

    if (MEMORY_DB) {
      const folder = { id: crypto.randomUUID(), household_id: req.sessionUser.household_id, parent_id: parentId, name, created_at: new Date().toISOString() };
      memoryDb.documentFolders.push(folder);
      return res.json(toClientFolder(folder));
    }

    const result = await pool.query(
      `INSERT INTO document_folders (household_id, parent_id, name) VALUES ($1, $2, $3) RETURNING *`,
      [req.sessionUser.household_id, parentId, name]
    );
    res.json(toClientFolder(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/documents/folders/:id", requireSession, async (req, res, next) => {
  try {
    const folders = await loadHouseholdFolders(req.sessionUser.household_id);
    const folder = folders.find((item) => item.id === req.params.id);
    if (!folder) return res.status(404).json({ error: "Folder not found" });

    const nextName = req.body?.name !== undefined ? String(req.body.name).trim() : folder.name;
    if (!nextName) return res.status(400).json({ error: "A folder name is required" });
    const nextParentId = req.body?.parentId !== undefined ? req.body.parentId : folder.parent_id;
    if (nextParentId && !folders.some((item) => item.id === nextParentId)) {
      return res.status(404).json({ error: "Parent folder not found" });
    }
    const cycleCandidates = folders.map((item) => ({ id: item.id, parentId: item.parent_id }));
    if (wouldCreateFolderCycle(cycleCandidates, folder.id, nextParentId)) {
      return res.status(400).json({ error: "Cannot move a folder into itself or one of its own subfolders" });
    }
    const nextWealthItemId = req.body?.wealthItemId !== undefined ? req.body.wealthItemId : folder.wealth_item_id;
    const nextWealthItemType = nextWealthItemId
      ? (req.body?.wealthItemId !== undefined ? req.body.wealthItemType : folder.wealth_item_type)
      : null;
    if (nextWealthItemId) {
      const wealthItem = await findHouseholdWealthItemById(req.sessionUser.household_id, nextWealthItemType, nextWealthItemId);
      if (!wealthItem) return res.status(400).json({ error: "Linked wealth item not found" });
    }

    if (MEMORY_DB) {
      folder.name = nextName;
      folder.parent_id = nextParentId;
      folder.wealth_item_type = nextWealthItemType;
      folder.wealth_item_id = nextWealthItemId;
      return res.json(toClientFolder(folder));
    }

    const result = await pool.query(
      `UPDATE document_folders SET name = $1, parent_id = $2, wealth_item_type = $3, wealth_item_id = $4 WHERE id = $5 AND household_id = $6 RETURNING *`,
      [nextName, nextParentId, nextWealthItemType, nextWealthItemId, folder.id, req.sessionUser.household_id]
    );
    res.json(toClientFolder(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/documents/folders/:id", requireSession, async (req, res, next) => {
  try {
    const folders = await loadHouseholdFolders(req.sessionUser.household_id);
    const folder = folders.find((item) => item.id === req.params.id);
    if (!folder) return res.status(404).json({ error: "Folder not found" });

    const documents = await loadHouseholdDocuments(req.sessionUser.household_id);
    const hasChildFolder = folders.some((item) => item.parent_id === folder.id);
    const hasDocument = documents.some((item) => item.folder_id === folder.id);
    if (hasChildFolder || hasDocument) {
      return res.status(409).json({ error: "Folder must be empty before it can be deleted" });
    }

    if (MEMORY_DB) {
      memoryDb.documentFolders = memoryDb.documentFolders.filter((item) => item.id !== folder.id);
      return res.json({ ok: true });
    }

    await pool.query("DELETE FROM document_folders WHERE id = $1 AND household_id = $2", [folder.id, req.sessionUser.household_id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/documents/upload-url", requireSession, async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const contentType = String(req.body?.contentType || "").trim();
    const sizeBytes = Number(req.body?.sizeBytes) || null;
    const folderId = req.body?.folderId || null;
    const noteId = req.body?.noteId || null;
    if (!name) return res.status(400).json({ error: "A document name is required" });
    if (!ALLOWED_DOCUMENT_CONTENT_TYPES.has(contentType)) return res.status(400).json({ error: "Unsupported file type" });
    if (sizeBytes && sizeBytes > MAX_DOCUMENT_SIZE_BYTES) return res.status(400).json({ error: "File exceeds the 500MB limit" });

    if (folderId) {
      const folders = await loadHouseholdFolders(req.sessionUser.household_id);
      if (!folders.some((item) => item.id === folderId)) return res.status(404).json({ error: "Folder not found" });
    }
    if (noteId) {
      const note = await findHouseholdNoteById(req.sessionUser.household_id, noteId);
      if (!note) return res.status(400).json({ error: "Linked note not found" });
    }

    const documentId = crypto.randomUUID();
    const storageObject = buildDocumentObjectPath(req.sessionUser.household_id, documentId, name);
    const { url, expiresAt } = await createSignedUploadUrl(storageObject, contentType);

    if (MEMORY_DB) {
      memoryDb.documents.push({
        id: documentId, household_id: req.sessionUser.household_id, uploaded_by: req.sessionUser.id,
        folder_id: folderId, note_id: noteId, name, description: "", content_type: contentType,
        size_bytes: sizeBytes, storage_object: storageObject, status: "pending",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });
      return res.json({ documentId, uploadUrl: url, expiresAt });
    }

    await pool.query(
      `INSERT INTO documents (id, household_id, uploaded_by, folder_id, note_id, name, content_type, size_bytes, storage_object, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
      [documentId, req.sessionUser.household_id, req.sessionUser.id, folderId, noteId, name, contentType, sizeBytes, storageObject]
    );
    res.json({ documentId, uploadUrl: url, expiresAt });
  } catch (error) {
    next(error);
  }
});

app.post("/api/documents/:id/confirm", requireSession, async (req, res, next) => {
  try {
    const documents = await loadHouseholdDocuments(req.sessionUser.household_id);
    const document = documents.find((item) => item.id === req.params.id);
    if (!document) return res.status(404).json({ error: "Document not found" });

    if (MEMORY_DB) {
      document.status = "ready";
      document.updated_at = new Date().toISOString();
      return res.json(toClientDocument(document));
    }

    const result = await pool.query(
      `UPDATE documents SET status = 'ready', updated_at = now() WHERE id = $1 AND household_id = $2 RETURNING *`,
      [document.id, req.sessionUser.household_id]
    );
    res.json(toClientDocument(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.get("/api/documents/:id/download-url", requireSession, async (req, res, next) => {
  try {
    const documents = await loadHouseholdDocuments(req.sessionUser.household_id);
    const document = documents.find((item) => item.id === req.params.id);
    if (!document) return res.status(404).json({ error: "Document not found" });

    const { url, expiresAt } = await createSignedDownloadUrl(document.storage_object);
    res.json({ url, expiresAt });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/documents/:id", requireSession, async (req, res, next) => {
  try {
    const documents = await loadHouseholdDocuments(req.sessionUser.household_id);
    const document = documents.find((item) => item.id === req.params.id);
    if (!document) return res.status(404).json({ error: "Document not found" });

    await deleteObject(document.storage_object);

    if (MEMORY_DB) {
      memoryDb.documents = memoryDb.documents.filter((item) => item.id !== document.id);
      return res.json({ ok: true });
    }

    await pool.query("DELETE FROM documents WHERE id = $1 AND household_id = $2", [document.id, req.sessionUser.household_id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/documents/:id", requireSession, async (req, res, next) => {
  try {
    const documents = await loadHouseholdDocuments(req.sessionUser.household_id);
    const document = documents.find((item) => item.id === req.params.id);
    if (!document) return res.status(404).json({ error: "Document not found" });

    const nextName = req.body?.name !== undefined ? String(req.body.name).trim() : document.name;
    if (!nextName) return res.status(400).json({ error: "A document name is required" });
    const nextDescription = req.body?.description !== undefined ? String(req.body.description) : document.description;
    const nextFolderId = req.body?.folderId !== undefined ? req.body.folderId : document.folder_id;
    const nextNoteId = req.body?.noteId !== undefined ? req.body.noteId : document.note_id;
    const nextWealthItemId = req.body?.wealthItemId !== undefined ? req.body.wealthItemId : document.wealth_item_id;
    const nextWealthItemType = nextWealthItemId
      ? (req.body?.wealthItemId !== undefined ? req.body.wealthItemType : document.wealth_item_type)
      : null;

    if (nextFolderId) {
      const folders = await loadHouseholdFolders(req.sessionUser.household_id);
      if (!folders.some((item) => item.id === nextFolderId)) return res.status(404).json({ error: "Folder not found" });
    }
    if (nextNoteId) {
      const note = await findHouseholdNoteById(req.sessionUser.household_id, nextNoteId);
      if (!note) return res.status(400).json({ error: "Linked note not found" });
    }
    if (nextWealthItemId) {
      const wealthItem = await findHouseholdWealthItemById(req.sessionUser.household_id, nextWealthItemType, nextWealthItemId);
      if (!wealthItem) return res.status(400).json({ error: "Linked wealth item not found" });
    }

    if (MEMORY_DB) {
      document.name = nextName;
      document.description = nextDescription;
      document.folder_id = nextFolderId;
      document.note_id = nextNoteId;
      document.wealth_item_type = nextWealthItemType;
      document.wealth_item_id = nextWealthItemId;
      document.updated_at = new Date().toISOString();
      return res.json(toClientDocument(document));
    }

    const result = await pool.query(
      `UPDATE documents SET name = $1, description = $2, folder_id = $3, note_id = $4, wealth_item_type = $5, wealth_item_id = $6, updated_at = now() WHERE id = $7 AND household_id = $8 RETURNING *`,
      [nextName, nextDescription, nextFolderId, nextNoteId, nextWealthItemType, nextWealthItemId, document.id, req.sessionUser.household_id]
    );
    res.json(toClientDocument(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.post("/api/internal/notifications/process", requireNotificationSecret, async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.body?.limit) || 200));
    const jobs = MEMORY_DB ? claimDueNotificationJobsMemory(limit) : await claimDueNotificationJobsDb(limit);

    const jobsByUser = new Map();
    for (const job of jobs) {
      if (!job.user_id) continue;
      if (!jobsByUser.has(job.user_id)) jobsByUser.set(job.user_id, []);
      jobsByUser.get(job.user_id).push(job);
    }

    const pushTokensByUser = new Map();
    if (jobsByUser.size) {
      const userIds = [...jobsByUser.keys()];
      const devices = MEMORY_DB
        ? memoryDb.pushDevices.filter((device) => userIds.includes(device.user_id))
        : (await pool.query("SELECT user_id, token FROM push_devices WHERE user_id = ANY($1)", [userIds])).rows;
      for (const device of devices) {
        if (!pushTokensByUser.has(device.user_id)) pushTokensByUser.set(device.user_id, []);
        pushTokensByUser.get(device.user_id).push(device.token);
      }
    }

    let pushSent = 0;
    const allInvalidTokens = new Set();
    for (const [userId, userJobs] of jobsByUser) {
      const tokens = pushTokensByUser.get(userId) || [];
      if (!tokens.length) continue;
      const title = userJobs.length === 1 ? userJobs[0].title : `${userJobs.length} FamilyLoop reminders`;
      const { sentCount, invalidTokens } = await sendExpoPush(tokens, title);
      pushSent += sentCount;
      invalidTokens.forEach((token) => allInvalidTokens.add(token));
    }
    if (allInvalidTokens.size) await prunePushDevices([...allInvalidTokens]);

    const phoneByUser = new Map();
    if (jobsByUser.size) {
      const userIds = [...jobsByUser.keys()];
      const rows = MEMORY_DB
        ? memoryDb.users.filter((user) => userIds.includes(user.id))
        : (await pool.query("SELECT id, phone, carrier FROM users WHERE id = ANY($1)", [userIds])).rows;
      for (const row of rows) {
        if (row.phone && row.carrier) phoneByUser.set(row.id, { phone: row.phone, carrier: row.carrier });
      }
    }

    let sent = 0;
    let failed = 0;
    let retried = 0;
    let smsSent = 0;
    for (const job of jobs) {
      try {
        const delivery = await sendReminderEmail({ email: job.recipient_email, title: job.title, dueAt: job.due_at, timeZone: job.time_zone });
        if (delivery.error) throw new Error(delivery.error);
        await markNotificationJobSent(job.id);
        sent += 1;
      } catch (error) {
        if (Number(job.attempts || 1) >= NOTIFICATION_MAX_ATTEMPTS) {
          await markNotificationJobGivenUp(job.id, error.message);
          failed += 1;
        } else {
          await recordNotificationJobError(job.id, error.message);
          retried += 1;
        }
      }
      const phoneInfo = job.user_id ? phoneByUser.get(job.user_id) : null;
      if (phoneInfo) {
        try {
          const smsDelivery = await sendReminderSms({ phone: phoneInfo.phone, carrier: phoneInfo.carrier, title: job.title, dueAt: job.due_at, timeZone: job.time_zone });
          if (!smsDelivery.skipped && !smsDelivery.error) smsSent += 1;
        } catch (_error) {
          // SMS is a best-effort bonus channel; failures here shouldn't affect the job's email retry bookkeeping.
        }
      }
    }

    res.json({ processed: jobs.length, sent, failed, retried, pushSent, pushPruned: allInvalidTokens.size, smsSent });
  } catch (error) {
    next(error);
  }
});

if (TEST_EXPOSE_NOTIFICATIONS) {
  app.get("/api/test/notification-jobs", (_req, res) => {
    res.json(memoryDb.notificationJobs);
  });
  app.get("/api/test/push-devices", (_req, res) => {
    res.json(memoryDb.pushDevices);
  });
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Something went wrong" });
});

let httpServer;

async function main() {
  await migrate();
  await seedDemoUser();
  await seedAdminUser();
  httpServer = app.listen(PORT, () => {
    console.log(`FamilyLoop listening on ${PORT}`);
  });
}

async function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  if (pool) await pool.end();
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
