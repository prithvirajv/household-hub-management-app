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

test("every night whatever is still waiting from the bank gets another chance, and the AI is not asked about the same row twice", async () => {
  const { retryWaitingDrafts } = require("../lib/linked-apply");
  const state = baseState({
    transactions: [{ date: "2026-09-02", payee: "KNOWN GROCER", amount: 20, lineId: "groceries", accountId: "chk", memo: "", tags: [] }],
    transactionInboxDrafts: [
      { id: "w1", payee: "KNOWN GROCER", amount: 30, date: "2026-10-20", lineId: "", accountId: "chk", externalId: "sf:A1:w1", lineSource: "" },
      { id: "w2", payee: "NEW CAFE", amount: 12, date: "2026-10-21", lineId: "", accountId: "chk", externalId: "sf:A1:w2", lineSource: "" },
      { id: "w3", payee: "HAND ENTERED", amount: 7, date: "2026-10-22", lineId: "", accountId: "chk", lineSource: "" }
    ]
  });
  let asked = 0;
  const suggest = async (rows) => { asked += rows.length; return rows.map((r) => ({ id: r.id, lineId: "dining", accountId: null, confidence: "high", tags: [] })); };
  const first = await retryWaitingDrafts(state, { suggest, createId: ids(), todayKey: TODAY });
  assert.equal(first.added, 2, "the two bank rows are added; a row typed or imported from a file is left alone");
  assert.equal(asked, 1, "only the row history could not place went to the AI");
  assert.deepEqual(state.transactionInboxDrafts.map((d) => d.id), ["w3"]);
  assert.equal(state.transactions.find((t) => t.payee === "NEW CAFE").lineId, "dining");
  const held = baseState({ transactionInboxDrafts: [{ id: "h1", payee: "ODD", amount: 3, date: "2026-10-20", lineId: "", accountId: "", externalId: "sf:A1:h1", lineSource: "" }] });
  let calls = 0;
  const quiet = async (rows) => { calls += 1; return rows.map((r) => ({ id: r.id, lineId: null, accountId: null, confidence: "low", tags: [] })); };
  await retryWaitingDrafts(held, { suggest: quiet, createId: ids(), todayKey: TODAY });
  await retryWaitingDrafts(held, { suggest: quiet, createId: ids(), todayKey: TODAY });
  assert.equal(calls, 1, "a row the AI already answered for is not sent again the next night");
});

test("an account's sync marks move only when loading is complete, and not at all when part of the range could not be fetched", async () => {
  const payload = (extra = {}) => ({ provider: "simplefin", accounts: [{ remoteId: "A1", balance: 100, balanceDate: "2026-10-25" }], transactions: [row("1", "NEW CAFE", 12, "2026-10-21")], coverage: { A1: { from: "2026-09-01", through: "2026-10-26" } }, ...extra });
  const stamped = baseState();
  await applyLinkedPayload(stamped, link, payload(), { suggest: async () => [], createId: ids(), todayKey: TODAY });
  const account = stamped.accounts.find((a) => a.id === "chk");
  assert.deepEqual([account.syncedThrough, typeof account.lastSyncedAt, account.syncedFrom], ["2026-10-25", "string", "2026-09-01"], "stamped once the rows are loaded");
  const partial = baseState();
  await applyLinkedPayload(partial, link, payload({ failedWindows: [{ from: "2026-08-01", to: "2026-09-01", error: "timeout" }] }), { suggest: async () => [], createId: ids(), todayKey: TODAY });
  const notCaughtUp = partial.accounts.find((a) => a.id === "chk");
  assert.deepEqual([notCaughtUp.syncedThrough, notCaughtUp.lastSyncedAt], [undefined, undefined], "an account that is not caught up is not stamped");
  const failing = baseState();
  await assert.rejects(() => applyLinkedPayload(failing, link, payload({ transactions: [row("1", "A", 1, "2026-10-21")] }), { suggest: async () => { throw new Error("x"); }, createId: () => { throw new Error("boom"); }, todayKey: TODAY }));
  assert.equal(failing.accounts.find((a) => a.id === "chk").lastSyncedAt, undefined, "a load that throws leaves the marks alone");
});

test("an account mapped to the Partners page keeps its rows and balance there, never in the ledger, Bank stream or Wealth", async () => {
  const state = baseState();
  const poolLink = { id: "L2", label: "Pool bank", provider: "simplefin", mappings: { A1: { accountId: "chk" }, P1: { accountId: "partners-pool" } } };
  const payload = { provider: "simplefin", accounts: [{ remoteId: "A1", balance: 100 }, { remoteId: "P1", balance: 4000, balanceDate: "2026-10-25", name: "Shared savings" }], transactions: [
    row("1", "KNOWN GROCER", 35.5, "2026-10-20"),
    row("p1", "ZELLE FROM JANE Q SAMPLE", -500, "2026-10-21", "P1"),
    row("p2", "LOANCO CASH 1111", 2600, "2026-10-22", "P1"),
    row("p3", "PENDING POOL ROW", -5, "2026-10-26", "P1", { pending: true })
  ] };
  const result = await applyLinkedPayload(state, poolLink, payload, { suggest: async () => [], createId: ids(), todayKey: TODAY });
  assert.deepEqual(state.partnerTransactions.map((r) => [r.payee, r.amount, r.externalId]), [["ZELLE FROM JANE Q SAMPLE", -500, "sf:P1:p1"], ["LOANCO CASH 1111", 2600, "sf:P1:p2"]], "posted rows only; pending waits");
  assert.equal(state.transactions.some((t) => t.accountId === "partners-pool" || /JANE|LOANCO/.test(t.payee)), false);
  assert.equal(state.transactionInboxDrafts.some((d) => d.accountId === "partners-pool"), false);
  assert.deepEqual(state.partnerPoolBalance, { amount: 4000, date: "2026-10-25", name: "Shared savings" });
  assert.equal(state.accounts.length, 2, "no Wealth account was created");
  assert.ok(state.linkedImportedIds.includes("sf:P1:p1"), "the ids are remembered so a later sync does not re-add them");
  const again = await applyLinkedPayload(state, poolLink, payload, { suggest: async () => [], createId: ids(), todayKey: TODAY });
  assert.equal(state.partnerTransactions.length, 2, "nothing doubled on a second run");
  assert.ok(result.imported >= 1 && again);
});

test("the overnight import leaves out a bank row already covered by a recorded transfer, or like one the household deleted before - the same checks the in-app import makes", async () => {
  const { rememberRemovedRow } = require("../lib/shared-logic");
  const state = baseState({ transfers: [{ id: "t1", date: "2026-10-20", fromAccountId: "chk", toAccountId: "card", amount: 300 }] });
  const deleted = { date: "2026-10-18", payee: "OLD GYM FEE", amount: 45, accountId: "chk" };
  rememberRemovedRow(state, deleted);
  const payload = { provider: "simplefin", accounts: [{ remoteId: "A1", balance: 100 }], transactions: [
    row("1", "TRANSFER TO CARD", 300, "2026-10-20"),
    row("2", "OLD GYM FEE", 45, "2026-10-18"),
    row("3", "NEW CAFE", 12, "2026-10-21")
  ] };
  const result = await applyLinkedPayload(state, link, payload, { suggest: async () => [], createId: ids(), todayKey: TODAY });
  const payees = state.transactions.filter((t) => t.externalId).map((t) => t.payee);
  assert.deepEqual(payees, ["NEW CAFE"], "the transfer's own bank row and the row deleted before are not brought in again");
  assert.ok(state.household.activity.some((line) => /already recorded as a transfer or deleted before/.test(line)));
  assert.ok(state.linkedImportedIds.includes("sf:A1:1") && state.linkedImportedIds.includes("sf:A1:2"), "their ids are remembered so they are not fetched again");
  assert.ok(result.imported >= 1);
});

test("charges the bank still lists as pending are kept on their account, never imported or counted, and leave the list when the bank posts them", async () => {
  const state = baseState();
  const night1 = { provider: "simplefin", accounts: [{ remoteId: "A1", balance: 900 }, { remoteId: "A2", balance: -150 }], transactions: [
    row("1", "POSTED CAFE", 12, "2026-10-21"),
    row("2", "PENDING DINNER", 41.25, "2026-10-25", "A2", { pending: true }),
    row("3", "PENDING GAS", 30, "2026-10-26", "A2", { pending: true })
  ] };
  const first = await applyLinkedPayload(state, link, night1, { suggest: null, createId: ids(), todayKey: TODAY });
  assert.equal(first.imported, 1, "only the posted row is imported");
  assert.equal(first.pending, 2, "the night's result says how many were pending, so '0 imported' can be told apart from 'nothing sent'");
  const card = state.accounts.find((a) => a.id === "card");
  assert.deepEqual(card.pendingRows.map((r) => [r.payee, r.amount, r.date]), [["PENDING GAS", 30, "2026-10-26"], ["PENDING DINNER", 41.25, "2026-10-25"]], "newest first");
  assert.equal(state.accounts.find((a) => a.id === "chk").pendingRows, undefined, "an account with none pending has no list");
  assert.equal(state.transactions.some((t) => /PENDING/.test(t.payee)), false, "not in the ledger");
  assert.equal(Math.round(balance(state, "card") * 100) / 100, 150, "not in the balance either");
  assert.equal((state.linkedImportedIds || []).some((id) => /:[23]$/.test(id)), false, "not remembered as imported, so they can still come in when posted");
  // The bank posts the dinner (new id) and drops the gas one: the next sync replaces the list and imports the posted row.
  const night2 = { provider: "simplefin", accounts: [{ remoteId: "A1", balance: 900 }, { remoteId: "A2", balance: -191.25 }], transactions: [row("9", "PENDING DINNER", 41.25, "2026-10-25", "A2"), row("3", "PENDING GAS", 30, "2026-10-26", "A2", { pending: true })] };
  const second = await applyLinkedPayload(state, link, night2, { suggest: null, createId: ids(), todayKey: TODAY });
  assert.equal(second.imported, 1, "the posted dinner comes in");
  assert.deepEqual(card.pendingRows.map((r) => r.payee), ["PENDING GAS"], "only what is still pending remains");
  const night3 = { provider: "simplefin", accounts: [{ remoteId: "A1", balance: 900 }, { remoteId: "A2", balance: -191.25 }], transactions: [] };
  await applyLinkedPayload(state, link, night3, { suggest: null, createId: ids(), todayKey: TODAY });
  assert.equal(card.pendingRows, undefined, "an account the bank answered for with nothing pending is cleared");
});

test("an account the bank did not answer for keeps its pending list, and a failed fetch window leaves every list alone", async () => {
  const state = baseState();
  state.accounts.find((a) => a.id === "card").pendingRows = [{ id: "sf:A2:7", date: "2026-10-24", payee: "OLD PENDING", amount: 10 }];
  const onlyChecking = { provider: "simplefin", accounts: [{ remoteId: "A1", balance: 900 }], transactions: [] };
  await applyLinkedPayload(state, link, onlyChecking, { suggest: null, createId: ids(), todayKey: TODAY });
  assert.equal(state.accounts.find((a) => a.id === "card").pendingRows.length, 1, "no answer for the card means no change to its list");
  const partial = { provider: "simplefin", accounts: [{ remoteId: "A2", balance: -150 }], transactions: [], failedWindows: ["2026-10-01..2026-10-10"] };
  await applyLinkedPayload(state, link, partial, { suggest: null, createId: ids(), todayKey: TODAY });
  assert.equal(state.accounts.find((a) => a.id === "card").pendingRows.length, 1, "a window that failed to fetch proves nothing, so the list stays");
});
