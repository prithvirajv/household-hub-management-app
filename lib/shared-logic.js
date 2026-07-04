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

if (typeof module !== "undefined" && module.exports) {
  module.exports = { applyChecklistToggle, mealWeeksForMonth };
}
