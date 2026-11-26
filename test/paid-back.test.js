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

test("the picker follows the usual pattern: a card purchase, the money comes back into another account; money sent to people and bills that cannot be split are left out", () => {
  const accounts = [{ id: "card", name: "Costco Citi", type: "credit_card" }, { id: "bofa", name: "BOFA 6769", type: "checking" }];
  const deposit = { id: "dep", date: "2026-10-05", payee: "Zelle payment from Priya", amount: -18.25, accountId: "bofa", lineId: "gifts" };
  const rows = [
    deposit,
    { id: "dinner", date: "2026-10-03", payee: "SPICY DESI", amount: 54.75, accountId: "card", lineId: "food" },         // 3 x 18.25, on the card, two days before
    { id: "ebay", date: "2026-10-05", payee: "eBay O*21-15234", amount: 24.36, accountId: "bofa", lineId: "shopping" },  // same account as the deposit, no even split
    { id: "zelleout", date: "2026-09-08", payee: "Zelle payment to Dharma Parameswaran", amount: 1500, accountId: "bofa", lineId: "gifts" },
    { id: "bigzelle", date: "2026-08-28", payee: "Zelle payment to SUDHARSAN for repay", amount: 2000, accountId: "bofa", lineId: "gifts" },
    { id: "amazon", date: "2026-10-05", payee: "Amazon.com*590AR0MH1", amount: 191.53, accountId: "card", lineId: "shopping" },
    { id: "paid", date: "2026-10-02", payee: "ALREADY SHARED", amount: 36.5, accountId: "card", lineId: "food" },
    { id: "r1", date: "2026-10-04", payee: "Zelle payment from Sam", amount: -18.25, paidBackFor: "paid" },
    { id: "r2", date: "2026-10-04", payee: "Zelle payment from Dee", amount: -18.25, paidBackFor: "paid" }
  ];
  const picked = paybackChargesFor(deposit, rows, { accounts });
  assert.deepEqual(picked.map((item) => item.row.id), ["dinner", "amazon", "ebay"], "the card dinner first, then the other card purchase; the Zelles you sent and the fully shared bill are gone");
  assert.ok(picked[0].reasons.includes("card purchase") && picked[0].reasons.includes("splits 3 ways"), picked[0].reasons.join(", "));
  assert.deepEqual(paybackChargesFor(deposit, rows, { accounts, includePeer: true }).map((item) => item.row.id).filter((id) => id.includes("zelle")), ["zelleout", "bigzelle"], "Show other charges brings the Zelles back");
  assert.equal(paybackChargesFor(deposit, rows, { accounts, limit: 1 }).length, 1);
  assert.ok(paybackChargesFor(deposit, rows, { accounts, limit: Infinity }).length >= 3);
});

test("a charge named in the note ranks first even when it is not on a card, and the memo hint sees every candidate, not just the top few", () => {
  const deposit = { id: "dep", date: "2026-10-05", payee: "Zelle payment from Alex IXL share", amount: -42, accountId: "bofa" };
  const noise = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, date: "2026-10-04", payee: `STORE ${i}`, amount: 84, accountId: "card" }));
  const ixl = { id: "ixl", date: "2026-09-20", payee: "IXL FAMILY SUBSCRIPT", amount: 419.25, accountId: "bofa" };
  const rows = [deposit, ...noise, ixl];
  const accounts = [{ id: "card", type: "credit_card" }, { id: "bofa", type: "checking" }];
  assert.equal(paybackChargesFor(deposit, rows, { accounts })[0].row.id, "ixl");
  assert.equal(paybackMemoHint(deposit, rows).id, "ixl", "twelve better-looking charges do not hide it");
});

test("the screen passes the accounts, shows where and why each charge is suggested, and offers Show other charges", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
  assert.ok(app.includes("paybackChargesFor(transaction, state.transactions, { accounts: state.accounts, ...(paybackFindMore ? { limit: 40, includePeer: true } : {}) })"));
  assert.ok(app.includes("item.reasons.slice(0, 2).join") && app.includes("accountName(item.row.accountId)") && app.includes("data-payback-more") && app.includes("let paybackFindMore = false;"));
  assert.match(css, /\.payback-charge-choice \{ background: var\(--panel\); color: var\(--text\);/, "light buttons, readable text");
});
