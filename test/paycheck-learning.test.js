const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { planPaycheckLearning, applyPaycheckLearning, matchesRecordedPaycheck, depositPayerKey } = require("../lib/shared-logic");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const deposit = (amount, extra = {}) => ({ id: "d1", payee: "ELECTRONIC DEPOSIT - SAMPLE CORP MANAGPAYROLL 261002 SAMPLE PERSON", amount, date: "2026-10-01", accountId: "chk", ...extra });
const paycheck = (extra = {}) => ({ id: "p1", name: "Sample Corp", amount: 1500, recurrence: "biweekly", date: "2026-09-17", depositAccountId: "chk", ...extra });
const state = () => ({
  household: { activity: [] }, budget: { income: 0 },
  paychecks: [paycheck()],
  paycheckOccurrences: [
    { id: "o0", seriesId: "p1", date: "2026-09-17", amount: 1500, depositAccountId: "chk" },
    { id: "o1", seriesId: "p1", date: "2026-10-01", amount: 1500, depositAccountId: "chk" },
    { id: "o2", seriesId: "p1", date: "2026-10-15", amount: 1500, depositAccountId: "chk" },
    { id: "o3", seriesId: "p1", date: "2026-10-29", amount: 900, depositAccountId: "chk" }
  ]
});

test("the payer is the meaningful words of the payee, not the bank wording, digits or reference numbers", () => {
  assert.equal(depositPayerKey("ELECTRONIC DEPOSIT - SAMPLE CORP MANAGPAYROLL 261002 SAMPLE PERSON"), "sample corp");
  assert.equal(depositPayerKey("Direct Deposit ACH Credit"), "");
});

test("a removed deposit is matched to the recorded paycheck by payer name, deposit account and pay wording - with the amount difference reported", () => {
  const plan = planPaycheckLearning(deposit(-3391.44), [paycheck()]);
  assert.equal(plan.paycheck.id, "p1");
  assert.equal(plan.received, 3391.44);
  assert.equal(plan.previous, 1500);
  assert.equal(plan.differs, true);
  assert.equal(planPaycheckLearning(deposit(-1500), [paycheck()]).differs, false, "same amount: nothing to update");
});

test("refunds, transfers, other accounts, other payers, expenses and small amounts never match", () => {
  const list = [paycheck()];
  assert.equal(planPaycheckLearning(deposit(-3391.44, { payee: "SAMPLE CORP REFUND" }), list), null);
  assert.equal(planPaycheckLearning(deposit(-3391.44, { accountId: "other" }), list), null);
  assert.equal(planPaycheckLearning(deposit(-3391.44, { payee: "ELECTRONIC DEPOSIT - OTHER EMPLOYER PAYROLL" }), list), null);
  assert.equal(planPaycheckLearning(deposit(3391.44), list), null, "money out");
  assert.equal(planPaycheckLearning(deposit(-50), list), null, "too small to be pay");
  assert.equal(planPaycheckLearning(deposit(-3391.44, { payee: "SAMPLE CORP PURCHASE" }), list), null, "not worded like pay");
});

test("the closest recorded paycheck wins when two share the payer", () => {
  const plan = planPaycheckLearning(deposit(-3300), [paycheck({ id: "small", amount: 900 }), paycheck({ id: "big", amount: 3200 })]);
  assert.equal(plan.paycheck.id, "big");
});

test("accepting the update moves the paycheck, this payday and later ones still at the old amount, and leaves past paydays alone", () => {
  const s = state();
  const plan = planPaycheckLearning(deposit(-3391.44), s.paychecks);
  assert.equal(applyPaycheckLearning(s, plan, deposit(-3391.44), { updateAmount: true }), true);
  assert.equal(s.paychecks[0].amount, 3391.44);
  assert.deepEqual(s.paycheckOccurrences.map((o) => o.amount), [1500, 3391.44, 3391.44, 900], "past payday kept, this and next follow, the hand-edited one is kept");
  assert.deepEqual(s.paychecks[0].depositPayeeKeys, ["sample corp"]);
  assert.match(s.household.activity[0], /income updated from \$1500\.00 to \$3391\.44/);
});

test("declining the update still remembers the payer but changes no amount", () => {
  const s = state();
  const plan = planPaycheckLearning(deposit(-3391.44), s.paychecks);
  assert.equal(applyPaycheckLearning(s, plan, deposit(-3391.44), { updateAmount: false }), false);
  assert.equal(s.paychecks[0].amount, 1500);
  assert.deepEqual(s.paychecks[0].depositPayeeKeys, ["sample corp"]);
  assert.deepEqual(s.paycheckOccurrences.map((o) => o.amount), [1500, 1500, 1500, 900]);
});

test("once the payer is learned, a deposit of any amount near a payday is held as that paycheck instead of added as new income", () => {
  const s = state();
  const row = deposit(-3391.44, { date: "2026-10-15" });
  assert.equal(matchesRecordedPaycheck(row, s.paycheckOccurrences, s.paychecks), false, "not learned yet, amount too far");
  s.paychecks[0].depositPayeeKeys = ["sample corp"];
  assert.equal(matchesRecordedPaycheck(row, s.paycheckOccurrences, s.paychecks), true);
  assert.equal(matchesRecordedPaycheck({ ...row, date: "2026-10-22" }, s.paycheckOccurrences, s.paychecks), false, "too far from a payday");
  assert.equal(matchesRecordedPaycheck({ ...row, accountId: "other" }, s.paycheckOccurrences, s.paychecks), false);
  assert.equal(matchesRecordedPaycheck(deposit(-1500, { date: "2026-10-15", payee: "SOMETHING ELSE" }), s.paycheckOccurrences, s.paychecks), true, "the old +-2% rule still holds");
});

test("deleting a Ledger deposit and skipping a Bank stream deposit both offer to learn the paycheck", () => {
  assert.match(app, /const \[removed\] = state\.transactions\.splice[\s\S]{0,200}offerPaycheckLearning\(removed\)/);
  assert.match(app, /Dismissed bank stream item[\s\S]{0,200}offerPaycheckLearning\(inboxItem\)/);
  assert.match(app, /async function offerPaycheckLearning[\s\S]{0,1600}applyPaycheckLearning\(state, plan, row, \{ updateAmount \}\)/);
});
