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

const CSV_DATE_HEADERS = ["date", "transaction date", "posted date", "trans date"];
const CSV_PAYEE_HEADERS = ["description", "payee", "merchant", "name"];
const CSV_AMOUNT_HEADERS = ["amount"];
const CSV_DEBIT_HEADERS = ["debit"];

// Bank exports vary in two ways this handles: (1) some files bury the real
// transaction table below a summary block (e.g. a beginning/ending balance
// recap) — rather than assuming row 0 is the header, this scans for the
// first row that actually looks like one; (2) some use a single signed
// Amount column (negative = money out), others split Debit/Credit into
// separate columns. Either way, only money leaving the account imports as a
// spend transaction — a payment, refund, or deposit is a credit, not
// something to categorize in the budget, so those rows are skipped.
function parseBankCsvTransactions(text) {
  const rows = parseDelimitedText(text).filter((row) => row.some((cell) => String(cell || "").trim() !== ""));
  const headerIndex = rows.findIndex((row) => {
    const cells = row.map((cell) => String(cell || "").trim().toLowerCase());
    const hasDate = cells.some((cell) => CSV_DATE_HEADERS.includes(cell));
    const hasPayee = cells.some((cell) => CSV_PAYEE_HEADERS.includes(cell));
    const hasAmount = cells.some((cell) => CSV_AMOUNT_HEADERS.includes(cell) || CSV_DEBIT_HEADERS.includes(cell));
    return hasDate && hasPayee && hasAmount;
  });
  if (headerIndex === -1) return [];
  const header = rows[headerIndex].map((cell) => String(cell || "").trim().toLowerCase());
  const dateIndex = header.findIndex((cell) => CSV_DATE_HEADERS.includes(cell));
  const payeeIndex = header.findIndex((cell) => CSV_PAYEE_HEADERS.includes(cell));
  const amountIndex = header.findIndex((cell) => CSV_AMOUNT_HEADERS.includes(cell));
  const debitIndex = header.findIndex((cell) => CSV_DEBIT_HEADERS.includes(cell));
  const results = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const date = normalizeCsvDate(row[dateIndex]);
    const payee = String(row[payeeIndex] || "").trim();
    let amount = NaN;
    if (debitIndex !== -1) {
      const debitValue = parseCsvAmount(row[debitIndex]);
      if (Number.isFinite(debitValue) && debitValue > 0) amount = debitValue;
    } else if (amountIndex !== -1) {
      const signedValue = parseCsvAmount(row[amountIndex]);
      if (Number.isFinite(signedValue) && signedValue < 0) amount = Math.abs(signedValue);
    }
    if (date && payee && Number.isFinite(amount) && amount > 0) results.push({ date, payee, amount });
  }
  return results;
}

function normalizeForAccountMatch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Matches a CSV's filename against an account by name — e.g. an export
// named "Costco Citi Jul 142026.CSV" should land on an account named
// "Costco Citi" without the household having to rename anything. Strips the
// extension, then normalizes both sides (lowercase, punctuation/spaces
// removed) and checks either containing the other, so a longer filename
// with extra words (dates, statement numbers) still matches a shorter
// account name and vice versa.
function matchAccountByFilename(filename, accounts) {
  const base = String(filename || "").replace(/\.[^.]+$/, "");
  const normalized = normalizeForAccountMatch(base);
  if (!normalized) return null;
  return (accounts || []).find((account) => {
    const accountNormalized = normalizeForAccountMatch(account.name);
    return accountNormalized && (normalized.includes(accountNormalized) || accountNormalized.includes(normalized));
  }) || null;
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    applyChecklistToggle, bucketChecklistItems, findChecklistDuplicate, mealWeeksForMonth, groupPlanTasksByBucket, validateJournalPayload,
    dailyTaskOccursOnDate, isDailyTaskDoneOnDate, toggleDailyTaskDoneOnDate,
    timeToMinutes, minutesToTime, snapMinutes, layoutTimelineBlocks, comparePlannedToActual,
    sanitizeFilename, buildDocumentObjectPath, wouldCreateFolderCycle, buildFolderTree,
    SMS_CARRIERS, smsGatewayAddress,
    paycheckOccurrencesSince, paycheckOccurrencesInRange, paycheckAllOccurrenceDatesInRange, recurringExpenseOccurrenceDates, accountBalance, accountsWithBalances,
    splitAmountEvenly,
    parseDelimitedText, parseBankCsvTransactions, normalizeForAccountMatch, matchAccountByFilename, isDuplicateTransaction,
    recurringBudgetSetAside, nextRecurringBudgetDueDate, monthsUntilDueInclusive,
    annualEventDate, nextAnnualEventDate, annualEventNotifyAt, rollAnnualNotifyAtForward
  };
}
