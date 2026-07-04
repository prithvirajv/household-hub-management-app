const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

// The actual roll-forward from the legacy seed month to the current month
// (migrateInitialMonth() in app.js) is client-side and runs once per load, gated on
// budget.monthPreferenceSet. This test only confirms the server persists that flag and
// an arbitrary month value unchanged, since the client relies on that persistence to avoid
// re-migrating on every load. Full migration behavior is verified via the preview tool.
test("a household's monthPreferenceSet flag and month persist through save/load", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "migration-owner@example.com", password: "Migration-Owner-Password-123!", name: "Migration Owner", householdName: "Migration Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;

  const fresh = await server.request("/api/state", { headers: { cookie } });
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.budget.monthPreferenceSet, true, "a freshly created household should not already be marked migrated");

  const state = fresh.body;
  state.budget.month = "2026-05";
  state.budget.monthPreferenceSet = false;
  await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });

  const legacyState = await server.request("/api/state", { headers: { cookie } });
  assert.equal(legacyState.body.budget.month, "2026-05");
  assert.equal(legacyState.body.budget.monthPreferenceSet, false);

  const currentMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  state.budget.month = currentMonthKey;
  state.budget.monthPreferenceSet = true;
  await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) });

  const migratedState = await server.request("/api/state", { headers: { cookie } });
  assert.equal(migratedState.body.budget.month, currentMonthKey);
  assert.equal(migratedState.body.budget.monthPreferenceSet, true);
});
