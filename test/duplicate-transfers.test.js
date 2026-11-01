const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { planBulkTransfers, planBulkLedgerTransfers, findDuplicateTransfer, planDuplicateTransferRemoval, rowsCoveredByTransfers, transferSourceIds } = require("../lib/shared-logic");

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

test("cleanup keeps the first of each identical group, but two transfers that each came from their own pair of bank rows are both kept", () => {
  const first = transfer("t1", "2026-10-09", "a", "b", 2446);
  const second = transfer("t2", "2026-10-09", "a", "b", 2446, "Payment");
  const other = transfer("t3", "2026-10-08", "c", "a", 1600);
  const otherCopy = transfer("t4", "2026-10-08", "c", "a", 1600);
  assert.deepEqual(planDuplicateTransferRemoval([first, second, other, otherCopy]), [second, otherCopy]);
  assert.deepEqual(planDuplicateTransferRemoval([first, other]), []);
  const real1 = { ...transfer("r1", "2026-10-09", "a", "b", 500), sourceIds: ["out-1", "in-1"] };
  const real2 = { ...transfer("r2", "2026-10-09", "a", "b", 500), sourceIds: ["out-2", "in-2"] };
  const again = { ...transfer("r3", "2026-10-09", "a", "b", 500), sourceIds: ["out-1", "in-1"] };
  assert.deepEqual(planDuplicateTransferRemoval([real1, real2]), [], "two real $500 payments");
  assert.deepEqual(planDuplicateTransferRemoval([real1, real2, again]), [again], "the same rows recorded again");
  assert.deepEqual(planDuplicateTransferRemoval([real1, transfer("m1", "2026-10-09", "a", "b", 500)]), [transfer("m1", "2026-10-09", "a", "b", 500)], "one with no rows behind it is a copy");
});

test("bulk planning follows the rows: one out + one in is one transfer, two of each are two", () => {
  const drafts = [
    draft("o1", "PAYMENT", 500, "2026-10-09", "a"), draft("i1", "PAYMENT RECEIVED", -500, "2026-10-09", "b"),
    draft("o2", "PAYMENT", 500, "2026-10-09", "a"), draft("i2", "PAYMENT RECEIVED", -500, "2026-10-09", "b")
  ];
  assert.equal(planBulkTransfers(drafts).length, 2);
  assert.equal(planBulkTransfers(drafts.slice(0, 2)).length, 1);
  assert.deepEqual(transferSourceIds({ id: "x", externalId: "bank-1" }, { id: "y" }, null), ["bank-1", "y"]);
});

test("a statement import: each recorded transfer covers one row per side, so a second real payment still comes in", () => {
  const list = [transfer("t1", "2026-10-09", "a", "b", 500)];
  const one = { date: "2026-10-09", amount: 500 };
  const two = { date: "2026-10-09", amount: 500 };
  assert.deepEqual(rowsCoveredByTransfers([one, two], "a", list), [one], "two rows, one transfer: one is covered");
  assert.deepEqual(rowsCoveredByTransfers([one, two], "a", [...list, transfer("t2", "2026-10-09", "a", "b", 500)]), [one, two], "two rows, two transfers");
  const arriving = { date: "2026-10-11", amount: -500 };
  assert.deepEqual(rowsCoveredByTransfers([arriving], "b", list), [arriving], "the arriving side, two days later");
  assert.deepEqual(rowsCoveredByTransfers([{ date: "2026-10-09", amount: -500 }], "a", list), [], "wrong direction for that account");
  assert.deepEqual(rowsCoveredByTransfers([one], "", list), [], "no account to judge by");
  assert.deepEqual(rowsCoveredByTransfers([{ date: "2026-10-20", amount: 500 }], "a", list), [], "far from the transfer date");
});

test("every place a transfer, ledger entry or statement row is added checks for a repeat first", () => {
  assert.match(app, /\$\("#transferForm"\)\?\.addEventListener\("submit", async[\s\S]{0,900}findDuplicateTransfer/);
  assert.match(app, /\$\("#moveToTransferForm"\)\.addEventListener\("submit", async[\s\S]{0,2600}!shouldClearCounterpart && findDuplicateTransfer/);
  assert.match(app, /\$\("#transactionForm"\)\?\.addEventListener\("submit", async[\s\S]{0,1500}already in your Ledger/);
  assert.match(app, /rowsCoveredByTransfers\(rows, matchedAccount\?\.id, state\.transfers\)/);
  assert.match(app, /id="removeDuplicateTransfers"/);
});
