const SMS_CARRIERS = [
  { value: "att", label: "AT&T", gateway: "txt.att.net" },
  { value: "verizon", label: "Verizon", gateway: "vtext.com" },
  { value: "tmobile", label: "T-Mobile", gateway: "tmomail.net" },
  { value: "sprint", label: "Sprint", gateway: "messaging.sprintpcs.com" },
  { value: "boost", label: "Boost Mobile", gateway: "myboostmobile.com" },
  { value: "cricket", label: "Cricket Wireless", gateway: "sms.cricketwireless.net" },
  { value: "uscellular", label: "US Cellular", gateway: "email.uscc.net" },
  { value: "googlefi", label: "Google Fi", gateway: "msg.fi.google.com" },
  { value: "metropcs", label: "Metro by T-Mobile", gateway: "mymetropcs.com" },
  { value: "virginmobile", label: "Virgin Mobile", gateway: "vmobl.com" },
  { value: "xfinitymobile", label: "Xfinity Mobile", gateway: "vtext.com" }
];

function smsGatewayAddress(phone, carrier) {
  const digits = String(phone || "").replace(/\D/g, "");
  const entry = SMS_CARRIERS.find((item) => item.value === carrier);
  if (!digits || !entry) return null;
  return `${digits}@${entry.gateway}`;
}

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

function bucketChecklistItems(checklist) {
  const byId = new Map(checklist.map((item) => [item.id, item]));
  const isCompleted = (item) => {
    if (!item.parentId) return Boolean(item.done);
    // A sub-item's own checkbox can be ticked before its siblings, but it
    // should stay visible next to its parent until the whole group is done
    // (i.e. until the parent itself auto-completes) so checking off one
    // task doesn't strand it out of context in the flat completed section.
    const parent = byId.get(item.parentId);
    return Boolean(parent?.done);
  };
  return {
    open: checklist.filter((item) => !isCompleted(item)),
    completed: checklist.filter((item) => isCompleted(item))
  };
}

function findChecklistDuplicate(checklist, text, parentId = "") {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return null;
  const scopeParentId = parentId || "";
  return checklist.find((item) => (item.parentId || "") === scopeParentId && String(item.text || "").trim().toLowerCase() === normalized) || null;
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

// Compares a task's planned schedule against what was actually logged for one
// occurrence, so the Daily Plan can show how far off the estimate was. Deltas
// are signed minute counts (positive = started later / ran longer than
// planned); either delta is null when there isn't enough data to compute it.
function comparePlannedToActual({ plannedStartTime, plannedDurationMinutes, actualStartTime, actualEndTime }) {
  const plannedStart = timeToMinutes(plannedStartTime);
  const actualStart = timeToMinutes(actualStartTime);
  const actualEnd = timeToMinutes(actualEndTime);
  const startDeltaMinutes = plannedStart != null && actualStart != null ? actualStart - plannedStart : null;
  const durationDeltaMinutes = actualStart != null && actualEnd != null && plannedDurationMinutes != null
    ? (actualEnd - actualStart) - plannedDurationMinutes
    : null;
  return { startDeltaMinutes, durationDeltaMinutes };
}

// Positions overlapping timeline blocks side-by-side instead of stacked on
// top of each other (where the last-rendered block would fully hide the
// others). Items in the same connected cluster of overlapping times share
// the same column count, so each gets an equal fractional width; items
// that don't overlap anything keep full width (column 0 of 1).
function layoutTimelineBlocks(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters = [];
  let currentCluster = [];
  let currentClusterEnd = -Infinity;
  for (const item of sorted) {
    if (currentCluster.length === 0 || item.start < currentClusterEnd) {
      currentCluster.push(item);
      currentClusterEnd = Math.max(currentClusterEnd, item.end);
    } else {
      clusters.push(currentCluster);
      currentCluster = [item];
      currentClusterEnd = item.end;
    }
  }
  if (currentCluster.length) clusters.push(currentCluster);

  const layout = new Map();
  clusters.forEach((cluster) => {
    const columnEnds = [];
    cluster.forEach((item) => {
      let columnIndex = columnEnds.findIndex((end) => end <= item.start);
      if (columnIndex === -1) {
        columnIndex = columnEnds.length;
        columnEnds.push(item.end);
      } else {
        columnEnds[columnIndex] = item.end;
      }
      layout.set(item.id, { column: columnIndex });
    });
    const columns = columnEnds.length;
    cluster.forEach((item) => { layout.get(item.id).columns = columns; });
  });

  return items.map((item) => ({ id: item.id, ...(layout.get(item.id) || { column: 0, columns: 1 }) }));
}

function sanitizeFilename(rawName) {
  const stripped = String(rawName || "")
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  const truncated = stripped.slice(0, 200).trim();
  return truncated || "file";
}

function buildDocumentObjectPath(householdId, documentId, filename) {
  if (!householdId || !documentId) return null;
  return `documents/${householdId}/${documentId}/${sanitizeFilename(filename)}`;
}

function wouldCreateFolderCycle(folders, folderId, newParentId) {
  if (!newParentId) return false;
  if (folderId === newParentId) return true;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let cursor = byId.get(newParentId);
  const seen = new Set();
  while (cursor) {
    if (cursor.id === folderId) return true;
    if (seen.has(cursor.id)) return false;
    seen.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
  }
  return false;
}

function buildFolderTree(folders) {
  const byParent = new Map();
  folders.forEach((folder) => {
    const key = folder.parentId || "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(folder);
  });
  const attachChildren = (folder) => ({ ...folder, children: (byParent.get(folder.id) || []).map(attachChildren) });
  return (byParent.get("") || []).map(attachChildren);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    applyChecklistToggle, bucketChecklistItems, findChecklistDuplicate, mealWeeksForMonth, groupPlanTasksByBucket, validateJournalPayload,
    dailyTaskOccursOnDate, isDailyTaskDoneOnDate, toggleDailyTaskDoneOnDate,
    timeToMinutes, minutesToTime, snapMinutes, layoutTimelineBlocks, comparePlannedToActual,
    sanitizeFilename, buildDocumentObjectPath, wouldCreateFolderCycle, buildFolderTree,
    SMS_CARRIERS, smsGatewayAddress
  };
}
