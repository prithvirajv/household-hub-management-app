const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./helpers");
const { capActivityLog, ACTIVITY_LOG_KEEP, HOUSEHOLD_STATE_LIMIT, HOUSEHOLD_STATE_BODY_LIMIT_BYTES } = require("../lib/shared-logic");

test("the activity log keeps the newest entries and leaves a short one alone", () => {
  const long = { household: { activity: Array.from({ length: 1981 }, (_, i) => `entry ${i}`) } };
  assert.equal(capActivityLog(long), long, "mutates and returns the state");
  assert.equal(long.household.activity.length, ACTIVITY_LOG_KEEP);
  assert.equal(long.household.activity[0], "entry 0", "newest first, so the oldest are the ones dropped");
  const short = { household: { activity: ["a", "b"] } };
  capActivityLog(short);
  assert.deepEqual(short.household.activity, ["a", "b"]);
  assert.doesNotThrow(() => { capActivityLog({}); capActivityLog({ household: {} }); capActivityLog(null); });
});

test("the limits leave real headroom: a bank import stops well before the save does", () => {
  assert.ok(HOUSEHOLD_STATE_BODY_LIMIT_BYTES >= 4 * 1024 * 1024 && HOUSEHOLD_STATE_LIMIT < HOUSEHOLD_STATE_BODY_LIMIT_BYTES * 0.9);
});

test("a household over the old 1 MB limit saves, comes back whole, has its activity log trimmed, and one past the new limit gets a plain 413", async () => {
  const server = await startTestServer({});
  try {
    const signup = await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "big@example.com", password: "Big-Password-123!", name: "Big", householdName: "Big house", country: "US" }) });
    assert.equal(signup.status, 201);
    const headers = { cookie: signup.cookie };
    const state = (await server.request("/api/state", { headers })).body;
    state.household.activity = Array.from({ length: 1981 }, (_, i) => `Assigned row ${i} to Food - Groceries`);
    state.linkedImportedIds = Array.from({ length: 20000 }, (_, i) => `sf:ACT-1234567890:${String(i).padStart(30, "0")}`);
    assert.ok(JSON.stringify(state).length > 1100000, "bigger than the old limit");
    const saved = await server.request("/api/state", { method: "PUT", headers, body: JSON.stringify(state) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 200));
    const back = (await server.request("/api/state", { headers })).body;
    assert.equal(back.linkedImportedIds.length, 20000);
    assert.equal(back.household.activity.length, ACTIVITY_LOG_KEEP);

    state.linkedImportedIds = Array.from({ length: 100000 }, (_, i) => `sf:ACT-1234567890:${String(i).padStart(30, "0")}`);
    const tooBig = await server.request("/api/state", { method: "PUT", headers, body: JSON.stringify(state) });
    assert.equal(tooBig.status, 413);
    assert.match(tooBig.body.error, /about 4 MB/);
  } finally { await server.stop(); }
});

const fs = require("node:fs");
const path = require("node:path");
const { capHouseholdState, householdSizeInfo, explainSyncFailure, DONE_IDS_KEEP } = require("../lib/shared-logic");

test("housekeeping keeps the newest Bank stream ids and the newest activity, and tolerates odd input", () => {
  const state = { household: { activity: Array.from({ length: 500 }, (_, i) => `a${i}`) }, transactionInboxDone: Array.from({ length: DONE_IDS_KEEP + 50 }, (_, i) => `id${i}`) };
  capHouseholdState(state);
  assert.equal(state.household.activity.length, ACTIVITY_LOG_KEEP);
  assert.equal(state.transactionInboxDone.length, DONE_IDS_KEEP);
  assert.equal(state.transactionInboxDone[DONE_IDS_KEEP - 1], `id${DONE_IDS_KEEP + 49}`, "newest last, oldest dropped");
  assert.doesNotThrow(() => { capHouseholdState({}); capHouseholdState(null); });
});

test("the size meter reports how full the household is", () => {
  assert.equal(householdSizeInfo({ x: "a".repeat(1_000_000) }).level, "ok");
  assert.equal(householdSizeInfo({ x: "a".repeat(2_700_000) }).level, "warn");
  assert.equal(householdSizeInfo({ x: "a".repeat(3_300_000) }).level, "full");
  assert.match(householdSizeInfo({ x: "a".repeat(1_000_000) }).label, /^1\.0 of 3\.5 MB$/);
});

test("a failed overnight run is explained in plain words with what to do", () => {
  assert.match(explainSyncFailure("Could not load the new transactions: Importing 4 transactions would push the household data past the size that can be saved").summary, /too big/);
  assert.match(explainSyncFailure("Your household was being edited while it loaded, so loading it was postponed.").fix, /by itself/);
  assert.match(explainSyncFailure("Auth required").summary, /sign in/);
  assert.match(explainSyncFailure("").summary, /did not report/);
  assert.ok(explainSyncFailure("x".repeat(400)).summary.length <= 161);
});

test("the app shows the plain failure on Home, the meter, and a receipt that says the bank sync is the reason", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /explainSyncFailure\(run\.error\)/);
  assert.ok(app.includes("Try again now") && app.includes("${renderDataSizeCard()}") && app.includes("householdSizeLineHtml()"));
  assert.ok(app.includes("receiptSyncNote(receipt)") && app.includes("receiptSyncNote(receiptData)"));
  const linked = fs.readFileSync(path.join(__dirname, "..", "server", "linked-accounts.js"), "utf8");
  assert.ok(linked.includes("explainSyncFailure(finished.error).summary"), "the phone notification is plain too");
});
