function applyChecklistToggle(checklist, itemId, done) {
  const next = checklist.map((item) => (item.id === itemId ? { ...item, done } : { ...item }));
  const target = next.find((item) => item.id === itemId);
  if (!target) return next;
  const children = next.filter((item) => item.parentId === itemId);
  children.forEach((child) => { child.done = done; });
  if (target.parentId) {
    const parent = next.find((item) => item.id === target.parentId);
    if (parent) {
      const siblings = next.filter((item) => item.parentId === target.parentId);
      parent.done = siblings.length > 0 && siblings.every((item) => item.done);
    }
  }
  return next;
}

function mealWeeksForMonth(monthValue) {
  const [year, month] = monthValue.split("-").map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const firstMonday = new Date(firstDay);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  firstMonday.setDate(firstDay.getDate() - mondayOffset);
  const weeks = [];
  for (let cursor = new Date(firstMonday), number = 1; cursor <= lastDay; number += 1, cursor.setDate(cursor.getDate() + 7)) {
    const end = new Date(cursor);
    end.setDate(end.getDate() + 6);
    const visibleStart = cursor < firstDay ? firstDay : cursor;
    const visibleEnd = end > lastDay ? lastDay : end;
    const startLabel = visibleStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const endLabel = visibleEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    weeks.push({ number, label: `${startLabel}–${endLabel}`, start: new Date(cursor) });
  }
  return weeks;
}

function groupPlanTasksByBucket(tasks) {
  return {
    daily: tasks.filter((task) => task.bucket === "daily"),
    weekly: tasks.filter((task) => task.bucket === "weekly"),
    monthly: tasks.filter((task) => task.bucket === "monthly")
  };
}

function validateJournalPayload(body, maxPhotosPerEntry = 8) {
  if (!body || !Array.isArray(body.entries)) return "Invalid journal payload";
  for (const entry of body.entries) {
    if (Array.isArray(entry.photos) && entry.photos.length > maxPhotosPerEntry) {
      return "Each journal entry supports at most 8 photos";
    }
  }
  return null;
}

const WEEKDAY_INDEXES = [1, 2, 3, 4, 5];

function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dailyTaskOccursOnDate(task, dateKey) {
  if (!task.anchorDate || dateKey < task.anchorDate) return false;
  const recurrence = task.recurrence || "none";
  if (recurrence === "none") return dateKey === task.anchorDate;
  const anchor = parseDateKey(task.anchorDate);
  const target = parseDateKey(dateKey);
  if (recurrence === "daily") return true;
  if (recurrence === "weekdays") return WEEKDAY_INDEXES.includes(target.getDay());
  if (recurrence === "weekly") return anchor.getDay() === target.getDay();
  if (recurrence === "monthly") return anchor.getDate() === target.getDate();
  return dateKey === task.anchorDate;
}

function isDailyTaskDoneOnDate(task, dateKey) {
  return (task.completedDates || []).includes(dateKey);
}

function toggleDailyTaskDoneOnDate(task, dateKey) {
  const completedDates = task.completedDates || [];
  const isDone = completedDates.includes(dateKey);
  return {
    ...task,
    completedDates: isDone ? completedDates.filter((date) => date !== dateKey) : [...completedDates, dateKey]
  };
}

function timeToMinutes(time) {
  if (!time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(totalMinutes) {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(totalMinutes)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function snapMinutes(value, step = 15) {
  return Math.round(value / step) * step;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    applyChecklistToggle, mealWeeksForMonth, groupPlanTasksByBucket, validateJournalPayload,
    dailyTaskOccursOnDate, isDailyTaskDoneOnDate, toggleDailyTaskDoneOnDate,
    timeToMinutes, minutesToTime, snapMinutes
  };
}
