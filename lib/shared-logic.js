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

// Reorders a checklist by drag-and-drop: moves draggedId to sit immediately
// before/after targetId. A dragged item that is itself a parent (no
// parentId of its own) brings its sub-items along as one contiguous block,
// in their existing relative order, so a family never gets split apart by
// the move - only a genuine top-level/child reassignment (the existing
// indent/outdent button) changes who belongs to whom. Returns the checklist
// unchanged if either id is missing or the drop target is inside the
// dragged item's own block (dragging a parent onto one of its own children
// is a no-op, not a hierarchy change).
function moveChecklistItem(checklist, draggedId, targetId, insertAfter) {
  if (!draggedId || !targetId || draggedId === targetId) return checklist;
  const dragged = checklist.find((item) => item.id === draggedId);
  if (!dragged) return checklist;
  const blockIds = new Set([draggedId]);
  if (!dragged.parentId) {
    checklist.forEach((item) => { if (item.parentId === draggedId) blockIds.add(item.id); });
  }
  if (blockIds.has(targetId)) return checklist;
  const block = checklist.filter((item) => blockIds.has(item.id));
  const rest = checklist.filter((item) => !blockIds.has(item.id));
  const targetIndex = rest.findIndex((item) => item.id === targetId);
  if (targetIndex === -1) return checklist;
  const insertAt = insertAfter ? targetIndex + 1 : targetIndex;
  rest.splice(insertAt, 0, ...block);
  return rest;
}

// Generic drag-and-drop reorder for a flat list of objects keyed by id (no
// parent/child grouping, unlike moveChecklistItem) - used for account
// ordering on the Wealth page, and reusable for any other flat draggable
// list. Returns the list unchanged if either id is missing or unknown.
function moveArrayItemById(list, draggedId, targetId, insertAfter) {
  if (!draggedId || !targetId || draggedId === targetId) return list;
  if (!list.some((item) => item.id === draggedId) || !list.some((item) => item.id === targetId)) return list;
  const dragged = list.find((item) => item.id === draggedId);
  const rest = list.filter((item) => item.id !== draggedId);
  const targetIndex = rest.findIndex((item) => item.id === targetId);
  const insertAt = insertAfter ? targetIndex + 1 : targetIndex;
  rest.splice(insertAt, 0, dragged);
  return rest;
}

// Same drag-and-drop reorder as moveArrayItemById, but block-aware: a Net
// worth grouped holdings card (a brokerage/retirement account's several
// stock/fund rows sharing one groupId) has to move as one contiguous unit,
// not just its first row - so items are keyed by groupId||id, and dragging
// a group's key moves every item sharing it together, in their existing
// relative order. A plain (non-holding) asset has no groupId, so its key is
// just its own id and it behaves exactly like moveArrayItemById's single
// item. Inserting "after" a multi-item target group lands past its last
// item, not its first, so the group never gets split by the inserted block.
function moveNetWorthAssetBlock(assets, draggedKey, targetKey, insertAfter) {
  if (!draggedKey || !targetKey || draggedKey === targetKey) return assets;
  const keyOf = (item) => item.groupId || item.id;
  if (!assets.some((item) => keyOf(item) === draggedKey) || !assets.some((item) => keyOf(item) === targetKey)) return assets;
  const draggedBlock = assets.filter((item) => keyOf(item) === draggedKey);
  const rest = assets.filter((item) => keyOf(item) !== draggedKey);
  const targetIndex = rest.findIndex((item) => keyOf(item) === targetKey);
  let insertAt = targetIndex;
  if (insertAfter) {
    while (insertAt < rest.length && keyOf(rest[insertAt]) === targetKey) insertAt += 1;
  }
  rest.splice(insertAt, 0, ...draggedBlock);
  return rest;
}

// A retirement account (401k/IRA) holds the same kind of positions a
// brokerage does - stocks and mutual funds - so it goes through the exact
// same grouped-holdings UI as "stock", just under its own assetClass for
// anyone who wants to keep the two visually/semantically distinct.
function isHoldingAssetClass(assetClass) {
  return assetClass === "stock" || assetClass === "retirement";
}

// Groups flat net-worth stock/mutual-fund holdings into one card per
// brokerage/retirement account. A holding created via the bulk/manage-
// holdings dialog carries an explicit groupId/groupName; a legacy solo
// holding (added one at a time before grouping existed) has neither, so it
// falls back to being its own single-holding group keyed by its own id -
// every holding-class asset ends up in exactly one group, none dropped
// silently.
function groupStockHoldings(assets) {
  const groups = [];
  const byKey = new Map();
  assets.filter((item) => isHoldingAssetClass(item.assetClass)).forEach((item) => {
    const key = item.groupId || item.id;
    if (!byKey.has(key)) {
      const group = { groupId: key, groupName: item.groupName || item.name, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).items.push(item);
  });
  return groups;
}

// A grouped holding card shows one label for the whole group ("Stocks",
// "Mutual Funds", or "Mixed") instead of a per-holding asset-class field -
// derived from each item's holdingType so the label stays accurate as
// holdings are added/removed/edited in the Manage holdings modal.
function assetClassLabelForHoldings(items) {
  const types = new Set(items.map((item) => item.holdingType || "stock"));
  if (types.size > 1) return "Mixed";
  return types.has("fund") ? "Mutual Funds" : "Stocks";
}

// Gain/loss for one holding, from its average cost basis (what was paid
// per share) vs its current price. costBasis defaults to 0 (never set) on
// older holdings, which would read as a nonsensical -100% loss - callers
// should treat hasCostBasis:false as "no gain/loss to show" rather than
// rendering the zeroed-out numbers.
function holdingGainLoss(item) {
  const shares = Number(item.shares || 0);
  const price = Number(item.price || 0);
  const costBasis = Number(item.costBasis || 0);
  const hasCostBasis = costBasis > 0;
  const amount = hasCostBasis ? (price - costBasis) * shares : 0;
  const percent = hasCostBasis ? ((price - costBasis) / costBasis) * 100 : 0;
  return { amount, percent, hasCostBasis };
}

// Aggregates gain/loss across every holding in a group that has a cost
// basis set - holdings without one (never priced in) are excluded from
// both sides of the ratio rather than silently treated as break-even,
// which would understate the real percent move of the ones that do.
function groupGainLoss(items) {
  const priced = items.filter((item) => Number(item.costBasis || 0) > 0);
  if (!priced.length) return { amount: 0, percent: 0, hasCostBasis: false };
  const amount = priced.reduce((sum, item) => sum + holdingGainLoss(item).amount, 0);
  const costTotal = priced.reduce((sum, item) => sum + Number(item.costBasis || 0) * Number(item.shares || 0), 0);
  const percent = costTotal > 0 ? (amount / costTotal) * 100 : 0;
  return { amount, percent, hasCostBasis: true };
}

// The debt payoff progress bar needs a real percent-paid-off, but debts
// only ever store their current balance, not an original one. Derive it
// from payment history instead: every logged payment's principal portion
// reduced the balance from some original amount, so balance + sum(principal
// paid) reconstructs that original amount without a new schema field.
function debtPayoffProgressPercent(debt) {
  const principalPaid = (debt.payments || []).reduce((sum, payment) => sum + Number(payment.principal || 0), 0);
  const originalBalance = Number(debt.balance || 0) + principalPaid;
  if (originalBalance <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((principalPaid / originalBalance) * 100)));
}

function findChecklistDuplicate(checklist, text, parentId = "") {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return null;
  const scopeParentId = parentId || "";
  return checklist.find((item) => (item.parentId || "") === scopeParentId && String(item.text || "").trim().toLowerCase() === normalized) || null;
}

// label is always the real Monday-Sunday span (never clamped to the
// month), even though a week's number/position is still driven by which
// calendar month it falls in - a boundary week genuinely spans two months
// (e.g. Jul 27-Aug 2 for August's "Week 1"), and showing a clamped 1-2 day
// stub instead ("Aug 1-Aug 2") reads as a broken/random date range rather
// than a real week. The grid this feeds (Meals) already dims the days that
// spill outside the selected month, so an unclamped label matches what's
// actually rendered underneath it.
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
    const startLabel = cursor.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const endLabel = end.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    weeks.push({ number, label: `${startLabel}–${endLabel}`, start: new Date(cursor) });
  }
  return weeks;
}

// Which week (per mealWeeksForMonth) contains "today" - falls back to week 1
// when today isn't inside monthValue at all (viewing a past/future month).
function currentMealWeekNumber(monthValue, today = new Date()) {
  const weeks = mealWeeksForMonth(monthValue);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const match = weeks.find((week) => {
    const end = new Date(week.start);
    end.setDate(end.getDate() + 6);
    return startOfToday >= week.start && startOfToday <= end;
  });
  return match ? match.number : 1;
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

// The calendar date a birthday/anniversary falls on in a given year, derived
// from its stable "MM-DD" (clamped for years without a Feb 29, etc).
function annualEventDate(event, year) {
  const [month, requestedDay] = String(event.monthDay || event.date?.slice(5) || "01-01").split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return new Date(year, month - 1, Math.min(requestedDay, lastDay));
}

// This year's occurrence if it hasn't passed yet, otherwise next year's —
// so a reminder always points at a real upcoming date, never a stale one.
function nextAnnualEventDate(event, referenceDate = new Date()) {
  const referenceMidnight = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const candidate = annualEventDate(event, referenceDate.getFullYear());
  if (candidate >= referenceMidnight) return candidate;
  return annualEventDate(event, referenceDate.getFullYear() + 1);
}

// The due date for a birthday/anniversary reminder, derived from the next
// upcoming occurrence minus reminderDays, at the given hour/minute.
// CLIENT-SIDE USE ONLY: this reads the wall-clock hour/minute via ambient
// local Date methods (setHours/getFullYear/etc), which only produces the
// intended instant when run in the user's own timezone (the browser). Do not
// call this on the server — a Cloud Run container's ambient timezone (UTC)
// won't match the user's real timezone and will silently compute the wrong
// absolute instant. Server code should use rollAnnualNotifyAtForward instead,
// which advances an already-correct client-computed instant by whole years
// without ever re-deriving hour/minute from scratch.
function annualEventNotifyAt(event, referenceDate = new Date()) {
  const occursOn = nextAnnualEventDate(event, referenceDate);
  const notifyDate = new Date(occursOn);
  notifyDate.setDate(notifyDate.getDate() - Number(event.reminderDays || 0));
  const [hour, minute] = String(event.dateTime?.slice(11, 16) || "09:00").split(":").map(Number);
  notifyDate.setHours(hour, minute, 0, 0);
  return notifyDate.toISOString();
}

// Timezone-agnostic: advances an already-computed notifyAt instant forward by
// whole years (pure UTC arithmetic) until it's no longer in the past, without
// ever re-deriving the hour/minute from monthDay + assumed local time. This is
// what makes it safe to call from the server, which may run in a different
// timezone than the client that originally localized this instant.
function rollAnnualNotifyAtForward(notifyAt, referenceDate = new Date()) {
  if (!notifyAt) return null;
  const date = new Date(notifyAt);
  if (Number.isNaN(date.getTime())) return null;
  let guard = 0;
  while (date.getTime() < referenceDate.getTime() && guard < 200) {
    date.setUTCFullYear(date.getUTCFullYear() + 1);
    guard += 1;
  }
  return date.toISOString();
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

// Every folder id in the subtree rooted at rootId - the root itself plus
// every descendant subfolder, at any depth - so deleting a folder can
// cascade to its whole subtree (and every document filed anywhere in it)
// in one step instead of requiring a household to empty it by hand first.
// Returns just [rootId] when the folder has no children.
function collectDescendantFolderIds(folders, rootId) {
  const byParent = new Map();
  folders.forEach((folder) => {
    const key = folder.parentId || "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(folder.id);
  });
  const ids = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift();
    (byParent.get(current) || []).forEach((childId) => {
      ids.push(childId);
      queue.push(childId);
    });
  }
  return ids;
}

// How many times a paycheck has landed by referenceDateKey: recurring
// paychecks (weekly/biweekly/monthly) deposit once per elapsed period since
// their anchor date, not just once, so a linked account's balance reflects
// every payday that has actually passed, not only the first. An optional
// endDate stops the recurrence as of that date without touching any
// occurrence before it, so past months stay exactly as they were once a
// paycheck is ended.
function paycheckOccurrencesSince(paycheck, referenceDateKey) {
  if (!paycheck.date || referenceDateKey < paycheck.date) return 0;
  const effectiveReferenceKey = paycheck.endDate && referenceDateKey > paycheck.endDate ? paycheck.endDate : referenceDateKey;
  if (effectiveReferenceKey < paycheck.date) return 0;
  const recurrence = paycheck.recurrence || "once";
  if (recurrence === "once" || recurrence === "bonus") return 1;
  const anchor = parseDateKey(paycheck.date);
  const reference = parseDateKey(effectiveReferenceKey);
  const dayMs = 24 * 60 * 60 * 1000;
  if (recurrence === "weekly") return Math.floor((reference - anchor) / (7 * dayMs)) + 1;
  if (recurrence === "biweekly") return Math.floor((reference - anchor) / (14 * dayMs)) + 1;
  if (recurrence === "monthly") {
    const months = (reference.getFullYear() - anchor.getFullYear()) * 12 + (reference.getMonth() - anchor.getMonth());
    return months + (reference.getDate() >= anchor.getDate() ? 1 : 0);
  }
  return 1;
}

function formatDateKeyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Every chore recurrence that repeats on a month-multiple grid (as opposed to
// a fixed day interval like weekly/biweekly/triweekly) maps to how many
// months apart consecutive occurrences land - shared by both
// nextPendingChoreOccurrence below and app.js's own calendar-grid/label
// logic, so a new cadence only needs to be added in one place.
const CHORE_MONTH_STEP_BY_RECURRENCE = {
  monthly: 1,
  every3months: 3,
  every4months: 4,
  every6months: 6,
  yearly: 12
};

function isChoreOccurrenceComplete(chore, date) {
  const assigneeKeys = (chore.assignees || []).map((assignee) => assignee.key);
  const completedKeys = (chore.completedBy || {})[date] || [];
  if (!assigneeKeys.length) return completedKeys.length > 0;
  return assigneeKeys.every((key) => completedKeys.includes(key));
}

// Whether a given occurrence still belongs on viewerKey's own pending list.
// Once a specific assignee has marked their own button for this date, it
// drops off THEIR view even if other assignees have not finished their part
// yet - the shared "is everyone done" check only applies when there is no
// particular viewer to personalize for (or the viewer is not an assignee).
function isChoreOccurrencePendingFor(chore, date, viewerKey) {
  const assigneeKeys = (chore.assignees || []).map((assignee) => assignee.key);
  if (viewerKey && assigneeKeys.includes(viewerKey)) {
    const completedKeys = (chore.completedBy || {})[date] || [];
    return !completedKeys.includes(viewerKey);
  }
  return !isChoreOccurrenceComplete(chore, date);
}

// The earliest occurrence of a chore that has not been marked complete yet,
// regardless of which month is displayed. Pass viewerKey (a signed-in
// user's own assignee key) to personalize this to their own completion
// instead of the whole household's.
function nextPendingChoreOccurrence(chore, viewerKey) {
  const recurrence = chore.recurrence || "once";
  const start = new Date(`${chore.startDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  // Once an occurrence would fall after the chore's end date, the chore has
  // finished repeating - there is nothing left to be pending.
  const choreEnd = chore.endDate ? new Date(`${chore.endDate}T00:00:00`) : null;

  if (recurrence === "once") {
    const key = formatDateKeyFromDate(start);
    return isChoreOccurrencePendingFor(chore, key, viewerKey) ? { date: key } : null;
  }

  const monthStep = CHORE_MONTH_STEP_BY_RECURRENCE[recurrence];
  if (monthStep) {
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    for (let i = 0; i < 240; i += 1) {
      const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const occurrence = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(start.getDate(), lastDay));
      if (occurrence >= start) {
        if (choreEnd && occurrence > choreEnd) return null;
        const key = formatDateKeyFromDate(occurrence);
        if (isChoreOccurrencePendingFor(chore, key, viewerKey)) return { date: key };
      }
      cursor.setMonth(cursor.getMonth() + monthStep);
    }
    return null;
  }

  const intervalDays = recurrence === "triweekly" ? 21 : recurrence === "biweekly" ? 14 : 7;
  const cursor = new Date(start);
  for (let i = 0; i < 3650; i += 1) {
    if (choreEnd && cursor > choreEnd) return null;
    const key = formatDateKeyFromDate(cursor);
    if (isChoreOccurrencePendingFor(chore, key, viewerKey)) return { date: key };
    cursor.setDate(cursor.getDate() + intervalDays);
  }
  return null;
}

// The chore occurrence a reminder should track right now - unlike
// nextPendingChoreOccurrence (which stays pinned on the oldest occurrence
// nobody has marked done yet, for however long that takes), this walks the
// recurrence grid purely by elapsed real time, never by completion state.
// A household that goes weeks without opening the app, or that simply never
// marks a given chore done, still gets exactly one reminder per occurrence
// going forward - the reminder doesn't freeze on the first missed one and
// then, the moment that old backlog is finally marked done, release every
// occurrence that piled up while nobody looked as one sudden burst.
// Deliberately returns only the LATEST occurrence on/before referenceDate
// (never every missed one in between) - a household that missed a few
// cycles should get one current reminder, not a pile of stale ones at once.
function currentChoreOccurrenceDate(chore, referenceDate = new Date()) {
  const recurrence = chore.recurrence || "once";
  const start = new Date(`${chore.startDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const choreEnd = chore.endDate ? new Date(`${chore.endDate}T00:00:00`) : null;
  const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());

  if (recurrence === "once") {
    if (choreEnd && start > choreEnd) return null;
    return { date: formatDateKeyFromDate(start) };
  }

  const monthStep = CHORE_MONTH_STEP_BY_RECURRENCE[recurrence];
  if (monthStep) {
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    let current = null;
    for (let i = 0; i < 240; i += 1) {
      const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const occurrence = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(start.getDate(), lastDay));
      if (occurrence >= start) {
        if (choreEnd && occurrence > choreEnd) break;
        if (occurrence > today) break;
        current = occurrence;
      }
      cursor.setMonth(cursor.getMonth() + monthStep);
    }
    if (current) return { date: formatDateKeyFromDate(current) };
    return choreEnd && start > choreEnd ? null : { date: formatDateKeyFromDate(start) };
  }

  const intervalDays = recurrence === "triweekly" ? 21 : recurrence === "biweekly" ? 14 : 7;
  const cursor = new Date(start);
  let current = null;
  for (let i = 0; i < 3650; i += 1) {
    if (choreEnd && cursor > choreEnd) break;
    if (cursor > today) break;
    current = new Date(cursor);
    cursor.setDate(cursor.getDate() + intervalDays);
  }
  if (current) return { date: formatDateKeyFromDate(current) };
  return choreEnd && start > choreEnd ? null : { date: formatDateKeyFromDate(start) };
}

function daysBetweenDateKeys(fromKey, toKey) {
  const [fromYear, fromMonth, fromDay] = fromKey.split("-").map(Number);
  const [toYear, toMonth, toDay] = toKey.split("-").map(Number);
  return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86400000);
}

// Converts a wall-clock date + time as understood in a given IANA timeZone
// into the correct absolute UTC instant. A server process has no timezone
// worth trusting for this (Cloud Run defaults to UTC no matter which zone a
// household actually lives in), so naively parsing "YYYY-MM-DDTHH:MM:00"
// (no offset) always uses the JS runtime's own zone, silently producing the
// wrong instant unless that happens to match the household's chosen one.
// Standard two-pass trick: guess the instant as if the wall-clock numbers
// were already UTC, read back what that guess displays as in timeZone, and
// the difference is the zone's real offset at that moment (accurate for any
// zone/DST combination, since an offset never shifts within the few hours
// this guess could be off by).
function zonedTimeToUtcIso(dateKey, hour, minute, timeZone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  if (!timeZone) return new Date(guessMs).toISOString();
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(new Date(guessMs)).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  } catch (_error) {
    return new Date(guessMs).toISOString();
  }
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), parts.hour === "24" ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offsetMs = asIfUtc - guessMs;
  return new Date(guessMs - offsetMs).toISOString();
}

// Recomputed every time this is called (client render, or a server-side
// notification pass) so the reminder always points at the current occurrence
// (see currentChoreOccurrenceDate - tracks elapsed time, not completion),
// instead of staying pinned to whichever date the chore was first created
// with and never firing again for later occurrences. Critically, this makes
// chore reminders self-healing on the server too: the scheduled notification
// worker can call this straight from a household's stored state to refresh
// due dates, without depending on a client having ever opened the app to
// advance them first.
//
// Unlike a fresh `new Date(pending.date + "T00:00:00")` every time, this only
// shifts the already-correct instant forward by whole days once one exists,
// rather than re-deriving the time-of-day from scratch. A fresh re-derive is
// parsed in whichever browser happens to render it, embedding THAT device's
// local timezone - for a household with members across timezones (e.g. a US
// member and an India member), a later device recomputing the same
// wall-clock reminder would otherwise store a different absolute UTC
// instant, bypassing the notification_jobs de-dupe (which keys off the exact
// due_at) and sending a genuine duplicate email hours apart, both still
// displaying the same "11:25 AM" because the email re-localizes to the
// household's fixed timezone rather than reflecting the underlying drift.
function choreNotifyAt(chore, referenceDate = new Date(), timeZone = "") {
  const pending = currentChoreOccurrenceDate(chore, referenceDate);
  if (!pending) return "";
  const sourceTime = String(chore.time || "09:00");
  const previousInstant = chore.notifyAt ? new Date(chore.notifyAt) : null;
  const intervalDays = chore.recurrence === "triweekly" ? 21 : chore.recurrence === "biweekly" ? 14 : chore.recurrence === "weekly" ? 7 : null;
  // The day-shift below only makes sense if notifyAtDateKey is still a real
  // point on the chore's CURRENT recurrence grid. If startDate or recurrence
  // was edited since notifyAtDateKey was last set, the old anchor can fall
  // off the new grid entirely - shifting it forward by the raw day gap
  // then lands on whatever weekday that gap happens to hit, not necessarily
  // one the chore is actually scheduled for (e.g. an anchor 13 days before
  // the next occurrence shifts a Monday onto a Sunday for a weekly chore).
  const anchorOnCurrentGrid = chore.notifyAtDateKey
    ? (intervalDays ? daysBetweenDateKeys(chore.startDate, chore.notifyAtDateKey) % intervalDays === 0 : chore.notifyAtDateKey === pending.date)
    : false;
  const canShift = previousInstant && !Number.isNaN(previousInstant.getTime()) && chore.notifyAtDateKey && chore.notifyAtSourceTime === sourceTime && anchorOnCurrentGrid;
  if (canShift && chore.notifyAtDateKey === pending.date) return chore.notifyAt;
  let result;
  if (canShift) {
    const dayDiff = daysBetweenDateKeys(chore.notifyAtDateKey, pending.date);
    result = new Date(previousInstant.getTime() + dayDiff * 86400000).toISOString();
  } else {
    const [hour, minute] = sourceTime.split(":").map(Number);
    // A server process has no timezone of its own worth trusting (Cloud Run
    // defaults to UTC regardless of which zone a household actually lives
    // in) - re-deriving via a naive `new Date(...).setHours(...)` here would
    // silently interpret hour/minute in whatever zone the JS runtime happens
    // to be in, not the household's real one. zonedTimeToUtcIso anchors it
    // to the household's actual timeZone instead, so a from-scratch
    // recompute (this branch) lands on the same wall-clock instant a
    // browser sitting in that zone would have produced.
    result = timeZone ? zonedTimeToUtcIso(pending.date, hour, minute, timeZone) : (() => {
      const notifyDate = new Date(`${pending.date}T00:00:00`);
      notifyDate.setHours(hour, minute, 0, 0);
      return notifyDate.toISOString();
    })();
  }
  // Keep all three bookkeeping fields mutated together - a caller that reads
  // chore.notifyAt again without writing this return value back first (the
  // server's own notification pass does exactly that, unlike app.js's call
  // site) would otherwise see notifyAtDateKey already advanced but notifyAt
  // still pointing at the previous occurrence's stale instant, and the
  // canShift shortcut above would hand back that stale value as if it were
  // current - producing a second, different due_at for the same occurrence
  // and a genuine duplicate notification_jobs row.
  chore.notifyAtDateKey = pending.date;
  chore.notifyAtSourceTime = sourceTime;
  chore.notifyAt = result;
  return result;
}

// How many times a paycheck lands within [rangeStartKey, rangeEndKey]
// (inclusive) — the Cash Flow report needs a per-month income figure, and a
// recurring paycheck can land more than once (or zero times) in any given
// month depending on its anchor date and recurrence. Reuses
// paycheckOccurrencesSince (a cumulative count) rather than re-deriving
// per-occurrence dates: occurrences in a range is just the difference
// between the cumulative counts at each end.
function paycheckOccurrencesInRange(paycheck, rangeStartKey, rangeEndKey) {
  const dayBeforeStart = formatDateKeyFromDate(new Date(parseDateKey(rangeStartKey).getTime() - 24 * 60 * 60 * 1000));
  return paycheckOccurrencesSince(paycheck, rangeEndKey) - paycheckOccurrencesSince(paycheck, dayBeforeStart);
}

// The actual date of every occurrence within [rangeStartKey, rangeEndKey]
// (inclusive) — paycheckOccurrencesInRange only returns a count, but the
// Paycheck/Income page needs each individual pay date (e.g. a biweekly
// paycheck anchored on the 10th lands on both the 10th and 24th within the
// same month) so a user can see every payday, not just a single total.
function paycheckAllOccurrenceDatesInRange(paycheck, rangeStartKey, rangeEndKey) {
  if (!paycheck?.date) return [];
  const recurrence = paycheck.recurrence || "once";
  const effectiveRangeEndKey = paycheck.endDate && rangeEndKey > paycheck.endDate ? paycheck.endDate : rangeEndKey;
  if (recurrence === "once" || recurrence === "bonus") {
    return (paycheck.date >= rangeStartKey && paycheck.date <= effectiveRangeEndKey) ? [paycheck.date] : [];
  }
  const anchor = parseDateKey(paycheck.date);
  const rangeEnd = parseDateKey(effectiveRangeEndKey);
  const dates = [];
  if (recurrence === "weekly" || recurrence === "biweekly") {
    const stepDays = recurrence === "weekly" ? 7 : 14;
    let cursor = anchor;
    while (cursor <= rangeEnd) {
      const key = formatDateKeyFromDate(cursor);
      if (key >= rangeStartKey) dates.push(key);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + stepDays);
    }
    return dates;
  }
  if (recurrence === "monthly") {
    let monthsElapsed = 0;
    let cursor = anchor;
    while (cursor <= rangeEnd) {
      const key = formatDateKeyFromDate(cursor);
      if (key >= rangeStartKey) dates.push(key);
      monthsElapsed += 1;
      const lastDayOfNextOccurrence = new Date(anchor.getFullYear(), anchor.getMonth() + monthsElapsed + 1, 0).getDate();
      cursor = new Date(anchor.getFullYear(), anchor.getMonth() + monthsElapsed, Math.min(anchor.getDate(), lastDayOfNextOccurrence));
    }
    return dates;
  }
  return [];
}

// Every date a recurring bill (weekly/biweekly/monthly) should have posted a
// real Ledger transaction by referenceDateKey, including the anchor date
// itself. Unlike paycheckOccurrencesSince (a count used only for account
// balance math), this returns individual dates because each elapsed period
// needs its own transaction row a user can see, edit, or delete. An optional
// endDate stops the recurrence as of that date without touching any
// occurrence before it, mirroring paycheckOccurrencesSince.
function recurringExpenseOccurrenceDates(recurring, referenceDateKey) {
  if (!recurring?.anchorDate || referenceDateKey < recurring.anchorDate) return [];
  const effectiveReferenceKey = recurring.endDate && referenceDateKey > recurring.endDate ? recurring.endDate : referenceDateKey;
  if (effectiveReferenceKey < recurring.anchorDate) return [];
  const recurrence = recurring.recurrence || "none";
  if (recurrence === "none") return [recurring.anchorDate];
  const anchor = parseDateKey(recurring.anchorDate);
  const reference = parseDateKey(effectiveReferenceKey);
  const dates = [];
  if (recurrence === "weekly" || recurrence === "biweekly") {
    const stepDays = recurrence === "weekly" ? 7 : 14;
    let cursor = anchor;
    while (cursor <= reference) {
      dates.push(formatDateKeyFromDate(cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + stepDays);
    }
    return dates;
  }
  if (recurrence === "monthly") {
    let monthsElapsed = 0;
    let cursor = anchor;
    while (cursor <= reference) {
      dates.push(formatDateKeyFromDate(cursor));
      monthsElapsed += 1;
      const lastDayOfNextOccurrence = new Date(anchor.getFullYear(), anchor.getMonth() + monthsElapsed + 1, 0).getDate();
      cursor = new Date(anchor.getFullYear(), anchor.getMonth() + monthsElapsed, Math.min(anchor.getDate(), lastDayOfNextOccurrence));
    }
    return dates;
  }
  return [recurring.anchorDate];
}

// Splits totalAmount into `count` shares that always sum back to exactly
// totalAmount (to the cent), unlike a naive totalAmount / count which drops
// or invents fractions of a cent on amounts that don't divide evenly (e.g.
// $100 split 3 ways). Works in integer cents and hands the leftover pennies
// to the first few people rather than losing them to rounding.
function splitAmountEvenly(totalAmount, count) {
  if (!Number.isFinite(count) || count <= 0) return [];
  const totalCents = Math.round(Number(totalAmount || 0) * 100);
  const baseCents = Math.floor(totalCents / count);
  const remainderCents = totalCents - baseCents * count;
  return Array.from({ length: count }, (_, index) => (baseCents + (index < remainderCents ? 1 : 0)) / 100);
}

// Splits totalAmount by percentage shares using the largest-remainder method:
// unlike splitAmountEvenly's "leftover cents to the first entries" (fine when
// every share is equal), percentage shares are often uneven (e.g. 90/10), so
// leftover pennies instead go to whichever entries have the largest
// fractional-cent remainder - fairer, and it's what naive independent
// rounding of each share would otherwise silently drop or invent.
// Returns null (not throwing) if the percentages don't sum to ~100 (a small
// tolerance allows entries like 33.33/33.33/33.34) so a caller can render an
// inline validation message without a try/catch.
function splitBillByPercentages(totalAmount, percentages) {
  if (!Array.isArray(percentages) || !percentages.length) return null;
  const percentSum = percentages.reduce((sum, pct) => sum + Number(pct || 0), 0);
  if (Math.abs(percentSum - 100) > 0.05) return null;
  const totalCents = Math.round(Number(totalAmount || 0) * 100);
  const rawShares = percentages.map((pct) => (totalCents * Number(pct || 0)) / 100);
  const cents = rawShares.map((share) => Math.floor(share));
  let remainder = totalCents - cents.reduce((sum, value) => sum + value, 0);
  const byLargestFraction = rawShares
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < byLargestFraction.length && remainder > 0; i++) {
    cents[byLargestFraction[i].index] += 1;
    remainder -= 1;
  }
  return cents.map((value) => value / 100);
}

// Splits totalAmount proportionally by raw "shares" (relative weights like
// "1 part"/"2 parts" - Splitwise's unequal-shares split) using the same
// largest-remainder method as splitBillByPercentages, just weighted by share
// counts instead of percentages that must sum to 100 - shares can be any
// positive numbers since only their ratio to each other matters. Returns
// null if there are no shares at all (nothing to divide by).
function splitBillByShares(totalAmount, shares) {
  if (!Array.isArray(shares) || !shares.length) return null;
  const totalShares = shares.reduce((sum, value) => sum + Number(value || 0), 0);
  if (totalShares <= 0) return null;
  const totalCents = Math.round(Number(totalAmount || 0) * 100);
  const rawShares = shares.map((value) => (totalCents * Number(value || 0)) / totalShares);
  const cents = rawShares.map((share) => Math.floor(share));
  let remainder = totalCents - cents.reduce((sum, value) => sum + value, 0);
  const byLargestFraction = rawShares
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < byLargestFraction.length && remainder > 0; i++) {
    cents[byLargestFraction[i].index] += 1;
    remainder -= 1;
  }
  return cents.map((value) => value / 100);
}

function normalizePersonName(name) {
  return String(name || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

// Groups unsettled IOUs by normalized person name, netting owed_to_me (+)
// against i_owe (-) for the same person - e.g. one i_owe $20 record and one
// owed_to_me $32 record for "Sam" collapse into one +12 (owed_to_me) balance,
// the way Splitwise shows one running balance per friend rather than a flat
// list. `records` keeps *references* to the original iou objects (not
// copies) so a caller can key UI actions off iou.id. A net of exactly zero
// (offsetting records that happen to cancel out) is reported as direction
// "settled" even though the underlying records aren't individually marked
// settled - there's nothing left to settle up.
function netBalancesByPerson(ious) {
  const groups = new Map();
  (ious || []).forEach((iou) => {
    if (iou.settled) return;
    const key = normalizePersonName(iou.person);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { key, label: String(iou.person).trim(), net: 0, records: [] });
    const group = groups.get(key);
    group.net += iou.direction === "owed_to_me" ? Number(iou.amount || 0) : -Number(iou.amount || 0);
    group.records.push(iou);
  });
  return [...groups.values()]
    .map((group) => {
      const net = Math.round(group.net * 100) / 100;
      const direction = net > 0.004 ? "owed_to_me" : net < -0.004 ? "i_owe" : "settled";
      return { ...group, net, direction };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Computes each friend's dollar share of a bill. `participants` holds the
// friend rows only, one per friend, never including the payer themselves.
//
// `yourShare` is optional and lets a caller give the payer's own row an
// explicit value (a percent, a share count, or an exact dollar amount,
// matching whatever splitType is active) instead of always leaving it as an
// implicit leftover - pass a real number, including 0, to fully control (or
// zero out) your own portion; omit it (undefined) to fall back to the
// original behavior, where the payer is always an implicit extra participant
// (friends.length + 1 people total, Splitwise-style) and payerAmount is
// whatever's left over after the friends' shares. Whichever path is taken,
// payerAmount + the sum of friendAmounts always reconciles to totalAmount to
// the cent. Reuses splitAmountEvenly for "equal", splitBillByPercentages for
// "percentage", and splitBillByShares for "shares"; "exact" just reads each
// participant's (and the payer's, if given) typed amount.
function computeBillSplitAmounts(splitType, totalAmount, participants, yourShare) {
  const total = Number(totalAmount || 0);
  const list = Array.isArray(participants) ? participants : [];
  if (!list.length) return { ok: false, error: "Add at least one person to split with." };
  const hasYourShare = yourShare !== undefined && yourShare !== null && yourShare !== "";

  if (splitType === "equal") {
    const amounts = splitAmountEvenly(total, list.length + 1);
    return { ok: true, friendAmounts: amounts.slice(0, list.length), payerAmount: amounts[list.length] };
  }

  // "all_them"/"all_me" are the direction-merged quick presets ("They owe
  // everything" / "I owe everything") - you're never a participant in
  // these, so the whole total is divided evenly across just the friend
  // list and your share is always 0, regardless of any yourShare passed in.
  if (splitType === "all_them" || splitType === "all_me") {
    const amounts = splitAmountEvenly(total, list.length);
    return { ok: true, friendAmounts: amounts, payerAmount: 0 };
  }

  if (splitType === "shares") {
    const friendShares = list.map((row) => Number(row.shares || 0));
    const yourShares = hasYourShare ? Number(yourShare) : 1;
    const allShares = [...friendShares, yourShares];
    const amounts = splitBillByShares(total, allShares);
    if (!amounts) return { ok: false, error: "Enter at least one share." };
    return { ok: true, friendAmounts: amounts.slice(0, list.length), payerAmount: amounts[list.length] };
  }

  if (splitType === "percentage") {
    const friendPercentages = list.map((row) => Number(row.percent || 0));
    if (hasYourShare) {
      const amounts = splitBillByPercentages(total, [...friendPercentages, Number(yourShare)]);
      if (!amounts) return { ok: false, error: "Percentages must add up to 100%." };
      return { ok: true, friendAmounts: amounts.slice(0, list.length), payerAmount: amounts[list.length] };
    }
    const friendPercentTotal = friendPercentages.reduce((sum, pct) => sum + pct, 0);
    if (friendPercentTotal <= 0 || friendPercentTotal > 100) {
      return { ok: false, error: "Friends' percentages must add up to more than 0% and no more than 100%." };
    }
    const allAmounts = splitBillByPercentages(total, [...friendPercentages, 100 - friendPercentTotal]);
    if (!allAmounts) return { ok: false, error: "Percentages must add up to 100%." };
    return { ok: true, friendAmounts: allAmounts.slice(0, list.length), payerAmount: allAmounts[list.length] };
  }

  // exact
  const friendAmounts = list.map((row) => Number(row.amount) || 0);
  const friendTotal = friendAmounts.reduce((sum, amount) => sum + amount, 0);
  if (hasYourShare) {
    const yourAmount = Number(yourShare);
    if (Math.abs(friendTotal + yourAmount - total) > 0.005) {
      return { ok: false, error: `Splits must add up to the ${total.toFixed(2)} total.` };
    }
    return { ok: true, friendAmounts, payerAmount: Math.round(yourAmount * 100) / 100 };
  }
  if (friendTotal > total + 0.005) {
    return { ok: false, error: `Splits add up to more than the ${total.toFixed(2)} total.` };
  }
  const payerAmount = Math.round((total - friendTotal) * 100) / 100;
  return { ok: true, friendAmounts, payerAmount };
}

// Settles up to settleAmount of a person's *net* outstanding balance, oldest
// record first, only touching records in the person's net direction (the
// offsetting direction's records already netted out of the displayed balance
// and are left untouched here). When the amount doesn't land on a whole-
// record boundary, the last touched record is split into a settled portion +
// an unsettled remainder (same accountId/direction/date/person, a new id for
// the remainder) - this keeps accountBalance's per-record settled/amount/
// accountId/date reads correct without it needing any person-aware logic.
// Rejects (ok:false) if the amount exceeds the person's net balance, and
// never mutates the input array.
function settleUpPersonIous(ious, personName, settleAmount, settledDate, createRemainderId) {
  const amount = Number(settleAmount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter a positive amount to settle." };
  const balance = netBalancesByPerson(ious).find((group) => group.key === normalizePersonName(personName));
  if (!balance || balance.direction === "settled") {
    return { ok: false, error: "There's no outstanding balance with this person." };
  }
  if (amount > Math.abs(balance.net) + 0.005) {
    return { ok: false, error: `That's more than the ${Math.abs(balance.net).toFixed(2)} outstanding balance.` };
  }

  const targetRecords = balance.records
    .filter((iou) => iou.direction === balance.direction)
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || String(a.id).localeCompare(String(b.id)));

  let remainingCents = Math.round(amount * 100);
  const settledCentsById = new Map();
  targetRecords.forEach((iou) => {
    if (remainingCents <= 0) return;
    const iouCents = Math.round(Number(iou.amount || 0) * 100);
    const applied = Math.min(iouCents, remainingCents);
    settledCentsById.set(iou.id, applied);
    remainingCents -= applied;
  });

  const settledIds = [];
  const result = [];
  (ious || []).forEach((iou) => {
    const settledCents = settledCentsById.get(iou.id);
    if (settledCents === undefined) {
      result.push(iou);
      return;
    }
    settledIds.push(iou.id);
    const iouCents = Math.round(Number(iou.amount || 0) * 100);
    if (settledCents >= iouCents) {
      result.push({ ...iou, settled: true, settledDate });
    } else {
      result.push({ ...iou, amount: settledCents / 100, settled: true, settledDate });
      const remainderId = createRemainderId ? createRemainderId(iou) : `${iou.id}-remainder`;
      result.push({ ...iou, id: remainderId, amount: (iouCents - settledCents) / 100, settled: false, settledDate: "" });
    }
  });
  return { ok: true, ious: result, settledIds };
}

// A lenient character-by-character CSV parser rather than a strict RFC4180
// one: real-world bank exports sometimes embed a literal, unescaped quote
// inside a quoted field (e.g. a Zelle memo like `"...for "Trip fund"; Conf#
// ..."`) instead of doubling it. Treat a quote as closing the field only
// when it's immediately followed by a comma, newline, or end of input —
// otherwise it's just a literal character within the field — so a field
// like that survives intact instead of getting split apart mid-sentence.
function parseDelimitedText(text) {
  const rows = [];
  let fields = [];
  let field = "";
  let inQuotes = false;
  const source = String(text || "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === "\"") {
        const next = source[i + 1];
        if (next === "\"") {
          field += "\"";
          i += 1;
        } else if (next === "," || next === "\n" || next === "\r" || next === undefined) {
          inQuotes = false;
        } else {
          field += "\"";
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"" && field === "") {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else if (char === "\r") {
      // skip, \n (handled next) ends the row
    } else if (char === "\n") {
      fields.push(field);
      rows.push(fields);
      fields = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || fields.length) {
    fields.push(field);
    rows.push(fields);
  }
  return rows;
}

function parseCsvAmount(value) {
  const cleaned = String(value ?? "").replace(/[,$]/g, "").trim();
  if (!cleaned) return NaN;
  return Number(cleaned);
}

// Accepts MM/DD/YYYY (the common US bank export format) or an already-ISO
// YYYY-MM-DD value; anything else is treated as unparseable.
function normalizeCsvDate(value) {
  const trimmed = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return "";
}

// "Posting Date" (Chase) and "Post Date"/"Trans. Date" (Discover) are real
// header text from those issuers' own CSV exports - without them, both
// files fail to find a header row at all and the whole import silently
// returns nothing.
const CSV_DATE_HEADERS = ["date", "transaction date", "posted date", "trans date", "posting date", "post date", "trans. date"];
const CSV_PAYEE_HEADERS = ["description", "payee", "merchant", "name"];
const CSV_AMOUNT_HEADERS = ["amount"];
const CSV_DEBIT_HEADERS = ["debit"];
const CSV_CREDIT_HEADERS = ["credit"];
// Wells Fargo's plain CSV export has no header row at all - just
// "date","amount","*","","description" per line, always exactly these five
// fields. Recognized structurally (every row has 5 fields, the first two
// look like a date and a number) since there's no header text to key off.
function parseHeaderlessWellsFargoCsv(rows) {
  const looksRight = rows.length > 0 && rows.every((row) => row.length === 5 && normalizeCsvDate(row[0]) && Number.isFinite(parseCsvAmount(row[1])));
  if (!looksRight) return [];
  const results = [];
  rows.forEach((row) => {
    const date = normalizeCsvDate(row[0]);
    const payee = String(row[4] || "").trim();
    const signedValue = parseCsvAmount(row[1]);
    if (!date || !payee || !Number.isFinite(signedValue) || signedValue === 0) return;
    if (signedValue < 0) {
      results.push({ date, payee, amount: Math.abs(signedValue) });
    } else {
      results.push({ date, payee, amount: -signedValue, isDeposit: true });
    }
  });
  return results;
}

// Bank exports vary in two ways this handles: (1) some files bury the real
// transaction table below a summary block (e.g. a beginning/ending balance
// recap) — rather than assuming row 0 is the header, this scans for the
// first row that actually looks like one; (2) a single signed Amount column
// means two entirely different things depending on the account type. A
// checking account's export is money-out-negative (a debit/spend is
// negative, a deposit is positive) - that's the default assumed below. A
// credit card export is the opposite (a purchase is positive - it increases
// what you owe - and only a payment/credit is negative), exactly like the
// PDF statement format parseCreditCardStatementText already handles; without
// detecting this, every real purchase in a credit-card CSV gets silently
// skipped and only the autopay/payment rows import (a real reported bug).
// Detected per-file from the data itself (no per-account settings needed):
// if there are more positive rows than negative ones, it's overwhelmingly
// likely a credit-card-style export (a checking account's activity is
// mostly negative debits, rarely mostly-positive), so that file is parsed
// with the credit-card sign convention instead.
function parseBankCsvTransactions(text) {
  const rows = parseDelimitedText(text).filter((row) => row.some((cell) => String(cell || "").trim() !== ""));
  const headerIndex = rows.findIndex((row) => {
    const cells = row.map((cell) => String(cell || "").trim().toLowerCase());
    const hasDate = cells.some((cell) => CSV_DATE_HEADERS.includes(cell));
    const hasPayee = cells.some((cell) => CSV_PAYEE_HEADERS.includes(cell));
    const hasAmount = cells.some((cell) => CSV_AMOUNT_HEADERS.includes(cell) || CSV_DEBIT_HEADERS.includes(cell));
    return hasDate && hasPayee && hasAmount;
  });
  if (headerIndex === -1) return parseHeaderlessWellsFargoCsv(rows);
  const header = rows[headerIndex].map((cell) => String(cell || "").trim().toLowerCase());
  const dateIndex = header.findIndex((cell) => CSV_DATE_HEADERS.includes(cell));
  const payeeIndex = header.findIndex((cell) => CSV_PAYEE_HEADERS.includes(cell));
  const amountIndex = header.findIndex((cell) => CSV_AMOUNT_HEADERS.includes(cell));
  const debitIndex = header.findIndex((cell) => CSV_DEBIT_HEADERS.includes(cell));
  const creditIndex = header.findIndex((cell) => CSV_CREDIT_HEADERS.includes(cell));
  const dataRows = rows.slice(headerIndex + 1);

  let isCreditCardStyle = false;
  if (debitIndex === -1 && amountIndex !== -1) {
    const signedAmounts = dataRows.map((row) => parseCsvAmount(row[amountIndex])).filter(Number.isFinite);
    const positiveCount = signedAmounts.filter((value) => value > 0).length;
    const negativeCount = signedAmounts.filter((value) => value < 0).length;
    // A "...PAYMENT...THANK YOU"/"ONLINE PAYMENT"-style negative row is a
    // strong, description-based signal on its own regardless of volume - a
    // checking account never describes its own deposits that way, only a
    // credit card's own payoff does. Without this, a small file with an even
    // (or negative-majority) split of purchases vs. payments/refunds - a
    // perfectly ordinary partial-month Amex/Discover export - loses the
    // volume-count tiebreak and gets parsed with the wrong sign convention
    // entirely (a real purchase misread as a deposit, a real refund misread
    // as a purchase).
    const hasPaymentDescriptionSignal = dataRows.some((row) => {
      const value = parseCsvAmount(row[amountIndex]);
      return Number.isFinite(value) && value < 0 && STATEMENT_PAYMENT_DESCRIPTION.test(String(row[payeeIndex] || ""));
    });
    isCreditCardStyle = hasPaymentDescriptionSignal || (positiveCount > negativeCount && positiveCount > 0);
  }

  const results = [];
  dataRows.forEach((row) => {
    const date = normalizeCsvDate(row[dateIndex]);
    const payee = String(row[payeeIndex] || "").trim();
    let amount = NaN;
    let isDeposit = false;
    let isPayment = false;
    if (debitIndex !== -1) {
      const debitValue = parseCsvAmount(row[debitIndex]);
      if (Number.isFinite(debitValue) && debitValue > 0) {
        amount = debitValue;
      } else if (creditIndex !== -1) {
        // A separate Debit/Credit column pair (Citi and similar) - a Credit
        // row is either an autopay/card-payment (money moving from a bank
        // account to pay this card down, not a purchase or refund of one) or
        // real money in. Both are kept (never silently dropped - a household
        // still needs to see and reconcile a payoff, typically via Move to
        // Transfers), just flagged differently so Bank Stream can label
        // them distinctly. Some exports store the Credit value as
        // already-negative, others as a plain positive magnitude - normalize
        // to negative either way, since that's this parser's convention for
        // money coming back.
        const creditValue = parseCsvAmount(row[creditIndex]);
        if (Number.isFinite(creditValue) && creditValue !== 0) {
          amount = -Math.abs(creditValue);
          if (STATEMENT_PAYMENT_DESCRIPTION.test(payee)) isPayment = true;
          else isDeposit = true;
        }
      }
    } else if (amountIndex !== -1) {
      const signedValue = parseCsvAmount(row[amountIndex]);
      if (!Number.isFinite(signedValue) || signedValue === 0) {
        amount = NaN;
      } else if (isCreditCardStyle) {
        // A payoff/autopay row is money moving from a bank account to pay
        // down the card, not a purchase or a refund of one - previously
        // dropped entirely here (silently, with no way to see or reconcile
        // it), the same class of bug as the checking-side deposit case
        // below. Now kept and flagged, so it lands in Bank Stream where
        // Move to Transfers is the correct next step. Everything else keeps
        // its real sign: positive stays a purchase, negative stays a
        // refund/credit (nets against the original purchase automatically).
        amount = signedValue;
        isPayment = STATEMENT_PAYMENT_DESCRIPTION.test(payee);
      } else if (signedValue < 0) {
        amount = Math.abs(signedValue);
      } else {
        // A checking-style export's raw positive value is a deposit (money
        // in, e.g. a paycheck or transfer) - previously only the negative
        // (money-out) rows above were kept here and every deposit was
        // silently dropped from the import entirely. Flip it to this app's
        // negative/income sign convention instead of dropping it, and flag
        // it so Bank Stream can label it as a deposit rather than a refund.
        amount = -signedValue;
        isDeposit = true;
      }
    }
    if (date && payee && Number.isFinite(amount) && amount !== 0) {
      const flags = { ...(isDeposit ? { isDeposit: true } : {}), ...(isPayment ? { isPayment: true } : {}) };
      results.push(Object.keys(flags).length ? { date, payee, amount, ...flags } : { date, payee, amount });
    }
  });
  return results;
}

function normalizeForAccountMatch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Matches any of several text hints (a filename, a label extracted from the
// file's own content, etc.) against an account by name — e.g. an export
// named "Costco Citi Jul 142026.CSV" should land on an account named
// "Costco Citi" without the household having to rename anything. Each hint
// is normalized (lowercase, punctuation/spaces removed) and checked either
// containing or contained by an account's own normalized name, so a longer
// hint with extra words (dates, statement numbers, account digits) still
// matches a shorter account name and vice versa. Hints are tried in order;
// the first one that matches any account wins.
function matchAccountByHints(hints, accounts) {
  for (const hint of hints || []) {
    const normalized = normalizeForAccountMatch(String(hint || "").replace(/\.[^.]+$/, ""));
    if (!normalized) continue;
    const match = (accounts || []).find((account) => {
      const accountNormalized = normalizeForAccountMatch(account.name);
      return accountNormalized && (normalized.includes(accountNormalized) || accountNormalized.includes(normalized));
    });
    if (match) return match;
  }
  return null;
}

function matchAccountByFilename(filename, accounts) {
  return matchAccountByHints([filename], accounts);
}

// A checking-account "Account Activity" PDF's own title line ("Adv Plus
// Banking - 6769 : Account Activity") names the real account/last-4 digits
// - unlike the upload's filename, which BofA's own print export always
// generates as the same generic "...Print Transaction Details.pdf"
// regardless of which account it's for, so filename-only matching can never
// succeed for this format. Returns "" when the line isn't present (e.g. a
// credit-card statement, which has no such title line at all).
function extractAccountActivityLabel(text) {
  const match = String(text || "").match(/^(.+?)\s*:\s*Account Activity\s*$/mi);
  return match ? match[1].trim() : "";
}

const DUPLICATE_TRANSACTION_DATE_TOLERANCE_DAYS = 2;

// Named distinctly from app.js's own daysBetweenDateKeys (a signed day-shift
// helper for chore recurrence) — shared-logic.js and app.js are separate
// <script> tags in the same global scope, so two same-named top-level
// functions silently collide and the later-loaded one (app.js) wins,
// breaking whichever caller expected the other's behavior.
function absoluteDaysBetweenDateKeys(leftKey, rightKey) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.abs(parseDateKey(leftKey).getTime() - parseDateKey(rightKey).getTime()) / millisecondsPerDay;
}

// A CSV re-imported over an overlapping date range (or a bank stream item
// that was already accepted into the ledger) reproduces the same amount,
// with the date drifting a day or two — a pending charge often posts a
// couple days later/earlier than it first appeared. Payee text is not
// checked: a CSV row's payee is the bank's raw statement description while
// the same charge in the ledger may carry a short hand-typed or
// recurring-bill name, so matching on amount and date alone catches more
// real duplicates than payee text ever reliably would.
function isDuplicateTransaction(candidate, existingTransactions) {
  const candidateAmount = Number(candidate.amount);
  return (existingTransactions || []).some((transaction) =>
    Number(transaction.amount) === candidateAmount &&
    absoluteDaysBetweenDateKeys(transaction.date, candidate.date) <= DUPLICATE_TRANSACTION_DATE_TOLERANCE_DAYS
  );
}

// Detects the *other side* of an account-to-account transfer (e.g. a
// checking account's "-500 Payment to Card" and the card's own "+500
// Payment Received"), so it can be offered as a Transfer instead of two
// unrelated expense/income transactions. Unlike isDuplicateTransaction
// (same amount, same account implied, catches re-imports), a transfer match
// needs the OPPOSITE amount on a DIFFERENT account within the same short
// date window - reuses the same tolerance constant and day-math rather than
// inventing a second one. Returns the matched record itself (like
// orderRefundMatch), not a boolean, since callers need its account/id to
// offer clearing both sides at once.
function findTransferCandidate(candidate, otherTransactions) {
  if (!candidate.accountId) return null;
  const candidateAmount = Number(candidate.amount);
  return (otherTransactions || []).find((other) =>
    other.accountId && other.accountId !== candidate.accountId &&
    Number(other.amount) === -candidateAmount &&
    absoluteDaysBetweenDateKeys(other.date, candidate.date) <= DUPLICATE_TRANSACTION_DATE_TOLERANCE_DAYS
  ) || null;
}

// A refund/return often lands in a separate statement import weeks after the
// original purchase, so this checks against every real ledger transaction
// by default (not just the current import batch) - the same orderNumber
// persisted on the original purchase is how the two get reconnected across
// sessions. Callers with a pending Bank Stream (transactions not yet
// accepted into the ledger) should pass a wider pool - otherwise an order
// and its return both still sitting in the inbox (e.g. a same-statement
// purchase+return, or a return imported before its purchase was accepted)
// never show as matched even though both are already sitting right there.
// Recomputed live (never cached on the draft) for the same reason
// possibleDuplicate is: a match that appears after the fact - because the
// original purchase was accepted into the ledger later - must not stay
// stuck showing "no match" forever.
function orderRefundMatch(candidate, pool) {
  if (!candidate.orderNumber || Number(candidate.amount) >= 0) return null;
  return (pool || []).find((transaction) => transaction.orderNumber === candidate.orderNumber && Number(transaction.amount) > 0) || null;
}

function normalizeForPayeeMatch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// A statement's refund line rarely reads identically to its purchase line -
// "TARGET.COM" vs "TARGET STORE 1147", "AMZN MKTP US" vs "AMAZON.COM" - so
// plain containment (either side being a full substring of the other, the
// way matchAccountByFilename compares a filename to an account name) misses
// most real pairs: neither string contains the other, they just share a
// merchant-name prefix. Containment is checked first since it costs nothing
// extra and does catch cases like an orderNumber-suffixed purchase line
// ("AMAZON.COM*A1B2C3") containing the shorter refund line ("AMAZON.COM")
// outright; the prefix check is what actually carries "TARGET"-style pairs.
const PAYEE_FUZZY_MATCH_PREFIX_LENGTH = 4;

function payeesFuzzyMatch(payeeA, payeeB) {
  const a = normalizeForPayeeMatch(payeeA);
  const b = normalizeForPayeeMatch(payeeB);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  if (a.length < PAYEE_FUZZY_MATCH_PREFIX_LENGTH || b.length < PAYEE_FUZZY_MATCH_PREFIX_LENGTH) return false;
  return a.slice(0, PAYEE_FUZZY_MATCH_PREFIX_LENGTH) === b.slice(0, PAYEE_FUZZY_MATCH_PREFIX_LENGTH);
}

// Most returns never carry an orderNumber at all (a walk-in store return, or
// a statement that just doesn't itemize one) - orderRefundMatch alone leaves
// these permanently unmatched. This is the fallback for exactly that case:
// a fuzzy payee match (see payeesFuzzyMatch) and the exact opposite amount.
// A return can never precede its own purchase, so the window only looks
// backward in time from the refund's date, bounded by
// REFUND_FUZZY_MATCH_DATE_WINDOW_DAYS - wide enough to cover a slow
// return/price-adjustment, not so wide that two unrelated same-payee,
// same-amount charges months apart falsely pair up.
const REFUND_FUZZY_MATCH_DATE_WINDOW_DAYS = 180;

function refundFuzzyMatch(candidate, pool) {
  const candidateAmount = Number(candidate.amount);
  if (candidateAmount >= 0) return null;
  if (!normalizeForPayeeMatch(candidate.payee)) return null;
  return (pool || []).find((transaction) =>
    Number(transaction.amount) === -candidateAmount &&
    transaction.date <= candidate.date &&
    absoluteDaysBetweenDateKeys(transaction.date, candidate.date) <= REFUND_FUZZY_MATCH_DATE_WINDOW_DAYS &&
    payeesFuzzyMatch(candidate.payee, transaction.payee)
  ) || null;
}

// The one entry point callers should use: an orderNumber match is the
// stronger, more specific signal (two unrelated purchases could coincidentally
// share a payee/amount, but not a real order id), so it's tried first. The
// fuzzy fallback also runs whenever the order match comes up empty - not just
// when the candidate has no orderNumber at all - since a refund/purchase pair
// doesn't always carry the same order id on both lines (one side truncated
// by the statement, or simply not itemized on one of the two), so requiring
// an exact id match on both ends left real same-payee/opposite-amount pairs
// unmatched even though the fuzzy fallback would have caught them.
function refundMatch(candidate, pool) {
  return orderRefundMatch(candidate, pool) || refundFuzzyMatch(candidate, pool);
}

// Learns from the household's own categorization history rather than
// requiring a fresh pick every time: an exact-normalized-payee match against
// already-categorized transactions. The single most *recently* categorized
// transaction for a payee wins outright - not whichever line has the most
// historical hits - so a household that changed how it categorizes a payee
// (moved "Netflix" from Entertainment to a new Subscriptions line) gets the
// newer choice immediately, rather than staying stuck suggesting the old
// line until it eventually outnumbers the new one. Only already-categorized
// transactions (a real lineId) count as history - an unassigned or
// still-pending row teaches this nothing.
//
// Deliberately exact-match only, no fuzzy fallback: payeesFuzzyMatch's
// same-first-4-characters rule (built for refund pairing, where it's always
// corroborated by an exact opposite amount within a date window - two
// independent signals, not one) is unsafe here on payee text alone. Real
// statements are full of generic shared prefixes across completely
// unrelated transactions - "Zelle payment to X" and "Zelle payment from Y"
// both normalize to the same "zell..." prefix regardless of who's on the
// other end. A confirmed real-world failure: fuzzy matching on prefix alone
// collapsed dozens of unrelated Zelle transfers onto whichever one of them
// happened to be categorized last, mis-suggesting the same wrong
// subcategory across an entire statement import.
function suggestSubcategoryFromHistory(payee, transactions) {
  const targetKey = normalizeForPayeeMatch(payee);
  if (!targetKey) return null;
  let best = null;
  (transactions || []).forEach((transaction) => {
    if (!transaction.lineId) return;
    if (normalizeForPayeeMatch(transaction.payee) !== targetKey) return;
    const date = String(transaction.date || "");
    if (!best || date > best.date) best = { lineId: transaction.lineId, date };
  });
  return best ? best.lineId : null;
}

// A real, computed confidence for suggestSubcategoryFromHistory's pick: what
// fraction of this payee's past categorized transactions actually used the
// same lineId as the most-recent one it's about to suggest. Never a
// fabricated score - a payee categorized the same way every time reads
// 100%, one that's been split across two different subcategories reads
// something lower.
function payeeCategorizationConfidence(payee, transactions) {
  const lineId = suggestSubcategoryFromHistory(payee, transactions);
  if (!lineId) return null;
  const targetKey = normalizeForPayeeMatch(payee);
  let total = 0;
  let matching = 0;
  (transactions || []).forEach((transaction) => {
    if (!transaction.lineId) return;
    if (normalizeForPayeeMatch(transaction.payee) !== targetKey) return;
    total += 1;
    if (transaction.lineId === lineId) matching += 1;
  });
  if (!total) return null;
  return { lineId, confidence: Math.round((matching / total) * 100), sampleSize: total };
}

// Mirrors suggestSubcategoryFromHistory exactly, but for which Wealth
// account a payee's transactions have actually been linked to - same
// exact-payee-match-only rule, same reasoning: a shared generic prefix
// ("Zelle payment to X" vs "Zelle payment from Y") must never
// cross-contaminate an unrelated transaction's real account, and there's no
// amount+date corroboration here the way refundMatch has to make a fuzzy
// guess safe. The single most recently used account for an exact payee
// match wins outright, so a household that moved a payee to a different
// account gets the newer choice immediately.
function suggestAccountFromHistory(payee, transactions) {
  const targetKey = normalizeForPayeeMatch(payee);
  if (!targetKey) return null;
  let best = null;
  (transactions || []).forEach((transaction) => {
    if (!transaction.accountId) return;
    if (normalizeForPayeeMatch(transaction.payee) !== targetKey) return;
    const date = String(transaction.date || "");
    if (!best || date > best.date) best = { accountId: transaction.accountId, date };
  });
  return best ? best.accountId : null;
}

const STATEMENT_DATE_HEADER = /(?:Statement Date|Opening\/Closing Date)[:\s]+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i;
// No whitespace is guaranteed between the description and the amount - real
// PDF text extraction often runs them together (e.g. "...Amzn.com/bill WA-74.40"
// or "...Amzn.com/bill WA26.28") - so the amount is captured as whatever
// trailing signed-decimal token reaches the end of the line, and the
// description is trimmed afterward to drop any run-together whitespace.
const STATEMENT_TRANSACTION_LINE = /^(\d{2})\/(\d{2})\s+(.+?)(-?[\d,]+\.\d{2})$/;
const STATEMENT_ORDER_NUMBER_LINE = /Order Number\s+([\w-]+)/i;
// A credit-card statement's own payoff ("AUTOMATIC PAYMENT - THANK YOU", "ONLINE
// PAYMENT, THANK YOU") is money moving from a bank account to pay down the
// card, not a purchase or a refund of one - it belongs in a transfer between
// accounts (if the household tracks that), never as a spend/refund line item.
const STATEMENT_PAYMENT_DESCRIPTION = /payment.*thank you|automatic payment|online payment|electronic payment|internet payment|autopay|auto-pmt/i;

function statementReferenceYear(text) {
  const match = String(text || "").match(STATEMENT_DATE_HEADER);
  if (!match) return new Date().getFullYear();
  const year = match[3];
  return year.length === 2 ? Number(`20${year}`) : Number(year);
}

function statementReferenceMonth(text) {
  const match = String(text || "").match(STATEMENT_DATE_HEADER);
  return match ? Number(match[1]) : new Date().getMonth() + 1;
}

// A statement dated e.g. January can list a December transaction (prior
// year) or, less commonly, a very early-in-cycle statement can list a
// transaction that already rolled into the next year - handles both
// directions of the wraparound rather than assuming the statement's own year.
function statementTransactionYear(month, referenceYear, referenceMonth) {
  if (month - referenceMonth > 6) return referenceYear - 1;
  if (referenceMonth - month > 6) return referenceYear + 1;
  return referenceYear;
}

// Extracts transactions from a credit-card statement's plain text (already
// run through PDF-to-text extraction upstream). Unlike a checking-account
// CSV (parseBankCsvTransactions), a credit card's sign convention is
// inverted: a purchase increases what's owed (kept positive, same as this
// app's normal spend amount), while a refund reduces it (kept negative) -
// spentByLine() and accountBalance() both sum transaction.amount directly,
// so a negative refund nets against its original purchase automatically,
// with no special cancellation logic needed. Every "Order Number" line
// immediately following a transaction row is captured as that row's
// orderNumber, so a refund landing in a LATER, separately-imported statement
// can still be matched back to its original purchase by order number alone
// (the caller is expected to cross-reference orderNumber against previously
// imported/accepted transactions - this function only extracts rows).
function parseCreditCardStatementText(text) {
  const source = String(text || "");
  const referenceYear = statementReferenceYear(source);
  const referenceMonth = statementReferenceMonth(source);
  const lines = source.split("\n").map((line) => line.trim());
  const results = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(STATEMENT_TRANSACTION_LINE);
    if (!match) continue;
    const [, month, day, description, amountText] = match;
    const payee = description.trim();
    if (!payee) continue;
    const amount = Number(amountText.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount === 0) continue;
    const year = statementTransactionYear(Number(month), referenceYear, referenceMonth);
    const date = `${year}-${month}-${day}`;
    let orderNumber = "";
    const nextLine = lines[i + 1];
    const orderMatch = nextLine && nextLine.match(STATEMENT_ORDER_NUMBER_LINE);
    if (orderMatch) {
      orderNumber = orderMatch[1];
      i += 1;
    }
    // A payoff/autopay row (money moving from a bank account to pay this
    // card down, not a purchase or refund) used to be dropped here entirely
    // - kept now, flagged, so it lands in Bank Stream where Move to
    // Transfers is the correct next step instead of the row vanishing with
    // no way to see or reconcile it.
    const flags = STATEMENT_PAYMENT_DESCRIPTION.test(payee) ? { isPayment: true } : {};
    results.push({ date, payee, amount, orderNumber, ...flags });
  }
  return results;
}

// A checking/deposit account's "Account Activity" print export (e.g. Bank of
// America's Online Banking > Deposit > Print Transaction Details) is a
// completely different shape from a credit-card monthly statement: a Posting
// date/Description/Type/Amount/Available balance table printed straight from
// a web page, so every page repeats the column header plus a footer/URL/
// page-number line, and a not-yet-posted item shows the literal word
// "Processing" instead of a date. PDF text extraction also wraps a long
// description onto its own line before the Type/Amount columns reach it
// (rejoined below with a single space), but real-world extraction (verified
// against pdf-parse's actual output, not just how a PDF viewer renders it)
// glues adjacent table cells with NO whitespace at all when they land on the
// same source line - "ProcessingPAYMENT TO ACCT #1657Debit-$59.99$2,107.53"
// - so every cell boundary below is \s* (zero-or-more), never \s+, and
// records are recovered by scanning the whole (noise-stripped, rejoined)
// text for "date-or-Processing ... Type Amount Balance" rather than
// assuming one record per source line or any guaranteed separator.
const CHECKING_ACTIVITY_HEADER = /Posting date\s*Description\s*Type\s*Amount\s*Available balance/i;
const CHECKING_ACTIVITY_NOISE_LINE = /^(Posting date\s*Description\s*Type\s*Amount\s*Available balance|Statement as of \d{1,2}\/\d{1,2}\/\d{4}|Balance Summary:.*|View:\s*today:.*|Transactions|BANK OF AMERICA|https?:\/\/\S+.*|.*Bank of America \| Online Banking.*|.*:\s*Account Activity)$/i;
// Multi-word type values are listed first so the alternation can't stop
// early on a shared prefix with a later, shorter alternative.
const CHECKING_ACTIVITY_TYPES = ["Bill Pay", "Other Payment", "Virtual Card", "Bank Charge", "Debit", "Credit", "Transfer", "Deposit", "Withdrawal"];
const CHECKING_ACTIVITY_RECORD = new RegExp(
  `(Processing|\\d{2}\\/\\d{2}\\/\\d{4})\\s*([\\s\\S]+?)\\s*(${CHECKING_ACTIVITY_TYPES.join("|")})\\s*(-?\\$[\\d,]+\\.\\d{2})\\s*\\$[\\d,]+\\.\\d{2}`,
  "g"
);

function usSlashDateToDateKey(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return "";
  const [, month, day, year] = match;
  return `${year}-${month}-${day}`;
}

// A "Processing" row hasn't posted yet, so it carries no real date at all -
// rather than dropping it (invisible until the household happens to
// re-upload once it posts, an easy transaction to simply lose track of) it's
// imported now dated today and flagged isPending, so Bank Stream can badge
// it and the household can correct the date once the bank assigns one.
function parseCheckingAccountActivityText(text, todayDateKey) {
  const today = todayDateKey || new Date().toISOString().slice(0, 10);
  const source = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !CHECKING_ACTIVITY_NOISE_LINE.test(line))
    .join(" ");
  const results = [];
  CHECKING_ACTIVITY_RECORD.lastIndex = 0;
  let match;
  while ((match = CHECKING_ACTIVITY_RECORD.exec(source))) {
    const [, postingToken, descriptionRaw, , amountText] = match;
    const payee = descriptionRaw.replace(/\s+/g, " ").trim();
    if (!payee) continue;
    const rawAmount = Number(amountText.replace(/[$,]/g, ""));
    if (!Number.isFinite(rawAmount) || rawAmount === 0) continue;
    const isPending = postingToken === "Processing";
    const date = isPending ? today : usSlashDateToDateKey(postingToken);
    if (!date) continue;
    // This app's own sign convention is spend-positive/income-negative (the
    // opposite of the printed table, which is money-out-negative) - the same
    // flip parseBankCsvTransactions above makes for a checking CSV export.
    const amount = -rawAmount;
    const flags = {
      ...(rawAmount > 0 ? { isDeposit: true } : {}),
      ...(STATEMENT_PAYMENT_DESCRIPTION.test(payee) ? { isPayment: true } : {}),
      ...(isPending ? { isPending: true } : {})
    };
    results.push(Object.keys(flags).length ? { date, payee, amount, ...flags } : { date, payee, amount });
  }
  return results;
}

// Auto-detects which statement shape a PDF's extracted text is (a checking/
// deposit account's "Account Activity" print export vs. a credit-card
// monthly statement) from the column-header signature alone, so the same
// upload button/endpoint handles either without the household having to know
// or pick a statement type up front.
function parseBankStatementPdfText(text) {
  return CHECKING_ACTIVITY_HEADER.test(String(text || ""))
    ? parseCheckingAccountActivityText(text)
    : parseCreditCardStatementText(text);
}

function normalizeTag(tag) {
  return String(tag || "").trim().toLowerCase();
}

// Groups every transaction that has at least one tag by that tag, across all
// months and categories - the whole point of a tag like "Florida trip" is to
// cut across the normal category/subcategory split. Matching is case/whitespace
// insensitive ("Florida Trip" and "florida trip" are the same group) so a typo
// on a later entry doesn't silently split one trip into two groups; the first
// casing seen is kept as the display label. A transaction with multiple tags
// counts toward each of its groups.
function groupTransactionsByTag(transactions) {
  const groups = new Map();
  (transactions || []).forEach((transaction) => {
    (transaction.tags || []).forEach((rawTag) => {
      const key = normalizeTag(rawTag);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, { key, label: String(rawTag).trim(), total: 0, transactions: [] });
      const group = groups.get(key);
      group.total += Number(transaction.amount || 0);
      group.transactions.push(transaction);
    });
  });
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const recurringBudgetFrequencyMonths = {
  monthly: 1,
  quarterly: 3,
  yearly: 12
};

function compareMonthKeys(left, right) {
  return String(left || "").localeCompare(String(right || ""));
}

function dateKeyToMonthKey(value) {
  return String(value || "").slice(0, 7);
}

// Every calendar month key (YYYY-MM) touched by [startDateKey, endDateKey],
// inclusive - the one function a "month", "date range", and "whole year"
// report scope can all funnel through: a single month is just the
// one-element case, and a year is startDateKey/endDateKey set to Jan 1/Dec 31.
function monthKeysInRange(startDateKey, endDateKey) {
  const startMonth = dateKeyToMonthKey(startDateKey);
  const endMonth = dateKeyToMonthKey(endDateKey);
  if (!startMonth || !endMonth || compareMonthKeys(startMonth, endMonth) > 0) return [];
  const keys = [];
  let [year, month] = startMonth.split("-").map(Number);
  let cursor = `${year}-${String(month).padStart(2, "0")}`;
  while (compareMonthKeys(cursor, endMonth) <= 0) {
    keys.push(cursor);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    cursor = `${year}-${String(month).padStart(2, "0")}`;
  }
  return keys;
}

// Same accounting spentByLine has always done (sum transactions on a line,
// no sign/abs assumptions so a refund still nets correctly), just for an
// arbitrary month instead of always the currently-viewed one - lets a report
// compute actual spend for any past month without touching app state.
//
// A split transaction (transaction.splits: [{lineId, amount}]) has no single
// lineId of its own - each split's own amount counts toward its own line
// instead of the whole transaction counting toward one line, so splitting a
// $120 grocery run into $80 Food + $40 Household correctly credits each
// category its own share rather than double-counting or picking one line
// arbitrarily.
function spentByLineInMonth(transactions, lineId, monthKey) {
  return (transactions || [])
    .filter((transaction) => dateKeyToMonthKey(transaction.date) === monthKey)
    .reduce((sum, transaction) => {
      if (transaction.splits?.length) {
        return sum + transaction.splits.filter((split) => split.lineId === lineId).reduce((splitSum, split) => splitSum + Number(split.amount || 0), 0);
      }
      return transaction.lineId === lineId ? sum + Number(transaction.amount || 0) : sum;
    }, 0);
}

function addMonthsClamped(date, months) {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + months + 1, 0).getDate();
  return new Date(date.getFullYear(), date.getMonth() + months, Math.min(date.getDate(), lastDay));
}

function monthsUntilDueInclusive(selectedMonth, dueDateKey) {
  if (!selectedMonth || !dueDateKey) return 1;
  const [selectedYear, selectedMonthNumber] = selectedMonth.split("-").map(Number);
  const [dueYear, dueMonthNumber] = dueDateKey.slice(0, 7).split("-").map(Number);
  if (!selectedYear || !selectedMonthNumber || !dueYear || !dueMonthNumber) return 1;
  return Math.max(1, (dueYear - selectedYear) * 12 + (dueMonthNumber - selectedMonthNumber) + 1);
}

function nextRecurringBudgetDueDate(bill, selectedMonth) {
  if (!bill?.dueDate || !selectedMonth) return "";
  const interval = recurringBudgetFrequencyMonths[bill.frequency] || 12;
  const anchor = parseDateKey(bill.dueDate);
  let cursor = anchor;
  while (compareMonthKeys(dateKeyToMonthKey(formatDateKeyFromDate(cursor)), selectedMonth) < 0) {
    cursor = addMonthsClamped(cursor, interval);
  }
  // A stored due date can also sit more than one interval ahead of the
  // selected month (e.g. someone picked the wrong year) - pull it back to
  // the nearest occurrence on or after selectedMonth instead of leaving it
  // wherever the anchor happened to land, so "months to save" reflects the
  // bill that's actually coming up next rather than some future repeat.
  let earlier = addMonthsClamped(cursor, -interval);
  while (compareMonthKeys(dateKeyToMonthKey(formatDateKeyFromDate(earlier)), selectedMonth) >= 0) {
    cursor = earlier;
    earlier = addMonthsClamped(cursor, -interval);
  }
  return formatDateKeyFromDate(cursor);
}

function recurringBudgetSetAside(bill, selectedMonth) {
  const amountDue = Math.max(0, Number(bill?.amount || 0));
  const frequency = recurringBudgetFrequencyMonths[bill?.frequency] ? bill.frequency : "yearly";
  const nextDueDate = nextRecurringBudgetDueDate({ ...bill, frequency }, selectedMonth);
  const monthsRemaining = monthsUntilDueInclusive(selectedMonth, nextDueDate);
  return {
    amountDue,
    frequency,
    nextDueDate,
    monthsRemaining,
    monthlyAmount: Number((amountDue / Math.max(monthsRemaining, 1)).toFixed(2))
  };
}

// Balances are always computed from an account's opening balance plus every
// movement that references it, never stored as a separately-mutable number,
// so a linked pair (e.g. Checking + Credit Card) can never drift apart.
// referenceDateKey bounds every movement type (transactions, transfers, and
// paycheck occurrences), not just deposits, so this can also answer "what was
// this account worth as of a past date" for a historical trend, not only
// "what is it worth right now" (its only caller until the Reports net worth
// trend needed a real past-date query).
function accountBalance(accountId, { accounts, transactions, paychecks, paycheckOccurrences, transfers, ious }, referenceDateKey) {
  const account = (accounts || []).find((item) => item.id === accountId);
  if (!account) return 0;
  const isLiability = account.type === "credit_card";

  const purchases = (transactions || [])
    .filter((transaction) => transaction.accountId === accountId && transaction.date <= referenceDateKey)
    .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  // Recurring paychecks deposit through materialized occurrence rows (one per
  // actual payday, individually editable/deletable), not recurrence math -
  // only genuinely one-time/bonus paychecks still use paycheckOccurrencesSince.
  const oneTimeDeposits = (paychecks || [])
    .filter((paycheck) => paycheck.depositAccountId === accountId && ["once", "bonus"].includes(paycheck.recurrence || "once"))
    .reduce((sum, paycheck) => sum + Number(paycheck.amount || 0) * paycheckOccurrencesSince(paycheck, referenceDateKey), 0);
  const recurringDeposits = (paycheckOccurrences || [])
    .filter((occurrence) => occurrence.depositAccountId === accountId && occurrence.date <= referenceDateKey)
    .reduce((sum, occurrence) => sum + Number(occurrence.amount || 0), 0);
  const deposits = oneTimeDeposits + recurringDeposits;
  const transfersOut = (transfers || [])
    .filter((transfer) => transfer.fromAccountId === accountId && transfer.date <= referenceDateKey)
    .reduce((sum, transfer) => sum + Number(transfer.amount || 0), 0);
  const transfersIn = (transfers || [])
    .filter((transfer) => transfer.toAccountId === accountId && transfer.date <= referenceDateKey)
    .reduce((sum, transfer) => sum + Number(transfer.amount || 0), 0);
  const opening = Number(account.openingBalance || 0);

  if (isLiability) {
    // Owed = opening + purchases charged to the card - payments received (a transfer INTO the card pays it down).
    return opening + purchases - transfersIn;
  }
  // Borrowing money is real cash landing in this account the moment it's
  // recorded (you now hold it, and owe it back); a split expense you already
  // paid separately doesn't touch this account until the friend actually
  // pays you back. Settling either direction is the matching opposite
  // movement, dated by settledDate rather than the IOU's original date.
  const iouCashFlow = (ious || [])
    .filter((iou) => iou.accountId === accountId)
    .reduce((sum, iou) => {
      let effect = 0;
      if (iou.direction === "i_owe" && iou.date && iou.date <= referenceDateKey) effect += Number(iou.amount || 0);
      if (iou.settled && iou.settledDate && iou.settledDate <= referenceDateKey) {
        effect += iou.direction === "i_owe" ? -Number(iou.amount || 0) : Number(iou.amount || 0);
      }
      return sum + effect;
    }, 0);
  // Cash = opening + deposits - purchases paid directly from this account - transfers out + transfers in + IOU cash flow.
  return opening + deposits - purchases - transfersOut + transfersIn + iouCashFlow;
}

function accountsWithBalances(state, referenceDateKey) {
  const accounts = state?.accounts || [];
  const context = {
    accounts,
    transactions: state?.transactions || [],
    paychecks: state?.paychecks || [],
    paycheckOccurrences: state?.paycheckOccurrences || [],
    transfers: state?.transfers || [],
    ious: state?.ious || []
  };
  return accounts.map((account) => ({ ...account, balance: accountBalance(account.id, context, referenceDateKey) }));
}

function monthEndDateKey(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return `${monthKey}-${String(lastDay).padStart(2, "0")}`;
}

// Holding-class items (stock/retirement) normally price out as shares *
// price, but a retirement account can also be a flat legacy entry from
// before grouped holdings existed (just a dollar value, no shares field at
// all) - those still need to read .value directly, so this only takes the
// shares * price path once shares is actually set to something.
function assetValue(item) {
  if (isHoldingAssetClass(item.assetClass) && Number(item.shares || 0) > 0) {
    return Math.max(0, Number(item.shares || 0)) * Math.max(0, Number(item.price || 0));
  }
  return Math.max(0, Number(item.value || 0));
}

function computeTrailingMonthKeys(currentMonthKey, count) {
  const [year, month] = currentMonthKey.split("-").map(Number);
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(year, month - 1 - i, 1);
    keys.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

// The Reports page's own scope-aware version of a per-category spend report:
// sums spentByLineInMonth across every month in the given range (falling
// back to the trailing 6 months when the scope covers everything), and
// breaks each category down into its subcategory (line) totals for
// drilldown - zero-spend subcategories are left out as noise.
function computeReportCategoriesForScope(state, monthKeys) {
  const categories = state?.budget?.categories || [];
  const transactions = state?.transactions || [];
  const effectiveMonthKeys = monthKeys.length ? monthKeys : computeTrailingMonthKeys(state?.budget?.month, 6);
  const lineTotal = (lineId) => effectiveMonthKeys.reduce((sum, monthKey) => sum + spentByLineInMonth(transactions, lineId, monthKey), 0);
  const withLines = categories.map((category) => {
    const lines = category.lines
      .map((line) => ({ id: line.id, name: line.name, value: lineTotal(line.id) }))
      .filter((line) => line.value !== 0);
    const value = category.lines.reduce((sum, line) => sum + lineTotal(line.id), 0);
    return { name: category.name, color: category.color, value, lines };
  });
  const max = Math.max(...withLines.map((category) => category.value), 1);
  return withLines.map((category) => ({ ...category, percent: Math.max(2, Math.round((category.value / max) * 100)) }));
}

// Net worth "as of" a past date, reconstructed rather than stored: a linked
// account's historical balance comes straight from accountBalance (real
// transaction/paycheck/transfer history), while an unlinked net-worth item
// (e.g. property, no transaction history behind it) has no way to know what
// it was worth in the past, so its current value is carried flat across the
// whole trend - an honest approximation given what data actually exists.
function computeNetWorthAtDate(state, referenceDateKey) {
  const context = {
    accounts: state?.accounts || [],
    transactions: state?.transactions || [],
    paychecks: state?.paychecks || [],
    paycheckOccurrences: state?.paycheckOccurrences || [],
    transfers: state?.transfers || [],
    ious: state?.ious || []
  };
  const assets = state?.goals?.netWorth?.assets || [];
  const liabilities = state?.goals?.netWorth?.liabilities || [];
  const assetTotal = assets.reduce((sum, asset) => {
    const linkedAccount = context.accounts.find((account) => account.netWorthAssetId === asset.id);
    return sum + (linkedAccount ? accountBalance(linkedAccount.id, context, referenceDateKey) : assetValue(asset));
  }, 0);
  const liabilityTotal = liabilities.reduce((sum, liability) => {
    const linkedAccount = context.accounts.find((account) => account.netWorthLiabilityId === liability.id);
    return sum + (linkedAccount ? accountBalance(linkedAccount.id, context, referenceDateKey) : Number(liability.value || 0));
  }, 0);
  return assetTotal - liabilityTotal;
}

function computeNetWorthTrend(state, monthKeys) {
  return monthKeys.map((monthKey) => ({ month: monthKey, value: computeNetWorthAtDate(state, monthEndDateKey(monthKey)) }));
}

function computeCashFlowByMonth(state, monthKeys) {
  const transactions = state?.transactions || [];
  const paychecks = state?.paychecks || [];
  const paycheckOccurrences = state?.paycheckOccurrences || [];
  return monthKeys.map((monthKey) => {
    const monthStart = `${monthKey}-01`;
    const monthEnd = monthEndDateKey(monthKey);
    const expenses = transactions
      .filter((transaction) => transaction.date >= monthStart && transaction.date <= monthEnd)
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    const oneTimeIncome = paychecks
      .filter((paycheck) => ["once", "bonus"].includes(paycheck.recurrence || "once"))
      .reduce((sum, paycheck) => sum + Number(paycheck.amount || 0) * paycheckOccurrencesInRange(paycheck, monthStart, monthEnd), 0);
    const recurringIncome = paycheckOccurrences
      .filter((occurrence) => occurrence.date >= monthStart && occurrence.date <= monthEnd)
      .reduce((sum, occurrence) => sum + Number(occurrence.amount || 0), 0);
    return { month: monthKey, income: oneTimeIncome + recurringIncome, expenses };
  });
}

// Builds the ordered list of destinations a Sankey-style breakdown flows
// income into: each category with real spend (largest first), plus a
// trailing "Savings" segment for whatever's left of income after expenses -
// omitted entirely (not shown as zero/negative) once spend meets or exceeds
// income, since there's nothing left to show.
// Budget categories have no id of their own (only their lines do), and
// category names aren't guaranteed unique, so a segment's own set of line
// ids doubles as its drill-down key - naturally unique per segment and
// exactly the set needed to filter matching transactions anyway.
function sankeyFlowSegments(categories, totalIncome, totalExpenses) {
  const segments = categories
    .filter((category) => category.value > 0)
    .map((category) => ({
      label: category.name,
      value: category.value,
      color: category.color,
      lineIds: category.lines.map((line) => line.id),
      children: category.lines
        .filter((line) => line.value > 0)
        .map((line) => ({ label: line.name, value: line.value, lineId: line.id }))
        .sort((a, b) => b.value - a.value)
    }))
    .sort((a, b) => b.value - a.value);
  const savings = totalIncome - totalExpenses;
  // Savings has no backing category/lines - it's whatever's left of income
  // after expenses, not a real spending bucket - so it's shown but not
  // drill-down-able like the real category segments above it, and has no
  // subcategory breakdown of its own.
  if (savings > 0) segments.push({ label: "Savings", value: savings, color: "#13936d", lineIds: [], children: [] });
  return segments;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    applyChecklistToggle, bucketChecklistItems, findChecklistDuplicate, moveChecklistItem, moveArrayItemById, moveNetWorthAssetBlock, groupStockHoldings, isHoldingAssetClass, assetClassLabelForHoldings, holdingGainLoss, groupGainLoss, debtPayoffProgressPercent, mealWeeksForMonth, currentMealWeekNumber, groupPlanTasksByBucket, validateJournalPayload,
    dailyTaskOccursOnDate, isDailyTaskDoneOnDate, toggleDailyTaskDoneOnDate,
    timeToMinutes, minutesToTime, snapMinutes, layoutTimelineBlocks, comparePlannedToActual,
    sanitizeFilename, buildDocumentObjectPath, wouldCreateFolderCycle, buildFolderTree, collectDescendantFolderIds,
    SMS_CARRIERS, smsGatewayAddress,
    paycheckOccurrencesSince, paycheckOccurrencesInRange, paycheckAllOccurrenceDatesInRange, recurringExpenseOccurrenceDates, accountBalance, accountsWithBalances,
    monthEndDateKey, assetValue, computeTrailingMonthKeys, computeReportCategoriesForScope, computeNetWorthAtDate, computeNetWorthTrend, computeCashFlowByMonth, sankeyFlowSegments,
    splitAmountEvenly, splitBillByPercentages, splitBillByShares, normalizePersonName, netBalancesByPerson, computeBillSplitAmounts, settleUpPersonIous, isValidEmail,
    parseDelimitedText, parseBankCsvTransactions, normalizeForAccountMatch, matchAccountByFilename, matchAccountByHints, extractAccountActivityLabel, isDuplicateTransaction, findTransferCandidate,
    orderRefundMatch, normalizeForPayeeMatch, payeesFuzzyMatch, refundFuzzyMatch, refundMatch, suggestSubcategoryFromHistory, suggestAccountFromHistory, payeeCategorizationConfidence,
    parseCreditCardStatementText, parseCheckingAccountActivityText, parseBankStatementPdfText,
    normalizeTag, groupTransactionsByTag,
    monthKeysInRange, spentByLineInMonth,
    recurringBudgetSetAside, nextRecurringBudgetDueDate, monthsUntilDueInclusive,
    annualEventDate, nextAnnualEventDate, annualEventNotifyAt, rollAnnualNotifyAtForward,
    formatDateKeyFromDate, isChoreOccurrenceComplete, isChoreOccurrencePendingFor, nextPendingChoreOccurrence, currentChoreOccurrenceDate, zonedTimeToUtcIso, choreNotifyAt,
    CHORE_MONTH_STEP_BY_RECURRENCE
  };
}
