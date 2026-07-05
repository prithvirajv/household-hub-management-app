const assert = require("node:assert/strict");
const test = require("node:test");
const { applyChecklistToggle, mealWeeksForMonth, groupPlanTasksByBucket, validateJournalPayload } = require("../lib/shared-logic");

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
