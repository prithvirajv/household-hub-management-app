const assert = require("node:assert/strict");
const test = require("node:test");
const { applyLinkedPayload } = require("../lib/linked-apply");
const { accountBalance } = require("../lib/shared-logic");

const TODAY = "2026-10-26";
const baseState = (overrides = {}) => ({
  household: { name: "H", country: "US", currency: "USD", activity: [] },
  budget: { month: "2026-10", income: 0, categories: [{ name: "Food", color: "", lines: [{ id: "groceries", name: "Groceries", planned: 400 }, { id: "dining", name: "Dining", planned: 100 }] }] },
  accounts: [{ id: "chk", name: "Checking", type: "checking", openingBalance: 0 }, { id: "card", name: "Card", type: "credit_card", openingBalance: 0 }],
  transactions: [], transactionInboxDrafts: [], transactionInboxDone: [], paychecks: [], paycheckOccurrences: [], transfers: [], ious: [],
  goals: { netWorth: { assets: [], liabilities: [] }, debts: [], sinkingFunds: [] },
  ...overrides
});
const link = { id: "L1", label: "My bank", provider: "simplefin", mappings: { A1: { accountId: "chk" }, A2: { accountId: "card" } } };
const row = (id, payee, amount, date, remoteAccountId = "A1", extra = {}) => ({ externalId: `sf:${remoteAccountId}:${id}`, remoteAccountId, payee, amount, date, pending: false, ...extra });
const ids = () => { let n = 0; return (seed) => `${seed}-${++n}`; };
const balance = (state, accountId) => accountBalance(accountId, { accounts: state.accounts, transactions: state.transactions, paychecks: state.paychecks, paycheckOccurrences: state.paycheckOccurrences, transfers: state.transfers, ious: [] }, TODAY);

test("an overnight apply puts safe rows in the ledger, holds the rest with their reasons, and leaves every balance at the bank's figure", async () => {
  const state = baseState({ transactions: [{ date: "2026-09-02", payee: "KNOWN GROCER", amount: 20, lineId: "groceries", accountId: "chk", memo: "", tags: [] }] });
  const payload = { provider: "simplefin", accounts: [{ remoteId: "A1", balance: 900 }, { remoteId: "A2", balance: -150 }], transactions: [
    row("1", "KNOWN GROCER", 35.5, "2026-10-20"),
    row("2", "NEW CAFE", 12, "2026-10-21"),
    row("3", "MYSTERY SHOP", 8, "2026-10-22"),
    row("4", "PENDING THING", 5, "2026-10-26", "A1", { pending: true }),
    row("5", "CARD STORE", 60, "2026-10-23", "A2")
  ] };
  const asked = [];
  const suggest = async (rows) => { asked.push(rows.map((r) => r.payee)); return rows.map((r) => (r.payee === "NEW CAFE" ? { id: r.id, lineId: "dining", accountId: null, confidence: "high", tags: ["coffee"] } : r.payee === "CARD STORE" ? { id: r.id, lineId: "groceries", accountId: null, confidence: "high", tags: [] } : { id: r.id, lineId: null, accountId: null, confidence: "low", tags: [] })); };
  const result = await applyLinkedPayload(state, link, payload, { suggest, createId: ids(), todayKey: TODAY });
  assert.equal(result.imported, 4, "the pending row is skipped until it posts");
  assert.equal(asked.flat().includes("KNOWN GROCER"), false, "history categorizes it without asking the AI");
  const byPayee = Object.fromEntries(state.transactions.filter((t) => t.externalId).map((t) => [t.payee, t]));
  assert.deepEqual([byPayee["KNOWN GROCER"].lineId, byPayee["NEW CAFE"].lineId, byPayee["NEW CAFE"].tags, byPayee["CARD STORE"].lineId], ["groceries", "dining", ["coffee"], "groceries"]);
  assert.deepEqual([byPayee["MYSTERY SHOP"].lineId, byPayee["MYSTERY SHOP"].memo], ["", "Needs a category"], "a row the AI could not place still goes in, marked");
  assert.equal(state.transactionInboxDrafts.length, 0);
  assert.deepEqual([result.added, result.uncategorized, result.left], [4, 1, 0]);
  assert.equal(Math.round(balance(state, "chk") * 100) / 100, 900, "the checking account matches the bank");
  assert.equal(Math.round(balance(state, "card") * 100) / 100, 150, "the card's owed amount matches the bank");
  assert.equal(state.linkedImportedIds.length, 4);
  assert.ok(state.household.activity[0].includes("added to the ledger overnight"));
  // Run again with the same data: nothing new, nothing doubled.
  const again = await applyLinkedPayload(state, link, payload, { suggest, createId: ids(), todayKey: TODAY });
  assert.deepEqual([again.imported, again.added], [0, 0]);
  assert.equal(state.transactions.filter((t) => t.externalId).length, 4);
});

test("when the AI cannot be reached the rows still go into the ledger marked Needs a category, and a later pass categorizes them", async () => {
  const state = baseState();
  const payload = { provider: "simplefin", accounts: [{ remoteId: "A1", balance: 100 }], transactions: [row("1", "NEW CAFE", 12, "2026-10-21"), row("2", "OTHER", 9, "2026-10-22")] };
  const failing = await applyLinkedPayload(state, link, payload, { suggest: async () => { throw new Error("HTTP 503 high demand"); }, createId: ids(), todayKey: TODAY });
  assert.deepEqual([failing.added, failing.uncategorized, failing.left], [2, 2, 0]);
  assert.match(failing.aiNote, /HTTP 503/);
  assert.deepEqual(state.transactions.map((t) => [t.lineId, t.memo]), [["", "Needs a category"], ["", "Needs a category"]]);
  assert.equal(Math.round(balance(state, "chk") * 100) / 100, 100, "the balance is the bank's either way");
  // Same with no AI configured at all.
  const noAi = baseState();
  const waiting = await applyLinkedPayload(noAi, link, payload, { suggest: null, createId: ids(), todayKey: TODAY });
  assert.deepEqual([waiting.added, waiting.uncategorized], [2, 2]);

  // The AI is back: the next pass categorizes what it is sure of and leaves the rest marked.
  const { fillUncategorizedLedgerRows } = require("../lib/linked-apply");
  const asked = [];
  const filled = await fillUncategorizedLedgerRows(state, { suggest: async (rows) => { asked.push(rows.length); return rows.map((r) => (r.payee === "NEW CAFE" ? { id: r.id, lineId: "dining", accountId: null, confidence: "high", tags: ["coffee"] } : { id: r.id, lineId: "groceries", accountId: null, confidence: "low", tags: [] })); } });
  assert.equal(filled, 1);
  const cafe = state.transactions.find((t) => t.payee === "NEW CAFE");
  assert.deepEqual([cafe.lineId, cafe.memo, cafe.tags, cafe.subcategoryName], ["dining", "Categorized by AI", ["coffee"], "Dining"]);
  assert.equal(state.transactions.find((t) => t.payee === "OTHER").memo, "Needs a category", "an unsure answer leaves the mark");
  assert.equal(await fillUncategorizedLedgerRows(state, { suggest: null }), 0);
  assert.deepEqual(asked, [2]);
});

test("answers already fetched are reused when the pass is run again after the household changed under it", async () => {
  const payload = { provider: "simplefin", accounts: [], transactions: [row("1", "NEW CAFE", 12, "2026-10-21")] };
  let calls = 0;
  const suggest = async (rows) => { calls += 1; return rows.map((r) => ({ id: r.id, lineId: "dining", accountId: null, confidence: "high", tags: [] })); };
  const aiCache = new Map();
  const first = baseState();
  await applyLinkedPayload(first, link, payload, { suggest, aiCache, createId: ids(), todayKey: TODAY });
  const second = baseState();
  await applyLinkedPayload(second, link, payload, { suggest, aiCache, createId: ids(), todayKey: TODAY });
  assert.equal(calls, 1, "the second attempt does not pay for the same answer twice");
  assert.equal(second.transactions[0].lineId, "dining");
});

test("a salary that shows in the overnight deposits becomes a paycheck and its rows are folded in", async () => {
  const state = baseState();
  const paydays = ["2026-08-14", "2026-08-28", "2026-09-11", "2026-09-25", "2026-10-09", "2026-10-23"];
  const payload = { provider: "simplefin", accounts: [{ remoteId: "A1", balance: 5000 }], transactions: paydays.map((date) => row(date, `ACME PAYROLL ${date.replace(/-/g, "")}`, -2500, date)) };
  const result = await applyLinkedPayload(state, link, payload, { suggest: async () => [], createId: ids(), todayKey: TODAY });
  assert.equal(state.paychecks.length, 1);
  assert.deepEqual([state.paychecks[0].recurrence, state.paychecks[0].amount, state.paychecks[0].depositAccountId], ["biweekly", 2500, ""]);
  assert.equal(state.transactions.length, 0, "the deposits are income, not ledger rows");
  assert.equal(state.transactionInboxDrafts.length, 0);
  assert.equal(result.added, 0);
  assert.equal(Math.round(balance(state, "chk") * 100) / 100, 5000, "the account still matches the bank");
});

test("an apply that would outgrow the 1 MB save limit is refused before it changes anything", async () => {
  const state = baseState({ notes: { entries: [{ id: "n", body: "x".repeat(899000) }] } });
  const payload = { provider: "simplefin", accounts: [], transactions: [row("1", "A", 1, "2026-10-21")] };
  await assert.rejects(() => applyLinkedPayload(state, link, payload, { createId: ids(), todayKey: TODAY }), /size/);
  assert.equal(state.transactionInboxDrafts.length, 0);
});
