const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

test("push device registration requires a session and upserts by token", async () => {
  const unauthenticated = await server.request("/api/push-devices", {
    method: "POST",
    body: JSON.stringify({ token: "ExponentPushToken[unauthenticated]", platform: "ios" })
  });
  assert.equal(unauthenticated.status, 401);

  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "device-owner@example.com", password: "Device-Owner-Password-123!", name: "Device Owner", householdName: "Device Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;

  const missingToken = await server.request("/api/push-devices", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ platform: "ios" })
  });
  assert.equal(missingToken.status, 400);

  const firstRegister = await server.request("/api/push-devices", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ token: "ExponentPushToken[device-1]", platform: "ios" })
  });
  assert.equal(firstRegister.status, 200);
  assert.equal(firstRegister.body.ok, true);

  const secondRegister = await server.request("/api/push-devices", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ token: "ExponentPushToken[device-1]", platform: "android" })
  });
  assert.equal(secondRegister.status, 200, "re-registering the same token should upsert, not fail");
});
