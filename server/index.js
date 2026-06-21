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
const { countries } = require("countries-list");
const { defaultState } = require("./default-state");

const PORT = Number(process.env.PORT || 8080);
const SESSION_COOKIE = "hh_session";
const HOUSEHOLD_COOKIE = "hh_household";
const SESSION_SECRET = process.env.SESSION_SECRET || "local-dev-session-secret-change-me";
const DATABASE_URL = process.env.DATABASE_URL || "postgres://household_hub:household_hub_dev@localhost:15432/household_hub";
const DATABASE_SSL = String(process.env.DATABASE_SSL || "false").toLowerCase() === "true";
const MEMORY_DB = String(process.env.MEMORY_DB || "false").toLowerCase() === "true";
const DEMO_EMAIL = "demo@householdhub.app";
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const ADMIN_NAME = String(process.env.ADMIN_NAME || "Household Hub Administrator").trim();
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const EMAIL_FROM = String(process.env.EMAIL_FROM || "Household Hub <no-reply@householdhub.app>").trim();
const APP_BASE_URL = String(process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

const pool = MEMORY_DB
  ? null
  : new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_SSL ? { rejectUnauthorized: false } : false
    });

const memoryDb = {
  users: [],
  households: [],
  memberships: [],
  invitations: [],
  loginEvents: []
};

const app = express();
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
    const delivery = {
      delivered: Boolean(SMTP_HOST),
      preview: !SMTP_HOST,
      messageId: info.messageId || ""
    };
    if (!SMTP_HOST) {
      console.log(`[email preview] ${subject} -> ${to}`);
    }
    return delivery;
  } catch (error) {
    console.error(`Email delivery failed for ${to}:`, error.message);
    return { delivered: false, preview: false, error: "Email delivery failed" };
  }
}

function sendWelcomeEmail({ email, name, householdName }) {
  const safeName = escapeHtml(name);
  const safeHousehold = escapeHtml(householdName);
  return sendTransactionalEmail({
    to: email,
    subject: "Welcome to Household Hub",
    text: `Hi ${name}, your Household Hub login has been created for ${householdName}. Open ${APP_BASE_URL} to get started.`,
    html: `<h2>Welcome to Household Hub</h2><p>Hi ${safeName},</p><p>Your login has been created for <strong>${safeHousehold}</strong>.</p><p><a href="${escapeHtml(APP_BASE_URL)}">Open Household Hub</a> to get started.</p>`
  });
}

function sendHouseholdInviteEmail({ email, name, inviterName, householdName, inviteCode, role, scopes }) {
  const scopeText = scopes.length ? scopes.join(", ") : "household workspace";
  return sendTransactionalEmail({
    to: email,
    subject: `${inviterName} shared ${householdName} with you`,
    text: `Hi ${name}, ${inviterName} invited you to ${householdName} in Household Hub as ${role}. Invite code: ${inviteCode}. Shared areas: ${scopeText}. Open ${APP_BASE_URL}.`,
    html: `<h2>You have been invited to Household Hub</h2><p>Hi ${escapeHtml(name)},</p><p><strong>${escapeHtml(inviterName)}</strong> shared <strong>${escapeHtml(householdName)}</strong> with you as ${escapeHtml(role)}.</p><p>Invite code: <strong>${escapeHtml(inviteCode)}</strong></p><p>Shared areas: ${escapeHtml(scopeText)}</p><p><a href="${escapeHtml(APP_BASE_URL)}">Open Household Hub</a></p>`
  });
}

function publicUser(row) {
  return row ? { id: row.id, email: row.email, name: row.name, isAdmin: Boolean(row.is_admin) } : null;
}

function signSession(res, userId) {
  res.cookie(SESSION_COOKIE, userId, {
    httpOnly: true,
    signed: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 14
  });
}

function clearSession(res) {
  res.clearCookie(SESSION_COOKIE);
  res.clearCookie(HOUSEHOLD_COOKIE);
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
  if (ADMIN_EMAIL) {
    await pool.query("UPDATE users SET is_admin = (email = $1)", [ADMIN_EMAIL]);
  } else {
    await pool.query("UPDATE users SET is_admin = false WHERE email = $1", [DEMO_EMAIL]);
  }
}

function makeInviteCode() {
  return `HUB-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
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

function householdState(name, country = "US", currency = "USD") {
  const state = JSON.parse(JSON.stringify(defaultState));
  state.household.name = name;
  state.household.country = country;
  state.household.currency = currency;
  state.household.inviteCode = makeInviteCode();
  if (country === "IN") {
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
      { name: "India bank account", value: 450000 },
      { name: "India property", value: 8500000 },
      { name: "EPF", value: 1200000 }
    ];
    state.goals.netWorth.liabilities = [
      { name: "India home loan", value: 3200000 }
    ];
    state.goals.debts = [
      { name: "India home loan", balance: 3200000, rate: 8.5, minimum: 32000 }
    ];
  }
  return state;
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
    const usState = householdState("US Household", "US", "USD");
    const household = {
      id: crypto.randomUUID(),
      name: "US Household",
      invite_code: usState.household.inviteCode,
      app_state: usState,
      created_at: new Date().toISOString()
    };
    const indiaState = householdState("India Household", "IN", "INR");
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
    return;
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [DEMO_EMAIL]);
  if (existing.rowCount > 0) {
    const userId = existing.rows[0].id;
    const memberships = await pool.query(
      `SELECT h.id, h.name FROM households h
       JOIN household_memberships hm ON hm.household_id = h.id
       WHERE hm.user_id = $1`,
      [userId]
    );
    const names = new Set(memberships.rows.map((row) => row.name));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (!names.has("US Household")) {
        const existingHousehold = memberships.rows.find((row) => row.name !== "India Household");
        if (existingHousehold) {
          await client.query(
            `UPDATE households
             SET name = 'US Household',
                 app_state = jsonb_set(
                   jsonb_set(
                     jsonb_set(app_state, '{household,name}', '"US Household"', true),
                     '{household,country}', '"US"', true
                   ),
                   '{household,currency}', '"USD"', true
                 )
             WHERE id = $1`,
            [existingHousehold.id]
          );
        } else {
          await createHouseholdForUser(client, userId, "US Household", householdState("US Household", "US", "USD"));
        }
      }
      if (!names.has("India Household")) {
        await createHouseholdForUser(client, userId, "India Household", householdState("India Household", "IN", "INR"));
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
    await createHouseholdForUser(client, user.rows[0].id, "US Household", householdState("US Household", "US", "USD"));
    await createHouseholdForUser(client, user.rows[0].id, "India Household", householdState("India Household", "IN", "INR"));
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
    user.password_hash = passwordHash;
    user.is_admin = true;
    user.disabled_at = null;
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let user = await client.query(
      `INSERT INTO users (email, password_hash, name, is_admin)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (email)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, is_admin = true, disabled_at = NULL
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
  const userId = req.signedCookies[SESSION_COOKIE];
  const selectedHouseholdId = req.signedCookies[HOUSEHOLD_COOKIE];
  if (!userId) return null;
  if (MEMORY_DB) {
    const user = memoryDb.users.find((item) => item.id === userId);
    const memberships = memoryDb.memberships.filter((item) => item.user_id === userId);
    const membership = memberships.find((item) => item.household_id === selectedHouseholdId) || memberships[0];
    const household = memoryDb.households.find((item) => item.id === membership?.household_id);
    if (!user || !household) return null;
    return { ...user, household_id: household.id, household_name: household.name };
  }

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.is_admin, u.disabled_at, h.id AS household_id, h.name AS household_name
     FROM users u
     JOIN household_memberships hm ON hm.user_id = u.id
     JOIN households h ON h.id = hm.household_id
     WHERE u.id = $1
     ORDER BY (h.id::text = $2) DESC, hm.created_at ASC
     LIMIT 1`,
    [userId, selectedHouseholdId || ""]
  );
  return result.rows[0] || null;
}

async function requireAdmin(req, res, next) {
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: "Authentication required" });
    if (!session.is_admin) return res.status(403).json({ error: "Admin access required" });
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
    isAdmin: Boolean(user.is_admin),
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
    if (!session) return res.status(401).json({ error: "Authentication required" });
    req.sessionUser = session;
    return next();
  } catch (error) {
    return next(error);
  }
}

app.get("/healthz", (_req, res) => {
  res.type("text/plain").send("ok");
});

app.get("/api/countries", (_req, res) => {
  res.json(countryCatalog());
});

app.get("/api/session", async (req, res, next) => {
  try {
    const session = await getSession(req);
    res.json({
      authenticated: Boolean(session),
      user: publicUser(session),
      household: session ? { id: session.household_id, name: session.household_name } : null
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
  if (email === DEMO_EMAIL || (ADMIN_EMAIL && email === ADMIN_EMAIL)) {
    return res.status(409).json({ error: "That email is reserved" });
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
    const emailDelivery = await sendWelcomeEmail({ email, name, householdName });
    signSession(res, user.id);
    return res.status(201).json({ user: publicUser(user), email: emailDelivery });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hash = await bcrypt.hash(password, 12);
    const user = await client.query(
      "INSERT INTO users (email, password_hash, name, is_admin) VALUES ($1, $2, $3, $4) RETURNING id, email, name, is_admin",
      [email, hash, name, false]
    );
    const state = householdState(householdName, country, currency);
    await createHouseholdForUser(client, user.rows[0].id, householdName, state);
    await client.query("COMMIT");
    const emailDelivery = await sendWelcomeEmail({ email, name, householdName });
    signSession(res, user.rows[0].id);
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
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      if (user.disabled_at) return res.status(403).json({ error: "This login has been disabled" });
      await recordLogin(user.id);
      signSession(res, user.id);
      return res.json({ user: publicUser(user) });
    }

    const result = await pool.query("SELECT id, email, name, password_hash, is_admin, disabled_at FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    if (user.disabled_at) return res.status(403).json({ error: "This login has been disabled" });
    await recordLogin(user.id);
    signSession(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/demo", async (_req, res, next) => {
  try {
    let user;
    if (MEMORY_DB) {
      user = memoryDb.users.find((item) => item.email === DEMO_EMAIL);
    } else {
      const result = await pool.query(
        "SELECT id, email, name, is_admin, disabled_at FROM users WHERE email = $1",
        [DEMO_EMAIL]
      );
      user = result.rows[0];
    }
    if (!user || user.disabled_at) {
      return res.status(503).json({ error: "Demo access is temporarily unavailable" });
    }
    await recordLogin(user.id);
    signSession(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
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
            selected: household.id === req.sessionUser.household_id
          };
        });
      return res.json(households);
    }

    const result = await pool.query(
      `SELECT h.id, h.name, hm.role,
              COALESCE(h.app_state->'household'->>'country', 'US') AS country,
              COALESCE(h.app_state->'household'->>'currency', 'USD') AS currency
       FROM households h
       JOIN household_memberships hm ON hm.household_id = h.id
       WHERE hm.user_id = $1
       ORDER BY hm.created_at ASC`,
      [req.sessionUser.id]
    );
    res.json(result.rows.map((household) => ({
      ...household,
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

    let household;
    let inviteCode;

    if (MEMORY_DB) {
      const membership = memoryDb.memberships.find((item) =>
        item.user_id === req.sessionUser.id && item.household_id === req.sessionUser.household_id
      );
      if (!membership || membership.role !== "owner") {
        return res.status(403).json({ error: "Only the household owner can send invitations" });
      }
      household = memoryDb.households.find((item) => item.id === req.sessionUser.household_id);
      if (!household) return res.status(404).json({ error: "Household not found" });
      inviteCode = household.invite_code || makeInviteCode();
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
    } else {
      const result = await pool.query(
        `SELECT h.id, h.name, h.invite_code, hm.role
         FROM households h
         JOIN household_memberships hm ON hm.household_id = h.id
         WHERE h.id = $1 AND hm.user_id = $2`,
        [req.sessionUser.household_id, req.sessionUser.id]
      );
      household = result.rows[0];
      if (!household) return res.status(404).json({ error: "Household not found" });
      if (household.role !== "owner") {
        return res.status(403).json({ error: "Only the household owner can send invitations" });
      }
      inviteCode = household.invite_code;
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
    }

    const emailDelivery = await sendHouseholdInviteEmail({
      email,
      name,
      inviterName: req.sessionUser.name,
      householdName: household.name,
      inviteCode,
      role,
      scopes
    });

    res.status(201).json({
      invitation: { email, name, role, scopes, inviteCode, status: "pending" },
      email: emailDelivery
    });
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
      return res.json(household.app_state);
    }

    const result = await pool.query("SELECT app_state FROM households WHERE id = $1", [req.sessionUser.household_id]);
    res.json(result.rows[0].app_state);
  } catch (error) {
    next(error);
  }
});

app.put("/api/state", requireSession, async (req, res, next) => {
  try {
    if (MEMORY_DB) {
      const household = memoryDb.households.find((item) => item.id === req.sessionUser.household_id);
      household.app_state = req.body;
      return res.json({ ok: true });
    }

    await pool.query(
      "UPDATE households SET app_state = $1, updated_at = now() WHERE id = $2",
      [req.body, req.sessionUser.household_id]
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Something went wrong" });
});

async function main() {
  await migrate();
  await seedDemoUser();
  await seedAdminUser();
  app.listen(PORT, () => {
    console.log(`Household Hub listening on ${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
