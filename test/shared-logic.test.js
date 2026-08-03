const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyChecklistToggle, bucketChecklistItems, findChecklistDuplicate, moveChecklistItem, mealWeeksForMonth, groupPlanTasksByBucket, validateJournalPayload,
  dailyTaskOccursOnDate, isDailyTaskDoneOnDate, toggleDailyTaskDoneOnDate,
  timeToMinutes, minutesToTime, snapMinutes, layoutTimelineBlocks, comparePlannedToActual,
  sanitizeFilename, buildDocumentObjectPath, wouldCreateFolderCycle, buildFolderTree,
  smsGatewayAddress, paycheckOccurrencesSince, paycheckOccurrencesInRange, paycheckAllOccurrenceDatesInRange, recurringExpenseOccurrenceDates, accountBalance, accountsWithBalances,
  monthEndDateKey, assetValue, computeTrailingMonthKeys, computeReportCategoriesForScope, computeNetWorthAtDate, computeNetWorthTrend, computeCashFlowByMonth, sankeyFlowSegments,
  splitAmountEvenly, splitBillByPercentages, splitBillByShares, netBalancesByPerson, computeBillSplitAmounts, settleUpPersonIous, isValidEmail,
  parseDelimitedText, parseBankCsvTransactions, normalizeForAccountMatch, matchAccountByFilename, matchAccountByHints, extractAccountActivityLabel, isDuplicateTransaction, findTransferCandidate,
  orderRefundMatch, normalizeForPayeeMatch, payeesFuzzyMatch, refundFuzzyMatch, refundMatch, suggestSubcategoryFromHistory, suggestAccountFromHistory,
  parseCreditCardStatementText, parseCheckingAccountActivityText, parseBankStatementPdfText, normalizeTag, groupTransactionsByTag, monthKeysInRange, spentByLineInMonth,
  recurringBudgetSetAside, nextRecurringBudgetDueDate, monthsUntilDueInclusive,
  annualEventDate, nextAnnualEventDate, annualEventNotifyAt, rollAnnualNotifyAtForward,
  nextPendingChoreOccurrence, currentChoreOccurrenceDate, zonedTimeToUtcIso, choreNotifyAt
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

test("moveChecklistItem moves a dragged item before the target when dropped on its top half", () => {
  const checklist = [
    { id: "a", text: "Splitwise adding", done: false, parentId: "" },
    { id: "b", text: "Fold clothes", done: false, parentId: "" },
    { id: "c", text: "Tax returns filing", done: false, parentId: "" }
  ];
  const result = moveChecklistItem(checklist, "b", "a", false);
  assert.deepEqual(result.map((item) => item.id), ["b", "a", "c"]);
});

test("moveChecklistItem moves a dragged item after the target when dropped on its bottom half", () => {
  const checklist = [
    { id: "a", text: "Splitwise adding", done: false, parentId: "" },
    { id: "b", text: "Fold clothes", done: false, parentId: "" },
    { id: "c", text: "Tax returns filing", done: false, parentId: "" }
  ];
  // Moving "Splitwise adding" to the third row, as in the user's example.
  const result = moveChecklistItem(checklist, "a", "c", true);
  assert.deepEqual(result.map((item) => item.id), ["b", "c", "a"]);
});

test("moveChecklistItem carries a parent's children along as one contiguous block", () => {
  const checklist = [
    { id: "parent-1", text: "Kanampalayam land", done: false, parentId: "" },
    { id: "child-1", text: "Check", done: false, parentId: "parent-1" },
    { id: "child-2", text: "Fencing", done: false, parentId: "parent-1" },
    { id: "parent-2", text: "IOB plot", done: false, parentId: "" }
  ];
  const result = moveChecklistItem(checklist, "parent-1", "parent-2", true);
  assert.deepEqual(result.map((item) => item.id), ["parent-2", "parent-1", "child-1", "child-2"], "the parent and both children move together, in their original relative order");
});

test("moveChecklistItem moves a single child without disturbing its siblings", () => {
  const checklist = [
    { id: "parent-1", text: "Kanampalayam land", done: false, parentId: "" },
    { id: "child-1", text: "Check", done: false, parentId: "parent-1" },
    { id: "child-2", text: "Fencing", done: false, parentId: "parent-1" }
  ];
  const result = moveChecklistItem(checklist, "child-2", "child-1", false);
  assert.deepEqual(result.map((item) => item.id), ["parent-1", "child-2", "child-1"]);
  assert.equal(result.find((item) => item.id === "child-2").parentId, "parent-1", "moving a child doesn't change who its parent is");
});

test("moveChecklistItem is a no-op when dropped on itself, a missing id, or its own child", () => {
  const checklist = [
    { id: "parent-1", text: "Kanampalayam land", done: false, parentId: "" },
    { id: "child-1", text: "Check", done: false, parentId: "parent-1" }
  ];
  assert.equal(moveChecklistItem(checklist, "parent-1", "parent-1", false), checklist);
  assert.equal(moveChecklistItem(checklist, "missing", "parent-1", false), checklist);
  assert.equal(moveChecklistItem(checklist, "parent-1", "child-1", false), checklist, "dragging a parent onto its own child isn't a valid drop");
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

test("splitBillByPercentages divides a clean percentage split exactly", () => {
  assert.deepEqual(splitBillByPercentages(100, [70, 30]), [70, 30]);
});

test("splitBillByPercentages uses largest-remainder rounding instead of naive independent rounding", () => {
  const shares = splitBillByPercentages(10, [33.33, 33.33, 33.34]);
  assert.deepEqual(shares, [3.33, 3.33, 3.34]);
  assert.equal(shares.reduce((sum, share) => sum + share, 0), 10);
});

test("splitBillByPercentages returns null when percentages don't sum to ~100", () => {
  assert.equal(splitBillByPercentages(100, [40, 40]), null);
  assert.equal(splitBillByPercentages(100, [60, 60]), null);
});

test("splitBillByPercentages accepts a small rounding tolerance around 100", () => {
  assert.deepEqual(splitBillByPercentages(100, [33.33, 33.33, 33.34]), [33.33, 33.33, 33.34]);
});

test("netBalancesByPerson nets an i_owe record against an owed_to_me record for the same person", () => {
  const ious = [
    { id: "a", person: "Sam", amount: 20, direction: "i_owe", settled: false },
    { id: "b", person: "Sam", amount: 32, direction: "owed_to_me", settled: false }
  ];
  const groups = netBalancesByPerson(ious);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].net, 12);
  assert.equal(groups[0].direction, "owed_to_me");
  assert.equal(groups[0].records.length, 2);
});

test("netBalancesByPerson reports i_owe direction when the net balance is negative", () => {
  const ious = [{ id: "a", person: "Priya", amount: 45, direction: "i_owe", settled: false }];
  const groups = netBalancesByPerson(ious);
  assert.equal(groups[0].net, -45);
  assert.equal(groups[0].direction, "i_owe");
});

test("netBalancesByPerson excludes settled records from the net entirely", () => {
  const ious = [
    { id: "a", person: "Jordan", amount: 20, direction: "owed_to_me", settled: true },
    { id: "b", person: "Jordan", amount: 15, direction: "owed_to_me", settled: false }
  ];
  const groups = netBalancesByPerson(ious);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].net, 15);
  assert.equal(groups[0].records.length, 1);
});

test("netBalancesByPerson collapses different casing/whitespace of the same name into one group", () => {
  const ious = [
    { id: "a", person: "Sam", amount: 10, direction: "owed_to_me", settled: false },
    { id: "b", person: " sam ", amount: 5, direction: "owed_to_me", settled: false }
  ];
  const groups = netBalancesByPerson(ious);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].net, 15);
});

test("netBalancesByPerson returns an empty array for no ious", () => {
  assert.deepEqual(netBalancesByPerson([]), []);
  assert.deepEqual(netBalancesByPerson(undefined), []);
});

test("computeBillSplitAmounts (equal): payerAmount always reconciles to the cent, including the leftover-cent case", () => {
  const result = computeBillSplitAmounts("equal", 100, [{}, {}]);
  assert.ok(result.ok);
  assert.equal(result.friendAmounts.length, 2);
  const total = result.friendAmounts.reduce((sum, amount) => sum + amount, 0) + result.payerAmount;
  assert.equal(Math.round(total * 100) / 100, 100);
});

test("computeBillSplitAmounts (percentage): friend percentages convert to dollar amounts, payer gets the rest", () => {
  const result = computeBillSplitAmounts("percentage", 100, [{ percent: 40 }, { percent: 30 }]);
  assert.ok(result.ok);
  assert.deepEqual(result.friendAmounts, [40, 30]);
  assert.equal(result.payerAmount, 30);
});

test("computeBillSplitAmounts (percentage): rejects friend percentages over 100", () => {
  const result = computeBillSplitAmounts("percentage", 100, [{ percent: 70 }, { percent: 40 }]);
  assert.equal(result.ok, false);
});

test("computeBillSplitAmounts (exact): passes through typed amounts, absorbing rounding fuzz into payerAmount", () => {
  const result = computeBillSplitAmounts("exact", 622.36, [{ amount: 150 }, { amount: 100 }]);
  assert.ok(result.ok);
  assert.deepEqual(result.friendAmounts, [150, 100]);
  assert.equal(result.payerAmount, 372.36);
});

test("computeBillSplitAmounts (exact): rejects a split that adds up to more than the total", () => {
  const result = computeBillSplitAmounts("exact", 100, [{ amount: 60 }, { amount: 60 }]);
  assert.equal(result.ok, false);
});

test("splitBillByShares divides proportionally by raw share counts, not requiring them to sum to any particular total", () => {
  const result = splitBillByShares(90, [1, 2]);
  assert.deepEqual(result, [30, 60]);
});

test("splitBillByShares returns null with no shares or when every share is zero", () => {
  assert.equal(splitBillByShares(100, []), null);
  assert.equal(splitBillByShares(100, [0, 0]), null);
});

test("computeBillSplitAmounts (shares): splits proportionally, defaulting your own share to 1 part when not given", () => {
  const result = computeBillSplitAmounts("shares", 90, [{ shares: 2 }]);
  assert.ok(result.ok);
  assert.deepEqual(result.friendAmounts, [60]);
  assert.equal(result.payerAmount, 30);
});

test("computeBillSplitAmounts (shares): an explicit yourShare of 0 excludes the payer entirely", () => {
  const result = computeBillSplitAmounts("shares", 90, [{ shares: 1 }, { shares: 2 }], 0);
  assert.ok(result.ok);
  assert.deepEqual(result.friendAmounts, [30, 60]);
  assert.equal(result.payerAmount, 0);
});

test("computeBillSplitAmounts (percentage): an explicit yourShare of 0 requires friends to cover 100%", () => {
  const full = computeBillSplitAmounts("percentage", 100, [{ percent: 60 }, { percent: 40 }], 0);
  assert.ok(full.ok);
  assert.deepEqual(full.friendAmounts, [60, 40]);
  assert.equal(full.payerAmount, 0);

  const short = computeBillSplitAmounts("percentage", 100, [{ percent: 60 }, { percent: 30 }], 0);
  assert.equal(short.ok, false, "60 + 30 + your 0% doesn't reach 100%, so this must be rejected instead of silently leaving 10% unaccounted for");
});

test("computeBillSplitAmounts (exact): an explicit yourShare of 0 requires friends to cover the full total", () => {
  const full = computeBillSplitAmounts("exact", 100, [{ amount: 100 }], 0);
  assert.ok(full.ok);
  assert.equal(full.payerAmount, 0);

  const short = computeBillSplitAmounts("exact", 100, [{ amount: 60 }], 0);
  assert.equal(short.ok, false, "friends only cover 60 of the 100 total while you explicitly claimed 0, so this must be rejected rather than silently pocketing the other 40");
});

test("settleUpPersonIous fully settles a single record", () => {
  const ious = [{ id: "a", person: "Sam", amount: 20, direction: "owed_to_me", date: "2026-07-01", settled: false, settledDate: "" }];
  const result = settleUpPersonIous(ious, "Sam", 20, "2026-07-15", () => "remainder");
  assert.ok(result.ok);
  assert.equal(result.ious.length, 1);
  assert.equal(result.ious[0].settled, true);
  assert.equal(result.ious[0].settledDate, "2026-07-15");
  assert.deepEqual(result.settledIds, ["a"]);
});

test("settleUpPersonIous settles across two records, oldest first", () => {
  const ious = [
    { id: "a", person: "Sam", amount: 20, direction: "owed_to_me", date: "2026-07-05", settled: false, settledDate: "" },
    { id: "b", person: "Sam", amount: 15, direction: "owed_to_me", date: "2026-07-01", settled: false, settledDate: "" }
  ];
  const result = settleUpPersonIous(ious, "Sam", 35, "2026-07-15", () => "remainder");
  assert.ok(result.ok);
  assert.ok(result.ious.every((iou) => iou.settled));
  assert.deepEqual(result.settledIds.sort(), ["a", "b"]);
});

test("settleUpPersonIous splits the last touched record when the amount doesn't land on a whole-record boundary", () => {
  const ious = [{ id: "a", person: "Sam", amount: 20, direction: "owed_to_me", date: "2026-07-01", accountId: "checking", settled: false, settledDate: "" }];
  const result = settleUpPersonIous(ious, "Sam", 12, "2026-07-15", () => "a-remainder");
  assert.ok(result.ok);
  assert.equal(result.ious.length, 2);
  const settledPortion = result.ious.find((iou) => iou.id === "a");
  const remainder = result.ious.find((iou) => iou.id === "a-remainder");
  assert.equal(settledPortion.amount, 12);
  assert.equal(settledPortion.settled, true);
  assert.equal(settledPortion.settledDate, "2026-07-15");
  assert.equal(remainder.amount, 8);
  assert.equal(remainder.settled, false);
  assert.equal(remainder.accountId, "checking");
  assert.equal(remainder.direction, "owed_to_me");
  assert.equal(settledPortion.amount + remainder.amount, 20);
});

test("settleUpPersonIous only touches records in the person's net direction, leaving offsetting records alone", () => {
  const ious = [
    { id: "a", person: "Sam", amount: 32, direction: "owed_to_me", date: "2026-07-01", settled: false, settledDate: "" },
    { id: "b", person: "Sam", amount: 20, direction: "i_owe", date: "2026-07-01", settled: false, settledDate: "" }
  ];
  const result = settleUpPersonIous(ious, "Sam", 12, "2026-07-15", () => "remainder");
  assert.ok(result.ok);
  const untouched = result.ious.find((iou) => iou.id === "b");
  assert.equal(untouched.settled, false);
});

test("settleUpPersonIous rejects an amount exceeding the net balance and leaves ious untouched", () => {
  const ious = [{ id: "a", person: "Sam", amount: 20, direction: "owed_to_me", date: "2026-07-01", settled: false, settledDate: "" }];
  const result = settleUpPersonIous(ious, "Sam", 25, "2026-07-15", () => "remainder");
  assert.equal(result.ok, false);
  assert.equal(ious[0].settled, false);
});

test("settleUpPersonIous regression: a partial settle-up split still reconciles with accountBalance's per-record reads", () => {
  const accounts = [{ id: "checking", type: "checking", openingBalance: 100 }];
  const ious = [{ id: "a", person: "Sam", amount: 20, direction: "owed_to_me", date: "2026-07-05", accountId: "checking", settled: false, settledDate: "" }];
  const before = accountBalance("checking", { accounts, transactions: [], paychecks: [], transfers: [], ious }, "2026-07-20");
  assert.equal(before, 100);
  const result = settleUpPersonIous(ious, "Sam", 12, "2026-07-15", () => "a-remainder");
  const after = accountBalance("checking", { accounts, transactions: [], paychecks: [], transfers: [], ious: result.ious }, "2026-07-20");
  assert.equal(after, 112);
  const stillPending = accountBalance("checking", { accounts, transactions: [], paychecks: [], transfers: [], ious: result.ious }, "2026-07-10");
  assert.equal(stillPending, 100);
});

test("isValidEmail accepts a well-formed address", () => {
  assert.equal(isValidEmail("friend@example.com"), true);
});

test("isValidEmail rejects a missing @ or missing domain dot", () => {
  assert.equal(isValidEmail("friendexample.com"), false);
  assert.equal(isValidEmail("friend@examplecom"), false);
});

test("isValidEmail rejects empty or whitespace-only input", () => {
  assert.equal(isValidEmail(""), false);
  assert.equal(isValidEmail("   "), false);
  assert.equal(isValidEmail(undefined), false);
});

test("parseDelimitedText keeps a comma inside a properly quoted field as one cell", () => {
  const rows = parseDelimitedText('a,"b, and c",d\n1,2,3\n');
  assert.deepEqual(rows, [["a", "b, and c", "d"], ["1", "2", "3"]]);
});

test("parseDelimitedText treats an unescaped quote as literal unless followed by a comma or line end", () => {
  const rows = parseDelimitedText('07/03/2026,"Zelle payment to X for "Niralya math"; Conf# abc","-160.00","484.30"\n');
  assert.deepEqual(rows[0], ["07/03/2026", 'Zelle payment to X for "Niralya math"; Conf# abc', "-160.00", "484.30"]);
});

test("parseBankCsvTransactions: a Debit/Credit format imports debit rows as expenses, flags an autopay credit as a payment (not silently dropped), and keeps a genuine credit as a flagged deposit", () => {
  const csv = [
    "Status,Date,Description,Debit,Credit,Member Name",
    'Cleared,07/13/2026,"REGAL MEDLOCK 18 0354 DULUTH GA",1.08,,J DOE',
    'Cleared,07/10/2026,"AUTOPAY 220115055210464RAUTOPAY AUTO-PMT",,-1768.09,J DOE',
    'Cleared,06/30/2026,"COSTCO WHSE #1175 CUMMING GA",,-26.74,J DOE',
    'Cleared,06/30/2026,"COSTCO GAS #1175 CUMMING GA",50.52,,J DOE'
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-07-13", payee: "REGAL MEDLOCK 18 0354 DULUTH GA", amount: 1.08 },
    { date: "2026-07-10", payee: "AUTOPAY 220115055210464RAUTOPAY AUTO-PMT", amount: -1768.09, isPayment: true },
    { date: "2026-06-30", payee: "COSTCO WHSE #1175 CUMMING GA", amount: -26.74, isDeposit: true },
    { date: "2026-06-30", payee: "COSTCO GAS #1175 CUMMING GA", amount: 50.52 }
  ]);
});

test("parseBankCsvTransactions: a signed single-Amount format imports both money-out rows and deposits (flagged isDeposit, not silently dropped)", () => {
  const csv = [
    "Date,Description,Amount,Running Bal.",
    '06/18/2026,"Zelle payment from SURENDRAN JAYABAL Conf# bc4nd92zb","63.75","1,291.97"',
    '06/22/2026,"T-MOBILE DES:PCS SVC ID:9514047","-215.59","1,108.34"',
    '07/17/2026,"ROCKET MORTGAGE DES:LOAN ID:8698964","-2,258.90","1,040.86"'
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-06-18", payee: "Zelle payment from SURENDRAN JAYABAL Conf# bc4nd92zb", amount: -63.75, isDeposit: true },
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

test("parseBankCsvTransactions: detects a credit-card-style export (mostly positive), keeps purchases positive, and flags autopay rows as payments instead of dropping them", () => {
  const csv = [
    "Date,Description,Card Member,Account #,Amount,Reference,Category",
    "06/09/2026,AUTOPAY PAYMENT - THANK YOU,J DOE,-55004,-256.87,'1',",
    "05/24/2026,DUNKIN #365203 CUMMING GA,J DOE,-55004,1.70,'2',Restaurant",
    "05/24/2026,KATE SPADE NEW YORK NY,J DOE,-55004,133.16,'3',Merchandise",
    "05/09/2026,AUTOPAY PAYMENT - THANK YOU,J DOE,-55004,-10.05,'4',",
    "04/27/2026,BUDGET RENT A CAR LOS ANGELES CA,J DOE,-55004,97.06,'5',Travel"
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-06-09", payee: "AUTOPAY PAYMENT - THANK YOU", amount: -256.87, isPayment: true },
    { date: "2026-05-24", payee: "DUNKIN #365203 CUMMING GA", amount: 1.70 },
    { date: "2026-05-24", payee: "KATE SPADE NEW YORK NY", amount: 133.16 },
    { date: "2026-05-09", payee: "AUTOPAY PAYMENT - THANK YOU", amount: -10.05, isPayment: true },
    { date: "2026-04-27", payee: "BUDGET RENT A CAR LOS ANGELES CA", amount: 97.06 }
  ]);
});

test("parseBankCsvTransactions: keeps a genuine merchant refund on a credit-card-style export as a negative amount, and flags a payoff row instead of dropping it", () => {
  const csv = [
    "Date,Description,Amount,Reference,Category",
    "07/01/2026,ONLINE PAYMENT - THANK YOU,-732.35,'1',",
    "06/20/2026,HOME2 SUITES INDIANAPOLIS IN,203.59,'2',Travel-Lodging",
    "06/19/2026,HILTON GLOBAL FND/TM REFUND,-2.00,'3',Travel-Lodging",
    "05/15/2026,DOUBLETREE FORT LEE NJ,163.65,'4',Travel-Lodging",
    "04/28/2026,DOUBLETREE COLLINSVILLE IL,211.61,'5',Travel-Lodging",
    "04/11/2026,HAMPTON INN COLUMBUS OH,115.52,'6',Travel-Lodging"
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-07-01", payee: "ONLINE PAYMENT - THANK YOU", amount: -732.35, isPayment: true },
    { date: "2026-06-20", payee: "HOME2 SUITES INDIANAPOLIS IN", amount: 203.59 },
    { date: "2026-06-19", payee: "HILTON GLOBAL FND/TM REFUND", amount: -2.00 },
    { date: "2026-05-15", payee: "DOUBLETREE FORT LEE NJ", amount: 163.65 },
    { date: "2026-04-28", payee: "DOUBLETREE COLLINSVILLE IL", amount: 211.61 },
    { date: "2026-04-11", payee: "HAMPTON INN COLUMBUS OH", amount: 115.52 }
  ]);
});

test("parseBankCsvTransactions: a checking-style export (mostly negative) is unaffected by credit-card detection, and its one deposit is kept (flagged), not dropped", () => {
  const csv = [
    "Date,Description,Amount",
    "07/01/2026,Paycheck deposit,2500.00",
    "07/02/2026,Grocery store,-84.21",
    "07/03/2026,Gas station,-45.00",
    "07/05/2026,Electric bill,-120.50"
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-07-01", payee: "Paycheck deposit", amount: -2500, isDeposit: true },
    { date: "2026-07-02", payee: "Grocery store", amount: 84.21 },
    { date: "2026-07-03", payee: "Gas station", amount: 45.00 },
    { date: "2026-07-05", payee: "Electric bill", amount: 120.50 }
  ]);
});

test("parseBankCsvTransactions: recognizes Chase's own 'Posting Date' header text (a real export column name this parser used to miss entirely, returning nothing)", () => {
  const csv = [
    "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
    "DEBIT,06/12/2026,SAMPLE COFFEE SHOP,-4.75,DEBIT_CARD,1200.00,",
    "DEBIT,06/10/2026,SAMPLE GROCERY STORE,-62.10,DEBIT_CARD,1204.75,",
    "CREDIT,06/09/2026,SAMPLE EMPLOYER PAYROLL,1500.00,ACH_CREDIT,1266.85,"
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-06-12", payee: "SAMPLE COFFEE SHOP", amount: 4.75 },
    { date: "2026-06-10", payee: "SAMPLE GROCERY STORE", amount: 62.10 },
    { date: "2026-06-09", payee: "SAMPLE EMPLOYER PAYROLL", amount: -1500, isDeposit: true }
  ]);
});

test("parseBankCsvTransactions: recognizes Discover's own 'Trans. Date'/'Post Date' header text, and a payment/thank-you description overrides a tied purchase-vs-payment volume count", () => {
  const csv = [
    "Trans. Date,Post Date,Description,Amount,Category",
    "06/12/2026,06/13/2026,SAMPLE RESTAURANT,25.40,Restaurants",
    "06/09/2026,06/10/2026,SAMPLE PAYMENT - THANK YOU,-400.00,Payments and Credits"
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-06-12", payee: "SAMPLE RESTAURANT", amount: 25.40 },
    { date: "2026-06-09", payee: "SAMPLE PAYMENT - THANK YOU", amount: -400, isPayment: true }
  ], "with one purchase and one payment (a volume tie), the payment-description signal alone must decide this is credit-card-style - without it, the tie falls back to checking-style and both rows come out with flipped/wrong signs");
});

test("parseBankCsvTransactions: a payment/thank-you description signal fixes an Amex-style export where the tied purchase-vs-payment count would otherwise flip both rows' signs", () => {
  const csv = [
    "Date,Description,Card Member,Account #,Amount",
    "06/12/2026,SAMPLE AIRLINE TICKET,SAMPLE PERSON,-12345,412.00",
    "06/05/2026,SAMPLE PAYMENT RECEIVED - THANK YOU,SAMPLE PERSON,-12345,-412.00"
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-06-12", payee: "SAMPLE AIRLINE TICKET", amount: 412 },
    { date: "2026-06-05", payee: "SAMPLE PAYMENT RECEIVED - THANK YOU", amount: -412, isPayment: true }
  ], "the real charge stays a positive spend and the payment-received row is flagged isPayment - previously (before the payment-description signal) this tied 1-purchase/1-payment file fell back to checking-style and came out completely backwards: the charge as a negative 'deposit' and the payment as a positive spend");
});

test("parseBankCsvTransactions: Wells Fargo's headerless export (\"date\",\"amount\",\"*\",\"\",\"description\" with no header row at all) is recognized structurally", () => {
  const csv = [
    `"06/12/2026","-52.30","*","","SAMPLE PHARMACY PURCHASE"`,
    `"06/10/2026","1500.00","*","","SAMPLE PAYROLL DEPOSIT"`
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), [
    { date: "2026-06-12", payee: "SAMPLE PHARMACY PURCHASE", amount: 52.30 },
    { date: "2026-06-10", payee: "SAMPLE PAYROLL DEPOSIT", amount: -1500, isDeposit: true }
  ]);
});

test("parseBankCsvTransactions: a plain 5-column file that doesn't match Wells Fargo's date/amount-in-column-0/1 shape still returns nothing, rather than the headerless fallback misfiring on an unrelated file", () => {
  const csv = [
    `"not a date","not a number","x","y","z"`,
    `"also not a date","still not a number","a","b","c"`
  ].join("\n");
  assert.deepEqual(parseBankCsvTransactions(csv), []);
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

test("matchAccountByHints tries each hint in order and returns the first that matches any account, skipping empty/unmatched hints along the way", () => {
  const accounts = [{ id: "a1", name: "Adv Plus Banking" }, { id: "a2", name: "Costco Citi" }];
  assert.equal(matchAccountByHints(["Adv Plus Banking - 6769", "Bank of America Online Banking Deposit Print Transaction Details.pdf"], accounts).id, "a1", "the content-extracted account label (a stronger, more specific signal) wins even though it's checked first");
  assert.equal(matchAccountByHints(["", undefined, "Bank of America Online Banking Deposit Print Transaction Details.pdf"], accounts), null, "a generic auto-generated filename with no account-identifying text matches nothing, and empty/missing hints are skipped rather than throwing");
  assert.equal(matchAccountByHints(["no such account anywhere", "Costco Citi Statement.pdf"], accounts).id, "a2", "falls through to a later hint once an earlier one fails to match");
});

test("extractAccountActivityLabel pulls the account name/digits off a checking-activity PDF's own title line, and returns '' for a credit-card statement with no such line", () => {
  assert.equal(extractAccountActivityLabel("Adv Plus Banking - 6769 : Account Activity\nBalance Summary: $1.00"), "Adv Plus Banking - 6769");
  assert.equal(extractAccountActivityLabel("Statement Date: 05/20/26\n\nPURCHASE\n05/20    AMAZON MKTPLACE PMTS Amzn.com/bill WA                  74.40"), "");
  assert.equal(extractAccountActivityLabel(""), "");
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

test("findTransferCandidate matches the opposite-sign entry on a different account within a 2-day tolerance", () => {
  const candidate = { accountId: "checking", amount: 500, date: "2026-07-10" };
  const onCard = { accountId: "card", amount: -500, date: "2026-07-11" };
  assert.deepEqual(findTransferCandidate(candidate, [onCard]), onCard, "opposite sign, different account, within tolerance matches");
  assert.equal(findTransferCandidate(candidate, [{ accountId: "card", amount: -500, date: "2026-07-07" }]), null, "outside the day tolerance does not match");
  assert.equal(findTransferCandidate(candidate, [{ accountId: "checking", amount: -500, date: "2026-07-10" }]), null, "same account never matches, even opposite sign");
  assert.equal(findTransferCandidate(candidate, [{ accountId: "card", amount: 500, date: "2026-07-10" }]), null, "same sign does not match");
  assert.equal(findTransferCandidate({ accountId: "", amount: 500, date: "2026-07-10" }, [onCard]), null, "candidate with no accountId never matches");
  assert.equal(findTransferCandidate(candidate, [{ amount: -500, date: "2026-07-10" }]), null, "other side with no accountId never matches");
});

test("orderRefundMatch pairs a negative-amount refund with a positive-amount purchase sharing the same orderNumber", () => {
  const purchase = { orderNumber: "112-9988", amount: 74.4, date: "2026-06-01", lineId: "line-1" };
  const refund = { orderNumber: "112-9988", amount: -74.4, date: "2026-06-20" };
  assert.deepEqual(orderRefundMatch(refund, [purchase]), purchase);
  assert.equal(orderRefundMatch({ orderNumber: "", amount: -74.4, date: "2026-06-20" }, [purchase]), null, "no orderNumber never matches");
  assert.equal(orderRefundMatch({ orderNumber: "112-9988", amount: 74.4, date: "2026-06-20" }, [purchase]), null, "a positive-amount candidate is not a refund");
  assert.equal(orderRefundMatch(refund, [{ ...purchase, orderNumber: "different" }]), null, "orderNumber must match exactly");
});

test("normalizeForPayeeMatch lowercases and strips punctuation/spaces the same way normalizeForAccountMatch does", () => {
  assert.equal(normalizeForPayeeMatch("TARGET.COM"), "targetcom");
  assert.equal(normalizeForPayeeMatch("Target Store #1147"), "targetstore1147");
  assert.equal(normalizeForPayeeMatch(""), "");
});

test("payeesFuzzyMatch catches both full containment and a shared merchant-name prefix", () => {
  assert.equal(payeesFuzzyMatch("AMAZON.COM*A1B2C3", "AMAZON.COM"), true, "the longer statement line contains the shorter one outright");
  assert.equal(payeesFuzzyMatch("TARGET.COM", "TARGET STORE 1147"), true, "neither contains the other, but they share a 4+ char merchant prefix");
  assert.equal(payeesFuzzyMatch("Costco Whse #442", "Costcutters Store"), true, "a shorter 4-char prefix pair now matches too (would not have at the old 6-char threshold)");
  assert.equal(payeesFuzzyMatch("Walmart", "Walgreens"), false, "a shared prefix under the 4-char threshold is not enough");
  assert.equal(payeesFuzzyMatch("Amazon", ""), false, "an empty side never matches");
});

test("refundFuzzyMatch pairs a same-payee, opposite-amount return with its purchase when there's no orderNumber", () => {
  const purchase = { payee: "TARGET STORE 1147", amount: 42.5, date: "2026-05-01", lineId: "line-shopping" };
  const refund = { payee: "TARGET.COM", amount: -42.5, date: "2026-05-20" };
  assert.deepEqual(refundFuzzyMatch(refund, [purchase]), purchase, "fuzzy payee match (either side containing the other) still pairs them");
  assert.equal(refundFuzzyMatch({ ...refund, amount: -10 }, [purchase]), null, "amount must be the exact opposite");
  assert.equal(refundFuzzyMatch({ ...refund, payee: "Completely Different Store" }, [purchase]), null, "unrelated payee never matches");
  assert.equal(refundFuzzyMatch({ ...refund, date: "2026-04-20" }, [purchase]), null, "a refund dated before its purchase never matches");
  assert.equal(refundFuzzyMatch({ ...refund, date: "2026-11-15" }, [purchase]), null, "beyond the fuzzy match window (180 days) does not match");
  assert.deepEqual(refundFuzzyMatch({ ...refund, date: "2026-10-28" }, [purchase]), purchase, "180 days later is still inside the window");
  assert.equal(refundFuzzyMatch({ ...purchase, amount: 42.5 }, [purchase]), null, "a positive-amount candidate is never treated as a refund");
});

test("refundMatch prefers an exact orderNumber match, falling back to fuzzy matching whenever the order match comes up empty", () => {
  const orderedPurchase = { orderNumber: "A-1", payee: "Amazon", amount: 30, date: "2026-06-01", lineId: "line-a" };
  const fuzzyPurchase = { payee: "COSTCO WHSE #442", amount: 30, date: "2026-06-01", lineId: "line-b" };
  assert.deepEqual(refundMatch({ orderNumber: "A-1", payee: "Amazon", amount: -30, date: "2026-06-10" }, [orderedPurchase, fuzzyPurchase]), orderedPurchase, "orderNumber match wins even when a fuzzy candidate also exists");
  assert.deepEqual(refundMatch({ payee: "COSTCO.COM", amount: -30, date: "2026-06-10" }, [orderedPurchase, fuzzyPurchase]), fuzzyPurchase, "falls back to fuzzy matching when the candidate has no orderNumber");
  assert.deepEqual(refundMatch({ orderNumber: "no-such-order", payee: "COSTCO.COM", amount: -30, date: "2026-06-10" }, [orderedPurchase, fuzzyPurchase]), fuzzyPurchase, "a candidate whose orderNumber doesn't match anything still falls back to fuzzy matching, since the two sides of a real pair don't always carry the same order id");
});

test("suggestSubcategoryFromHistory: the single most recently categorized transaction for a payee wins outright, even against a line with far more historical hits", () => {
  const transactions = [
    { payee: "SAWNEE EMC Bill Payment", amount: 140, date: "2026-01-02", lineId: "utilities" },
    { payee: "SAWNEE EMC Bill Payment", amount: 138, date: "2026-02-02", lineId: "utilities" },
    { payee: "Sawnee EMC Bill Payment", amount: 145, date: "2026-03-02", lineId: "utilities" },
    // The household re-categorized this payee starting in April - fewer
    // total observations on the new line, but it's the more recent choice.
    { payee: "SAWNEE EMC Bill Payment", amount: 150, date: "2026-04-02", lineId: "home-services" },
    { payee: "Some Other Payee", amount: 20, date: "2026-01-01", lineId: "misc" }
  ];
  assert.equal(suggestSubcategoryFromHistory("SAWNEE EMC Bill Payment", transactions), "home-services", "3 historical uses of 'utilities' still lose to a single more-recent use of 'home-services'");
});

test("suggestSubcategoryFromHistory: is exact-match only, deliberately never fuzzy - a near-miss spelling variant and a merely-similar-looking payee both return null rather than guessing", () => {
  const transactions = [
    { payee: "TARGET STORE 1147", amount: 42, date: "2026-01-05", lineId: "shopping" },
    { payee: "TARGET STORE 1147", amount: 18, date: "2026-02-05", lineId: "shopping" }
  ];
  assert.equal(suggestSubcategoryFromHistory("TARGET.COM", transactions), null, "no exact match for 'TARGET.COM' - unlike refundMatch, there's no amount+date to corroborate a fuzzy guess here, so it stays null rather than risking a wrong suggestion");
  assert.equal(suggestSubcategoryFromHistory("A Completely Unrelated Payee", transactions), null);
  assert.equal(suggestSubcategoryFromHistory("", transactions), null, "an empty payee never matches anything");
});

test("suggestSubcategoryFromHistory: a shared generic prefix across unrelated payees ('Zelle payment to X' vs 'Zelle payment from Y') never cross-contaminates a suggestion - regression test for a real production incident where a whole statement import collapsed onto one wrong subcategory", () => {
  const transactions = [
    { payee: "Zelle payment to NUR MOHAMMAD Conf# qznyvr4du", amount: 1100, date: "2026-07-30", lineId: "home-repair" },
    { payee: "Online transfer from CHK 6777 Confirmation# k7ufdtq0i; KRISHNAMURTHY, SUDHARSAN", amount: 1050, date: "2026-01-30", lineId: "cloudcost" }
  ];
  assert.equal(suggestSubcategoryFromHistory("Zelle payment from SARITHA SHEELA for Backpack amount", transactions), null, "shares only the generic 'Zelle payment' prefix with the history entry - must not inherit its lineId");
  assert.equal(suggestSubcategoryFromHistory("Online transfer from CHK 6777 Confirmation# o524gmpag; KRISHNAMURTHY, SUDHARSAN", transactions), null, "a different confirmation number is a different transaction, not the same payee");
});

test("suggestSubcategoryFromHistory: ignores transactions with no lineId yet (unassigned/still-pending history teaches nothing)", () => {
  const transactions = [
    { payee: "Coffee Shop", amount: 5, date: "2026-01-01", lineId: "" },
    { payee: "Coffee Shop", amount: 6, date: "2026-01-08", lineId: undefined }
  ];
  assert.equal(suggestSubcategoryFromHistory("Coffee Shop", transactions), null);
});

test("suggestAccountFromHistory: the single most recently linked account for an exact payee match wins outright, mirroring suggestSubcategoryFromHistory's own tie-break rule", () => {
  const transactions = [
    { payee: "SAWNEE EMC Bill Payment", amount: 140, date: "2026-01-02", accountId: "old-checking" },
    { payee: "SAWNEE EMC Bill Payment", amount: 138, date: "2026-02-02", accountId: "old-checking" },
    // The household switched which account pays this bill starting in
    // March - fewer total observations on the new account, but it's the
    // more recent choice.
    { payee: "SAWNEE EMC Bill Payment", amount: 145, date: "2026-03-02", accountId: "new-checking" }
  ];
  assert.equal(suggestAccountFromHistory("SAWNEE EMC Bill Payment", transactions), "new-checking");
});

test("suggestAccountFromHistory: is exact-match only, deliberately never fuzzy - the same generic-prefix cross-contamination that hit suggestSubcategoryFromHistory must never happen here either", () => {
  const transactions = [
    { payee: "Zelle payment to NUR MOHAMMAD Conf# qznyvr4du", amount: 1100, date: "2026-07-30", accountId: "checking" }
  ];
  assert.equal(suggestAccountFromHistory("Zelle payment from SARITHA SHEELA for Backpack amount", transactions), null, "shares only the generic 'Zelle payment' prefix - must not inherit its accountId");
  assert.equal(suggestAccountFromHistory("A Completely Unrelated Payee", transactions), null);
  assert.equal(suggestAccountFromHistory("", transactions), null, "an empty payee never matches anything");
});

test("suggestAccountFromHistory: ignores transactions with no accountId yet (never-linked history teaches nothing)", () => {
  const transactions = [
    { payee: "Coffee Shop", amount: 5, date: "2026-01-01", accountId: "" },
    { payee: "Coffee Shop", amount: 6, date: "2026-01-08", accountId: undefined }
  ];
  assert.equal(suggestAccountFromHistory("Coffee Shop", transactions), null);
});

test("parseCreditCardStatementText: purchases stay positive, refunds go negative, and Order Number lines attach to the row above them", () => {
  const text = `
Statement Date: 05/20/26

PAYMENTS AND OTHER CREDITS
05/17    AUTOMATIC PAYMENT - THANK YOU                          -551.36
05/20    AMAZON MKTPLACE PMTS Amzn.com/bill WA                  -74.40
         Order Number   111-7373945-8473814
05/20    AMAZON MKTPLACE PMTS Amzn.com/bill WA                  -6.40
         Order Number   113-6200057-6118623

PURCHASE
04/29    AMAZON MKTPL*BJ4UW0ZI1 Amzn.com/bill WA                 6.40
         Order Number   113-6200057-6118623
04/30    AMAZON MKTPL*BS3VY1QQ0 Amzn.com/bill WA               151.92
         Order Number   111-7373945-8473814
`;
  const rows = parseCreditCardStatementText(text);
  assert.deepEqual(rows, [
    { date: "2026-05-17", payee: "AUTOMATIC PAYMENT - THANK YOU", amount: -551.36, orderNumber: "", isPayment: true },
    { date: "2026-05-20", payee: "AMAZON MKTPLACE PMTS Amzn.com/bill WA", amount: -74.40, orderNumber: "111-7373945-8473814" },
    { date: "2026-05-20", payee: "AMAZON MKTPLACE PMTS Amzn.com/bill WA", amount: -6.40, orderNumber: "113-6200057-6118623" },
    { date: "2026-04-29", payee: "AMAZON MKTPL*BJ4UW0ZI1 Amzn.com/bill WA", amount: 6.40, orderNumber: "113-6200057-6118623" },
    { date: "2026-04-30", payee: "AMAZON MKTPL*BS3VY1QQ0 Amzn.com/bill WA", amount: 151.92, orderNumber: "111-7373945-8473814" }
  ], "AUTOMATIC PAYMENT is flagged isPayment rather than dropped; the full refund and the partial refund each keep their own signed amount and matching order number");
});

test("parseCreditCardStatementText: flags payoff/payment lines (even without an Order Number) instead of dropping them", () => {
  const text = `
Statement Date: 05/20/26

PAYMENTS AND OTHER CREDITS
05/17    AUTOMATIC PAYMENT - THANK YOU                          -551.36
04/02    ONLINE PAYMENT, THANK YOU                              -200.00

PURCHASE
04/21    Amazon.com*BJ9U93OB2 Amzn.com/bill WA                  26.28
         Order Number   111-6080014-1493051
`;
  const rows = parseCreditCardStatementText(text);
  assert.deepEqual(rows, [
    { date: "2026-05-17", payee: "AUTOMATIC PAYMENT - THANK YOU", amount: -551.36, orderNumber: "", isPayment: true },
    { date: "2026-04-02", payee: "ONLINE PAYMENT, THANK YOU", amount: -200.00, orderNumber: "", isPayment: true },
    { date: "2026-04-21", payee: "Amazon.com*BJ9U93OB2 Amzn.com/bill WA", amount: 26.28, orderNumber: "111-6080014-1493051" }
  ]);
});

test("parseCreditCardStatementText: a December transaction on a January statement rolls back to the prior year", () => {
  const text = `
Statement Date: 01/15/27

PURCHASE
12/28    Amazon.com*ABC123 Amzn.com/bill WA                     15.00
`;
  const rows = parseCreditCardStatementText(text);
  assert.equal(rows[0].date, "2026-12-28");
});

test("parseCreditCardStatementText: returns an empty array for text with no matching transaction lines", () => {
  assert.deepEqual(parseCreditCardStatementText("Not a statement at all"), []);
  assert.deepEqual(parseCreditCardStatementText(""), []);
});

// Modeled on a checking/deposit account's "Account Activity" print export
// (e.g. Bank of America's Online Banking > Deposit > Print Transaction
// Details) - every page repeats the column header and a footer/URL/page-
// number line, a long description wraps onto its own line before the Type/
// Amount columns catch up to it, and a not-yet-posted item shows the literal
// word "Processing" instead of a date. Whitespace here deliberately mirrors
// pdf-parse's REAL output on an actual exported PDF of this format (verified
// directly, not just how a PDF viewer renders it) - adjacent table cells on
// the same source line are glued with NO separator at all
// ("ProcessingPAYMENT TO...Debit-$40.00$500.00"); only where the original
// layout happened to wrap onto a new line does a real separator exist there,
// which parseCheckingAccountActivityText re-inserts as a single space when
// it joins lines back together. All names/numbers below are made up.
const CHECKING_ACTIVITY_SAMPLE_TEXT = `
Adv Plus Banking - 1234 : Account Activity
Balance Summary: $500.00 (available balance as of today 06/15/2026)
View: today: 06/15/2026

Transactions

Posting dateDescriptionTypeAmountAvailable balance

ProcessingPAYMENT TO ACCT #9999 ON 06/15 VIA WEBDebit-$40.00$500.00

ProcessingZelle Transfer CONF# AB12CD34; JANE SAMPLE
DOE
Debit-$75.00$540.00

06/12/2026Zelle payment from JOHN EXAMPLE for "Shared grocery
run"; Conf# xy98zw76
Transfer$22.50$615.00

06/10/2026ACME CORP DES:PAYROLL ID:XXXXX0001 INDN:SAMPLE
EMPLOYEE...
Deposit$1,200.00$592.50

Statement as of 06/09/2026

06/08/2026GENERIC UTILITY CO DES:BILL PAY ID:XXXXX1234
INDN:SAMPLE PERSON...
Other
Payment
-$88.20$607.50

06/05/2026SAMPLE ATM 06/05 #XXXXX0000 WITHDRWL MAIN ST ANYTOWN STWithdrawal-$100.00$519.30

6/15/26, 9:00 AMBank of America | Online Banking | Deposit | Print Transaction Details
https://secure.bankofamerica.com/deposit-details/print/?adx=deadbeef1/2
`;

test("parseCheckingAccountActivityText: extracts a full 'Account Activity' print export, flipping to this app's spend-positive sign convention", () => {
  const rows = parseCheckingAccountActivityText(CHECKING_ACTIVITY_SAMPLE_TEXT, "2026-06-15");
  assert.deepEqual(rows, [
    { date: "2026-06-15", payee: "PAYMENT TO ACCT #9999 ON 06/15 VIA WEB", amount: 40.00, isPending: true },
    { date: "2026-06-15", payee: "Zelle Transfer CONF# AB12CD34; JANE SAMPLE DOE", amount: 75.00, isPending: true },
    { date: "2026-06-12", payee: `Zelle payment from JOHN EXAMPLE for "Shared grocery run"; Conf# xy98zw76`, amount: -22.50, isDeposit: true },
    { date: "2026-06-10", payee: "ACME CORP DES:PAYROLL ID:XXXXX0001 INDN:SAMPLE EMPLOYEE...", amount: -1200.00, isDeposit: true },
    { date: "2026-06-08", payee: "GENERIC UTILITY CO DES:BILL PAY ID:XXXXX1234 INDN:SAMPLE PERSON...", amount: 88.20 },
    { date: "2026-06-05", payee: "SAMPLE ATM 06/05 #XXXXX0000 WITHDRWL MAIN ST ANYTOWN ST", amount: 100.00 }
  ], "Processing rows are dated with the supplied today-date and flagged isPending; a money-in row (positive in the printed table) flips to negative and gets isDeposit; the header, boilerplate, 'Statement as of', and footer/URL lines are all ignored rather than corrupting a description - all despite zero whitespace between most adjacent table cells");
});

test("parseCheckingAccountActivityText: defaults 'today' to the real current date when none is supplied", () => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = parseCheckingAccountActivityText("Posting dateDescriptionTypeAmountAvailable balance\nProcessingSAMPLE PENDING CHARGEDebit-$5.00$100.00\n");
  assert.deepEqual(rows, [{ date: today, payee: "SAMPLE PENDING CHARGE", amount: 5.00, isPending: true }]);
});

test("parseCheckingAccountActivityText: returns an empty array for text with no matching rows", () => {
  assert.deepEqual(parseCheckingAccountActivityText("Not a statement at all"), []);
  assert.deepEqual(parseCheckingAccountActivityText(""), []);
});

test("parseBankStatementPdfText: auto-detects a checking 'Account Activity' export vs. a credit-card statement from the text alone", () => {
  const checkingRows = parseBankStatementPdfText(CHECKING_ACTIVITY_SAMPLE_TEXT);
  assert.equal(checkingRows.length, 6, "the checking-format header signature routes to parseCheckingAccountActivityText");

  const creditCardText = `
Statement Date: 05/20/26

PURCHASE
05/20    AMAZON MKTPLACE PMTS Amzn.com/bill WA                  74.40
`;
  const creditCardRows = parseBankStatementPdfText(creditCardText);
  assert.deepEqual(creditCardRows, [{ date: "2026-05-20", payee: "AMAZON MKTPLACE PMTS Amzn.com/bill WA", amount: 74.40, orderNumber: "" }], "text without the checking header signature falls back to parseCreditCardStatementText");
});

test("normalizeTag trims and lowercases so casing/whitespace differences match", () => {
  assert.equal(normalizeTag("  Florida Trip "), "florida trip");
  assert.equal(normalizeTag("florida trip"), "florida trip");
  assert.equal(normalizeTag(""), "");
});

test("groupTransactionsByTag groups across categories/months and merges case/whitespace variants into one group", () => {
  const transactions = [
    { payee: "Publix", amount: 62.5, tags: ["Florida trip"] },
    { payee: "Universal tickets", amount: 220, tags: ["florida trip"] },
    { payee: "Shell gas", amount: 40, tags: [" Florida Trip "] },
    { payee: "Electric bill", amount: 90, tags: ["Utilities"] },
    { payee: "Untagged", amount: 15, tags: [] }
  ];
  const groups = groupTransactionsByTag(transactions);
  assert.equal(groups.length, 2);
  const trip = groups.find((g) => g.key === "florida trip");
  assert.equal(trip.label, "Florida trip", "keeps the first-seen casing as the display label");
  assert.equal(trip.total, 322.5);
  assert.equal(trip.transactions.length, 3);
  const utilities = groups.find((g) => g.key === "utilities");
  assert.equal(utilities.total, 90);
});

test("groupTransactionsByTag counts a multi-tagged transaction toward every one of its groups", () => {
  const transactions = [{ payee: "Grocery run", amount: 50, tags: ["Florida trip", "Groceries"] }];
  const groups = groupTransactionsByTag(transactions);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.total === 50));
});

test("groupTransactionsByTag returns an empty array when nothing is tagged", () => {
  assert.deepEqual(groupTransactionsByTag([{ payee: "x", amount: 1, tags: [] }, { payee: "y", amount: 2 }]), []);
  assert.deepEqual(groupTransactionsByTag([]), []);
});

test("monthKeysInRange returns a single key when start and end fall in the same month", () => {
  assert.deepEqual(monthKeysInRange("2026-03-05", "2026-03-28"), ["2026-03"]);
});

test("monthKeysInRange lists every month touched by a multi-month range, inclusive", () => {
  assert.deepEqual(monthKeysInRange("2026-03-20", "2026-06-02"), ["2026-03", "2026-04", "2026-05", "2026-06"]);
});

test("monthKeysInRange spans a full year and correctly rolls over into the next year", () => {
  assert.deepEqual(monthKeysInRange("2026-01-01", "2026-12-31"), [
    "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
    "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"
  ]);
  assert.deepEqual(monthKeysInRange("2025-11-01", "2026-02-28"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});

test("monthKeysInRange returns an empty array for a missing or backwards range", () => {
  assert.deepEqual(monthKeysInRange("", "2026-03-01"), []);
  assert.deepEqual(monthKeysInRange("2026-03-01", ""), []);
  assert.deepEqual(monthKeysInRange("2026-06-01", "2026-01-01"), []);
});

test("spentByLineInMonth sums only the given line's transactions dated within the given month", () => {
  const transactions = [
    { lineId: "groceries", date: "2026-03-05", amount: 40 },
    { lineId: "groceries", date: "2026-03-20", amount: 25 },
    { lineId: "groceries", date: "2026-04-01", amount: 99 },
    { lineId: "gas", date: "2026-03-10", amount: 60 }
  ];
  assert.equal(spentByLineInMonth(transactions, "groceries", "2026-03"), 65);
  assert.equal(spentByLineInMonth(transactions, "groceries", "2026-04"), 99);
  assert.equal(spentByLineInMonth(transactions, "gas", "2026-03"), 60);
  assert.equal(spentByLineInMonth(transactions, "groceries", "2026-05"), 0);
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

test("nextPendingChoreOccurrence never returns a date off the recurrence grid, even with a stale completedBy entry", () => {
  const chore = { startDate: "2026-07-19", recurrence: "weekly", completedBy: {} };
  assert.equal(nextPendingChoreOccurrence(chore).date, "2026-07-19");
  chore.completedBy = { "2026-07-19": ["household"] };
  assert.equal(nextPendingChoreOccurrence(chore).date, "2026-07-26", "the next Sunday, never a Monday");
});

test("nextPendingChoreOccurrence advances by the right number of months for every3months/every4months/every6months/yearly", () => {
  const quarterly = { startDate: "2026-01-15", recurrence: "every3months", completedBy: { "2026-01-15": ["household"], "2026-04-15": ["household"] } };
  assert.equal(nextPendingChoreOccurrence(quarterly).date, "2026-07-15");

  const every4 = { startDate: "2026-01-31", recurrence: "every4months", completedBy: { "2026-01-31": ["household"] } };
  assert.equal(nextPendingChoreOccurrence(every4).date, "2026-05-31");

  const semiannual = { startDate: "2026-01-15", recurrence: "every6months", completedBy: {} };
  assert.equal(nextPendingChoreOccurrence(semiannual).date, "2026-01-15");

  const yearly = { startDate: "2026-02-28", recurrence: "yearly", completedBy: { "2026-02-28": ["household"] } };
  assert.equal(nextPendingChoreOccurrence(yearly).date, "2027-02-28");
});

test("choreNotifyAt re-derives from scratch instead of drifting when the stored anchor no longer matches the current recurrence grid", () => {
  const chore = {
    startDate: "2026-07-19",
    recurrence: "weekly",
    time: "13:50",
    completedBy: {},
    // Simulates a chore whose startDate/recurrence was edited after
    // notifyAt was last set - the old anchor (a Monday) is stale and no
    // longer a real point on the new Sunday-anchored grid.
    notifyAt: "2026-07-13T17:50:00.000Z",
    notifyAtDateKey: "2026-07-13",
    notifyAtSourceTime: "13:50"
  };
  // Referenced "today" sits between the 07-19 and 07-26 occurrences, so
  // 07-19 is the current one regardless of completedBy.
  const result = choreNotifyAt(chore, new Date("2026-07-21T12:00:00.000Z"));
  assert.equal(chore.notifyAtDateKey, "2026-07-19", "re-derives against the current grid instead of shifting the stale anchor");
  assert.equal(result.slice(0, 10), "2026-07-19");
});

test("choreNotifyAt still uses the cheap day-shift path when the anchor is still on the current grid", () => {
  const chore = {
    startDate: "2026-07-19",
    recurrence: "weekly",
    time: "13:50",
    completedBy: {},
    notifyAt: "2026-07-19T17:50:00.000Z",
    notifyAtDateKey: "2026-07-19",
    notifyAtSourceTime: "13:50"
  };
  // Referenced "today" has moved past the 07-26 occurrence, so that's now
  // current - purely from elapsed time, with nothing ever marked done.
  const result = choreNotifyAt(chore, new Date("2026-07-27T12:00:00.000Z"));
  assert.equal(chore.notifyAtDateKey, "2026-07-26");
  assert.equal(result.slice(0, 10), "2026-07-26");
  assert.equal(new Date(result).getUTCHours(), 17, "the original time-of-day is preserved by the shift, not re-derived");
});

test("zonedTimeToUtcIso anchors a wall-clock time to the household's real timezone, not the server process's own", () => {
  // 1:50 PM Eastern in July is EDT (UTC-4), so it must land on 17:50 UTC -
  // a naive `new Date(...).setHours(13, 50)` on a UTC server would instead
  // produce 13:50 UTC, 4 hours early.
  assert.equal(zonedTimeToUtcIso("2026-07-26", 13, 50, "America/New_York"), "2026-07-26T17:50:00.000Z");
  // January is EST (UTC-5) - confirms this isn't a hardcoded offset.
  assert.equal(zonedTimeToUtcIso("2026-01-26", 13, 50, "America/New_York"), "2026-01-26T18:50:00.000Z");
  // No timeZone given falls back to treating the wall-clock as UTC already.
  assert.equal(zonedTimeToUtcIso("2026-07-26", 13, 50, ""), "2026-07-26T13:50:00.000Z");
});

test("choreNotifyAt's from-scratch recompute uses the household's timeZone, not the server process's own", () => {
  const chore = { startDate: "2026-07-19", recurrence: "weekly", time: "13:50", completedBy: {} };
  // No stored notifyAt/notifyAtDateKey yet, so this always takes the
  // from-scratch path - exactly what a server-side worker tick does for a
  // chore no client has ever rendered/saved.
  const result = choreNotifyAt(chore, new Date("2026-07-21T12:00:00.000Z"), "America/New_York");
  assert.equal(result, "2026-07-19T17:50:00.000Z", "1:50 PM Eastern in July (EDT) is 17:50 UTC, not 13:50 UTC");
});

test("currentChoreOccurrenceDate never depends on completedBy - it tracks elapsed time only", () => {
  const chore = { startDate: "2026-07-19", recurrence: "weekly", completedBy: {} };
  const reference = new Date("2026-07-27T00:00:00.000Z");
  const untouched = currentChoreOccurrenceDate(chore, reference).date;
  chore.completedBy = { "2026-07-19": ["household"], "2026-07-26": ["household"] };
  const afterMarkingDone = currentChoreOccurrenceDate(chore, reference).date;
  assert.equal(untouched, "2026-07-26");
  assert.equal(afterMarkingDone, "2026-07-26", "marking prior occurrences done doesn't change which occurrence is current");
});

test("choreNotifyAt advances through real elapsed time even when no occurrence is ever marked done - no backlog to release as a burst", () => {
  const chore = { startDate: "2026-07-19", recurrence: "weekly", time: "09:00", completedBy: {} };
  const weekOne = choreNotifyAt(chore, new Date("2026-07-20T00:00:00.000Z"));
  assert.equal(weekOne.slice(0, 10), "2026-07-19");
  const weekThree = choreNotifyAt(chore, new Date("2026-08-03T00:00:00.000Z"));
  assert.equal(weekThree.slice(0, 10), "2026-08-02", "keeps tracking the current occurrence instead of staying pinned to the first one nobody completed");
});

test("monthEndDateKey returns the real last day of the month, including February in a leap year", () => {
  assert.equal(monthEndDateKey("2026-04"), "2026-04-30");
  assert.equal(monthEndDateKey("2026-02"), "2026-02-28", "2026 is not a leap year");
  assert.equal(monthEndDateKey("2028-02"), "2028-02-29", "2028 is a leap year");
});

test("assetValue computes a stock holding from shares * price, or reads .value directly otherwise, clamping negatives to 0", () => {
  assert.equal(assetValue({ assetClass: "stock", shares: 10, price: 25.5 }), 255);
  assert.equal(assetValue({ value: 400 }), 400);
  assert.equal(assetValue({ value: -50 }), 0, "a negative plain value clamps to 0, not a negative asset");
  assert.equal(assetValue({ assetClass: "stock", shares: -5, price: 10 }), 0, "negative shares clamp to 0 before multiplying");
});

test("computeTrailingMonthKeys lists the N months ending at the given month, inclusive, rolling back across a year boundary", () => {
  assert.deepEqual(computeTrailingMonthKeys("2026-03", 3), ["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(computeTrailingMonthKeys("2026-02", 4), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});

test("computeReportCategoriesForScope sums spend per category/subcategory across every month in scope, falling back to a trailing 6 months when the scope is empty", () => {
  const state = {
    budget: {
      month: "2026-06",
      categories: [
        { name: "Food", color: "#111", lines: [{ id: "groceries", name: "Groceries", planned: 0 }, { id: "dining", name: "Dining", planned: 0 }] },
        { name: "Empty Category", color: "#222", lines: [{ id: "unused", name: "Unused", planned: 0 }] }
      ]
    },
    transactions: [
      { lineId: "groceries", amount: 100, date: "2026-05-15" },
      { lineId: "groceries", amount: 50, date: "2026-06-10" },
      { lineId: "dining", amount: 30, date: "2026-06-12" }
    ]
  };
  const result = computeReportCategoriesForScope(state, ["2026-05", "2026-06"]);
  const food = result.find((category) => category.name === "Food");
  assert.equal(food.value, 180, "sums across both months in scope");
  assert.deepEqual(food.lines.map((line) => line.name), ["Groceries", "Dining"]);
  const empty = result.find((category) => category.name === "Empty Category");
  assert.equal(empty.lines.length, 0, "a zero-spend subcategory is left out as noise");
  const fallback = computeReportCategoriesForScope(state, []);
  assert.ok(fallback.find((category) => category.name === "Food").value >= 180, "an empty scope falls back to the trailing 6 months, which still covers May+June");
});

test("computeNetWorthAtDate sums unlinked assets/liabilities directly and linked ones via accountBalance instead of their own stored value", () => {
  const state = {
    accounts: [{ id: "savings", type: "checking", openingBalance: 5000, netWorthAssetId: "investments" }],
    transactions: [],
    paychecks: [],
    paycheckOccurrences: [],
    transfers: [],
    ious: [],
    goals: {
      netWorth: {
        // "investments" is linked to the savings account, so its own .value
        // (999999) must be ignored in favor of the account's real balance.
        assets: [{ id: "house", value: 300000 }, { id: "investments", value: 999999 }],
        liabilities: [{ id: "car-loan", value: 20000 }]
      }
    }
  };
  assert.equal(computeNetWorthAtDate(state, "2026-06-30"), 300000 + 5000 - 20000);
});

test("computeNetWorthTrend maps each month key to its net worth at that month's end date", () => {
  const state = {
    accounts: [],
    transactions: [],
    paychecks: [],
    paycheckOccurrences: [],
    transfers: [],
    ious: [],
    goals: { netWorth: { assets: [{ id: "cash", value: 5000 }], liabilities: [] } }
  };
  const trend = computeNetWorthTrend(state, ["2026-01", "2026-02"]);
  assert.deepEqual(trend, [{ month: "2026-01", value: 5000 }, { month: "2026-02", value: 5000 }]);
});

test("computeCashFlowByMonth sums expenses and both one-time and recurring-occurrence income within each month", () => {
  const state = {
    transactions: [{ date: "2026-06-05", amount: 200 }, { date: "2026-06-20", amount: -40 }],
    paychecks: [{ amount: 1000, recurrence: "once", date: "2026-06-10" }],
    paycheckOccurrences: [{ date: "2026-06-15", amount: 2500 }]
  };
  const [june] = computeCashFlowByMonth(state, ["2026-06"]);
  assert.equal(june.expenses, 160);
  assert.equal(june.income, 3500, "one-time paycheck (1000) + recurring occurrence (2500)");
});

test("sankeyFlowSegments sorts categories by value descending, drops zero-spend categories, and appends Savings only when income exceeds expenses", () => {
  const categories = [
    { name: "Rent", color: "#a", value: 1500, lines: [{ id: "rent" }] },
    { name: "Groceries", color: "#b", value: 3000, lines: [{ id: "groceries" }] },
    { name: "Unused", color: "#c", value: 0, lines: [] }
  ];
  const withSavings = sankeyFlowSegments(categories, 6000, 4500);
  assert.deepEqual(withSavings.map((segment) => segment.label), ["Groceries", "Rent", "Savings"], "largest category first, Savings last");
  assert.equal(withSavings.find((segment) => segment.label === "Savings").value, 1500);
  const noSavings = sankeyFlowSegments(categories, 4000, 4500);
  assert.equal(noSavings.find((segment) => segment.label === "Savings"), undefined, "no Savings segment once spend meets or exceeds income");
});
