const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

// The 21-day expansion for "Every 3 weeks" recurrence is client-side logic in app.js;
// this test only confirms the recurrence field itself round-trips through the API
// unchanged. The actual expansion is verified visually via the preview tool.
test("a chore's triweekly recurrence value round-trips through save/load unchanged", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "recurrence-owner@example.com", password: "Recurrence-Owner-Password-123!", name: "Recurrence Owner", householdName: "Recurrence Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;

  const current = await server.request("/api/state", { headers: { cookie } });
  const state = current.body;
  state.calendar.chores = [{ id: "chore-triweekly-1", title: "Water the garden", assignee: "recurrence-owner@example.com", cadence: "triweekly", recurrence: "triweekly", nextDue: new Date().toISOString().slice(0, 10) }];

  const save = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });
  assert.equal(save.status, 200);

  const reloaded = await server.request("/api/state", { headers: { cookie } });
  assert.equal(reloaded.status, 200);
  const chore = reloaded.body.calendar.chores.find((item) => item.id === "chore-triweekly-1");
  assert.equal(chore.recurrence, "triweekly");
});
