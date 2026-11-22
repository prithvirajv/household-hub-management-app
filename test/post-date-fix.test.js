const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseBankCsvTransactions, planPostDateFixes } = require("../lib/shared-logic");

const CSV = [
  "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
  "11/15/2026,11/17/2026,SAMPLE PEST CONTROL,Home,Sale,-26.66,",
  "11/15/2026,11/17/2026,SAMPLE PEST CONTROL,Home,Sale,-20.00,",
  "10/31/2026,11/02/2026,SAMPLE PEST CONTROL,Home,Sale,-26.66,",
  "11/03/2026,11/03/2026,AUTOMATIC PAYMENT - THANK,,Payment,46.66,"
].join("\n");

test("the parser adds the purchase day to a row only when asked and only when it differs from the post date", () => {
  assert.equal(parseBankCsvTransactions(CSV).some((row) => "transactionDate" in row), false, "the default result is unchanged");
  const rows = parseBankCsvTransactions(CSV, { withTransactionDate: true });
  assert.deepEqual(rows.map((row) => [row.date, row.transactionDate]), [["2026-11-17", "2026-11-15"], ["2026-11-17", "2026-11-15"], ["2026-11-02", "2026-10-31"], ["2026-11-03", undefined]]);
});

const ledger = () => [
  { id: "t1", payee: "Sample Pest Control", amount: 26.66, date: "2026-11-15", accountId: "card" },
  { id: "t2", payee: "SAMPLE PEST CONTROL", amount: 20, date: "2026-11-15", accountId: "card" },
  { id: "t3", payee: "SAMPLE PEST CONTROL", amount: 26.66, date: "2026-10-31", accountId: "card" },
  { id: "t4", payee: "SAMPLE PEST CONTROL", amount: 26.66, date: "2026-11-15", externalId: "sf:ACC:1", accountId: "card" },
  { id: "t5", payee: "SAMPLE PEST CONTROL", amount: 26.66, date: "2026-11-15", accountId: "other-card" },
  { id: "t6", payee: "SAMPLE PEST CONTROL", amount: 26.66, date: "2026-11-17", accountId: "card" }
];

test("rows imported on the purchase day are matched to their post dates; bank-fed rows, other accounts and rows already on the post date are left alone", () => {
  const rows = parseBankCsvTransactions(CSV, { withTransactionDate: true });
  const { fixes, notFound } = planPostDateFixes(rows, ledger(), [], "card");
  assert.deepEqual(fixes.map((fix) => [fix.id, fix.from, fix.to, fix.monthChanges]), [
    ["t1", "2026-11-15", "2026-11-17", false],
    ["t2", "2026-11-15", "2026-11-17", false],
    ["t3", "2026-10-31", "2026-11-02", true]
  ]);
  assert.equal(notFound, 0);
  assert.ok(!fixes.some((fix) => ["t4", "t5", "t6"].includes(fix.id)), "a bank-fed row, another account's row and one already dated the post day are untouched");
});

test("one statement row moves one stored row, and a row that is not in the ledger is counted, not guessed", () => {
  const rows = parseBankCsvTransactions(CSV, { withTransactionDate: true });
  const onlyOne = [{ id: "a", payee: "SAMPLE PEST CONTROL", amount: 26.66, date: "2026-11-15", accountId: "card" }];
  const result = planPostDateFixes(rows, onlyOne, [], "card");
  assert.deepEqual(result.fixes.map((fix) => fix.id), ["a"], "two identical stored rows are not both claimed by one statement row");
  assert.equal(result.notFound, 2, "the $20.00 row and the Oct 31 row were not found");
  const twice = planPostDateFixes([{ date: "2026-11-17", transactionDate: "2026-11-15", payee: "X SHOP", amount: 5 }, { date: "2026-11-18", transactionDate: "2026-11-15", payee: "X SHOP", amount: 5 }],
    [{ id: "a", payee: "X SHOP", amount: 5, date: "2026-11-15" }, { id: "b", payee: "X SHOP", amount: 5, date: "2026-11-15" }], [], "");
  assert.deepEqual(twice.fixes.map((fix) => [fix.id, fix.to]), [["a", "2026-11-17"], ["b", "2026-11-18"]], "two real identical charges pair off one to one");
});

test("rows waiting in Bank stream are re-dated too, and a row with no account is allowed through", () => {
  const rows = [{ date: "2026-11-17", transactionDate: "2026-11-15", payee: "SAMPLE PEST CONTROL", amount: 26.66 }];
  const { fixes } = planPostDateFixes(rows, [], [{ id: "d1", payee: "Sample Pest", amount: 26.66, date: "2026-11-15", accountId: "" }], "card");
  assert.deepEqual(fixes.map((fix) => [fix.kind, fix.id]), [["draft", "d1"]]);
});

test("the Transactions page has the Re-date control, a preview you confirm, and only moves rows still on the date the preview showed", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /id="postDateFixInput" accept="\.csv,text\/csv"/);
  assert.match(app, /parseBankCsvTransactions\(await file\.text\(\), \{ withTransactionDate: true \}\)/);
  assert.match(app, /Nothing changes until you choose Move\./);
  assert.match(app, /String\(row\.date \|\| ""\)\.slice\(0, 10\) !== fix\.from\) return;/, "a row edited since the preview is left alone");
});
