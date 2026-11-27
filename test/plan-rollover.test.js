const test = require("node:test");
const assert = require("node:assert/strict");
const { planShiftDateKey, unfinishedEarlierTasks, rollTasksToDate, undoRollTasks, planDaySuggestions } = require("../lib/shared-logic");

const task = (id, anchorDate, extra = {}) => ({ id, title: id, bucket: "daily", anchorDate, recurrence: "none", completedDates: [], ...extra });
const TODAY = "2026-11-27";

test("date keys shift across month and year ends", () => {
  assert.equal(planShiftDateKey("2026-11-27", -1), "2026-11-26");
  assert.equal(planShiftDateKey("2026-03-01", -1), "2026-02-28");
  assert.equal(planShiftDateKey("2026-01-01", -1), "2025-12-31");
  assert.equal(planShiftDateKey("2026-12-31", 1), "2027-01-01");
});

test("unfinished earlier tasks: one-time, undone, within two weeks, before today - nothing else", () => {
  const tasks = [
    task("old-undone", "2026-11-20"),
    task("yesterday-undone", "2026-11-26"),
    task("done-on-its-day", "2026-11-25", { completedDates: ["2026-11-25"] }),
    task("today", TODAY),
    task("future", "2026-11-30"),
    task("too-old", "2026-11-01"),
    task("repeats", "2026-11-10", { recurrence: "daily" }),
    { ...task("legacy-weekly", "2026-11-20"), bucket: "weekly" }
  ];
  assert.deepEqual(unfinishedEarlierTasks(tasks, TODAY).map((item) => item.id), ["old-undone", "yesterday-undone"]);
  assert.deepEqual(unfinishedEarlierTasks([], TODAY), []);
  assert.deepEqual(unfinishedEarlierTasks(undefined, TODAY), []);
});

test("rolling moves tasks to today keeping their time, and Undo puts each back on its own day", () => {
  const tasks = [task("a", "2026-11-20", { startTime: "09:30" }), task("b", "2026-11-26"), task("c", "2026-11-25")];
  const moved = rollTasksToDate(tasks, ["a", "b"], TODAY);
  assert.deepEqual(moved, ["a", "b"]);
  assert.equal(tasks[0].anchorDate, TODAY);
  assert.equal(tasks[0].startTime, "09:30");
  assert.equal(tasks[2].anchorDate, "2026-11-25", "an unlisted task stays");
  undoRollTasks(tasks, moved);
  assert.deepEqual(tasks.map((item) => item.anchorDate), ["2026-11-20", "2026-11-26", "2026-11-25"]);
  assert.ok(!("rolledFrom" in tasks[0]), "the mark is removed");
});

test("first-use suggestions: yesterday's one-time tasks and the newest note with open items", () => {
  const tasks = [task("y1", "2026-11-26", { startTime: "08:00", durationMinutes: 45 }), task("y2", "2026-11-26", { recurrence: "weekly" }), task("older", "2026-11-20")];
  const notes = [
    { id: "n0", title: "Done list", checklist: [{ text: "x", done: true }] },
    { id: "n1", title: "Weekend", checklist: [{ text: " Garage ", done: false }, { text: "Dinner", done: false }, { text: "Milk", done: true }] },
    { id: "n2", title: "Archived", archived: true, checklist: [{ text: "z", done: false }] }
  ];
  const result = planDaySuggestions({ tasks, notes, todayKey: TODAY });
  assert.deepEqual(result.yesterday, [{ title: "y1", startTime: "08:00", durationMinutes: 45 }]);
  assert.deepEqual(result.note, { id: "n1", title: "Weekend", items: ["Garage", "Dinner"] });
  assert.deepEqual(planDaySuggestions({ tasks: [], notes: [], todayKey: TODAY }), { yesterday: [], note: null });
});
