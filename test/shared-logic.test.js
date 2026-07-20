const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyChecklistToggle, bucketChecklistItems, findChecklistDuplicate, mealWeeksForMonth, groupPlanTasksByBucket, validateJournalPayload,
  dailyTaskOccursOnDate, isDailyTaskDoneOnDate, toggleDailyTaskDoneOnDate,
  timeToMinutes, minutesToTime, snapMinutes, layoutTimelineBlocks, comparePlannedToActual,
  sanitizeFilename, buildDocumentObjectPath, wouldCreateFolderCycle, buildFolderTree,
  smsGatewayAddress, paycheckOccurrencesSince, paycheckOccurrencesInRange, paycheckAllOccurrenceDatesInRange, recurringExpenseOccurrenceDates, accountBalance, accountsWithBalances,
  splitAmountEvenly,
  parseDelimitedText, parseBankCsvTransactions, normalizeForAccountMatch, matchAccountByFilename, isDuplicateTransaction,
  recurringBudgetSetAside, nextRecurringBudgetDueDate, monthsUntilDueInclusive,
  annualEventDate, nextAnnualEventDate, annualEventNotifyAt, rollAnnualNotifyAtForward
} = require("../lib/shared-logic");

test("layoutTimelineBlocks gives non-overlapping tasks full width", () => {
  const result = layoutTimelineBlocks([
    { id: "a", start: 480, end: 510 },
    { id: "b", start: 540, end: 570 }
  ]);
  assert.deepEqual(result.find((item) => item.id === "a"), { id: "a", column: 0, columns: 1 });
  assert.deepEqual(result.find((item) => item.id === "b"), { id: "b", column: 0, columns: 1 });
});

test("layoutTimelineBlocks splits two overlapping tasks into two side-by-side columns", () => {
  const result = layoutTimelineBlocks([
    { id: "a", start: 480, end: 540 },
    { id: "b", start: 500, end: 560 }
  ]);
  const a = result.find((item) => item.id === "a");
  const b = result.find((item) => item.id === "b");
  assert.equal(a.columns, 2);
  assert.equal(b.columns, 2);
  assert.notEqual(a.column, b.column, "overlapping tasks must not share a column, or one would still hide the other");
});

test("layoutTimelineBlocks lets a later non-overlapping task reuse a freed column", () => {
  // a spans the whole cluster; b and c don't overlap each other, so they can
  // share one column between them, giving the cluster only 2 columns total.
  const result = layoutTimelineBlocks([
    { id: "a", start: 480, end: 600 },
    { id: "b", start: 490, end: 520 },
    { id: "c", start: 540, end: 570 }
  ]);
  const byId = Object.fromEntries(result.map((item) => [item.id, item]));
  assert.equal(byId.a.columns, 2);
  assert.equal(byId.b.columns, 2);
  assert.equal(byId.c.columns, 2);
  assert.equal(byId.b.column, byId.c.column, "b and c don't overlap each other and should reuse the same column");
  assert.notEqual(byId.a.column, byId.b.column);
});

test("layoutTimelineBlocks treats disjoint clusters independently", () => {
  const result = layoutTimelineBlocks([
    { id: "a", start: 480, end: 510 },
    { id: "b", start: 480, end: 510 },
    { id: "c", start: 700, end: 720 }
  ]);
  const byId = Object.fromEntries(result.map((item) => [item.id, item]));
  assert.equal(byId.a.columns, 2);
  assert.equal(byId.b.columns, 2);
  assert.equal(byId.c.columns, 1, "a task in a separate, non-overlapping cluster should keep full width");
});

test("sanitizeFilename strips path separators, parent-dir sequences, and control characters", () => {
  const traversal = sanitizeFilename("../../etc/passwd");
  assert.ok(!traversal.includes("/"), "sanitized name must not contain a path separator");
  assert.ok(!traversal.includes(".."), "sanitized name must not contain a parent-directory sequence");
  assert.equal(sanitizeFilename("deed\\scan.pdf"), "deed_scan.pdf");
  assert.equal(sanitizeFilename("tax\x00receipt.pdf"), "taxreceipt.pdf");
  assert.equal(sanitizeFilename("   "), "file");
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(sanitizeFilename(null), "file");
});

test("sanitizeFilename truncates very long names", () => {
  const long = `${"a".repeat(250)}.pdf`;
  const result = sanitizeFilename(long);
  assert.ok(result.length <= 200, "sanitized filename should be capped at 200 characters");
});

test("buildDocumentObjectPath embeds household id, document id, and a sanitized filename", () => {
  const path = buildDocumentObjectPath("household-1", "doc-1", "Kanampalayam Patta.pdf");
  assert.equal(path, "documents/household-1/doc-1/Kanampalayam Patta.pdf");
});

test("buildDocumentObjectPath returns null when householdId or documentId is missing", () => {
  assert.equal(buildDocumentObjectPath(null, "doc-1", "a.pdf"), null);
  assert.equal(buildDocumentObjectPath("household-1", null, "a.pdf"), null);
});

test("wouldCreateFolderCycle rejects moving a folder into itself", () => {
  const folders = [{ id: "a", parentId: null }];
  assert.equal(wouldCreateFolderCycle(folders, "a", "a"), true);
});

test("wouldCreateFolderCycle rejects moving a folder into its own child or grandchild", () => {
  const folders = [
    { id: "a", parentId: null },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" }
  ];
  assert.equal(wouldCreateFolderCycle(folders, "a", "b"), true, "moving a into its direct child b should be rejected");
  assert.equal(wouldCreateFolderCycle(folders, "a", "c"), true, "moving a into its grandchild c should be rejected");
});

test("wouldCreateFolderCycle allows moving a folder to a sibling or to the root", () => {
  const folders = [
    { id: "a", parentId: null },
    { id: "b", parentId: "a" },
    { id: "sibling", parentId: "a" }
  ];
  assert.equal(wouldCreateFolderCycle(folders, "b", "sibling"), false);
  assert.equal(wouldCreateFolderCycle(folders, "b", null), false);
});

test("buildFolderTree nests folders by parentId", () => {
  const folders = [
    { id: "a", parentId: null, name: "Root" },
    { id: "b", parentId: "a", name: "Child" },
    { id: "c", parentId: "b", name: "Grandchild" }
  ];
  const tree = buildFolderTree(folders);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "a");
  assert.equal(tree[0].children[0].id, "b");
  assert.equal(tree[0].children[0].children[0].id, "c");
});

test("bucketChecklistItems keeps a checked child in the open bucket while its siblings are still open", () => {
  const checklist = [
    { id: "parent", text: "Peedampally land", done: false, parentId: "" },
    { id: "child-1", text: "Get the survey sign", done: false, parentId: "parent" },
    { id: "child-2", text: "subdivision", done: false, parentId: "parent" },
    { id: "child-3", text: "Fence on one side", done: true, parentId: "parent" }
  ];
  const { open, completed } = bucketChecklistItems(checklist);
  assert.deepEqual(open.map((item) => item.id), ["parent", "child-1", "child-2", "child-3"],
    "checking one child shouldn't strand it in the completed section while siblings are still open");
  assert.deepEqual(completed.map((item) => item.id), []);
});

test("bucketChecklistItems moves the whole group to completed once every child is done", () => {
  const checklist = [
    { id: "parent", text: "Peedampally land", done: true, parentId: "" },
    { id: "child-1", text: "Get the survey sign", done: true, parentId: "parent" },
    { id: "child-2", text: "subdivision", done: true, parentId: "parent" }
  ];
  const { open, completed } = bucketChecklistItems(checklist);
  assert.deepEqual(open, []);
  assert.deepEqual(completed.map((item) => item.id), ["parent", "child-1", "child-2"]);
});

test("bucketChecklistItems buckets standalone top-level items by their own done state", () => {
  const checklist = [
    { id: "item-1", text: "Buy milk", done: false, parentId: "" },
    { id: "item-2", text: "Pay rent", done: true, parentId: "" }
  ];
  const { open, completed } = bucketChecklistItems(checklist);
  assert.deepEqual(open.map((item) => item.id), ["item-1"]);
  assert.deepEqual(completed.map((item) => item.id), ["item-2"]);
});

test("findChecklistDuplicate ignores same-text items that belong to a different parent", () => {
  const checklist = [
    { id: "parent-1", text: "Kanampalayam land", done: false, parentId: "" },
    { id: "child-1", text: "subdivision", done: false, parentId: "parent-1" },
    { id: "parent-2", text: "IOB plot", done: false, parentId: "" }
  ];
  // Adding a new root-level "subdivision" item should not be blocked by the
  // one nested under a different parent.
  assert.equal(findChecklistDuplicate(checklist, "subdivision", ""), null);
  // But it should still find a duplicate among items that share the same parent.
  assert.equal(findChecklistDuplicate(checklist, "subdivision", "parent-1")?.id, "child-1");
});

test("findChecklistDuplicate matches case-insensitively and trims whitespace within the same scope", () => {
  const checklist = [{ id: "item-1", text: "Milk", done: false, parentId: "" }];
  assert.equal(findChecklistDuplicate(checklist, "  milk  ", "")?.id, "item-1");
});

test("checking a child marks the parent done once every sibling is done", () => {
  const checklist = [
    { id: "parent", text: "Kanampalayam land", done: false },
    { id: "child", text: "Check Patta", done: false, parentId: "parent" }
  ];
  const result = applyChecklistToggle(checklist, "child", true);
  assert.equal(result.find((item) => item.id === "child").done, true);
  assert.equal(result.find((item) => item.id === "parent").done, true, "parent should auto-complete once its only child is done");
});

test("checking a parent directly cascades done to all its children", () => {
  const checklist = [
    { id: "parent", text: "Kanampalayam land", done: false },
    { id: "child-1", text: "Check Patta", done: false, parentId: "parent" },
    { id: "child-2", text: "Pay property tax", done: false, parentId: "parent" }
  ];
  const result = applyChecklistToggle(checklist, "parent", true);
  assert.equal(result.find((item) => item.id === "parent").done, true);
  assert.equal(result.find((item) => item.id === "child-1").done, true, "checking the parent should also check its children");
  assert.equal(result.find((item) => item.id === "child-2").done, true, "checking the parent should also check its children");
});

test("unchecking a parent directly cascades not-done to all its children", () => {
  const checklist = [
    { id: "parent", text: "Kanampalayam land", done: true },
    { id: "child-1", text: "Check Patta", done: true, parentId: "parent" },
    { id: "child-2", text: "Pay property tax", done: true, parentId: "parent" }
  ];
  const result = applyChecklistToggle(checklist, "parent", false);
  assert.equal(result.find((item) => item.id === "child-1").done, false);
  assert.equal(result.find((item) => item.id === "child-2").done, false);
});

test("unchecking one child un-completes the parent even if it was previously auto-completed", () => {
  const checklist = [
    { id: "parent", text: "Kanampalayam land", done: true },
    { id: "child-1", text: "Check Patta", done: true, parentId: "parent" },
    { id: "child-2", text: "Pay property tax", done: true, parentId: "parent" }
  ];
  const result = applyChecklistToggle(checklist, "child-1", false);
  assert.equal(result.find((item) => item.id === "child-1").done, false);
  assert.equal(result.find((item) => item.id === "parent").done, false, "parent should no longer show done once a sibling is open again");
  assert.equal(result.find((item) => item.id === "child-2").done, true, "the untouched sibling should keep its own state");
});

test("toggling a standalone item with no parent or children only affects itself", () => {
  const checklist = [{ id: "solo", text: "Water the plants", done: false }];
  const result = applyChecklistToggle(checklist, "solo", true);
  assert.equal(result.find((item) => item.id === "solo").done, true);
});

test("toggling an unknown item id returns the checklist unchanged", () => {
  const checklist = [{ id: "solo", text: "Water the plants", done: false }];
  const result = applyChecklistToggle(checklist, "missing", true);
  assert.deepEqual(result.map((item) => ({ id: item.id, done: item.done })), [{ id: "solo", done: false }]);
});

test("mealWeeksForMonth splits a month into Monday-anchored weeks with correct labels", () => {
  const weeks = mealWeeksForMonth("2026-07");
  assert.equal(weeks[0].number, 1);
  assert.equal(weeks[0].label, "Jul 1–Jul 5");
  assert.equal(weeks[0].start.getDay(), 1, "each week should start on a Monday");
  assert.ok(weeks.length >= 4, "a month should split into at least 4 weeks");
});

test("mealWeeksForMonth week start dates advance by exactly 7 days", () => {
  const weeks = mealWeeksForMonth("2026-07");
  for (let index = 1; index < weeks.length; index += 1) {
    const diffDays = (weeks[index].start - weeks[index - 1].start) / 86400000;
    assert.equal(diffDays, 7);
  }
});

test("groupPlanTasksByBucket sorts tasks into daily, weekly, and monthly groups", () => {
  const tasks = [
    { id: "1", bucket: "daily" },
    { id: "2", bucket: "weekly" },
    { id: "3", bucket: "monthly" },
    { id: "4", bucket: "daily" }
  ];
  const grouped = groupPlanTasksByBucket(tasks);
  assert.deepEqual(grouped.daily.map((task) => task.id), ["1", "4"]);
  assert.deepEqual(grouped.weekly.map((task) => task.id), ["2"]);
  assert.deepEqual(grouped.monthly.map((task) => task.id), ["3"]);
});

test("groupPlanTasksByBucket returns empty arrays for buckets with no tasks", () => {
  const grouped = groupPlanTasksByBucket([]);
  assert.deepEqual(grouped, { daily: [], weekly: [], monthly: [] });
});

test("validateJournalPayload rejects a non-object or missing entries array", () => {
  assert.equal(validateJournalPayload(null), "Invalid journal payload");
  assert.equal(validateJournalPayload({}), "Invalid journal payload");
  assert.equal(validateJournalPayload({ entries: "not-an-array" }), "Invalid journal payload");
});

test("validateJournalPayload accepts entries within the photo limit", () => {
  const payload = { entries: [{ id: "1", photos: [{ id: "p1" }, { id: "p2" }] }] };
  assert.equal(validateJournalPayload(payload), null);
});

test("validateJournalPayload rejects an entry exceeding the photo limit", () => {
  const photos = Array.from({ length: 9 }, (_, index) => ({ id: `p${index}` }));
  const payload = { entries: [{ id: "1", photos }] };
  assert.equal(validateJournalPayload(payload), "Each journal entry supports at most 8 photos");
});

test("validateJournalPayload respects a custom photo limit", () => {
  const photos = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
  const payload = { entries: [{ id: "1", photos }] };
  assert.equal(validateJournalPayload(payload, 2), "Each journal entry supports at most 8 photos");
  assert.equal(validateJournalPayload(payload, 5), null);
});

test("dailyTaskOccursOnDate: recurrence none only occurs on its exact anchor date", () => {
  const task = { anchorDate: "2026-07-06", recurrence: "none" };
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-06"), true);
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-07"), false);
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-05"), false);
});

test("dailyTaskOccursOnDate: recurrence daily occurs every day on or after the anchor", () => {
  const task = { anchorDate: "2026-07-06", recurrence: "daily" };
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-06"), true);
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-20"), true);
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-05"), false, "must not occur before the anchor date");
});

test("dailyTaskOccursOnDate: recurrence weekdays skips Saturday and Sunday", () => {
  // 2026-07-06 is a Monday.
  const task = { anchorDate: "2026-07-06", recurrence: "weekdays" };
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-10"), true, "Friday should occur");
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-11"), false, "Saturday should not occur");
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-12"), false, "Sunday should not occur");
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-13"), true, "the following Monday should occur");
});

test("dailyTaskOccursOnDate: recurrence weekly repeats on the same weekday", () => {
  // 2026-07-06 is a Monday.
  const task = { anchorDate: "2026-07-06", recurrence: "weekly" };
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-13"), true, "the following Monday should occur");
  assert.equal(dailyTaskOccursOnDate(task, "2026-07-14"), false, "Tuesday should not occur");
});

test("dailyTaskOccursOnDate: recurrence monthly repeats on the same day of month", () => {
  const task = { anchorDate: "2026-07-06", recurrence: "monthly" };
  assert.equal(dailyTaskOccursOnDate(task, "2026-08-06"), true);
  assert.equal(dailyTaskOccursOnDate(task, "2026-08-07"), false);
});

test("isDailyTaskDoneOnDate and toggleDailyTaskDoneOnDate track completion per occurrence date", () => {
  const task = { id: "t1", anchorDate: "2026-07-06", recurrence: "daily", completedDates: [] };
  assert.equal(isDailyTaskDoneOnDate(task, "2026-07-06"), false);

  const afterFirstToggle = toggleDailyTaskDoneOnDate(task, "2026-07-06");
  assert.equal(isDailyTaskDoneOnDate(afterFirstToggle, "2026-07-06"), true);
  assert.equal(isDailyTaskDoneOnDate(afterFirstToggle, "2026-07-07"), false, "a different occurrence date must be unaffected");

  const afterSecondToggle = toggleDailyTaskDoneOnDate(afterFirstToggle, "2026-07-06");
  assert.equal(isDailyTaskDoneOnDate(afterSecondToggle, "2026-07-06"), false, "toggling again must un-complete it");
});

test("timeToMinutes and minutesToTime convert both directions", () => {
  assert.equal(timeToMinutes("09:30"), 570);
  assert.equal(timeToMinutes("00:00"), 0);
  assert.equal(minutesToTime(570), "09:30");
  assert.equal(minutesToTime(0), "00:00");
});

test("minutesToTime clamps to a single day", () => {
  assert.equal(minutesToTime(-10), "00:00");
  assert.equal(minutesToTime(24 * 60 + 10), "23:59");
});

test("snapMinutes rounds to the nearest step", () => {
  assert.equal(snapMinutes(52, 15), 45);
  assert.equal(snapMinutes(58, 15), 60);
  assert.equal(snapMinutes(0, 15), 0);
});

test("comparePlannedToActual reports a positive start delta when the task started later than planned", () => {
  const result = comparePlannedToActual({ plannedStartTime: "09:00", plannedDurationMinutes: 30, actualStartTime: "09:15", actualEndTime: "09:45" });
  assert.equal(result.startDeltaMinutes, 15);
  assert.equal(result.durationDeltaMinutes, 0);
});

test("comparePlannedToActual reports a negative start delta when the task started earlier than planned", () => {
  const result = comparePlannedToActual({ plannedStartTime: "09:00", plannedDurationMinutes: 30, actualStartTime: "08:50", actualEndTime: "09:20" });
  assert.equal(result.startDeltaMinutes, -10);
  assert.equal(result.durationDeltaMinutes, 0);
});

test("comparePlannedToActual reports a positive duration delta when the task ran longer than planned", () => {
  const result = comparePlannedToActual({ plannedStartTime: "09:00", plannedDurationMinutes: 30, actualStartTime: "09:00", actualEndTime: "09:50" });
  assert.equal(result.startDeltaMinutes, 0);
  assert.equal(result.durationDeltaMinutes, 20);
});

test("comparePlannedToActual returns null deltas when planned or actual times are missing", () => {
  assert.deepEqual(comparePlannedToActual({ plannedStartTime: "", plannedDurationMinutes: 30, actualStartTime: "09:15", actualEndTime: "09:45" }), { startDeltaMinutes: null, durationDeltaMinutes: 0 });
  assert.deepEqual(comparePlannedToActual({ plannedStartTime: "09:00", plannedDurationMinutes: 30, actualStartTime: "", actualEndTime: "" }), { startDeltaMinutes: null, durationDeltaMinutes: null });
  assert.deepEqual(comparePlannedToActual({ plannedStartTime: "09:00", plannedDurationMinutes: 30, actualStartTime: "09:15", actualEndTime: "" }), { startDeltaMinutes: 15, durationDeltaMinutes: null });
});

test("smsGatewayAddress builds a carrier gateway address from digits-only phone and a known carrier", () => {
  assert.equal(smsGatewayAddress("(555) 123-4567", "verizon"), "5551234567@vtext.com");
  assert.equal(smsGatewayAddress("555-987-6543", "tmobile"), "5559876543@tmomail.net");
});

test("smsGatewayAddress returns null for an unknown carrier", () => {
  assert.equal(smsGatewayAddress("5551234567", "not-a-real-carrier"), null);
});

test("smsGatewayAddress returns null when the phone number has no digits", () => {
  assert.equal(smsGatewayAddress("", "verizon"), null);
  assert.equal(smsGatewayAddress("   ", "verizon"), null);
});

test("accountBalance: checking account with one paycheck deposit and no purchases", () => {
  const accounts = [{ id: "checking", type: "checking", openingBalance: 100 }];
  const paychecks = [{ date: "2026-07-01", recurrence: "once", amount: 2600, depositAccountId: "checking" }];
  const balance = accountBalance("checking", { accounts, transactions: [], paychecks, transfers: [] }, "2026-07-11");
  assert.equal(balance, 2700);
});

test("accountBalance: a purchase linked to the account reduces its balance, an unlinked purchase does not", () => {
  const accounts = [{ id: "checking", type: "checking", openingBalance: 1000 }];
  const transactions = [
    { date: "2026-07-05", amount: 50, accountId: "checking" },
    { date: "2026-07-05", amount: 999, accountId: "" }
  ];
  const balance = accountBalance("checking", { accounts, transactions, paychecks: [], transfers: [] }, "2026-07-11");
  assert.equal(balance, 950);
});

test("accountBalance: a credit card's owed balance increases with a purchase and no payments", () => {
  const accounts = [{ id: "card", type: "credit_card", openingBalance: 0 }];
  const transactions = [{ date: "2026-07-05", amount: 120, accountId: "card" }];
  const balance = accountBalance("card", { accounts, transactions, paychecks: [], transfers: [] }, "2026-07-11");
  assert.equal(balance, 120);
});

test("accountBalance: paying off a credit card via one transfer reduces both the checking and card balances", () => {
  const accounts = [
    { id: "checking", type: "checking", openingBalance: 2000 },
    { id: "card", type: "credit_card", openingBalance: 0 }
  ];
  const transactions = [{ date: "2026-07-05", amount: 300, accountId: "card" }];
  const transfers = [{ date: "2026-07-08", fromAccountId: "checking", toAccountId: "card", amount: 300 }];
  const context = { accounts, transactions, paychecks: [], transfers };
  assert.equal(accountBalance("checking", context, "2026-07-11"), 1700);
  assert.equal(accountBalance("card", context, "2026-07-11"), 0);
});

test("accountBalance: movements referencing a different account do not leak into the account under test", () => {
  const accounts = [
    { id: "checking", type: "checking", openingBalance: 500 },
    { id: "savings", type: "savings", openingBalance: 500 }
  ];
  const transactions = [{ date: "2026-07-05", amount: 40, accountId: "savings" }];
  const paychecks = [{ date: "2026-07-01", recurrence: "once", amount: 1000, depositAccountId: "savings" }];
  const transfers = [{ date: "2026-07-05", fromAccountId: "savings", toAccountId: "checking", amount: 10 }];
  const balance = accountBalance("checking", { accounts, transactions, paychecks, transfers }, "2026-07-11");
  assert.equal(balance, 510);
});

test("accountBalance: a historical query excludes transactions and transfers dated after the reference date", () => {
  const accounts = [
    { id: "checking", type: "checking", openingBalance: 1000 },
    { id: "card", type: "credit_card", openingBalance: 0 }
  ];
  const transactions = [
    { date: "2026-06-01", amount: 50, accountId: "checking" },
    { date: "2026-08-01", amount: 200, accountId: "checking" }
  ];
  const transfers = [{ date: "2026-08-05", fromAccountId: "checking", toAccountId: "card", amount: 40 }];
  const context = { accounts, transactions, paychecks: [], transfers };
  assert.equal(accountBalance("checking", context, "2026-07-01"), 950);
  assert.equal(accountBalance("checking", context, "2026-09-01"), 710);
});

test("accountBalance returns 0 for an unknown or deleted account id", () => {
  const balance = accountBalance("does-not-exist", { accounts: [], transactions: [], paychecks: [], transfers: [] }, "2026-07-11");
  assert.equal(balance, 0);
});

test("accountBalance: borrowing money is an immediate cash inflow, still outstanding", () => {
  const accounts = [{ id: "checking", type: "checking", openingBalance: 100 }];
  const ious = [{ direction: "i_owe", amount: 45, date: "2026-07-05", accountId: "checking", settled: false }];
  const balance = accountBalance("checking", { accounts, transactions: [], paychecks: [], transfers: [], ious }, "2026-07-11");
  assert.equal(balance, 145);
});

test("accountBalance: paying back a borrowed IOU nets it back out once settled", () => {
  const accounts = [{ id: "checking", type: "checking", openingBalance: 100 }];
  const ious = [{ direction: "i_owe", amount: 45, date: "2026-07-05", accountId: "checking", settled: true, settledDate: "2026-07-09" }];
  const context = { accounts, transactions: [], paychecks: [], transfers: [], ious };
  assert.equal(accountBalance("checking", context, "2026-07-08"), 145);
  assert.equal(accountBalance("checking", context, "2026-07-10"), 100);
});

test("accountBalance: a split expense owed to you does not affect the account until settled", () => {
  const accounts = [{ id: "checking", type: "checking", openingBalance: 100 }];
  const ious = [{ direction: "owed_to_me", amount: 33, date: "2026-07-05", accountId: "checking", settled: false }];
  const context = { accounts, transactions: [], paychecks: [], transfers: [], ious };
  assert.equal(accountBalance("checking", context, "2026-07-11"), 100);
  ious[0].settled = true;
  ious[0].settledDate = "2026-07-09";
  assert.equal(accountBalance("checking", context, "2026-07-11"), 133);
});

test("accountBalance: an IOU linked to a different account does not leak into this one", () => {
  const accounts = [
    { id: "checking", type: "checking", openingBalance: 100 },
    { id: "savings", type: "savings", openingBalance: 200 }
  ];
  const ious = [{ direction: "i_owe", amount: 45, date: "2026-07-05", accountId: "savings", settled: false }];
  const balance = accountBalance("checking", { accounts, transactions: [], paychecks: [], transfers: [], ious }, "2026-07-11");
  assert.equal(balance, 100);
});

test("accountsWithBalances attaches a computed balance to every account", () => {
  const state = {
    accounts: [
      { id: "checking", type: "checking", openingBalance: 100 },
      { id: "card", type: "credit_card", openingBalance: 0 }
    ],
    transactions: [{ date: "2026-07-05", amount: 25, accountId: "card" }],
    paychecks: [{ date: "2026-07-01", recurrence: "once", amount: 200, depositAccountId: "checking" }],
    transfers: []
  };
  const result = accountsWithBalances(state, "2026-07-11");
  assert.deepEqual(result.map((account) => [account.id, account.balance]), [["checking", 300], ["card", 25]]);
});

test("paycheckOccurrencesSince: a monthly paycheck deposits once per elapsed month since its anchor date", () => {
  const paycheck = { date: "2026-04-11", recurrence: "monthly" };
  assert.equal(paycheckOccurrencesSince(paycheck, "2026-04-11"), 1);
  assert.equal(paycheckOccurrencesSince(paycheck, "2026-05-10"), 1);
  assert.equal(paycheckOccurrencesSince(paycheck, "2026-05-11"), 2);
  assert.equal(paycheckOccurrencesSince(paycheck, "2026-07-11"), 4);
});

test("paycheckOccurrencesSince: weekly and biweekly paychecks count elapsed periods", () => {
  const weekly = { date: "2026-07-01", recurrence: "weekly" };
  assert.equal(paycheckOccurrencesSince(weekly, "2026-07-01"), 1);
  assert.equal(paycheckOccurrencesSince(weekly, "2026-07-07"), 1);
  assert.equal(paycheckOccurrencesSince(weekly, "2026-07-08"), 2);

  const biweekly = { date: "2026-07-01", recurrence: "biweekly" };
  assert.equal(paycheckOccurrencesSince(biweekly, "2026-07-14"), 1);
  assert.equal(paycheckOccurrencesSince(biweekly, "2026-07-15"), 2);
});

test("paycheckOccurrencesSince: a one-time or bonus paycheck always counts as exactly one", () => {
  assert.equal(paycheckOccurrencesSince({ date: "2026-01-01", recurrence: "once" }, "2026-07-11"), 1);
  assert.equal(paycheckOccurrencesSince({ date: "2026-01-01", recurrence: "bonus" }, "2026-07-11"), 1);
});

test("paycheckOccurrencesSince: a future-dated paycheck has not occurred yet", () => {
  assert.equal(paycheckOccurrencesSince({ date: "2026-08-01", recurrence: "monthly" }, "2026-07-11"), 0);
});

test("paycheckOccurrencesInRange: a monthly paycheck counts exactly one landing per month", () => {
  const paycheck = { date: "2026-04-11", recurrence: "monthly" };
  assert.equal(paycheckOccurrencesInRange(paycheck, "2026-05-01", "2026-05-31"), 1);
  assert.equal(paycheckOccurrencesInRange(paycheck, "2026-04-01", "2026-04-10"), 0);
  assert.equal(paycheckOccurrencesInRange(paycheck, "2026-03-01", "2026-03-31"), 0);
});

test("paycheckOccurrencesInRange: a biweekly paycheck can land twice within one month", () => {
  const paycheck = { date: "2026-07-01", recurrence: "biweekly" };
  assert.equal(paycheckOccurrencesInRange(paycheck, "2026-07-01", "2026-07-31"), 3);
});

test("paycheckOccurrencesInRange: a one-time paycheck only counts in the month it lands", () => {
  const paycheck = { date: "2026-06-15", recurrence: "once" };
  assert.equal(paycheckOccurrencesInRange(paycheck, "2026-06-01", "2026-06-30"), 1);
  assert.equal(paycheckOccurrencesInRange(paycheck, "2026-07-01", "2026-07-31"), 0);
});

test("paycheckAllOccurrenceDatesInRange: a biweekly paycheck lists every individual pay date within the month", () => {
  const paycheck = { date: "2026-07-10", recurrence: "biweekly" };
  assert.deepEqual(paycheckAllOccurrenceDatesInRange(paycheck, "2026-07-01", "2026-07-31"), ["2026-07-10", "2026-07-24"]);
});

test("paycheckAllOccurrenceDatesInRange: a monthly paycheck lists exactly one date per month", () => {
  const paycheck = { date: "2026-04-11", recurrence: "monthly" };
  assert.deepEqual(paycheckAllOccurrenceDatesInRange(paycheck, "2026-05-01", "2026-05-31"), ["2026-05-11"]);
  assert.deepEqual(paycheckAllOccurrenceDatesInRange(paycheck, "2026-03-01", "2026-03-31"), []);
});

test("paycheckAllOccurrenceDatesInRange: a one-time paycheck only lists its own date when inside the range", () => {
  const paycheck = { date: "2026-06-15", recurrence: "once" };
  assert.deepEqual(paycheckAllOccurrenceDatesInRange(paycheck, "2026-06-01", "2026-06-30"), ["2026-06-15"]);
  assert.deepEqual(paycheckAllOccurrenceDatesInRange(paycheck, "2026-07-01", "2026-07-31"), []);
});

test("paycheckOccurrencesInRange: an endDate stops future occurrences without changing past ones", () => {
  const paycheck = { date: "2026-07-10", recurrence: "biweekly", endDate: "2026-09-30" };
  assert.equal(paycheckOccurrencesInRange(paycheck, "2026-07-01", "2026-07-31"), 2);
  assert.equal(paycheckOccurrencesInRange(paycheck, "2026-09-01", "2026-09-30"), 2);
  assert.equal(paycheckOccurrencesInRange(paycheck, "2026-10-01", "2026-10-31"), 0);
});

test("paycheckAllOccurrenceDatesInRange: an endDate excludes dates after it but keeps earlier ones", () => {
  const paycheck = { date: "2026-07-10", recurrence: "biweekly", endDate: "2026-07-15" };
  assert.deepEqual(paycheckAllOccurrenceDatesInRange(paycheck, "2026-07-01", "2026-07-31"), ["2026-07-10"]);
  assert.deepEqual(paycheckAllOccurrenceDatesInRange(paycheck, "2026-08-01", "2026-08-31"), []);
});

test("recurringExpenseOccurrenceDates: a one-time bill posts only its anchor date once reached", () => {
  assert.deepEqual(recurringExpenseOccurrenceDates({ anchorDate: "2026-07-11", recurrence: "none" }, "2026-07-11"), ["2026-07-11"]);
  assert.deepEqual(recurringExpenseOccurrenceDates({ anchorDate: "2026-07-11", recurrence: "none" }, "2026-09-01"), ["2026-07-11"]);
});

test("recurringExpenseOccurrenceDates: a future anchor date has not occurred yet", () => {
  assert.deepEqual(recurringExpenseOccurrenceDates({ anchorDate: "2026-08-01", recurrence: "monthly" }, "2026-07-11"), []);
});

test("recurringExpenseOccurrenceDates: weekly and biweekly bills post one date per elapsed period", () => {
  const weekly = { anchorDate: "2026-07-01", recurrence: "weekly" };
  assert.deepEqual(recurringExpenseOccurrenceDates(weekly, "2026-07-01"), ["2026-07-01"]);
  assert.deepEqual(recurringExpenseOccurrenceDates(weekly, "2026-07-22"), ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"]);

  const biweekly = { anchorDate: "2026-07-01", recurrence: "biweekly" };
  assert.deepEqual(recurringExpenseOccurrenceDates(biweekly, "2026-07-29"), ["2026-07-01", "2026-07-15", "2026-07-29"]);
});

test("recurringExpenseOccurrenceDates: a monthly bill clamps to the last day of shorter months", () => {
  const monthly = { anchorDate: "2026-01-31", recurrence: "monthly" };
  assert.deepEqual(recurringExpenseOccurrenceDates(monthly, "2026-04-30"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("recurringExpenseOccurrenceDates: an end date stops posting new occurrences after it without touching earlier ones", () => {
  const monthly = { anchorDate: "2026-01-31", recurrence: "monthly", endDate: "2026-03-15" };
  assert.deepEqual(recurringExpenseOccurrenceDates(monthly, "2026-04-30"), ["2026-01-31", "2026-02-28"]);
  assert.deepEqual(recurringExpenseOccurrenceDates(monthly, "2026-02-28"), ["2026-01-31", "2026-02-28"]);
});

test("recurringExpenseOccurrenceDates: an end date before the anchor date means it never occurred", () => {
  assert.deepEqual(recurringExpenseOccurrenceDates({ anchorDate: "2026-07-11", recurrence: "weekly", endDate: "2026-07-01" }, "2026-09-01"), []);
});

test("splitAmountEvenly divides evenly when the amount divides cleanly", () => {
  assert.deepEqual(splitAmountEvenly(90, 3), [30, 30, 30]);
});

test("splitAmountEvenly hands leftover cents to the first shares instead of losing them to rounding", () => {
  const shares = splitAmountEvenly(100, 3);
  assert.deepEqual(shares, [33.34, 33.33, 33.33]);
  assert.equal(shares.reduce((sum, share) => sum + share, 0), 100);
});

test("splitAmountEvenly returns an empty list for a zero or negative count", () => {
  assert.deepEqual(splitAmountEvenly(50, 0), []);
  assert.deepEqual(splitAmountEvenly(50, -2), []);
});

test("parseDelimitedText keeps a comma inside a properly quoted field as one cell", () => {
  const rows = parseDelimitedText('a,"b, and c",d\n1,2,3\n');
  assert.deepEqual(rows, [["a", "b, and c", "d"], ["1", "2", "3"]]);
});

test("parseDelimitedText treats an unescaped quote as literal unless followed by a comma or line end", () => {
  const rows = parseDelimitedText('07/03/2026,"Zelle payment to X for "Niralya math"; Conf# abc","-160.00","484.30"\n');
  assert.deepEqual(rows[0], ["07/03/2026", 'Zelle payment to X for "Niralya math"; Conf# abc', "-160.00", "484.30"]);
});

test("parseBankCsvTransactions: a Debit/Credit format imports only debit rows as positive expenses", () => {
  const csv = [
    "Status,Date,Description,Debit,Credit,Member Name",
    'Cleared,07/13/2026,"REGAL MEDLOCK 18 0354 DULUTH GA",1.08,,PRITHVI RAJ VELUCHAMY',
    'Cleared,07/10/2026,"AUTOPAY 220115055210464RAUTOPAY AUTO-PMT",,-1768.09,PRITHVI RAJ VELUCHAMY',
    'Cleared,06/30/2026,"COSTCO WHSE #1175 CUMMING GA",,-26.74,PRITHVI RAJ VELUCHAMY',
    'Cleared,06/30/2026,"COSTCO GAS #1175 CUMMING GA",50.52,,PRITHVI RAJ VELUCHAMY'
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-07-13", payee: "REGAL MEDLOCK 18 0354 DULUTH GA", amount: 1.08 },
    { date: "2026-06-30", payee: "COSTCO GAS #1175 CUMMING GA", amount: 50.52 }
  ]);
});

test("parseBankCsvTransactions: a signed single-Amount format imports only negative (money-out) rows", () => {
  const csv = [
    "Date,Description,Amount,Running Bal.",
    '06/18/2026,"Zelle payment from SURENDRAN JAYABAL Conf# bc4nd92zb","63.75","1,291.97"',
    '06/22/2026,"T-MOBILE DES:PCS SVC ID:9514047","-215.59","1,108.34"',
    '07/17/2026,"ROCKET MORTGAGE DES:LOAN ID:8698964","-2,258.90","1,040.86"'
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-06-22", payee: "T-MOBILE DES:PCS SVC ID:9514047", amount: 215.59 },
    { date: "2026-07-17", payee: "ROCKET MORTGAGE DES:LOAN ID:8698964", amount: 2258.9 }
  ]);
});

test("parseBankCsvTransactions: skips a leading summary block and finds the real transaction header", () => {
  const csv = [
    "Description,,Summary Amt.",
    "Beginning balance as of 06/18/2026,,\"1,228.22\"",
    "Total credits,,\"5,253.21\"",
    "Total debits,,\"-5,938.62\"",
    "Ending balance as of 07/19/2026,,\"542.81\"",
    "",
    "Date,Description,Amount,Running Bal.",
    '06/18/2026,Beginning balance as of 06/18/2026,,"1,228.22"',
    '07/02/2026,"SAWNEE EMC Bill Payment","-138.06","664.47"'
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-07-02", payee: "SAWNEE EMC Bill Payment", amount: 138.06 }
  ]);
});

test("normalizeForAccountMatch strips punctuation, spaces, and case", () => {
  assert.equal(normalizeForAccountMatch("Costco Citi"), "costcociti");
  assert.equal(normalizeForAccountMatch("BoFA"), "bofa");
});

test("matchAccountByFilename matches a filename with extra words/dates against a shorter account name", () => {
  const accounts = [{ id: "a1", name: "Costco Citi" }, { id: "a2", name: "BoFA" }];
  assert.equal(matchAccountByFilename("Costco Citi Jul 142026.CSV", accounts).id, "a1");
  assert.equal(matchAccountByFilename("BoFA.csv", accounts).id, "a2");
  assert.equal(matchAccountByFilename("unrelated-export.csv", accounts), null);
});

test("isDuplicateTransaction matches on amount alone (payee is ignored) within a 2-day date tolerance", () => {
  const existing = [{ date: "2026-07-10", amount: 35, payee: "RETURN CHECK FEE - 071026" }];
  assert.equal(isDuplicateTransaction({ date: "2026-07-10", amount: 35, payee: "Completely Different Payee" }, existing), true, "payee text is not checked");
  assert.equal(isDuplicateTransaction({ date: "2026-07-08", amount: 35, payee: "Anything" }, existing), true, "2 days earlier still counts as a duplicate");
  assert.equal(isDuplicateTransaction({ date: "2026-07-12", amount: 35, payee: "Anything" }, existing), true, "2 days later still counts as a duplicate");
  assert.equal(isDuplicateTransaction({ date: "2026-07-07", amount: 35, payee: "Anything" }, existing), false, "3 days earlier is outside the tolerance");
  assert.equal(isDuplicateTransaction({ date: "2026-07-13", amount: 35, payee: "Anything" }, existing), false, "3 days later is outside the tolerance");
  assert.equal(isDuplicateTransaction({ date: "2026-07-10", amount: 36, payee: "RETURN CHECK FEE - 071026" }, existing), false, "amount must match exactly");
  assert.equal(isDuplicateTransaction({ date: "2026-07-10", amount: 35, payee: "RETURN CHECK FEE - 071026" }, []), false);
});

test("recurringBudgetSetAside divides a yearly bill across only the months remaining before it is due", () => {
  const bill = { amount: 1200, frequency: "yearly", dueDate: "2026-12-15" };
  assert.equal(nextRecurringBudgetDueDate(bill, "2026-07"), "2026-12-15");
  assert.equal(monthsUntilDueInclusive("2026-07", "2026-12-15"), 6);
  assert.deepEqual(recurringBudgetSetAside(bill, "2026-07"), {
    amountDue: 1200,
    frequency: "yearly",
    nextDueDate: "2026-12-15",
    monthsRemaining: 6,
    monthlyAmount: 200
  });
});

test("recurringBudgetSetAside charges the full amount when the due month is the current budget month", () => {
  const bill = { amount: 1200, frequency: "yearly", dueDate: "2026-07-20" };
  assert.equal(recurringBudgetSetAside(bill, "2026-07").monthlyAmount, 1200);
});

test("recurringBudgetSetAside supports quarterly and monthly budget bills", () => {
  const quarterly = recurringBudgetSetAside({ amount: 600, frequency: "quarterly", dueDate: "2026-09-30" }, "2026-07");
  assert.equal(quarterly.nextDueDate, "2026-09-30");
  assert.equal(quarterly.monthsRemaining, 3);
  assert.equal(quarterly.monthlyAmount, 200);

  const monthly = recurringBudgetSetAside({ amount: 75, frequency: "monthly", dueDate: "2026-01-31" }, "2026-02");
  assert.equal(monthly.nextDueDate, "2026-02-28");
  assert.equal(monthly.monthlyAmount, 75);
});

test("accountBalance: a recurring paychecks materialized occurrences each deposit into its linked account", () => {
  const accounts = [{ id: "checking", type: "checking", openingBalance: 0 }];
  const paycheckOccurrences = [
    { date: "2026-04-11", amount: 1000, depositAccountId: "checking" },
    { date: "2026-05-11", amount: 1000, depositAccountId: "checking" },
    { date: "2026-06-11", amount: 1000, depositAccountId: "checking" },
    { date: "2026-07-11", amount: 1000, depositAccountId: "checking" },
    { date: "2026-08-11", amount: 1000, depositAccountId: "checking" }
  ];
  const balance = accountBalance("checking", { accounts, transactions: [], paychecks: [], paycheckOccurrences, transfers: [] }, "2026-07-11");
  assert.equal(balance, 4000);
});

test("annualEventDate clamps Feb 29 to Feb 28 in non-leap years", () => {
  const event = { monthDay: "02-29" };
  const nonLeap = annualEventDate(event, 2025);
  assert.equal(nonLeap.getMonth(), 1);
  assert.equal(nonLeap.getDate(), 28);
  const leap = annualEventDate(event, 2024);
  assert.equal(leap.getMonth(), 1);
  assert.equal(leap.getDate(), 29);
});

test("nextAnnualEventDate returns this year's date when it hasn't passed yet", () => {
  const event = { monthDay: "09-24" };
  const reference = new Date(2026, 6, 11);
  const next = nextAnnualEventDate(event, reference);
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 8);
  assert.equal(next.getDate(), 24);
});

test("nextAnnualEventDate rolls to next year once this year's date has already passed", () => {
  const event = { monthDay: "05-28" };
  const reference = new Date(2026, 6, 11);
  const next = nextAnnualEventDate(event, reference);
  assert.equal(next.getFullYear(), 2027);
  assert.equal(next.getMonth(), 4);
  assert.equal(next.getDate(), 28);
});

test("nextAnnualEventDate treats today's own date as not yet passed", () => {
  const event = { monthDay: "07-11" };
  const reference = new Date(2026, 6, 11);
  const next = nextAnnualEventDate(event, reference);
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 6);
  assert.equal(next.getDate(), 11);
});

test("annualEventNotifyAt derives the due date from the next occurrence and reminderDays, ignoring a literal birth year", () => {
  const event = { monthDay: "09-24", reminderDays: 7, dateTime: "1986-09-24T13:00" };
  const reference = new Date(2026, 6, 11);
  const notifyAt = new Date(annualEventNotifyAt(event, reference));
  assert.equal(notifyAt.getFullYear(), 2026);
  assert.equal(notifyAt.getMonth(), 8);
  assert.equal(notifyAt.getDate(), 17);
  assert.equal(notifyAt.getHours(), 13);
});

test("annualEventNotifyAt rolls the due date to next year once this year's occurrence has passed", () => {
  const event = { monthDay: "05-28", reminderDays: 7, dateTime: "2020-05-28T09:00" };
  const reference = new Date(2026, 6, 11);
  const notifyAt = new Date(annualEventNotifyAt(event, reference));
  assert.equal(notifyAt.getFullYear(), 2027);
  assert.equal(notifyAt.getMonth(), 4);
  assert.equal(notifyAt.getDate(), 21);
});

test("rollAnnualNotifyAtForward leaves a future instant unchanged", () => {
  const notifyAt = "2027-05-28T13:00:00.000Z";
  const reference = new Date("2026-07-11T12:00:00.000Z");
  assert.equal(rollAnnualNotifyAtForward(notifyAt, reference), notifyAt);
});

test("rollAnnualNotifyAtForward advances a stale instant to the same hour/minute in a future year, never re-deriving the time of day", () => {
  // This is the exact scenario that caused a duplicate email in production:
  // the server must not recompute the hour using its own ambient timezone.
  const notifyAt = "1982-07-11T13:00:00.000Z";
  const beforeThisYearsTime = new Date("2026-07-11T12:00:00.000Z");
  assert.equal(rollAnnualNotifyAtForward(notifyAt, beforeThisYearsTime), "2026-07-11T13:00:00.000Z");

  const afterThisYearsTime = new Date("2026-07-11T14:00:00.000Z");
  assert.equal(rollAnnualNotifyAtForward(notifyAt, afterThisYearsTime), "2027-07-11T13:00:00.000Z");
});

test("rollAnnualNotifyAtForward returns null for a missing or invalid notifyAt", () => {
  assert.equal(rollAnnualNotifyAtForward(""), null);
  assert.equal(rollAnnualNotifyAtForward(null), null);
  assert.equal(rollAnnualNotifyAtForward("not-a-date"), null);
});
