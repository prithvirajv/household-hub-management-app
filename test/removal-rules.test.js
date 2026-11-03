const assert = require("node:assert/strict");
const test = require("node:test");
const { setRemovalRule, lookupRemovalRule, removeRemovalRule, rememberRemovalReason, rowsSkippedByRemovalRules, autoAcceptDecision, REMOVAL_REASONS } = require("../lib/shared-logic");
const { applyLinkedPayload } = require("../lib/linked-apply");

const TODAY = "2026-11-03";
const state = () => ({ household: { activity: [] } });

test("a removal rule is kept per payee and direction, matches a differently written payee, and counts repeats", () => {
  const st = state();
  const rule = setRemovalRule(st, { payee: "BUSINESS CO*4411 PURCHASE", amount: 40 }, { reason: "Business expense", effect: "hold" }, TODAY);
  assert.deepEqual([rule.direction, rule.effect, rule.count], ["out", "hold", 1]);
  assert.equal(lookupRemovalRule(st.removalRules, { payee: "BUSINESS CO*9087 PURCHASE", amount: 12 }).reason, "Business expense", "store numbers do not matter");
  assert.equal(lookupRemovalRule(st.removalRules, { payee: "BUSINESS CO*4411 PURCHASE", amount: -40 }), null, "money in is a different thing from money out");
  setRemovalRule(st, { payee: "BUSINESS CO*4411 PURCHASE", amount: 5 }, { reason: "Not mine", effect: "skip" }, TODAY);
  assert.deepEqual([st.removalRules.length, st.removalRules[0].count, st.removalRules[0].reason, st.removalRules[0].effect], [1, 2, "Not mine", "skip"]);
  assert.equal(setRemovalRule(st, { payee: "X CAFE", amount: 3 }, { reason: "anything", effect: "none" }, TODAY), null, "'do nothing special' records nothing");
  removeRemovalRule(st, st.removalRules[0].id);
  assert.equal(st.removalRules.length, 0);
});

test("typed reasons are remembered newest first, without repeating the built-in ones", () => {
  const st = state();
  rememberRemovalReason(st, "Reimbursed by work");
  rememberRemovalReason(st, "Gift for my sister");
  rememberRemovalReason(st, "reimbursed by work");
  rememberRemovalReason(st, REMOVAL_REASONS[0].label);
  assert.deepEqual(st.removalReasons, ["reimbursed by work", "Gift for my sister"]);
});

test("a row like one the household removed is never posted on its own, and a refund is not caught by it", () => {
  const rule = { reason: "Business expense", effect: "hold" };
  const ok = { lineId: "groceries", accountId: "chk", lineSource: "history" };
  const ctx = { accountsExist: true, possibleDuplicate: false, accountClosedForDate: false, bankFeed: true };
  assert.equal(autoAcceptDecision(ok, ctx).accept, true);
  assert.equal(autoAcceptDecision(ok, { ...ctx, removalRule: rule }).reason, "removed before: Business expense");
  assert.equal(autoAcceptDecision({ ...ok, amount: -5 }, { ...ctx, removalRule: rule, refundMatch: { lineId: "groceries" }, refundMatchPosted: true }).accept, true);
});

test("an overnight sync leaves out rows a skip rule covers, holds rows a hold rule covers, and still brings in everything else", async () => {
  const st = {
    household: { name: "H", currency: "USD", activity: [] },
    budget: { month: "2026-11", income: 0, categories: [{ name: "Food", color: "", lines: [{ id: "groceries", name: "Groceries", planned: 400 }] }] },
    accounts: [{ id: "chk", name: "Checking", type: "checking", openingBalance: 0 }],
    transactions: [{ date: "2026-10-02", payee: "KNOWN GROCER", amount: 20, lineId: "groceries", accountId: "chk", memo: "", tags: [] }, { date: "2026-10-03", payee: "SIDE GIG LLC", amount: 9, lineId: "groceries", accountId: "chk", memo: "", tags: [] }],
    transactionInboxDrafts: [], transactionInboxDone: [], paychecks: [], paycheckOccurrences: [], transfers: [], ious: [],
    goals: { netWorth: { assets: [], liabilities: [] }, debts: [], sinkingFunds: [] }
  };
  setRemovalRule(st, { payee: "NOT MINE SHOP", amount: 10 }, { reason: "Not mine", effect: "skip" }, TODAY);
  setRemovalRule(st, { payee: "SIDE GIG LLC", amount: 10 }, { reason: "Business expense", effect: "hold" }, TODAY);
  const link = { id: "L1", label: "Bank", provider: "simplefin", mappings: { A1: { accountId: "chk" } } };
  const row = (id, payee, amount) => ({ externalId: `sf:A1:${id}`, remoteAccountId: "A1", payee, amount, date: "2026-11-02", pending: false });
  const payload = { provider: "simplefin", accounts: [{ remoteId: "A1", balance: 500 }], transactions: [row("1", "NOT MINE SHOP", 25), row("2", "SIDE GIG LLC", 14), row("3", "KNOWN GROCER", 30)] };
  await applyLinkedPayload(st, link, payload, { suggest: null, createId: ((n) => (seed) => `${seed}-${++n}`)(0), todayKey: TODAY });
  assert.equal(st.transactions.some((t) => t.payee === "NOT MINE SHOP") || st.transactionInboxDrafts.some((d) => d.payee === "NOT MINE SHOP"), false, "skipped rows appear nowhere");
  assert.ok(st.linkedImportedIds.includes("sf:A1:1"), "but their bank ids are remembered, so they are not fetched again");
  assert.equal(st.transactions.some((t) => t.payee === "KNOWN GROCER" && t.externalId), true, "ordinary rows still post");
  const held = st.transactionInboxDrafts.find((d) => d.payee === "SIDE GIG LLC");
  assert.ok(held, "a held row waits in Bank stream even though history would have posted it");
  assert.equal(st.household.activity.some((line) => /Left out 1 bank row/.test(line)), true);
});

test("rowsSkippedByRemovalRules only returns rows a skip rule covers", () => {
  const st = state();
  setRemovalRule(st, { payee: "SKIP ME STORE", amount: 1 }, { reason: "x", effect: "skip" }, TODAY);
  setRemovalRule(st, { payee: "HOLD ME STORE", amount: 1 }, { reason: "y", effect: "hold" }, TODAY);
  const rows = [{ payee: "SKIP ME STORE", amount: 3 }, { payee: "HOLD ME STORE", amount: 3 }, { payee: "OTHER PLACE", amount: 3 }];
  assert.deepEqual(rowsSkippedByRemovalRules(rows, st.removalRules).map((r) => r.payee), ["SKIP ME STORE"]);
});
