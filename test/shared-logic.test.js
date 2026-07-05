const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyChecklistToggle, bucketChecklistItems, findChecklistDuplicate, mealWeeksForMonth, groupPlanTasksByBucket, validateJournalPayload,
  dailyTaskOccursOnDate, isDailyTaskDoneOnDate, toggleDailyTaskDoneOnDate,
  timeToMinutes, minutesToTime, snapMinutes,
  sanitizeFilename, buildDocumentObjectPath, wouldCreateFolderCycle, buildFolderTree
} = require("../lib/shared-logic");

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
