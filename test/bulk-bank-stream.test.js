const assert = require("node:assert/strict");
const test = require("node:test");
const { planBulkTransfers, planBulkLedgerTransfers, planBulkDuplicateSkips } = require("../lib/shared-logic");

const draft = (id, payee, amount, date, accountId, extra = {}) => ({ id, payee, amount, date, accountId, ...extra });

test("both halves of a transfer between two own accounts are paired once, nearest dates first, and the money direction follows the sign", () => {
  const drafts = [
    draft("a", "TRANSFER TO MBR ***7", 1500, "2026-09-25", "deebiga"),
    draft("b", "TRANSFER FROM ACCT", -1500, "2026-09-25", "prithvi"),
    draft("c", "ELECTRONIC WITHDRAWAL", 1500, "2026-09-24", "prithvi"),
    draft("d", "ONLINE PAYMENT, THANK YOU", -1500, "2026-09-23", "card"),
    draft("e", "ONLINE PAYMENT, THANK YOU", -1500, "2026-09-25", "card")
  ];
  const pairs = planBulkTransfers(drafts);
  assert.deepEqual(pairs.map((pair) => [pair.out.id, pair.in.id]), [["c", "d"], ["a", "b"]]);
  assert.equal(new Set(pairs.flatMap((pair) => [pair.out.id, pair.in.id])).size, 4, "a row is used once");
});

test("rows with no account, pending rows, same-account rows, far-apart dates and different amounts are left for review", () => {
  const none = (out, other) => assert.deepEqual(planBulkTransfers([out, other]), []);
  none(draft("a", "OUT", 100, "2026-09-25", ""), draft("b", "IN", -100, "2026-09-25", "y"));
  none(draft("c", "OUT", 100, "2026-09-25", "x", { isPending: true }), draft("d", "IN", -100, "2026-09-25", "y"));
  none(draft("e", "OUT", 100, "2026-09-25", "x"), draft("f", "IN", -100, "2026-09-25", "x"));
  none(draft("g", "OUT", 100, "2026-09-25", "x"), draft("h", "IN", -100, "2026-10-05", "y"));
  none(draft("i", "OUT", 100, "2026-09-25", "x"), draft("j", "IN", -101, "2026-09-25", "y"));
  assert.equal(planBulkTransfers([draft("k", "OUT", 100, "2026-09-25", "x"), draft("l", "IN", -100, "2026-09-26", "y")]).length, 1);
});

test("duplicates: the same bank id as a recorded or earlier row, or the same amount, date and a shared payee word as a hand-entered entry", () => {
  const ledger = [
    { externalId: "sf:A:1", payee: "COSTCO", amount: 50, date: "2026-09-01" },
    { payee: "Coffee House", amount: 12, date: "2026-09-10" }
  ];
  const drafts = [
    draft("1", "COSTCO WHSE", 50, "2026-09-01", "a", { externalId: "sf:A:1" }),
    draft("2", "SQ *COFFEE HOUSE 123", 12, "2026-09-11", "a", { externalId: "sf:A:2" }),
    draft("3", "CHIPOTLE", 12, "2026-09-10", "a", { externalId: "sf:A:3" }),
    draft("4", "COSTCO WHSE", 50, "2026-09-01", "a", { externalId: "sf:A:4" }),
    draft("5", "ANOTHER", 9, "2026-09-12", "a", { externalId: "sf:A:5" }),
    draft("6", "ANOTHER", 9, "2026-09-12", "a", { externalId: "sf:A:5" }),
    draft("7", "TWO COFFEES", 5, "2026-09-12", "a"),
    draft("8", "TWO COFFEES", 5, "2026-09-12", "a")
  ];
  assert.deepEqual(planBulkDuplicateSkips(drafts, ledger).map((d) => d.id), ["1", "2", "6"], "a different bank id is a different transaction; two untagged waiting rows are not judged against each other");
});

test("person-to-person payments, direct deposits and card-to-card matches are never paired as transfers", () => {
  const accounts = [{ id: "chk", type: "checking" }, { id: "card1", type: "credit_card" }, { id: "card2", type: "credit_card" }, { id: "chk2", type: "checking" }];
  assert.deepEqual(planBulkTransfers([draft("a", "Zelle payment to Sam", 1500, "2026-09-08", "chk"), draft("b", "TRANSFER FROM ACCT", -1500, "2026-09-08", "chk2")], accounts), []);
  assert.deepEqual(planBulkTransfers([draft("c", "TRANSFER TO MBR", 1500, "2026-09-09", "chk"), draft("d", "Zelle payment from Sam", -1500, "2026-09-09", "chk2")], accounts), []);
  assert.deepEqual(planBulkTransfers([draft("e", "SAMPLE PAYROLL DIRECT DEP", -4800, "2026-08-03", "chk"), draft("f", "SAMPLE DIRECT DEPOSIT", 4800, "2026-08-03", "card1")], accounts), []);
  assert.deepEqual(planBulkTransfers([draft("g", "SAMPLE SHOP A", 7.25, "2026-09-03", "card1"), draft("h", "SAMPLE SHOP B", -7.25, "2026-09-03", "card2")], accounts), []);
  assert.equal(planBulkTransfers([draft("i", "CARD AUTOPAY", 100, "2026-09-03", "chk"), draft("j", "AUTOPAY THANK YOU", -100, "2026-09-03", "card1")], accounts).length, 1);
});

test("a waiting row whose other half is already in the Ledger is offered when the match is unambiguous, with the money direction following the sign", () => {
  const accounts = [{ id: "card", type: "credit_card" }, { id: "checking", type: "checking" }];
  const ledger = [{ payee: "ELECTRONIC WITHDRAWAL", amount: 100, date: "2026-09-26", accountId: "checking" }];
  const pairs = planBulkLedgerTransfers([draft("a", "AUTO PAYMENT - THANKS", -100, "2026-09-24", "card")], ledger, accounts);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].out.accountId, pairs[0].in.accountId, pairs[0].ledgerRow, pairs[0].draft.id], ["checking", "card", ledger[0], "a"]);
  const outgoing = planBulkLedgerTransfers([draft("b", "TRANSFER OUT", 50, "2026-09-24", "checking")], [{ payee: "TRANSFER IN", amount: -50, date: "2026-09-24", accountId: "savings" }], accounts);
  assert.deepEqual([outgoing[0].out.accountId, outgoing[0].in.accountId], ["checking", "savings"]);
});

test("ledger transfers are left alone when ambiguous, split, excluded, same account, card-to-card, pending or too far apart", () => {
  const accounts = [{ id: "cardA", type: "credit_card" }, { id: "cardB", type: "credit_card" }, { id: "checking", type: "checking" }];
  const row = (extra = {}) => ({ payee: "ELECTRONIC WITHDRAWAL", amount: 100, date: "2026-09-26", accountId: "checking", ...extra });
  const plan = (d, ledger) => planBulkLedgerTransfers([d], ledger, accounts).length;
  const waiting = draft("a", "AUTO PAYMENT", -100, "2026-09-25", "cardA");
  assert.equal(plan(waiting, [row()]), 1);
  assert.equal(plan(waiting, [row(), row({ date: "2026-09-25" })]), 0, "two possible ledger partners");
  assert.equal(planBulkLedgerTransfers([waiting, draft("b", "AUTO PAYMENT", -100, "2026-09-26", "cardB")], [row()], accounts).length, 0, "two waiting rows for one ledger entry");
  assert.equal(plan(waiting, [row({ splits: [{ lineId: "x", amount: 100 }] })]), 0, "split ledger entry");
  assert.equal(plan(waiting, [row({ payee: "ZELLE TO SAM" })]), 0, "person-to-person payee");
  assert.equal(plan(waiting, [row({ accountId: "cardA" })]), 0, "same account");
  assert.equal(plan(waiting, [row({ accountId: "cardB" })]), 0, "card to card");
  assert.equal(plan({ ...waiting, isPending: true }, [row()]), 0, "pending row");
  assert.equal(plan(waiting, [row({ date: "2026-10-05" })]), 0, "too far apart");
});
