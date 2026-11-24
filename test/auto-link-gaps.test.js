const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { paybackAutoMatch, paybackMemoHits, applyPayback, removePayback, autoLinkedPaybacks, statementGaps, monthRunsLabel, newUserTemplateReminder } = require("../lib/shared-logic");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const charge = (extra = {}) => ({ id: "c1", date: "2026-09-01", payee: "IXL Learning", amount: 126, lineId: "learning", ...extra });
const deposit = (extra = {}) => ({ id: "d1", date: "2026-09-04", payee: "Zelle payment from Alex IXL share 2026", amount: -42, lineId: "income", ...extra });

test("a repayment is linked on its own only when its note names exactly one charge it fits", () => {
  const rows = [charge(), deposit()];
  assert.equal(paybackAutoMatch(rows[1], rows), rows[0], "one named charge: linked");
  const twoCharges = [charge(), charge({ id: "c2", date: "2026-09-02" }), deposit()];
  assert.equal(paybackAutoMatch(twoCharges[2], twoCharges), null, "two charges from the same merchant is a question, not an answer");
  assert.equal(paybackAutoMatch(deposit({ payee: "Zelle payment from Alex dinner" }), rows), null, "a note that names nothing is not enough");
  assert.equal(paybackAutoMatch(deposit({ amount: -200 }), rows), null, "more than the charge");
  assert.equal(paybackAutoMatch({ ...rows[1], paybackAutoDeclined: true }, rows), null, "undone once, never again");
  assert.equal(paybackAutoMatch(rows[1], [charge({ lineId: "", splits: [] }), rows[1]]), null, "a charge with no budget line has nothing to net against");
});

test("transfers, micro-deposits, a merchant's own refund and person-to-person Zelles are never linked automatically", () => {
  const rows = [charge(), deposit()];
  assert.equal(paybackAutoMatch(rows[1], rows), rows[0], "baseline");
  const link = (d, c = charge()) => paybackAutoMatch(d, [c, d]);
  assert.equal(link(deposit({ payee: "Transfer IXL, a PayPal Service", amount: -0.01 })), null, "a one-cent transfer");
  assert.equal(link(deposit({ payee: "Transfer from IXL savings", amount: -42 })), null, "a transfer");
  assert.equal(link(deposit({ payee: "PAYPAL *IXLLEARN 402-935-7733 CA", amount: -126 }), charge({ payee: "PAYPAL *IXLLEARN 402-935-7733 CA" })), null, "a merchant echoing its own charge is a refund");
  assert.equal(link(deposit({ payee: "Zelle payment from Alex Dinner", amount: -700 }), charge({ payee: "Zelle payment to Alex", amount: 2000 })), null, "two people settling up");
  assert.ok(paybackMemoHits(deposit({ payee: "Transfer IXL, a PayPal Service", amount: -42 }), rows).length, "the manual hint still offers a PayPal-style row");
});

test("what is already repaid counts against the charge", () => {
  const rows = [charge({ amount: 100 }), deposit({ id: "d1", amount: -60 }), deposit({ id: "d2", amount: -60 })];
  assert.equal(paybackAutoMatch(rows[1], rows), rows[0]);
  applyPayback(rows[0], [rows[1]]);
  assert.equal(paybackAutoMatch(rows[2], rows), null, "the second deposit no longer fits in what is left");
  assert.equal(paybackMemoHits(rows[2], rows).length, 1);
});

test("an automatic link is listed for two weeks with its Undo, then drops away; acknowledging clears it", () => {
  const c = charge();
  const d = deposit();
  applyPayback(c, [d]);
  d.paidBackAuto = { at: "2026-09-05T10:00:00.000Z" };
  const now = Date.parse("2026-09-10T00:00:00Z");
  assert.deepEqual(autoLinkedPaybacks([c, d], now).map((item) => item.row.id), ["d1"]);
  assert.deepEqual(autoLinkedPaybacks([c, d], Date.parse("2026-10-01T00:00:00Z")), [], "after two weeks");
  d.paidBackAuto.seen = true;
  assert.deepEqual(autoLinkedPaybacks([c, d], now), []);
  d.paidBackAuto.seen = false;
  assert.equal(removePayback(d), true);
  assert.equal(d.paidBackAuto, undefined, "undoing removes the mark");
  assert.equal(d.lineId, "income", "and puts the deposit back where it was");
});

const accounts = [{ id: "a", name: "DCU", type: "checking" }, { id: "b", name: "Card", type: "credit_card" }, { id: "c", name: "House", type: "other" }, { id: "d", name: "Old", type: "checking", closedAt: "2026-01-01" }];
const monthRows = (accountId, months) => months.flatMap((month) => [1, 2].map((day) => ({ accountId, date: `${month}-0${day}`, amount: 5 })));

test("statement gaps list months with nothing recorded on an account clearly in use, never this month", () => {
  const transactions = [...monthRows("a", ["2026-01", "2026-04", "2026-07", "2026-08", "2026-09", "2026-10"]), ...monthRows("b", ["2026-08", "2026-09", "2026-10"]), ...monthRows("c", ["2026-01"])];
  const gaps = statementGaps({ accounts, transactions, drafts: [], notices: [], ignored: [], today: "2026-11-23" });
  assert.deepEqual(gaps.map((gap) => [gap.accountName, monthRunsLabel(gap.months)]), [["DCU", "Feb–Mar, May–Jun 2026"]], "other-type and closed accounts are left alone, November is not over, and a card is not blamed for months before its first record");
});

test("statement gaps clear as rows (ledger or Bank stream) arrive, honour 'nothing happened then', and skip months a bank notice already names", () => {
  const base = monthRows("a", ["2026-01", "2026-04", "2026-07", "2026-08", "2026-09", "2026-10"]);
  const call = (extra) => statementGaps({ accounts, transactions: base, drafts: [], notices: [], ignored: [], today: "2026-11-23", ...extra });
  assert.equal(call({}).length, 1);
  assert.deepEqual(call({ drafts: monthRows("a", ["2026-02", "2026-03", "2026-05", "2026-06"]) }), [], "waiting rows count as covered");
  assert.deepEqual(call({ ignored: ["a|2026-02", "a|2026-03"] })[0].months, ["2026-05", "2026-06"]);
  assert.deepEqual(call({ notices: [{ accountId: "a", fromMonth: "2026-02", toMonth: "2026-03" }] })[0].months, ["2026-05", "2026-06"]);
});

test("an account with only a few rows, or a household with no rows, is not nagged", () => {
  assert.deepEqual(statementGaps({ accounts, transactions: monthRows("a", ["2026-01"]).slice(0, 2), drafts: [], notices: [], ignored: [], today: "2026-11-23" }), []);
  assert.deepEqual(statementGaps({ accounts, transactions: [], drafts: [], notices: [], ignored: [], today: "2026-11-23" }), []);
  assert.deepEqual(statementGaps({ accounts, transactions: monthRows("a", ["2024-01", "2024-02", "2026-10"]), drafts: [], notices: [], ignored: [], today: "2026-11-23" })[0].months.length, 11, "no further back than a year");
});

test("month runs read naturally across years", () => {
  assert.equal(monthRunsLabel(["2026-02", "2026-03", "2026-05"]), "Feb–Mar, May 2026");
  assert.equal(monthRunsLabel(["2025-12", "2026-01", "2026-03"]), "Dec 2025; Jan, Mar 2026");
  assert.equal(monthRunsLabel([]), "");
});

test("the template reminder is for the owner only, until saved or dismissed, and offers January 2025 when it exists", () => {
  const info = { saved: false };
  assert.deepEqual(newUserTemplateReminder({ info, isAdmin: true, dismissed: false, months: ["2026-11", "2025-01", "2025-02"] }), { show: true, month: "2025-01" });
  assert.deepEqual(newUserTemplateReminder({ info, isAdmin: true, dismissed: false, months: ["2026-11", "2026-10"] }), { show: true, month: "2026-11" }, "otherwise the newest");
  assert.equal(newUserTemplateReminder({ info, isAdmin: false, dismissed: false, months: ["2025-01"] }).show, false);
  assert.equal(newUserTemplateReminder({ info: { saved: true }, isAdmin: true, dismissed: false, months: ["2025-01"] }).show, false);
  assert.equal(newUserTemplateReminder({ info, isAdmin: true, dismissed: true, months: ["2025-01"] }).show, false);
  assert.equal(newUserTemplateReminder({ info: null, isAdmin: true, dismissed: false, months: ["2025-01"] }).show, false, "before the answer arrives");
  assert.equal(newUserTemplateReminder({ info, isAdmin: true, dismissed: false, months: [] }).show, false, "nothing to save");
});

test("the app wires all three: linking on import, Home cards with their actions, and the Admin banner", () => {
  const app = read("app.js");
  assert.match(app, /if \(autoLinkPostedPayback\(postDraftToLedger\(draft\)\)\) repaymentsLinked \+= 1;/);
  ["renderAutoLinkedPaybackCard()", "renderStatementGapCard()", "renderTemplateReminderCard()"].forEach((call) => assert.ok(app.includes(`\${${call}}`), `Home draws ${call}`));
  ["data-undo-auto-payback", "data-keep-auto-payback", "data-statement-gap-import", "data-statement-gap-idle", "templateReminderSave", "templateReminderDismiss", "template-banner"].forEach((hook) => assert.ok(app.includes(hook), hook));
  assert.match(app, /state\.statementGapIgnored/);
  assert.ok(read("docs/consumer-guide.md").includes("Linked for you"), "documented");
});
