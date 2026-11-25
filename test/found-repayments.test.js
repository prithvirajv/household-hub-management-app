const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { foundRepayments, stuckPendingAccounts, householdSizeBreakdown, bankSyncOkText, applyPayback } = require("../lib/shared-logic");

const charge = (extra = {}) => ({ id: "c1", date: "2026-09-08", payee: "IXL FAMILY SUBSCRIPT 650-372-4", amount: 419.25, lineId: "learning", ...extra });
const dep = (id, extra = {}) => ({ id, date: "2026-09-08", payee: "Zelle payment from Alex IXL share 2026", amount: -42, lineId: "income", ...extra });

test("deposits already in the ledger that clearly repay one charge are found and grouped", () => {
  const rows = [charge(), dep("d1"), dep("d2"), dep("d3", { payee: "Zelle payment from Sam dinner" }), dep("d4", { payee: "Transfer IXL, a PayPal Service", amount: -0.01 })];
  const found = foundRepayments(rows, "2026-11-24");
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].rows.map((row) => row.id), ["d1", "d2"], "the dinner Zelle and the one-cent transfer are not offered");
  assert.equal(found[0].total, 84);
  assert.equal(found[0].share, 335.25);
});

test("deposits are only taken while together they fit the charge, linked or declined ones are skipped, and old ones are left alone", () => {
  const rows = [charge({ amount: 100 }), dep("d1", { amount: -60 }), dep("d2", { amount: -60 })];
  assert.deepEqual(foundRepayments(rows, "2026-11-24")[0].rows.map((row) => row.id), ["d1"], "the second no longer fits");
  const linked = [charge(), dep("d1"), dep("d2")];
  applyPayback(linked[0], [linked[1]]);
  assert.deepEqual(foundRepayments(linked, "2026-11-24")[0].rows.map((row) => row.id), ["d2"], "already linked deposits are not offered again");
  const declined = [charge(), dep("d1", { paybackAutoDeclined: true })];
  assert.deepEqual(foundRepayments(declined, "2026-11-24"), []);
  assert.deepEqual(foundRepayments([charge({ date: "2025-01-01" }), dep("d1", { date: "2025-01-02" })], "2026-11-24"), [], "older than the window");
});

test("pending charges that stay pending for days point at the bank's feed", () => {
  const accounts = [
    { id: "a", name: "Card", pendingRows: [{ date: "2026-11-20" }, { date: "2026-11-23" }] },
    { id: "b", name: "Fresh", pendingRows: [{ date: "2026-11-23" }] },
    { id: "c", name: "Closed", closedAt: "2026-01-01", pendingRows: [{ date: "2026-11-01" }] },
    { id: "d", name: "None" }
  ];
  assert.deepEqual(stuckPendingAccounts(accounts, "2026-11-24"), [{ accountId: "a", name: "Card", count: 1, oldest: "2026-11-20" }]);
});

test("the storage breakdown names what is big and how to shrink it", () => {
  const state = { transactions: Array.from({ length: 3000 }, (_, i) => ({ payee: `P${i}`, amount: i })), tiny: { a: 1 }, notes: { entries: ["x".repeat(20000)] } };
  const breakdown = householdSizeBreakdown(state);
  assert.equal(breakdown[0].key, "transactions");
  assert.match(breakdown[0].hint, /Clean up/);
  assert.ok(breakdown.every((entry) => entry.pct >= 3) && !breakdown.some((entry) => entry.key === "tiny"));
});

test("the calm sync line appears only when every link finished cleanly", () => {
  const link = (extra = {}) => ({ status: "active", mappings: { a: { accountId: "x" } }, lastRun: { at: "2026-11-24T08:30:00Z", ok: true, stage: "applied", added: 4 }, ...extra });
  const when = (iso) => "Tue 3:30 AM";
  assert.equal(bankSyncOkText([link()], 8, when), "Bank sync: last ran Tue 3:30 AM, 4 new transactions added, all loaded; 8 still pending at the bank.");
  assert.match(bankSyncOkText([link({ lastRun: { at: "2026-11-24T08:30:00Z", ok: true, stage: "applied", added: 0 } })], 0, when), /nothing new, all loaded\.$/);
  assert.equal(bankSyncOkText([link({ lastRun: { at: "x", ok: false, stage: "apply" } })], 0, when), "", "a failed run is the problem card's job");
  assert.equal(bankSyncOkText([], 0, when), "");
  assert.equal(bankSyncOkText([link({ status: "needs_reconnect" })], 0, when), "");
});

test("the app draws the new Home cards and wires their buttons", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  ["${renderFoundRepaymentsCard()}", "${renderBankSyncOkLine()}", "data-found-link", "data-found-skip", "stuckPendingAccounts(state.accounts", "What uses the space", "currentHouseholdBreakdown()"].forEach((piece) => assert.ok(app.includes(piece), piece));
});
