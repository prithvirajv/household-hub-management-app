const assert = require("node:assert/strict");
const test = require("node:test");
const { payeeLearnKey, lookupCategorizationRule, setCategorizationRule, planCategoryRelearn, suggestSubcategoryFromHistory } = require("../lib/shared-logic");
const { applyLinkedPayload } = require("../lib/linked-apply");

test("a merchant written with store numbers or reference codes keeps one learn key; people and transfers never do", () => {
  assert.equal(payeeLearnKey("SAMPLE MARKT*532WR2451"), "samplemarkt");
  assert.equal(payeeLearnKey("SAMPLE MARKT*A1B2C3"), "samplemarkt");
  assert.equal(payeeLearnKey("SAMPLE MARKT #1234 TOWNVILLE ST"), "samplemarkt");
  assert.equal(payeeLearnKey("SQ *CORNER CAFE 123"), "cornercafe");
  assert.equal(payeeLearnKey("SHOPSAMPLE.COM 8005550100 CITY ST"), "shopsample.com".replace(/[^a-z]/g, ""));
  assert.equal(payeeLearnKey("Zelle payment to Sam"), "");
  assert.equal(payeeLearnKey("TRANSFER TO SAVINGS 1234"), "");
  assert.equal(payeeLearnKey("AB"), "", "too short to be a safe key");
});

test("a rule is set under both keys, found by a differently written payee, and cleared in one go", () => {
  const state = {};
  setCategorizationRule(state, "SAMPLE MARKT*ABC123", "groceries");
  assert.equal(lookupCategorizationRule(state.transactionCategorizationRules, "SAMPLE MARKT*ZZZ999"), "groceries");
  assert.equal(lookupCategorizationRule(state.transactionCategorizationRules, "OTHER SHOP"), "");
  assert.equal(Object.keys(state.transactionCategorizationRuleLabels).length, 2);
  setCategorizationRule(state, "SAMPLE MARKT*ZZZ999", "");
  assert.equal(lookupCategorizationRule(state.transactionCategorizationRules, "SAMPLE MARKT*ABC123"), "", "clearing removes the loose key too");
  setCategorizationRule(state, "Zelle payment to Sam", "other");
  assert.equal(lookupCategorizationRule(state.transactionCategorizationRules, "Zelle payment to Priya"), "", "people are exact only");
  assert.equal(lookupCategorizationRule(state.transactionCategorizationRules, "Zelle payment to Sam"), "other");
});

test("changing one transaction offers the earlier ones of the same payee filed elsewhere, never itself or ones already there", () => {
  const rows = [
    { payee: "SAMPLE MARKT*A1", lineId: "dining" },
    { payee: "SAMPLE MARKT*B2", lineId: "groceries" },
    { payee: "SAMPLE MARKT*C3", lineId: "" },
    { payee: "OTHER SHOP", lineId: "dining" },
    { payee: "SAMPLE MARKT*D4", lineId: "dining" }
  ];
  assert.deepEqual(planCategoryRelearn(rows, 1, "groceries"), [0, 2, 4]);
  assert.deepEqual(planCategoryRelearn(rows, 3, "groceries"), []);
  assert.deepEqual(planCategoryRelearn(rows, 1, ""), []);
});

test("history falls back to the same merchant written differently when the exact payee was never seen", () => {
  const rows = [{ payee: "SAMPLE MARKT*A1", lineId: "groceries", date: "2026-09-01" }, { payee: "SAMPLE MARKT*B2", lineId: "dining", date: "2026-09-10" }];
  assert.equal(suggestSubcategoryFromHistory("SAMPLE MARKT*NEW", rows), "dining");
  assert.equal(suggestSubcategoryFromHistory("SAMPLE MARKT*A1", [rows[0]]), "groceries");
  assert.equal(suggestSubcategoryFromHistory("UNRELATED THING", rows), null);
});

test("overnight, a row of a learned payee follows the rule even when its reference code is new", async () => {
  const state = {
    household: { name: "H", country: "US", currency: "USD", activity: [] },
    budget: { month: "2026-10", income: 0, categories: [{ name: "Food", color: "", lines: [{ id: "groceries", name: "Groceries", planned: 400 }, { id: "dining", name: "Dining", planned: 100 }] }] },
    accounts: [{ id: "chk", name: "Checking", type: "checking", openingBalance: 0 }],
    transactions: [{ date: "2026-09-01", payee: "SAMPLE MARKT*OLD1", amount: 10, lineId: "dining", accountId: "chk", memo: "", tags: [] }],
    transactionInboxDrafts: [], transactionInboxDone: [], paychecks: [], paycheckOccurrences: [], transfers: [], ious: [],
    goals: { netWorth: { assets: [], liabilities: [] }, debts: [], sinkingFunds: [] }
  };
  setCategorizationRule(state, "SAMPLE MARKT*OLD1", "groceries");
  const link = { id: "L", label: "Bank", provider: "simplefin", mappings: { A1: { accountId: "chk" } } };
  const payload = { provider: "simplefin", accounts: [], transactions: [{ externalId: "sf:A1:1", remoteAccountId: "A1", payee: "SAMPLE MARKT*NEW9", amount: 20, date: "2026-10-20", pending: false }] };
  let n = 0;
  await applyLinkedPayload(state, link, payload, { suggest: async () => [], createId: (seed) => `${seed}-${++n}`, todayKey: "2026-10-26" });
  const added = state.transactions.find((t) => t.externalId === "sf:A1:1");
  assert.deepEqual([added.lineId, added.memo === "Needs a category"], ["groceries", false]);
});
