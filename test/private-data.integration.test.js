const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer, combineCookies } = require("./helpers");

let server;

test.before(async () => { server = await startTestServer(); });
test.after(async () => { await server.stop(); });

test("private-data endpoints require a session", async () => {
  const get = await server.request("/api/private-data");
  assert.equal(get.status, 401);

  const putJournal = await server.request("/api/private-data/journal", { method: "PUT", body: JSON.stringify({ entries: [] }) });
  assert.equal(putJournal.status, 401);

  const putPlans = await server.request("/api/private-data/plans", { method: "PUT", body: JSON.stringify({ tasks: [] }) });
  assert.equal(putPlans.status, 401);
});

test("GET /api/private-data upserts an empty default on first access", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "journal-owner-1@example.com", password: "Journal-Owner-Password-123!", name: "Journal Owner", householdName: "Journal Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;

  const first = await server.request("/api/private-data", { headers: { cookie } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { journal: { entries: [] }, plans: { tasks: [] } });
});

test("journal and plan entries persist independently and survive a household switch", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "journal-owner-2@example.com", password: "Journal-Owner-Password-123!", name: "Journal Owner Two", householdName: "First Household", country: "US" })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.cookie;

  const journalPayload = { entries: [{ id: "entry-1", entryDate: "2026-07-04", title: "A good day", body: "Wrote some code.", mood: "Happy", tags: ["work"], photos: [], createdAt: "2026-07-04T00:00:00.000Z", updatedAt: "2026-07-04T00:00:00.000Z" }] };
  const savedJournal = await server.request("/api/private-data/journal", { method: "PUT", headers: { cookie }, body: JSON.stringify(journalPayload) });
  assert.equal(savedJournal.status, 200);

  const plansPayload = { tasks: [{ id: "task-1", title: "Buy groceries", notes: "", bucket: "daily", anchorDate: "2026-07-04", done: false, createdAt: "2026-07-04T00:00:00.000Z" }] };
  const savedPlans = await server.request("/api/private-data/plans", { method: "PUT", headers: { cookie }, body: JSON.stringify(plansPayload) });
  assert.equal(savedPlans.status, 200);

  const afterSave = await server.request("/api/private-data", { headers: { cookie } });
  assert.deepEqual(afterSave.body.journal, journalPayload);
  assert.deepEqual(afterSave.body.plans, plansPayload);

  // Saving plans again must not disturb the journal, and vice versa.
  const secondPlansPayload = { tasks: [...plansPayload.tasks, { id: "task-2", title: "Walk the dog", notes: "", bucket: "weekly", anchorDate: "2026-06-29", done: false, createdAt: "2026-07-04T01:00:00.000Z" }] };
  await server.request("/api/private-data/plans", { method: "PUT", headers: { cookie }, body: JSON.stringify(secondPlansPayload) });
  const afterSecondPlanSave = await server.request("/api/private-data", { headers: { cookie } });
  assert.deepEqual(afterSecondPlanSave.body.journal, journalPayload, "journal must be untouched by a plans-only save");
  assert.deepEqual(afterSecondPlanSave.body.plans, secondPlansPayload);

  // Create and switch to a second household for the same user; private data must be identical.
  const secondHousehold = await server.request("/api/households", { method: "POST", headers: { cookie }, body: JSON.stringify({ name: "Second Household", country: "IN" }) });
  assert.equal(secondHousehold.status, 201);
  const combinedCookie = combineCookies(cookie, secondHousehold.cookie);

  const afterHouseholdSwitch = await server.request("/api/private-data", { headers: { cookie: combinedCookie } });
  assert.equal(afterHouseholdSwitch.status, 200);
  assert.deepEqual(afterHouseholdSwitch.body.journal, journalPayload, "journal must be identical regardless of which household is selected");
  assert.deepEqual(afterHouseholdSwitch.body.plans, secondPlansPayload, "plans must be identical regardless of which household is selected");

  // Confirm private data never leaks into the shared household state blob.
  const householdState = await server.request("/api/state", { headers: { cookie: combinedCookie } });
  assert.equal(householdState.body.journal, undefined);
  assert.equal(householdState.body.plans, undefined);
});

test("private data is isolated per user", async () => {
  const ownerA = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "journal-isolation-a@example.com", password: "Journal-Isolation-Password-123!", name: "Owner A", householdName: "Household A", country: "US" })
  });
  const ownerB = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "journal-isolation-b@example.com", password: "Journal-Isolation-Password-123!", name: "Owner B", householdName: "Household B", country: "US" })
  });

  await server.request("/api/private-data/journal", {
    method: "PUT",
    headers: { cookie: ownerA.cookie },
    body: JSON.stringify({ entries: [{ id: "secret-entry", entryDate: "2026-07-04", title: "Only for me", body: "Private thoughts", mood: "", tags: [], photos: [], createdAt: "2026-07-04T00:00:00.000Z", updatedAt: "2026-07-04T00:00:00.000Z" }] })
  });

  const ownerBView = await server.request("/api/private-data", { headers: { cookie: ownerB.cookie } });
  assert.deepEqual(ownerBView.body.journal, { entries: [] }, "owner B must never see owner A's journal entries");
});

test("journal PUT rejects an entry with more than 8 photos", async () => {
  const signup = await server.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "journal-owner-3@example.com", password: "Journal-Owner-Password-123!", name: "Journal Owner Three", householdName: "Third Household", country: "US" })
  });
  const cookie = signup.cookie;
  const photos = Array.from({ length: 9 }, (_, index) => ({ id: `photo-${index}`, dataUrl: "data:image/jpeg;base64,AAAA", createdAt: "2026-07-04T00:00:00.000Z" }));
  const response = await server.request("/api/private-data/journal", {
    method: "PUT",
    headers: { cookie },
    body: JSON.stringify({ entries: [{ id: "entry-1", entryDate: "2026-07-04", title: "Too many photos", body: "", mood: "", tags: [], photos, createdAt: "2026-07-04T00:00:00.000Z", updatedAt: "2026-07-04T00:00:00.000Z" }] })
  });
  assert.equal(response.status, 400);
});
