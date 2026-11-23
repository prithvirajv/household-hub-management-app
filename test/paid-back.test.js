const test = require("node:test");
const assert = require("node:assert/strict");
const { paybackSummary, paybackCandidates, paybackChargesFor, paybackSiblings, paybackNameToken, paybackMemoHint, applyPayback, removePayback, syncPaybackLines, paybackLineOf, spentByLineInMonth, monthSpendingSummary } = require("../lib/shared-logic");

const charge = () => ({ id: "tx-ixl", payee: "IXL LEARNING", amount: 419, date: "2026-11-02", lineId: "edu", accountId: "citi-card" });
const zelle = (id, amount, date, payee = "Zelle payment from Sam") => ({ id, payee, amount: -amount, date, accountId: "citi-checking" });

test("candidates are repayments in the window, no bigger than the charge, person-to-person ones first", () => {
  const c = charge();
  const rows = [c, zelle("a", 41.9, "2026-11-05"), { id: "pay", payee: "ACME PAYROLL", amount: -300, date: "2026-11-03" }, zelle("late", 41.9, "2027-02-01"), zelle("early", 41.9, "2026-10-01"), zelle("big", 500, "2026-11-04"), { id: "spend", payee: "SHOP", amount: 12, date: "2026-11-03" }];
  const found = paybackCandidates(c, rows);
  assert.deepEqual(found.map((item) => item.row.id), ["a", "pay"]);
  assert.equal(found[0].likely, true);
  assert.equal(found[1].likely, false);
  assert.deepEqual(paybackCandidates({ ...c, amount: -5 }, rows), [], "a deposit is not a charge");
  assert.deepEqual(paybackCandidates(c, [{ ...zelle("done", 41.9, "2026-11-06"), paidBackFor: "tx-other" }]), [], "already linked rows are skipped");
});

test("linking files the deposits under the charge's line so the line nets to the household's share", () => {
  const c = charge();
  const deposits = Array.from({ length: 9 }, (_, i) => zelle(`d${i}`, 41.9, "2026-11-05"));
  const result = applyPayback(c, deposits);
  assert.deepEqual({ ok: result.ok, linked: result.linked }, { ok: true, linked: 9 });
  assert.ok(deposits.every((row) => row.lineId === "edu" && row.paidBackFor === "tx-ixl" && row.lineSource === "payback"));
  const ledger = [c, ...deposits];
  const summary = paybackSummary(c, ledger);
  assert.equal(summary.count, 9);
  assert.equal(summary.paid, 377.1);
  assert.equal(summary.share, 41.9);
  assert.equal(summary.covered, false);
  assert.equal(Math.round(spentByLineInMonth(ledger, "edu", "2026-11") * 100) / 100, 41.9, "the budget line shows only the household's share");
  const month = monthSpendingSummary(ledger, [{ lines: [{ id: "edu" }] }], "2026-11");
  assert.equal(Math.round(month.total * 100) / 100, 41.9);
  assert.equal(month.moneyInNotCounted, 0, "the deposits are no longer loose money in");
});

test("a fully repaid charge is covered; the charge gets an id when it had none", () => {
  const c = { payee: "Dinner", amount: 100, date: "2026-11-02", lineId: "food" };
  const d = [zelle("x", 100, "2026-11-03")];
  applyPayback(c, d);
  assert.ok(c.id);
  assert.equal(paybackSummary(c, [c, ...d]).covered, true);
});

test("a charge with no budget line is refused, and nothing changes", () => {
  const c = { id: "t1", amount: 50, date: "2026-11-02", lineId: "" };
  const d = [zelle("x", 10, "2026-11-03")];
  const result = applyPayback(c, d);
  assert.equal(result.ok, false);
  assert.match(result.error, /subcategory/);
  assert.equal(d[0].paidBackFor, undefined);
  assert.equal(applyPayback(null, d).ok, false);
});

test("a split charge uses its biggest split's line", () => {
  assert.equal(paybackLineOf({ splits: [{ lineId: "a", amount: 10 }, { lineId: "b", amount: 90 }] }), "b");
  assert.equal(paybackLineOf({ splits: [], lineId: "z" }), "z");
});

test("undo restores what the deposit had before", () => {
  const c = charge();
  const row = { ...zelle("x", 20, "2026-11-04"), lineId: "income", lineSource: "ai-low" };
  applyPayback(c, [row]);
  assert.equal(removePayback(row), true);
  assert.equal(row.lineId, "income");
  assert.equal(row.lineSource, "ai-low");
  assert.equal(row.paidBackFor, undefined);
  assert.equal(row.paidBackPrev, undefined);
  assert.equal(removePayback(row), false, "nothing to undo twice");
  const bare = zelle("y", 5, "2026-11-04");
  applyPayback(c, [bare]);
  removePayback(bare);
  assert.equal(bare.lineId, "");
  assert.equal("lineSource" in bare, false);
});

test("re-categorizing the charge moves its repayments along", () => {
  const c = charge();
  const d = [zelle("x", 20, "2026-11-04")];
  applyPayback(c, d);
  c.lineId = "kids";
  assert.equal(syncPaybackLines([c, ...d]), 1);
  assert.equal(d[0].lineId, "kids");
  d[0].lineSource = "manual";
  c.lineId = "edu";
  assert.equal(syncPaybackLines([c, ...d]), 0, "a row the person re-filed by hand is left alone");
});

test("deposits the person already filed under the charge's own line are listed first", () => {
  const c = charge();
  const rows = [c, zelle("plain", 41.9, "2026-11-04"), { ...zelle("filed", 41.9, "2026-11-06"), lineId: "edu" }];
  const found = paybackCandidates(c, rows);
  assert.deepEqual(found.map((item) => item.row.id), ["filed", "plain"]);
  assert.deepEqual(found.map((item) => item.sameLine), [true, false]);
});

test("from a repayment, the charges it could belong to: big enough, recent, same budget line first", () => {
  const dep = { ...zelle("d", 42, "2026-11-08"), lineId: "edu" };
  const rows = [
    dep,
    charge(),
    { id: "small", payee: "SNACK", amount: 10, date: "2026-11-07", lineId: "food" },
    { id: "old", payee: "OLD BIG", amount: 500, date: "2026-08-01", lineId: "edu" },
    { id: "near", payee: "NEAR BIG", amount: 100, date: "2026-11-07", lineId: "food" },
    { id: "future", payee: "LATER", amount: 100, date: "2026-12-30", lineId: "edu" },
    { id: "split", payee: "SPLIT", amount: 80, date: "2026-10-30", splits: [{ lineId: "edu", amount: 80 }] }
  ];
  assert.deepEqual(paybackChargesFor(dep, rows).map((item) => item.row.id), ["tx-ixl", "split", "near"], "same line first, then the closest in time");
  assert.deepEqual(paybackChargesFor(zelle("x", 5, "2026-11-08").amount > 0 ? null : { ...dep, amount: 42 }, rows), [], "a charge is not a repayment");
  assert.deepEqual(paybackChargesFor(null, rows), []);
});

test("look-alike deposits are pre-ticked only while they fit under the charge", () => {
  const c = { ...charge(), amount: 100 };
  const first = zelle("a", 42, "2026-11-05");
  const rows = [c, first, zelle("b", 42, "2026-11-05"), zelle("c", 41, "2026-11-06"), zelle("d", 42, "2026-11-07"), zelle("odd", 7, "2026-11-06"), { id: "nz", payee: "ACME", amount: -42, date: "2026-11-06" }];
  assert.deepEqual(paybackSiblings(c, first, rows).map((row) => row.id), ["b"], "42 + 42 = 84; a third would pass 100; the odd amount and the non-Zelle row are left out");
  assert.deepEqual(paybackSiblings(null, first, rows), []);
});

test("the merchant name is the first meaningful word of the charge, after processor prefixes and filler", () => {
  assert.equal(paybackNameToken("IXL FAMILY SUBSCRIPT 650-372-4040 CA"), "ixl");
  assert.equal(paybackNameToken("SQ *MADURAI FOOD"), "madurai");
  assert.equal(paybackNameToken("TST* PAYMENT THE HOME DEPOT"), "home");
  assert.equal(paybackNameToken("AMAZON MKTPLACE PMTS"), "amazon");
  assert.equal(paybackNameToken("12 34 56"), "");
  assert.equal(paybackNameToken(""), "");
});

test("a repayment whose note names the charge's merchant is matched to it; timing alone is not enough", () => {
  const c = { ...charge(), payee: "IXL FAMILY SUBSCRIPT 650-372-4040 CA" };
  const named = zelle("n", 42, "2026-11-08", 'Zelle payment from SAM LEE for "IXL share 2026";');
  const unnamed = zelle("u", 42, "2026-11-08", 'Zelle payment from SAM LEE for "kids";');
  const other = { id: "o", payee: "COSTCO WHSE", amount: 300, date: "2026-11-07", lineId: "food" };
  assert.equal(paybackMemoHint(named, [c, named, other]), c);
  assert.equal(paybackMemoHint(unnamed, [c, unnamed, other]), null, "no merchant in the note");
  assert.equal(paybackMemoHint({ ...named, paidBackFor: "x" }, [c, named]), null, "already linked");
  assert.equal(paybackMemoHint({ id: "p", payee: "ACME PAYROLL for IXL", amount: -42, date: "2026-11-08" }, [c]), null, "not a person-to-person payment");
  assert.equal(paybackMemoHint(zelle("big", 900, "2026-11-08", 'Zelle for "IXL"'), [c]), null, "bigger than the charge");
  assert.equal(paybackMemoHint(named, []), null);
});
