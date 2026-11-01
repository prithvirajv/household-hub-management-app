const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { removedRowSignature, rememberRemovedRow, rowsAlreadyRemoved, learnedExamples, learnedAccountExamples } = require("../lib/shared-logic");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const row = (payee, amount, date = "2026-10-03") => ({ payee, amount, date });

test("a removed row is remembered by date, amount, direction and payee; rows without those are not", () => {
  assert.equal(removedRowSignature(row("SAMPLE CAFE #12", 4.5)), removedRowSignature(row("sample cafe #12", 4.5)));
  assert.notEqual(removedRowSignature(row("SAMPLE CAFE", 4.5)), removedRowSignature(row("SAMPLE CAFE", -4.5)), "money in is not money out");
  assert.notEqual(removedRowSignature(row("SAMPLE CAFE", 4.5)), removedRowSignature(row("SAMPLE CAFE", 4.5, "2026-10-04")));
  assert.equal(removedRowSignature(row("", 4.5)), "");
  assert.equal(removedRowSignature(row("SAMPLE CAFE", 0)), "");
  const state = {};
  assert.equal(rememberRemovedRow(state, row("SAMPLE CAFE", 4.5)), true);
  assert.equal(rememberRemovedRow(state, row("", 4.5)), false);
  assert.equal(state.removedRowSignatures.length, 1);
});

test("a re-imported file leaves out the rows that were removed, one row per removal, so a second identical purchase still comes in", () => {
  const state = {};
  rememberRemovedRow(state, row("SAMPLE CAFE", 4.5));
  const first = row("SAMPLE CAFE", 4.5);
  const second = row("SAMPLE CAFE", 4.5);
  const other = row("SAMPLE SHOP", 20);
  assert.deepEqual(rowsAlreadyRemoved([first, second, other], state.removedRowSignatures), [first]);
  rememberRemovedRow(state, row("SAMPLE CAFE", 4.5));
  assert.deepEqual(rowsAlreadyRemoved([first, second, other], state.removedRowSignatures), [first, second], "two removals, two rows");
  assert.deepEqual(rowsAlreadyRemoved([other], []), []);
});

test("the list of removed rows is capped", () => {
  const state = {};
  for (let i = 1; i <= 3100; i += 1) rememberRemovedRow(state, row(`SAMPLE ${i}`, i));
  assert.equal(state.removedRowSignatures.length, 3000);
  assert.match(state.removedRowSignatures.at(-1), /\|310000\|/);
});

test("deleting a Ledger row, skipping a Bank stream row and importing a statement all use it", () => {
  assert.match(app, /splice\(Number\(deleteTransactionButton\.dataset\.deleteTransaction\), 1\);\s*rememberRemovedRow\(state, removed\)/);
  assert.match(app, /Dismissed bank stream item[\s\S]{0,120}rememberRemovedRow\(state, inboxItem\)/);
  assert.match(app, /rowsAlreadyRemoved\(rows, state\.removedRowSignatures\)/);
});

test("every way a category is changed by hand is learned: a single change, a bulk apply, and rules follow a moved or deleted Subcategory", () => {
  assert.match(app, /await learnFromCategoryChange\(index\)/);
  assert.match(app, /ledgerBulkApplyButton[\s\S]{0,1800}learnPayeeLine\(payee, lineId\)/);
  assert.match(app, /goingLineIds[\s\S]{0,500}state\.transactionCategorizationRules\[key\] = targetLineId/);
});

test("the AI is told what the household already decided: rules first, then recent categorized rows, one per payee, only ids that still exist", () => {
  const state = {
    transactionCategorizationRules: { "sample market": "groc", samplemarket: "groc" }, transactionCategorizationRuleLabels: { "sample market": "SAMPLE MARKET", samplemarket: "SAMPLE MARKET" },
    transactions: [
      { date: "2026-09-01", payee: "SAMPLE MARKET", amount: 10, lineId: "other", accountId: "chk" },
      { date: "2026-10-02", payee: "SAMPLE GAS", amount: 30, lineId: "fuel", accountId: "card" },
      { date: "2026-10-03", payee: "SAMPLE GONE", amount: 5, lineId: "deleted-line", accountId: "chk" },
      { date: "2026-10-04", payee: "SAMPLE SPLIT", amount: 5, lineId: "", splits: [{ lineId: "groc", amount: 5 }] },
      { date: "2026-10-05", payee: "", amount: 5, lineId: "groc" }
    ]
  };
  const examples = learnedExamples(state, ["groc", "fuel", "other"], ["chk", "card"]);
  assert.deepEqual(examples.map((e) => [e.payee, e.lineId, e.accountId]), [["SAMPLE MARKET", "groc", "chk"], ["SAMPLE GAS", "fuel", "card"]]);
  assert.deepEqual(learnedAccountExamples(state, ["chk"]).map((e) => e.payee), ["SAMPLE GONE", "SAMPLE MARKET"]);
});

test("every AI call carries the household's decisions: the app's three calls, the overnight apply and the fill-in pass", () => {
  assert.equal((app.match(/learnedExamples\(state/g) || []).length >= 2, true);
  assert.match(app, /learnedAccountExamples\(state/);
  const linked = fs.readFileSync(path.join(__dirname, "..", "lib", "linked-apply.js"), "utf8");
  assert.equal((linked.match(/const examples = learnedExamples\(state/g) || []).length, 2);
  assert.equal((linked.match(/knownTags, examples\)/g) || []).length, 2);
});
