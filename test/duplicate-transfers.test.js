const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { planBulkTransfers, planBulkLedgerTransfers, findDuplicateTransfer, planDuplicateTransferRemoval, repeatsRecordedTransfer } = require("../lib/shared-logic");

const draft = (id, payee, amount, date, accountId) => ({ id, payee, amount, date, accountId });
const transfer = (id, date, fromAccountId, toAccountId, amount, memo = "") => ({ id, date, fromAccountId, toAccountId, amount, memo });
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("an identical transfer (date, accounts, amount) is found; a different date, direction or amount is not", () => {
  const list = [transfer("t1", "2026-10-09", "a", "b", 2446)];
  assert.ok(findDuplicateTransfer(list, { date: "2026-10-09", fromAccountId: "a", toAccountId: "b", amount: 2446, memo: "other memo" }));
  assert.equal(findDuplicateTransfer(list, { date: "2026-10-10", fromAccountId: "a", toAccountId: "b", amount: 2446 }), null);
  assert.equal(findDuplicateTransfer(list, { date: "2026-10-09", fromAccountId: "b", toAccountId: "a", amount: 2446 }), null);
  assert.equal(findDuplicateTransfer(list, { date: "2026-10-09", fromAccountId: "a", toAccountId: "b", amount: 2446.01 }), null);
});

test("cleanup keeps the first of each identical group and returns only the extras", () => {
  const first = transfer("t1", "2026-10-09", "a", "b", 2446);
  const second = transfer("t2", "2026-10-09", "a", "b", 2446, "Payment");
  const other = transfer("t3", "2026-10-08", "c", "a", 1600);
  const otherCopy = transfer("t4", "2026-10-08", "c", "a", 1600);
  assert.deepEqual(planDuplicateTransferRemoval([first, second, other, otherCopy]), [second, otherCopy]);
  assert.deepEqual(planDuplicateTransferRemoval([first, other]), []);
});

test("bulk pairs already recorded as a transfer are held back, and two identical pairs in one batch make only one transfer", () => {
  const drafts = [
    draft("o1", "PAYMENT", 2446, "2026-10-09", "a"), draft("i1", "PAYMENT RECEIVED", -2446, "2026-10-09", "b"),
    draft("o2", "PAYMENT", 2446, "2026-10-09", "a"), draft("i2", "PAYMENT RECEIVED", -2446, "2026-10-09", "b")
  ];
  assert.equal(planBulkTransfers(drafts).length, 2, "without the transfer list both pairs are offered");
  assert.equal(planBulkTransfers(drafts, [], []).length, 1, "the second identical pair in the batch is held back");
  assert.equal(planBulkTransfers(drafts, [], [transfer("t1", "2026-10-09", "a", "b", 2446)]).length, 0, "already in Transfers");
});

test("a ledger-half pair already recorded as a transfer is held back", () => {
  const ledger = [{ date: "2026-10-09", payee: "Citi payment", amount: -2446, accountId: "b" }];
  const drafts = [draft("o1", "PAYMENT", 2446, "2026-10-09", "a")];
  assert.equal(planBulkLedgerTransfers(drafts, ledger, []).length, 1);
  assert.equal(planBulkLedgerTransfers(drafts, ledger, [], [transfer("t1", "2026-10-09", "a", "b", 2446)]).length, 0);
});

test("a statement row that is half of a recorded transfer is recognised by its account, direction and amount", () => {
  const list = [transfer("t1", "2026-10-09", "a", "b", 2446)];
  assert.equal(repeatsRecordedTransfer({ date: "2026-10-09", amount: 2446 }, "a", list), true, "leaving the from-account");
  assert.equal(repeatsRecordedTransfer({ date: "2026-10-11", amount: -2446 }, "b", list), true, "arriving, two days later");
  assert.equal(repeatsRecordedTransfer({ date: "2026-10-09", amount: -2446 }, "a", list), false, "wrong direction for that account");
  assert.equal(repeatsRecordedTransfer({ date: "2026-10-09", amount: 2446 }, "", list), false, "no account to judge by");
  assert.equal(repeatsRecordedTransfer({ date: "2026-10-20", amount: 2446 }, "a", list), false, "far from the transfer date");
});

test("every place a transfer, ledger entry or statement row is added checks for a repeat first", () => {
  assert.match(app, /bulkTransferPlans\(\)/);
  assert.match(app, /\$\("#transferForm"\)\?\.addEventListener\("submit", async[\s\S]{0,900}findDuplicateTransfer/);
  assert.match(app, /\$\("#moveToTransferForm"\)\.addEventListener\("submit", async[\s\S]{0,2600}findDuplicateTransfer/);
  assert.match(app, /\$\("#transactionForm"\)\?\.addEventListener\("submit", async[\s\S]{0,1500}already in your Ledger/);
  assert.match(app, /repeatsRecordedTransfer\(row, matchedAccount\?\.id, state\.transfers\)/);
  assert.match(app, /id="removeDuplicateTransfers"/);
});
