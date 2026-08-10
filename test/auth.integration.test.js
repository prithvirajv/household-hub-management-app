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

function combineCookies(...cookieHeaders) {
  const cookies = new Map();
  cookieHeaders.filter(Boolean).forEach((header) => {
    header.split(";").map((item) => item.trim()).filter(Boolean).forEach((cookie) => {
      const separator = cookie.indexOf("=");
      cookies.set(cookie.slice(0, separator), cookie.slice(separator + 1));
    });
  });
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
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
      SMTP_HOST: "",
      TEST_BYPASS_GOOGLE_AUTH: "true"
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
    body: JSON.stringify({ email: "demo@familyloop.net", password: "budget123" })
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
  for (const email of [adminEmail, "demo@familyloop.net"]) {
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

test("signup rejects an unrecognized mobile carrier but allows leaving phone/carrier blank", async () => {
  const badCarrier = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email: "bad-carrier@example.com", password: "Consumer-Password-123!", name: "Bad Carrier", householdName: "Bad Carrier Household", country: "US",
      phone: "5551234567", carrier: "not-a-real-carrier"
    })
  });
  assert.equal(badCarrier.status, 400);

  const noPhone = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email: "no-phone@example.com", password: "Consumer-Password-123!", name: "No Phone", householdName: "No Phone Household", country: "US"
    })
  });
  assert.equal(noPhone.status, 201);
  assert.equal(noPhone.body.user.phone, "");
  assert.equal(noPhone.body.user.carrier, "");
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
    headers: { cookie: combineCookies(signin.cookie, differentCurrency.cookie) }
  });
  assert.equal(starterState.status, 200);
  assert.equal(starterState.body.budget.income, 0);
  assert.equal(starterState.body.budget.setupStarted, false);
  assert.equal(starterState.body.budget.categories.length, 0);
  assert.equal(starterState.body.transactions.length, 0);
  assert.equal(starterState.body.paychecks.length, 0);
  assert.equal(starterState.body.calendar.events.length, 0);
  assert.equal(starterState.body.calendar.chores.length, 0);
  assert.equal(starterState.body.notes.entries.length, 0);
  assert.equal(starterState.body.notes.labels.length, 0);
  assert.equal(starterState.body.meals.recipes.length, 0);
  assert.equal(starterState.body.goals.sinkingFunds.length, 0);
  assert.equal(starterState.body.goals.debts.length, 0);
  assert.equal(starterState.body.goals.netWorth.assets.length, 0);
  assert.equal(starterState.body.goals.netWorth.liabilities.length, 0);
  assert.ok(starterState.body.budget.categories.every((category) =>
    category.lines.every((line) => line.planned === 0)
  ));

  starterState.body.goals.netWorth.assets.push({ id: "home-asset", name: "Family home", value: 500000, assetClass: "property" });
  starterState.body.goals.netWorth.assets.push({ id: "stock-asset", name: "Apple shares", value: 2000, assetClass: "stock", symbol: "AAPL", shares: 10, price: 200 });
  starterState.body.goals.netWorth.liabilities.push({ id: "mortgage-debt", name: "Mortgage", value: 200000 });
  starterState.body.goals.debts.push({
    id: "mortgage-debt",
    name: "Mortgage",
    balance: 200000,
    rate: 6.5,
    minimum: 1500,
    termMonths: 240,
    payments: [{ id: "payment-1", date: "2026-07-01", amount: 1500, interest: 1083.33, principal: 416.67, extra: 0 }],
    assetId: "home-asset"
  });
  starterState.body.notes.entries.push({ id: "shared-note", title: "Shared packing list", items: [] });
  starterState.body.meals.recipes.push({ id: "shared-recipe", name: "Family pasta", ingredients: ["pasta"] });
  starterState.body.goals.sinkingFunds.push({ id: "shared-goal", name: "Family vacation", target: 5000, saved: 250 });
  starterState.body.calendar.events.push({ id: "shared-event", title: "Family meeting", date: "2026-07-10", type: "reminder" });
  const savedState = await request("/api/state", {
    method: "PUT",
    headers: { cookie: combineCookies(signin.cookie, differentCurrency.cookie) },
    body: JSON.stringify(starterState.body)
  });
  assert.equal(savedState.status, 200);

  const reloadedState = await request("/api/state", {
    headers: { cookie: combineCookies(signin.cookie, differentCurrency.cookie) }
  });
  assert.equal(reloadedState.body.goals.debts[0].assetId, "home-asset");
  assert.equal(reloadedState.body.goals.debts[0].termMonths, 240);
  assert.equal(reloadedState.body.goals.debts[0].payments[0].principal, 416.67);
  assert.equal(reloadedState.body.goals.netWorth.assets.find((item) => item.id === "stock-asset").shares, 10);
  assert.equal(reloadedState.body.goals.netWorth.assets.find((item) => item.id === "stock-asset").price, 200);

  const householdList = await request("/api/households", {
    headers: { cookie: combineCookies(signin.cookie, differentCurrency.cookie) }
  });
  const usdHousehold = householdList.body.find((household) => household.currency === "USD");
  const inrHousehold = householdList.body.find((household) => household.currency === "INR");
  const selectUsd = await request("/api/households/select", {
    method: "POST",
    headers: { cookie: combineCookies(signin.cookie, differentCurrency.cookie) },
    body: JSON.stringify({ householdId: usdHousehold.id })
  });
  assert.equal(selectUsd.status, 200);
  const usdState = await request("/api/state", {
    headers: { cookie: combineCookies(signin.cookie, selectUsd.cookie) }
  });
  assert.equal(usdState.body.notes.entries.some((item) => item.id === "shared-note"), true);
  assert.equal(usdState.body.meals.recipes.some((item) => item.id === "shared-recipe"), true);
  assert.equal(usdState.body.calendar.events.some((item) => item.id === "shared-event"), true);
  assert.equal(usdState.body.goals.sinkingFunds.some((item) => item.id === "shared-goal"), false);
  assert.equal(usdState.body.goals.netWorth.assets.some((item) => item.id === "home-asset"), false);
  assert.equal(usdState.body.goals.netWorth.assets.some((item) => item.id === "stock-asset"), false);

  const setIndiaDefault = await request("/api/households/default", {
    method: "POST",
    headers: { cookie: combineCookies(signin.cookie, differentCurrency.cookie) },
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

test("a single invite can target multiple owned households at once, in one email", async () => {
  const adminSignin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  assert.equal(adminSignin.status, 200);

  const households = await request("/api/households", {
    headers: { cookie: adminSignin.cookie }
  });
  const usdHousehold = households.body.find((household) => household.currency === "USD");
  const inrHousehold = households.body.find((household) => household.currency === "INR");
  assert.ok(usdHousehold, "admin should already own a pre-provisioned USD household");
  assert.ok(inrHousehold, "admin should already own a pre-provisioned INR household");

  const coOwnerEmail = "family-co-owner@example.com";
  const invitation = await request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: adminSignin.cookie },
    body: JSON.stringify({
      email: coOwnerEmail,
      name: "Family Co-owner",
      role: "Co-owner, full edit",
      scopes: ["Budget"],
      householdIds: [usdHousehold.id, inrHousehold.id]
    })
  });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  assert.equal(invitation.body.invitations.length, 2);
  const usdInvite = invitation.body.invitations.find((item) => item.householdName === usdHousehold.name);
  const inrInvite = invitation.body.invitations.find((item) => item.householdName === inrHousehold.name);
  assert.ok(usdInvite.inviteCode);
  assert.ok(inrInvite.inviteCode);
  assert.notEqual(usdInvite.inviteCode, inrInvite.inviteCode);

  const acceptFirst = await request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: coOwnerEmail,
      inviteCode: usdInvite.inviteCode,
      password: "Family-Co-Owner-Password-123!"
    })
  });
  assert.equal(acceptFirst.status, 200, JSON.stringify(acceptFirst.body));

  const acceptSecond = await request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: coOwnerEmail,
      inviteCode: inrInvite.inviteCode,
      password: "Family-Co-Owner-Password-123!"
    })
  });
  assert.equal(acceptSecond.status, 200, JSON.stringify(acceptSecond.body));

  const memberHouseholds = await request("/api/households", {
    headers: { cookie: acceptSecond.cookie }
  });
  assert.equal(memberHouseholds.status, 200);
  assert.equal(memberHouseholds.body.length, 2);
  assert.ok(memberHouseholds.body.every((household) => household.role === "owner"));
});

test("a household can be added to an invite later, after the first invite was already sent", async () => {
  const adminSignin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  assert.equal(adminSignin.status, 200);

  const households = await request("/api/households", {
    headers: { cookie: adminSignin.cookie }
  });
  const usdHousehold = households.body.find((household) => household.currency === "USD");
  const inrHousehold = households.body.find((household) => household.currency === "INR");

  const laterEmail = "later-household-member@example.com";
  const firstInvite = await request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: adminSignin.cookie },
    body: JSON.stringify({
      email: laterEmail,
      name: "Later Member",
      role: "Co-owner, full edit",
      scopes: ["Budget"],
      householdIds: [usdHousehold.id]
    })
  });
  assert.equal(firstInvite.status, 201);
  assert.equal(firstInvite.body.invitations.length, 1);

  const acceptFirst = await request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: laterEmail,
      inviteCode: firstInvite.body.invitations[0].inviteCode,
      password: "Later-Member-Password-123!"
    })
  });
  assert.equal(acceptFirst.status, 200, JSON.stringify(acceptFirst.body));

  const secondInvite = await request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: adminSignin.cookie },
    body: JSON.stringify({
      email: laterEmail,
      name: "Later Member",
      role: "Co-owner, full edit",
      scopes: ["Budget"],
      householdIds: [inrHousehold.id]
    })
  });
  assert.equal(secondInvite.status, 201, JSON.stringify(secondInvite.body));
  assert.equal(secondInvite.body.invitations.length, 1);
  assert.equal(secondInvite.body.invitations[0].householdName, inrHousehold.name);

  const acceptSecond = await request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: laterEmail,
      inviteCode: secondInvite.body.invitations[0].inviteCode,
      password: "Later-Member-Password-123!"
    })
  });
  assert.equal(acceptSecond.status, 200, JSON.stringify(acceptSecond.body));

  const memberHouseholds = await request("/api/households", {
    headers: { cookie: acceptSecond.cookie }
  });
  assert.equal(memberHouseholds.body.length, 2);
});

test("only owned households can be targeted by an invite, even if requested", async () => {
  const outsiderSignup = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email: "outsider-owner@example.com",
      password: "Outsider-Owner-Password-123!",
      name: "Outsider Owner",
      householdName: "Outsider Household",
      country: "GB"
    })
  });
  assert.equal(outsiderSignup.status, 201);
  const outsiderHouseholds = await request("/api/households", {
    headers: { cookie: outsiderSignup.cookie }
  });
  const outsiderHouseholdId = outsiderHouseholds.body[0].id;

  const adminSignin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  const blocked = await request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: adminSignin.cookie },
    body: JSON.stringify({
      email: "someone@example.com",
      name: "Someone",
      role: "Member",
      scopes: [],
      householdIds: [outsiderHouseholdId]
    })
  });
  assert.equal(blocked.status, 403);
});

test("the primary owner can revoke household access and the removed user loses access", async () => {
  const ownerSignin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  const invitedEmail = "revoked-member@example.com";
  const invitation = await request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: ownerSignin.cookie },
    body: JSON.stringify({ email: invitedEmail, name: "Revoked Member", role: "Member", scopes: ["Notes"] })
  });
  assert.equal(invitation.status, 201);
  const accepted = await request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: invitedEmail,
      inviteCode: invitation.body.invitation.inviteCode,
      password: "Revoked-Member-Password-123!"
    })
  });
  assert.equal(accepted.status, 200);

  const accessBefore = await request("/api/households/access", { headers: { cookie: ownerSignin.cookie } });
  assert.equal(accessBefore.status, 200);
  assert.equal(accessBefore.body.canManage, true);
  assert.equal(accessBefore.body.members.some((member) => member.email === invitedEmail), true);

  const revoked = await request("/api/households/access", {
    method: "DELETE",
    headers: { cookie: ownerSignin.cookie },
    body: JSON.stringify({ email: invitedEmail })
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.email.preview, true);

  const removedAccess = await request("/api/state", { headers: { cookie: accepted.cookie } });
  assert.equal(removedAccess.status, 401);
  const accessAfter = await request("/api/households/access", { headers: { cookie: ownerSignin.cookie } });
  assert.equal(accessAfter.body.members.some((member) => member.email === invitedEmail), false);
});

function googlePayload(email, overrides = {}) {
  return { email, email_verified: true, sub: `google-sub-${email}`, name: "Googly User", ...overrides };
}

test("Google sign-in requires a credential", async () => {
  const attempt = await request("/api/auth/google", { method: "POST", body: JSON.stringify({}) });
  assert.equal(attempt.status, 400);
});

test("Google sign-in rejects an unverified email", async () => {
  const attempt = await request("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ testPayload: googlePayload("unverified@example.com", { email_verified: false }) })
  });
  assert.equal(attempt.status, 401);
});

test("Google sign-in creates a new account and household for a first-time user", async () => {
  const email = "new-googler@example.com";
  const signin = await request("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ testPayload: googlePayload(email, { name: "Googly Newcomer" }) })
  });
  assert.equal(signin.status, 201);
  assert.equal(signin.body.user.email, email);
  assert.equal(signin.body.user.isAdmin, false);

  const state = await request("/api/state", { headers: { cookie: signin.cookie } });
  assert.equal(state.status, 200);
  assert.equal(state.body.household.name, "Googly Newcomer's Household");
});

test("a returning Google user signs back into the same account", async () => {
  const email = "returning-googler@example.com";
  const payload = googlePayload(email, { name: "Repeat Googler" });

  const first = await request("/api/auth/google", { method: "POST", body: JSON.stringify({ testPayload: payload }) });
  assert.equal(first.status, 201);

  const second = await request("/api/auth/google", { method: "POST", body: JSON.stringify({ testPayload: payload }) });
  assert.equal(second.status, 200);
  assert.equal(second.body.user.id, first.body.user.id);
});

test("Google sign-in is blocked when the email already has a password account", async () => {
  const email = "password-first@example.com";
  const signup = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email, password: "Consumer-Password-123!", name: "Password User",
      householdName: "Password Household", country: "US"
    })
  });
  assert.equal(signup.status, 201);

  const googleAttempt = await request("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ testPayload: googlePayload(email) })
  });
  assert.equal(googleAttempt.status, 409);
  assert.equal(googleAttempt.body.error, "An account with this email already exists. Sign in with your password instead.");
});

test("Google sign-in rejects reserved administrator and demo identities", async () => {
  for (const email of [adminEmail, "demo@familyloop.net"]) {
    const attempt = await request("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ testPayload: googlePayload(email) })
    });
    assert.equal(attempt.status, 409);
  }
});

test("a disabled Google account is rejected on sign-in", async () => {
  const email = "disabled-googler@example.com";
  const payload = googlePayload(email, { name: "Disabled Googler" });
  const created = await request("/api/auth/google", { method: "POST", body: JSON.stringify({ testPayload: payload }) });
  assert.equal(created.status, 201);

  const adminSignin = await request("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: initialPassword })
  });
  assert.equal(adminSignin.status, 200);

  const users = await request("/api/admin/users", { headers: { cookie: adminSignin.cookie } });
  const target = users.body.find((user) => user.email === email);
  assert.ok(target);

  const disable = await request(`/api/admin/users/${target.id}`, {
    method: "PATCH",
    headers: { cookie: adminSignin.cookie },
    body: JSON.stringify({ disabled: true })
  });
  assert.equal(disable.status, 200);

  const blocked = await request("/api/auth/google", { method: "POST", body: JSON.stringify({ testPayload: payload }) });
  assert.equal(blocked.status, 403);
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

test("a new signup starts unverified, gets a verification token, and confirming it marks the account verified", async () => {
  const email = "unverified-signup@example.com";
  const signup = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email, password: "Consumer-Password-123!", name: "Unverified Signup",
      householdName: "Unverified Household", country: "US"
    })
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.user.emailVerified, false);
  assert.ok(signup.body.verificationToken);

  const session = await request("/api/session", { headers: { cookie: signup.cookie } });
  assert.equal(session.body.user.emailVerified, false);

  const badToken = await request("/api/auth/verify-email/confirm", {
    method: "POST",
    body: JSON.stringify({ email, token: "not-the-real-token" })
  });
  assert.equal(badToken.status, 400);

  const confirmation = await request("/api/auth/verify-email/confirm", {
    method: "POST",
    body: JSON.stringify({ email, token: signup.body.verificationToken })
  });
  assert.equal(confirmation.status, 200);

  const verifiedSession = await request("/api/session", { headers: { cookie: signup.cookie } });
  assert.equal(verifiedSession.body.user.emailVerified, true);

  const reuse = await request("/api/auth/verify-email/confirm", {
    method: "POST",
    body: JSON.stringify({ email, token: signup.body.verificationToken })
  });
  assert.equal(reuse.status, 400);
});

test("resend verification is rate-limited, no-ops once verified, and updates the account when confirmed", async () => {
  const email = "resend-verify@example.com";
  const signup = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email, password: "Consumer-Password-123!", name: "Resend Verify",
      householdName: "Resend Verify Household", country: "US"
    })
  });
  assert.equal(signup.status, 201);

  const immediateResend = await request("/api/auth/verify-email/resend", {
    method: "POST",
    headers: { cookie: signup.cookie },
    body: "{}"
  });
  assert.equal(immediateResend.status, 202);
  assert.equal("verificationToken" in immediateResend.body, false);

  const confirmation = await request("/api/auth/verify-email/confirm", {
    method: "POST",
    body: JSON.stringify({ email, token: signup.body.verificationToken })
  });
  assert.equal(confirmation.status, 200);

  const resendAfterVerified = await request("/api/auth/verify-email/resend", {
    method: "POST",
    headers: { cookie: signup.cookie },
    body: "{}"
  });
  assert.equal(resendAfterVerified.status, 400);
  assert.equal(resendAfterVerified.body.error, "This email is already verified");
});

test("a Google sign-in account is verified immediately since Google already confirmed the email", async () => {
  const email = "verified-by-google@example.com";
  const signin = await request("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ testPayload: googlePayload(email) })
  });
  assert.equal(signin.status, 201);
  assert.equal(signin.body.user.emailVerified, true);
});

test("a view-only member's writes are rejected server-side, and the owner can toggle access levels", async () => {
  const ownerEmail = "access-level-owner@example.com";
  const ownerSignup = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email: ownerEmail, password: "Access-Owner-Password-123!", name: "Access Owner",
      householdName: "Access Level Household", country: "US"
    })
  });
  assert.equal(ownerSignup.status, 201);

  const memberEmail = "access-level-member@example.com";
  const invitation = await request("/api/households/invitations", {
    method: "POST",
    headers: { cookie: ownerSignup.cookie },
    body: JSON.stringify({ email: memberEmail, name: "Access Member", role: "Member", scopes: ["Budget"] })
  });
  assert.equal(invitation.status, 201);
  const accepted = await request("/api/auth/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      email: memberEmail,
      inviteCode: invitation.body.invitation.inviteCode,
      password: "Access-Member-Password-123!"
    })
  });
  assert.equal(accepted.status, 200);
  const memberCookie = accepted.cookie;

  // Defaults to "edit" - a freshly-invited member can write until told otherwise.
  const stateBeforeGet = await request("/api/state", { headers: { cookie: memberCookie } });
  assert.equal(stateBeforeGet.status, 200);
  const editBeforeRestriction = await request("/api/state", {
    method: "PUT",
    headers: { cookie: memberCookie },
    body: JSON.stringify(stateBeforeGet.body)
  });
  assert.equal(editBeforeRestriction.status, 200);

  // A non-owner can't change anyone's access level.
  const blockedChange = await request("/api/households/access", {
    method: "PATCH",
    headers: { cookie: memberCookie },
    body: JSON.stringify({ email: memberEmail, accessLevel: "view" })
  });
  assert.equal(blockedChange.status, 403);

  // The owner sets the member to view-only.
  const setView = await request("/api/households/access", {
    method: "PATCH",
    headers: { cookie: ownerSignup.cookie },
    body: JSON.stringify({ email: memberEmail, accessLevel: "view" })
  });
  assert.equal(setView.status, 200);
  assert.equal(setView.body.accessLevel, "view");

  // The owner's own access level can never be changed, even by themselves.
  const changeOwnerAccess = await request("/api/households/access", {
    method: "PATCH",
    headers: { cookie: ownerSignup.cookie },
    body: JSON.stringify({ email: ownerEmail, accessLevel: "view" })
  });
  assert.equal(changeOwnerAccess.status, 400);

  // The member's session was established before the change - access level is
  // read fresh from the membership on every request, not cached in the
  // session cookie, so the very next request already reflects it.
  const stateGetStillWorks = await request("/api/state", { headers: { cookie: memberCookie } });
  assert.equal(stateGetStillWorks.status, 200, "a view-only member can still read");
  const blockedWrite = await request("/api/state", {
    method: "PUT",
    headers: { cookie: memberCookie },
    body: JSON.stringify(stateGetStillWorks.body)
  });
  assert.equal(blockedWrite.status, 403);

  // Documents mutations are blocked too, not just the main state blob.
  const blockedFolder = await request("/api/documents/folders", {
    method: "POST",
    headers: { cookie: memberCookie },
    body: JSON.stringify({ name: "Should not be created" })
  });
  assert.equal(blockedFolder.status, 403);

  const sharingList = await request("/api/households/access", { headers: { cookie: ownerSignup.cookie } });
  const memberRow = sharingList.body.members.find((item) => item.email === memberEmail);
  assert.equal(memberRow.accessLevel, "view");

  // The owner restores edit access.
  const setEdit = await request("/api/households/access", {
    method: "PATCH",
    headers: { cookie: ownerSignup.cookie },
    body: JSON.stringify({ email: memberEmail, accessLevel: "edit" })
  });
  assert.equal(setEdit.status, 200);
  const stateAfterRestore = await request("/api/state", { headers: { cookie: memberCookie } });
  const editAfterRestore = await request("/api/state", {
    method: "PUT",
    headers: { cookie: memberCookie },
    body: JSON.stringify(stateAfterRestore.body)
  });
  assert.equal(editAfterRestore.status, 200);
});
