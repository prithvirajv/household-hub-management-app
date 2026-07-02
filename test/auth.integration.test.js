const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");

const port = 43000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const adminEmail = "private-admin@example.com";
const initialPassword = "Initial-Admin-Password-123!";
const resetPassword = "Reset-Admin-Password-456!";
let server;

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
    } catch (_error) {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not become ready");
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return {
    status: response.status,
    body,
    cookie: setCookies.map((cookie) => cookie.split(";")[0]).join("; ")
  };
}

test.before(async () => {
  server = spawn(process.execPath, ["server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MEMORY_DB: "true",
      NODE_ENV: "test",
      TEST_EXPOSE_RESET_TOKEN: "true",
      SESSION_SECRET: "test-session-secret-with-sufficient-entropy",
      SESSION_IDLE_MS: "1500",
      ADMIN_EMAIL: adminEmail,
      ADMIN_PASSWORD: initialPassword,
      ADMIN_NAME: "Private Administrator",
      APP_BASE_URL: baseUrl,
      SMTP_HOST: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer();
});

test.after(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await once(server, "exit");
});

test("consumer demo is isolated from administrator APIs", async () => {
  const demo = await request("/api/auth/demo", { method: "POST", body: "{}" });
  assert.equal(demo.status, 200);
  assert.equal(demo.body.user.isAdmin, false);
  assert.equal(demo.body.household.name, "US Household");

  const demoState = await request("/api/state", {
    headers: { cookie: demo.cookie }
  });
  assert.equal(demoState.status, 200);
  assert.equal(demoState.body.household.country, "US");
  assert.equal(demoState.body.household.currency, "USD");

  const adminAttempt = await request("/api/admin/session", {
    headers: { cookie: demo.cookie }
  });
  assert.equal(adminAttempt.status, 403);

  const passwordAttempt = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: "demo@famelo.net", password: "budget123" })
  });
  assert.equal(passwordAttempt.status, 400);
});

test("configured private administrator can sign in and is the sole admin", async () => {
  const signin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  assert.equal(signin.status, 200);
  assert.equal(signin.body.user.isAdmin, true);

  const validation = await request("/api/admin/session", {
    headers: { cookie: signin.cookie }
  });
  assert.equal(validation.status, 200);
  assert.equal(validation.body.authorized, true);

  const users = await request("/api/admin/users", {
    headers: { cookie: signin.cookie }
  });
  assert.equal(users.status, 200);
  assert.deepEqual(users.body.filter((user) => user.isAdmin).map((user) => user.email), [adminEmail]);
});

test("authenticated sessions expire after the configured idle window", async () => {
  const signin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  assert.equal(signin.status, 200);

  const activeSession = await request("/api/session", {
    headers: { cookie: signin.cookie }
  });
  assert.equal(activeSession.status, 200);
  assert.equal(activeSession.body.authenticated, true);

  await new Promise((resolve) => setTimeout(resolve, 1700));

  const expiredSession = await request("/api/session", {
    headers: { cookie: signin.cookie }
  });
  assert.equal(expiredSession.status, 200);
  assert.equal(expiredSession.body.authenticated, false);

  const adminAttempt = await request("/api/admin/session", {
    headers: { cookie: signin.cookie }
  });
  assert.equal(adminAttempt.status, 401);
});

test("public signup cannot claim reserved administrator or demo identities", async () => {
  for (const email of [adminEmail, "demo@famelo.net"]) {
    const signup = await request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        email,
        password: "Consumer-Password-123!",
        name: "Reserved User",
        householdName: "Reserved Household",
        country: "US"
      })
    });
    assert.equal(signup.status, 409);
  }
});

test("a user cannot create multiple households with the same currency", async () => {
  const signin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  assert.equal(signin.status, 200);

  const duplicateUsd = await request("/api/households", {
    method: "POST",
    headers: { cookie: signin.cookie },
    body: JSON.stringify({ name: "Second USD Household", country: "EC" })
  });
  assert.equal(duplicateUsd.status, 409);
  assert.equal(duplicateUsd.body.error, "You already belong to a household using USD");

  const differentCurrency = await request("/api/households", {
    method: "POST",
    headers: { cookie: signin.cookie },
    body: JSON.stringify({ name: "India Household", country: "IN" })
  });
  assert.equal(differentCurrency.status, 201);
  assert.equal(differentCurrency.body.currency, "INR");

  const starterState = await request("/api/state", {
    headers: { cookie: `${signin.cookie}; ${differentCurrency.cookie}` }
  });
  assert.equal(starterState.status, 200);
  assert.equal(starterState.body.budget.income, 0);
  assert.equal(starterState.body.transactions.length, 0);
  assert.equal(starterState.body.paychecks.length, 0);
  assert.equal(starterState.body.calendar.events.length, 0);
  assert.equal(starterState.body.calendar.chores.length, 0);
  assert.equal(starterState.body.notes.entries.length, 0);
  assert.equal(starterState.body.meals.recipes.length, 0);
  assert.equal(starterState.body.goals.sinkingFunds.length, 0);
  assert.equal(starterState.body.goals.debts.length, 0);
  assert.equal(starterState.body.goals.netWorth.assets.length, 0);
  assert.equal(starterState.body.goals.netWorth.liabilities.length, 0);
  assert.ok(starterState.body.budget.categories.every((category) =>
    category.lines.every((line) => line.planned === 0)
  ));

  starterState.body.goals.netWorth.assets.push({ id: "home-asset", name: "Family home", value: 500000 });
  starterState.body.goals.netWorth.liabilities.push({ id: "mortgage-debt", name: "Mortgage", value: 200000 });
  starterState.body.goals.debts.push({
    id: "mortgage-debt",
    name: "Mortgage",
    balance: 200000,
    rate: 6.5,
    minimum: 1500,
    assetId: "home-asset"
  });
  const savedState = await request("/api/state", {
    method: "PUT",
    headers: { cookie: `${signin.cookie}; ${differentCurrency.cookie}` },
    body: JSON.stringify(starterState.body)
  });
  assert.equal(savedState.status, 200);

  const reloadedState = await request("/api/state", {
    headers: { cookie: `${signin.cookie}; ${differentCurrency.cookie}` }
  });
  assert.equal(reloadedState.body.goals.debts[0].assetId, "home-asset");

  const householdList = await request("/api/households", {
    headers: { cookie: `${signin.cookie}; ${differentCurrency.cookie}` }
  });
  const usdHousehold = householdList.body.find((household) => household.currency === "USD");
  const inrHousehold = householdList.body.find((household) => household.currency === "INR");
  const setIndiaDefault = await request("/api/households/default", {
    method: "POST",
    headers: { cookie: `${signin.cookie}; ${differentCurrency.cookie}` },
    body: JSON.stringify({ householdId: inrHousehold.id })
  });
  assert.equal(setIndiaDefault.status, 200);

  const freshSignin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  const defaultHouseholds = await request("/api/households", {
    headers: { cookie: freshSignin.cookie }
  });
  assert.equal(defaultHouseholds.body.find((household) => household.selected).id, inrHousehold.id);
  assert.equal(defaultHouseholds.body.find((household) => household.isDefault).id, inrHousehold.id);

  const restoreDefault = await request("/api/households/default", {
    method: "POST",
    headers: { cookie: freshSignin.cookie },
    body: JSON.stringify({ householdId: usdHousehold.id })
  });
  assert.equal(restoreDefault.status, 200);
});

test("an existing user cannot accept an invitation for a duplicate currency", async () => {
  const signup = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email: "existing-usd-user@example.com",
      password: "Existing-User-Password-123!",
      name: "Existing User",
      householdName: "Existing USD Household",
      country: "US"
    })
  });
  assert.equal(signup.status, 201);

  const adminSignin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  const invitation = await request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: adminSignin.cookie },
    body: JSON.stringify({
      email: "existing-usd-user@example.com",
      name: "Existing User",
      role: "Member",
      scopes: ["Budget"]
    })
  });
  assert.equal(invitation.status, 201);

  const accepted = await request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: "existing-usd-user@example.com",
      inviteCode: invitation.body.invitation.inviteCode,
      password: "Existing-User-Password-123!"
    })
  });
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.error, "You already belong to a household using USD");
});

test("invitation code creates a login, joins the household, and is single-use", async () => {
  const adminSignin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  assert.equal(adminSignin.status, 200);

  const invitedEmail = "invited-member@example.com";
  const invitation = await request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: adminSignin.cookie },
    body: JSON.stringify({
      email: invitedEmail,
      name: "Invited Member",
      role: "Member",
      scopes: ["Budget", "Calendar"]
    })
  });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  assert.ok(invitation.body.invitation.inviteCode);

  const wrongEmail = await request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: "different@example.com",
      inviteCode: invitation.body.invitation.inviteCode,
      password: "Invited-Member-Password-123!"
    })
  });
  assert.equal(wrongEmail.status, 400);

  const accepted = await request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: invitedEmail,
      inviteCode: invitation.body.invitation.inviteCode,
      password: "Invited-Member-Password-123!"
    })
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.user.email, invitedEmail);
  assert.equal(accepted.body.user.isAdmin, false);
  assert.equal(accepted.body.household.name, "Administrator Household");

  const households = await request("/api/households", {
    headers: { cookie: accepted.cookie }
  });
  assert.equal(households.status, 200);
  assert.equal(households.body.length, 1);
  assert.equal(households.body[0].selected, true);
  assert.equal(households.body[0].role, "member");

  const reused = await request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: invitedEmail,
      inviteCode: invitation.body.invitation.inviteCode,
      password: "Invited-Member-Password-123!"
    })
  });
  assert.equal(reused.status, 400);
});

test("password reset is generic, one-time, and preserves admin authorization", async () => {
  const unknown = await request("/api/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify({ email: "unknown@example.com" })
  });
  assert.equal(unknown.status, 202);
  assert.equal("resetToken" in unknown.body, false);

  const resetRequest = await request("/api/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail })
  });
  assert.equal(resetRequest.status, 202);
  assert.ok(resetRequest.body.resetToken);

  const confirmation = await request("/api/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify({
      email: adminEmail,
      token: resetRequest.body.resetToken,
      password: resetPassword
    })
  });
  assert.equal(confirmation.status, 200);

  const reuse = await request("/api/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify({
      email: adminEmail,
      token: resetRequest.body.resetToken,
      password: "Another-Password-789!"
    })
  });
  assert.equal(reuse.status, 400);

  const oldSignin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  assert.equal(oldSignin.status, 401);

  const newSignin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: resetPassword })
  });
  assert.equal(newSignin.status, 200);
  assert.equal(newSignin.body.user.isAdmin, true);
});
