const assert = require("node:assert/strict");
const test = require("node:test");
const { behindAccountsSince, SIMPLEFIN_OVERLAP_DAYS } = require("../server/linked-accounts");

const TODAY = "2026-11-03";
const state = { accounts: [
  { id: "a", name: "Card", syncedThrough: "2026-11-02" },
  { id: "b", name: "Broken CU", syncedThrough: "2026-10-12" },
  { id: "c", name: "Older break", syncedThrough: "2026-10-05" },
  { id: "d", name: "Closed", syncedThrough: "2026-08-01", closedAt: "2026-08-02" },
  { id: "e", name: "Never synced" }
] };

test("the nightly fetch reaches back to the oldest date an account's data stops at, but only for accounts that are behind", () => {
  const mappings = { A: { accountId: "a" }, B: { accountId: "b" }, C: { accountId: "c" }, D: { accountId: "d" }, E: { accountId: "e" }, F: { skipped: true, accountId: "b" }, G: { groupId: "g" } };
  assert.equal(behindAccountsSince(state, mappings, TODAY), "2026-10-05");
  assert.equal(behindAccountsSince(state, { A: { accountId: "a" }, E: { accountId: "e" }, D: { accountId: "d" } }, TODAY), "", "current, never-synced and closed accounts need no catch-up");
  assert.equal(behindAccountsSince(state, { B: { accountId: "b", skipped: true } }, TODAY), "", "an account chosen not to import is left alone");
  assert.equal(behindAccountsSince({ accounts: [{ id: "a", syncedThrough: "2026-11-01" }] }, { A: { accountId: "a" } }, TODAY), "", "one day behind is normal (the bank's own balance date)");
  assert.equal(behindAccountsSince({ accounts: [{ id: "a", syncedThrough: "2026-10-31" }] }, { A: { accountId: "a" } }, TODAY), "2026-10-31");
});

test("every fetch re-asks for rows from more than a few days before the last sync", () => {
  assert.ok(SIMPLEFIN_OVERLAP_DAYS >= 7, "a row the data feed delivers days late is still inside the window");
});
