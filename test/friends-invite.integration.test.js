const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

async function signUp(email) {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "Friend-Owner-Password-123!", name: "Friend Owner", householdName: "Friend Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  return signup.cookie;
}

test("friend invite requires a session", async () => {
  const response = await server.request("/api/friends/invite", {
    method: "POST",
    body: JSON.stringify({ name: "Alex", email: "alex@example.com" })
  });
  assert.equal(response.status, 401);
});

test("friend invite rejects an invalid email", async () => {
  const cookie = await signUp("friend-owner-1@example.com");
  const response = await server.request("/api/friends/invite", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ name: "Alex", email: "not-an-email" })
  });
  assert.equal(response.status, 400);
});

test("friend invite sends (preview mode under the test SMTP config) for a valid email", async () => {
  const cookie = await signUp("friend-owner-2@example.com");
  const response = await server.request("/api/friends/invite", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ name: "Alex", email: "alex@example.com", inviterName: "Friend Owner" })
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.email.preview, true);
});
