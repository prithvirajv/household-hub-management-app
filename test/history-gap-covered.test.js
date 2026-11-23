const test = require("node:test");
const assert = require("node:assert/strict");
const { historyGapCovered, historyGapMissingMonths, openHistoryGapNotices } = require("../lib/shared-logic");

const notice = { id: "g1", accountId: "amex", fromMonth: "2026-09", toMonth: "2026-10" };
const row = (date, accountId = "amex") => ({ accountId, date });

test("a notice clears once every month it names has a row on that account", () => {
  assert.equal(historyGapCovered(notice, [row("2026-09-04"), row("2026-10-02")], []), true);
});

test("a missing month, another account's rows or a bad notice keep it open", () => {
  assert.equal(historyGapCovered(notice, [row("2026-09-04")], []), false, "October has nothing");
  assert.equal(historyGapCovered(notice, [row("2026-09-04", "chase"), row("2026-10-02", "chase")], []), false, "wrong account");
  assert.equal(historyGapCovered({ ...notice, accountId: "" }, [row("2026-09-04")], []), false);
  assert.equal(historyGapCovered({ ...notice, toMonth: "2026-08" }, [row("2026-09-04")], []), false);
  assert.equal(historyGapCovered(null, [], []), false);
});

test("rows still waiting in Bank stream count, and a range can cross a year", () => {
  assert.equal(historyGapCovered(notice, [row("2026-09-04")], [row("2026-10-30")]), true);
  const wrap = { id: "g2", accountId: "amex", fromMonth: "2025-12", toMonth: "2026-01" };
  assert.equal(historyGapCovered(wrap, [row("2025-12-31"), row("2026-01-01")], []), true);
  assert.equal(historyGapCovered(wrap, [row("2025-12-31")], []), false);
});

test("openHistoryGapNotices keeps only the notices that are still open", () => {
  const other = { id: "g3", accountId: "chase", fromMonth: "2026-03", toMonth: "2026-03" };
  const open = openHistoryGapNotices([notice, other], [row("2026-09-04"), row("2026-10-02")], []);
  assert.deepEqual(open.map((item) => item.id), ["g3"]);
});

test("the months still empty are named, for notices that are partly covered", () => {
  const wide = { id: "g9", accountId: "amex", fromMonth: "2026-01", toMonth: "2026-07" };
  const rows = [row("2026-01-15"), row("2026-04-02"), row("2026-07-30"), row("2026-02-03", "chase")];
  assert.deepEqual(historyGapMissingMonths(wide, rows, []), ["2026-02", "2026-03", "2026-05", "2026-06"]);
  assert.deepEqual(historyGapMissingMonths(wide, [...rows, row("2026-03-01")], [row("2026-02-20")]).length, 2);
  assert.equal(historyGapMissingMonths({ ...wide, accountId: "" }, rows, []), null, "a notice with no account cannot be judged");
  assert.deepEqual(historyGapMissingMonths({ ...wide, fromMonth: "2025-11", toMonth: "2026-01" }, rows, []), ["2025-11", "2025-12"]);
});
