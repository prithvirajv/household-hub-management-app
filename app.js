const views = [
  ["home", "Home", "◈"],
  ["budget", "Budget", "▦"],
  ["transactions", "Transactions", "☰"],
  ["paychecks", "Paycheck/Income", "☑"],
  ["calendar", "Calendar", "⌂"],
  ["notes", "Notes", "✎"],
  ["journal", "Journal", "✒"],
  ["plan", "Plan", "◫"],
  ["documents", "Documents", "▢"],
  ["decisions", "Decisions", "⚖"],
  ["meals", "Meals", "♨"],
  ["recipes", "Recipes", "▤"],
  ["goals", "Goals", "◎"],
  ["wealth", "Wealth", "▥"],
  ["sharing", "Sharing", "♙"],
  ["reports", "Reports", "◷"],
  ["profile", "Profile", "◍"],
  ["help", "Help", "?"],
  ["admin", "Admin", "⚙"]
];

let state = null;
let sessionUser = null;
let adminData = null;
let sharingAccess = null;
let sharedCalendarMembers = [];
let households = [];
let countryCatalog = [];
let currentView = "home";
let autosaveTimer = null;
let inviteEmailStatus = "";
let googleSignInInitialized = false;
let calendarFilterOwner = "";
let calendarFeedback = "";
// Kept out of state (like calendarFeedback) so a confirmation message never
// gets saved into the shared household blob and replayed for every login.
let mealsFeedback = "";
let profileNameFeedback = "";
let profileNameFeedbackIsError = false;
let profilePasswordFeedback = "";
let profilePasswordFeedbackIsError = false;
let profileVerifyFeedback = "";
let profileVerifyFeedbackIsError = false;
// Keyed by asset id (not index, since rows can reorder/delete) so a stale
// "Refresh price" result never gets attributed to the wrong stock row.
let stockPriceFeedback = {};
// privateData is scoped to the signed-in user (not the household) and is never part
// of `state` or autosaveState() — it must never reach the shared household blob.
let privateData = null;
let journalTimer = null;
let planTimer = null;
// documentsData is household-shared (like Notes/Calendar), backed by real Postgres
// rows and Google Cloud Storage, not part of `state`/autosaveState().
let documentsData = null;
let documentsCurrentFolderId = null;
let documentsUploading = false;
let documentsDragPayload = null;
let wealthDocsExpandedKey = null;

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function migrateInitialMonth() {
  if (!state?.budget || state.budget.monthPreferenceSet) return false;
  state.budget.month = currentMonthKey();
  state.budget.monthPreferenceSet = true;
  return true;
}

const formatterCache = new Map();
function currencyFormatter(exact = false) {
  const currency = state?.household?.currency || "USD";
  const locale = currency === "INR" ? "en-IN" : "en-US";
  const key = `${locale}:${currency}:${exact}`;
  if (!formatterCache.has(key)) {
    formatterCache.set(key, new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: exact ? 2 : 0,
      minimumFractionDigits: exact ? 2 : 0
    }));
  }
  return formatterCache.get(key);
}
const money = { format: (value) => currencyFormatter(false).format(Number(value || 0)) };
const exactMoney = { format: (value) => currencyFormatter(true).format(Number(value || 0)) };
const $ = (selector) => document.querySelector(selector);
const nav = $("#nav");
const view = $("#view");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function initialsFromName(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const initials = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0];
  return initials.toUpperCase();
}

async function handleAuthExpired() {
  state = null;
  sessionUser = null;
  adminData = null;
  sharingAccess = null;
  households = [];
  document.body.classList.add("auth-mode");
  $("#householdWorkspaceControl").hidden = true;
  $("#workspace").hidden = true;
  $("#authPanel").hidden = false;
  showSigninForm();
  $("#authMessage").textContent = "Your session expired. Please sign in again.";
}

function api(path, options = {}) {
  return fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options
  }).then(async (response) => {
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      await handleAuthExpired();
    }
    if (!response.ok) throw new Error(body.error || body || "Request failed");
    return body;
  });
}

function autosaveState() {
  if (!state) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    api("/api/state", { method: "PUT", body: JSON.stringify(state) }).catch((error) => {
      console.warn("Autosave failed", error);
    });
  }, 350);
}

async function saveStateNow() {
  if (!state) return;
  clearTimeout(autosaveTimer);
  await api("/api/state", { method: "PUT", body: JSON.stringify(state) });
}

function autosaveJournal() {
  if (!privateData) return;
  clearTimeout(journalTimer);
  journalTimer = setTimeout(() => {
    api("/api/private-data/journal", { method: "PUT", body: JSON.stringify(privateData.journal) }).catch((error) => {
      console.warn("Journal autosave failed", error);
    });
  }, 350);
}

function autosavePlans() {
  if (!privateData) return;
  clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    api("/api/private-data/plans", { method: "PUT", body: JSON.stringify(privateData.plans) }).catch((error) => {
      console.warn("Plan autosave failed", error);
    });
  }, 350);
}

function allLines() {
  return state.budget.categories.flatMap((category) => category.lines.map((line) => ({ ...line, category: category.name, color: category.color })));
}

function lineName(lineId) {
  return allLines().find((line) => line.id === lineId)?.name || lineId;
}

function lineSnapshot(lineId) {
  const line = allLines().find((item) => item.id === lineId);
  return {
    categoryName: line?.category || "Deleted category",
    subcategoryName: line?.name || lineId || "Deleted subcategory"
  };
}

function transactionAssignmentLabel(transaction) {
  const liveLine = allLines().find((line) => line.id === transaction.lineId);
  const category = liveLine?.category || transaction.categoryName || "Deleted category";
  const subcategory = liveLine?.name || transaction.subcategoryName || transaction.lineId || "Deleted subcategory";
  return `${category} - ${subcategory}`;
}

function makeTransaction({ date, payee, amount, lineId, memo, accountId = "" }) {
  return { date, payee, amount, lineId, memo, accountId, ...lineSnapshot(lineId) };
}

function snapshotTransactionsForLine(line) {
  if (!line) return;
  state.transactions.forEach((transaction) => {
    if (transaction.lineId === line.id) {
      transaction.categoryName = line.category;
      transaction.subcategoryName = line.name;
    }
  });
}

function plannedTotal() {
  return allLines().reduce((sum, line) => sum + Number(line.planned || 0), 0);
}

function paycheckAssignedAmount(paycheck) {
  return paycheck.assignedLineIds.reduce((sum, id) => sum + (allLines().find((line) => line.id === id)?.planned || 0), 0);
}

function spentByLine(lineId) {
  return state.transactions.filter((transaction) => transaction.lineId === lineId).reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
}

function spentTotal() {
  return state.transactions.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
}

function lowerActivityMargin() {
  const lowerActivity = allLines()
    .filter((line) => Number(line.planned || 0) > 0 && spentByLine(line.id) < Number(line.planned || 0) * 0.5);
  const margin = lowerActivity.reduce((sum, line) => sum + (Number(line.planned || 0) - spentByLine(line.id)), 0);
  return { margin, count: lowerActivity.length };
}

function tightestBudgetLine() {
  const candidates = allLines()
    .filter((line) => Number(line.planned || 0) > 0)
    .map((line) => ({ line, remaining: Number(line.planned || 0) - spentByLine(line.id) }));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => a.remaining - b.remaining)[0];
}

function unassignedTransactionSummary() {
  const items = transactionInboxItems().filter((item) => !(state.transactionInboxDone || []).includes(item.id));
  return { count: items.length, payees: items.map((item) => item.payee) };
}

function billAndGoalReminders() {
  const dismissed = state.budget.dismissedReminders?.[state.budget.month] || [];
  const billReminders = allLines()
    .filter((line) => line.dueDay && Number(line.planned || 0) > spentByLine(line.id))
    .map((line) => ({
      id: `bill:${line.id}`,
      title: `${line.name} payoff due`,
      detail: `Due day ${line.dueDay} · ${money.format(Number(line.planned || 0) - spentByLine(line.id))} left`
    }));
  const goalReminders = (state.goals?.sinkingFunds || [])
    .filter((fund) => Number(fund.saved || 0) < Number(fund.target || 0))
    .map((fund, index) => ({
      id: `goal:${fund.name || index}`,
      title: `${fund.name || "Goal"} needs funding`,
      detail: `${money.format(Number(fund.target || 0) - Number(fund.saved || 0))} remaining${fund.targetDate ? ` · by ${fund.targetDate}` : ""}`
    }));
  return [...billReminders, ...goalReminders].filter((reminder) => !dismissed.includes(reminder.id));
}

function dismissBudgetReminder(id) {
  state.budget.dismissedReminders ||= {};
  state.budget.dismissedReminders[state.budget.month] ||= [];
  if (!state.budget.dismissedReminders[state.budget.month].includes(id)) {
    state.budget.dismissedReminders[state.budget.month].push(id);
  }
  autosaveState();
  render();
}

function remainingTotal() {
  return state.budget.income - spentTotal();
}

function assetValue(item) {
  if (item.assetClass === "stock") return Math.max(0, Number(item.shares || 0)) * Math.max(0, Number(item.price || 0));
  return Math.max(0, Number(item.value || 0));
}

function netWorth() {
  const assets = state.goals.netWorth.assets.reduce((sum, item) => sum + assetValue(item), 0);
  const liabilities = state.goals.netWorth.liabilities.reduce((sum, item) => sum + Number(item.value || 0), 0);
  return { assets, liabilities, total: assets - liabilities };
}

function refreshNetWorthTotals() {
  const totals = netWorth();
  const total = document.querySelector("[data-net-worth-total]");
  const assets = document.querySelector("[data-net-worth-assets]");
  const liabilities = document.querySelector("[data-net-worth-liabilities]");
  if (total) total.textContent = money.format(totals.total);
  if (assets) assets.textContent = money.format(totals.assets);
  if (liabilities) liabilities.textContent = money.format(totals.liabilities);

  const metrics = $("#metrics");
  if (metrics) {
    metrics.innerHTML = metricsForView().map(([label, value, note]) => `
      <article class="metric">
        <span>${label}</span>
        <strong>${value}</strong>
        ${note ? `<small>${note}</small>` : ""}
      </article>
    `).join("");
  }
}

function ensureDebtNetWorthSync() {
  state.goals.debts ||= [];
  state.goals.netWorth ||= { assets: [], liabilities: [] };
  state.goals.netWorth.assets ||= [];
  state.goals.netWorth.liabilities ||= [];
  state.goals.netWorth.assets.forEach((asset) => {
    asset.id ||= uniqueId(asset.name || "asset");
    asset.assetClass ||= "other";
    if (asset.assetClass === "stock") asset.value = assetValue(asset);
  });
  state.goals.debts.forEach((debt) => {
    debt.rate = Math.max(0, Number(debt.rate || 0));
    debt.minimum = Math.max(0, Number(debt.minimum || 0));
    debt.termMonths = Math.max(0, Math.round(Number(debt.termMonths || 0)));
    debt.payments ||= [];
  });
  if (state.goals.debtNetWorthLinked) return false;

  const linkedDebtIds = new Set();
  state.goals.netWorth.liabilities.forEach((liability) => {
    liability.id ||= uniqueId(liability.name || "liability");
    const debt = state.goals.debts.find((item) =>
      item.id === liability.id || String(item.name).trim().toLowerCase() === String(liability.name).trim().toLowerCase()
    );
    if (debt) {
      debt.id = liability.id;
      debt.name = liability.name;
      debt.balance = Math.max(0, Number(liability.value || 0));
      debt.rate = Math.max(0, Number(debt.rate || 0));
      debt.minimum = Math.max(0, Number(debt.minimum || 0));
    } else {
      state.goals.debts.push({
        id: liability.id,
        name: liability.name,
        balance: Math.max(0, Number(liability.value || 0)),
        rate: 0,
        minimum: 0,
        termMonths: 0,
        payments: []
      });
    }
    linkedDebtIds.add(liability.id);
  });
  state.goals.debts = state.goals.debts.filter((debt) => linkedDebtIds.has(debt.id));
  state.goals.debtNetWorthLinked = true;
  return true;
}

// Unlike ensureDebtNetWorthSync (which links once, then lets the two lists be
// edited independently), a linked account must drive its paired net-worth
// value on every render — the whole point is one computed number, never two
// that can drift apart.
function ensureAccountsData() {
  state.accounts ||= [];
  state.transfers ||= [];
  state.accounts.forEach((account) => {
    account.openingBalance = Number(account.openingBalance || 0);
    account.netWorthAssetId ||= "";
    account.netWorthLiabilityId ||= "";
  });
  state.accounts.forEach((account) => {
    const balance = currentAccountBalance(account.id);
    if (account.netWorthAssetId) {
      const asset = state.goals.netWorth.assets.find((item) => item.id === account.netWorthAssetId);
      if (asset) asset.value = balance;
    }
    if (account.netWorthLiabilityId) {
      const liability = state.goals.netWorth.liabilities.find((item) => item.id === account.netWorthLiabilityId);
      if (liability) liability.value = balance;
    }
  });
}

function currentAccountBalance(accountId) {
  return accountBalance(accountId, {
    accounts: state.accounts,
    transactions: state.transactions,
    paychecks: state.paychecks,
    transfers: state.transfers
  }, dateKey(new Date()));
}

function accountName(accountId) {
  return state.accounts.find((account) => account.id === accountId)?.name || "";
}

function isAccountLinked(type, id) {
  return type === "asset"
    ? state.accounts.some((account) => account.netWorthAssetId === id)
    : state.accounts.some((account) => account.netWorthLiabilityId === id);
}

function accountOptions(selectedId, { excludeType } = {}) {
  return state.accounts
    .filter((account) => !excludeType || account.type !== excludeType)
    .map((account) => `<option value="${account.id}" ${account.id === selectedId ? "selected" : ""}>${escapeHtml(account.name)}</option>`)
    .join("");
}

function suggestedEmi(debt) {
  const balance = Math.max(0, Number(debt.balance || 0));
  const months = Math.max(0, Math.round(Number(debt.termMonths || 0)));
  if (!balance || !months) return 0;
  const monthlyRate = Math.max(0, Number(debt.rate || 0)) / 1200;
  if (!monthlyRate) return balance / months;
  return balance * monthlyRate * ((1 + monthlyRate) ** months) / (((1 + monthlyRate) ** months) - 1);
}

function payoffMonths(debt) {
  const balance = Math.max(0, Number(debt.balance || 0));
  const payment = Math.max(0, Number(debt.minimum || 0));
  if (!balance) return 0;
  if (!payment) return null;
  const monthlyRate = Math.max(0, Number(debt.rate || 0)) / 1200;
  if (!monthlyRate) return Math.ceil(balance / payment);
  if (payment <= balance * monthlyRate) return Infinity;
  return Math.ceil(-Math.log(1 - (monthlyRate * balance / payment)) / Math.log(1 + monthlyRate));
}

function termLabel(months) {
  if (months === null) return "Set an EMI to calculate payoff";
  if (!Number.isFinite(months)) return "EMI does not cover monthly interest";
  if (months === 0) return "Paid off";
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  return [years ? `${years} ${years === 1 ? "year" : "years"}` : "", remainder ? `${remainder} ${remainder === 1 ? "month" : "months"}` : ""].filter(Boolean).join(" ");
}

function liabilityForDebt(debt) {
  return state.goals.netWorth.liabilities.find((liability) => liability.id === debt.id);
}

function debtAssetOptions(debt) {
  return [
    `<option value="">Unsecured / no asset</option>`,
    ...state.goals.netWorth.assets.map((asset) =>
      `<option value="${escapeHtml(asset.id)}" ${debt.assetId === asset.id ? "selected" : ""}>${escapeHtml(asset.name)}</option>`
    )
  ].join("");
}

function monthLabel() {
  return formatMonth(state.budget.month);
}

function formatMonth(monthValue) {
  if (!monthValue) return "";
  const [year, month] = monthValue.split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function availablePreviousBudgets() {
  ensureBudgetHistory();
  const history = state.budgetHistory || [];
  return history
    .filter((budget) => budget.month < state.budget.month && Array.isArray(budget.categories))
    .sort((a, b) => b.month.localeCompare(a.month));
}

function offsetMonth(monthValue, offset) {
  const [year, month] = monthValue.split("-").map(Number);
  const date = new Date(year, month - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function ensureBudgetHistory() {
  state.budgetHistory ||= [];
  if (state.budgetHistory.length > 0) return;
  state.budgetHistory = [-1, -2].map((offset) => ({
    month: offsetMonth(state.budget.month, offset),
    income: state.budget.income,
    categories: cloneBudgetCategories(state.budget.categories)
  }));
}

function cloneBudgetCategories(categories) {
  return JSON.parse(JSON.stringify(categories)).map((category) => ({
    ...category,
    lines: category.lines.map((line) => ({ ...line }))
  }));
}

function copyBudgetFromMonth(month) {
  const source = (state.budgetHistory || []).find((budget) => budget.month === month);
  if (!source) return;
  state.budget.categories = cloneBudgetCategories(source.categories);
  state.budget.income = Number(source.income || state.budget.income || 0);
  state.household.activity.unshift(`Copied budget from ${formatMonth(source.month)} into ${monthLabel()}`);
}

function rememberCurrentBudgetSnapshot() {
  state.budgetHistory ||= [];
  const snapshot = {
    month: state.budget.month,
    income: state.budget.income,
    categories: cloneBudgetCategories(state.budget.categories)
  };
  const existingIndex = state.budgetHistory.findIndex((budget) => budget.month === snapshot.month);
  if (existingIndex >= 0) state.budgetHistory[existingIndex] = snapshot;
  else state.budgetHistory.push(snapshot);
}

function monthDateMin() {
  return `${state.budget.month}-01`;
}

function monthDateMax() {
  const [year, month] = state.budget.month.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return `${state.budget.month}-${String(lastDay).padStart(2, "0")}`;
}

function dueDateValue(dueDay) {
  if (!dueDay) return "";
  return `${state.budget.month}-${String(dueDay).padStart(2, "0")}`;
}

function dueDayFromDate(value) {
  if (!value || !value.startsWith(`${state.budget.month}-`)) return null;
  return Number(value.slice(-2));
}

function formatShortDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatReminderTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function renderNav() {
  nav.innerHTML = views.filter(([key]) => key !== "admin" || sessionUser?.isAdmin).map(([key, label, icon]) => `
    <button class="nav-button ${key === currentView ? "active" : ""}" data-view="${key}" type="button">
      <span>${icon}</span>${label}
    </button>
  `).join("");
}

function renderShell() {
  const title = views.find(([key]) => key === currentView)?.[1] || "Budget";
  const isAdminView = currentView === "admin";
  const isNotesView = currentView === "notes";
  const isHelpView = currentView === "help";
  const isRecipesView = currentView === "recipes";
  const isGoalsView = currentView === "goals";
  const isWealthView = currentView === "wealth";
  const isJournalView = currentView === "journal";
  const isPlanView = currentView === "plan";
  const isDocumentsView = currentView === "documents";
  const isDecisionsView = currentView === "decisions";
  const isProfileView = currentView === "profile";
  const isHomeView = currentView === "home";
  $("#viewTitle").textContent = isAdminView
    ? "Application admin"
    : isHelpView
      ? "Help center"
      : isNotesView
        ? "Household notes"
        : isRecipesView
          ? "Recipe library"
          : isGoalsView
            ? "Financial goals"
            : isWealthView
              ? "Household wealth"
              : isJournalView
                ? "Your journal"
                : isPlanView
                  ? "Your plan"
                  : isDocumentsView
                    ? "Household documents"
                    : isDecisionsView
                      ? "Household decisions"
                      : isProfileView
                        ? "Your profile"
                        : isHomeView
                          ? "Home"
          : `${monthLabel()} plan`;
  $("#householdName").textContent = title.toUpperCase();
  $("#userName").textContent = sessionUser?.name || "Demo User";
  $("#userEmail").textContent = sessionUser?.email || "demo@familyloop.net";
  $("#userInitials").textContent = initialsFromName(sessionUser?.name || "Demo User");
  $("#monthPicker").value = state.budget.month;
  const isMealsView = currentView === "meals";
  $("#mealWeekHeaderControl").hidden = !isMealsView;
  if (isMealsView) {
    ensureMealWeekData();
    $("#mealWeekHeaderSelect").innerHTML = mealWeeksForMonth(state.budget.month).map((week) =>
      `<option value="${week.number}" ${week.number === selectedMealWeek() ? "selected" : ""}>Week ${week.number} · ${week.label}</option>`
    ).join("");
  }
  $("#householdPicker").innerHTML = households.map((household) =>
    `<option value="${household.id}" ${household.selected ? "selected" : ""}>${household.name} · ${household.country}${household.isDefault ? " · Default" : ""}</option>`
  ).join("");
  $("#householdWorkspaceControl").hidden = isAdminView || isHelpView;
  $("#removeHouseholdButton").disabled = households.length <= 1;
  const selectedHousehold = households.find((household) => household.selected);
  $("#defaultHouseholdButton").disabled = Boolean(selectedHousehold?.isDefault);
  $("#defaultHouseholdButton").textContent = selectedHousehold?.isDefault ? "Default household" : "Set as default";
  $(".month-control").hidden = isAdminView || isNotesView || isHelpView || isRecipesView || isGoalsView || isWealthView || isJournalView || isPlanView || isDocumentsView || isDecisionsView || isProfileView || isHomeView;
  $("#syncButton").hidden = isAdminView || isHelpView;
  $("#downloadCsvButton").hidden = isAdminView || isNotesView || isHelpView || isJournalView || isPlanView || isDocumentsView || isDecisionsView || isProfileView || isHomeView;
  renderNav();
  const metrics = metricsForView();
  $("#metrics").hidden = metrics.length === 0;
  $("#metrics").innerHTML = metrics.map(([label, value, note]) => `
    <article class="metric">
      <span>${label}</span>
      <strong>${value}</strong>
      ${note ? `<small>${note}</small>` : ""}
    </article>
  `).join("");
}

function metricsForView() {
  const margin = state.budget.income - plannedTotal();
  const upcoming = scheduleItems().length;
  const groceries = groceryList().length;
  if (currentView === "home") {
    const items = homeActionItems();
    const pastDue = items.filter((item) => item.overdue).length;
    const dueToday = items.length - pastDue;
    const openBillsAndGoals = billAndGoalReminders().length;
    return [["Past due", String(pastDue), "chores, birthdays and reminders"], ["Due today", String(dueToday), "needs action today"], ["Bills & goals", String(openBillsAndGoals), "still open"], ["All caught up", pastDue + dueToday + openBillsAndGoals === 0 ? "Yes" : "Not yet", "across the household"]];
  }
  if (currentView === "calendar") {
    const annualEventsThisMonth = annualEventOccurrencesForMonth().length;
    return [["Chore rotation", String(state.calendar.chores.length), "household chores"], ["Birthdays & anniversaries", String(annualEventsThisMonth), `annual events in ${monthLabel()}`], [`${monthLabel()} events`, String(upcoming), "chores, birthdays, anniversaries and reminders"], ["Shared calendar", "Household", "tasks in every member"]];
  }
  if (currentView === "notes") return [];
  if (currentView === "journal") return [];
  if (currentView === "plan") return [];
  if (currentView === "documents") return [];
  if (currentView === "help") return [];
  if (currentView === "meals") {
    ensureMealWeekData();
    return [["Weekly meals", `${currentMealPlans().length}/28`, `occupied slots in Week ${selectedMealWeek()}`], ["Groceries estimate", money.format(groceryEstimateAmount()), "can post directly to budget"], ["Planned servings", String(plannedServingsTotal()), "people or portions planned"], ["Household plan", "Shared", "meals, recipes and grocery list"]];
  }
  if (currentView === "recipes") return [["Saved recipes", String(state.meals.recipes.length), "available to meal plans"], ["Ingredients", String(new Set(state.meals.recipes.flatMap((recipe) => recipe.ingredients)).size), "unique grocery items"], ["Average protein", `${Math.round(state.meals.recipes.reduce((sum, recipe) => sum + Number(recipe.protein || 0), 0) / Math.max(state.meals.recipes.length, 1))}g`, "per recipe"], ["Household library", "Shared", "available to every member"]];
  if (currentView === "sharing") return [["Invite status", state.household.inviteCode || "Ready", "household invite"], ["Members", String(sharingAccess?.members.length ?? state.household.members.length), "active and invited users"], ["Shared scopes", String(state.household.sharedScopes.length), "workspace modules"], ["Activity", String(state.household.activity.length), "recent household changes"]];
  if (currentView === "reports") return [["Spending", money.format(spentTotal()), "posted transactions"], ["Budget health", money.format(margin), "zero balance target"], ["Savings and debt", money.format(1220), "planned allocation"], ["Cash left", money.format(remainingTotal()), "after ledger"]];
  if (currentView === "goals") return [["Active goals", String(state.goals.sinkingFunds.length), "sinking funds"], ["Saved", money.format(state.goals.sinkingFunds.reduce((sum, fund) => sum + fund.saved, 0)), "across goals"], ["Remaining", money.format(state.goals.sinkingFunds.reduce((sum, fund) => sum + fund.target - fund.saved, 0)), "to targets"]];
  if (currentView === "wealth") return [["Assets", money.format(netWorth().assets), "tracked"], ["Liabilities", money.format(netWorth().liabilities), "tracked"], ["Net worth", money.format(netWorth().total), "current estimate"], ["Debt accounts", String(state.goals.debts.length), "payoff plan"]];
  if (currentView === "admin") return [];
  return [["Income", money.format(state.budget.income), "ready to assign"], ["Assigned", money.format(plannedTotal()), "planned this month"], ["Available", money.format(state.budget.income - plannedTotal()), "left to budget"], ["Overdue", money.format(0), "no urgent items"]];
}

function render() {
  if (!state) return;
  // Captured once per household so the server can format reminder-email due
  // times in the household's own timezone instead of the server container's
  // (see notificationCandidates/formatDueLabel in server/index.js).
  state.household.timeZone ||= Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (currentView === "admin" && !sessionUser?.isAdmin) currentView = "home";
  if (currentView === "wealth") { ensureDebtNetWorthSync(); ensureAccountsData(); }
  renderShell();
  view.innerHTML = (renderers[currentView] || renderers.budget)();
  bindViewEvents();
  if (currentView === "admin" && !adminData) loadAdminData();
  if (["documents", "wealth"].includes(currentView) && !documentsData) loadDocumentsData();
  if (["sharing", "calendar"].includes(currentView) && !sharingAccess) loadSharingAccess();
  if (currentView === "calendar" && sharedCalendarMembers.length === 0) loadCalendarMembers();
  autosaveState();
}

const renderers = {
  home: renderHome,
  budget: renderBudget,
  transactions: renderTransactions,
  paychecks: renderPaychecks,
  calendar: renderCalendar,
  notes: renderNotes,
  journal: renderJournal,
  plan: renderPlan,
  documents: renderDocuments,
  decisions: renderDecisions,
  meals: renderMeals,
  recipes: renderRecipes,
  goals: renderGoals,
  wealth: renderWealth,
  sharing: renderSharing,
  reports: renderReports,
  profile: renderProfile,
  help: renderHelp,
  admin: renderAdmin
};

function renderHome() {
  const items = homeActionItems();
  const billsAndGoals = billAndGoalReminders();
  return `
    <section class="work-grid">
      <div class="main-stack">
        <section class="card">
          <div class="section-head"><div><span class="card-label">Action needed</span><h3>Past due and due today</h3></div></div>
          ${items.length ? items.map((item) => `
            <div class="compact-row ${item.overdue ? "overdue" : ""}">
              <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.kind)} · ${item.overdue ? "Past due" : "Due today"} · ${escapeHtml(item.detail)}</small></div>
              <div class="chore-complete-group">${item.completion}</div>
              <button class="icon-button" data-goto-view="${item.gotoView}" type="button" aria-label="View ${escapeHtml(item.title)} in Calendar">✎</button>
            </div>`).join("") : `<div class="empty-inline">Nothing past due or due today — you're all caught up.</div>`}
        </section>
      </div>
      <aside class="side-stack">
        <section class="card">
          <div class="card-label">Bills &amp; goals</div><h3>Needs funding or payment</h3>
          ${billsAndGoals.length ? billsAndGoals.map((reminder) => `<div class="compact-row"><div><strong>${escapeHtml(reminder.title)}</strong><small>${escapeHtml(reminder.detail)}</small></div><button class="pill-button" data-dismiss-reminder="${escapeHtml(reminder.id)}" type="button">Done</button></div>`).join("") : `<div class="empty-inline">No open bills or goals right now.</div>`}
        </section>
      </aside>
    </section>`;
}

function renderBudget() {
  ensurePaycheckRecurrenceData();
  const setupStarted = state.budget.setupStarted ?? (state.paychecks.length > 0 || state.budget.categories.length > 0);
  if (!setupStarted) {
    return `<section class="onboarding-empty budget-onboarding">
      <div class="onboarding-graphic" aria-hidden="true"><span>1</span><span>2</span><span>3</span></div>
      <span class="card-label">A clean monthly plan</span>
      <h3>Start your ${monthLabel()} budget</h3>
      <p>Add only the income and categories that belong to this household. Nothing is prefilled.</p>
      <button id="startBudgetButton" type="button">Start planning</button>
    </section>`;
  }
  const previousBudgets = availablePreviousBudgets();
  return `
    <section class="work-grid transactions-grid">
      <div class="main-stack">
        <section class="budget-ledger-card card">
          <div class="budget-ledger-head">
            <div><h3>Income</h3><small data-income-left>${money.format(state.budget.income - plannedTotal())} left to budget</small></div>
            <span>Planned</span>
            <span>Remaining</span>
            <span>Repeats</span>
          </div>
          ${state.paychecks.map((paycheck, index) => `
            <div class="budget-money-row">
              <input class="line-name-input" data-income-name="${index}" value="${paycheck.name}">
              <input class="money-input" data-income-amount="${index}" type="number" step="0.01" value="${paycheck.amount}">
              <strong data-income-remaining="${index}">${exactMoney.format(Number(paycheck.amount || 0) - paycheckAssignedAmount(paycheck))}</strong>
              <select class="income-recurrence-select" data-income-recurrence="${index}" aria-label="How often ${escapeHtml(paycheck.name)} repeats">${Object.entries(paycheckRecurrenceLabels).map(([value, label]) => `<option value="${value}" ${paycheck.recurrence === value ? "selected" : ""}>${label}</option>`).join("")}</select>
            </div>
          `).join("")}
          <button id="addIncomeButton" class="link-button" type="button">Add income</button>
        </section>
        <section class="card">
          <div class="section-head">
            <div><span class="card-label">Budget core</span><h3>Categories and subcategories</h3></div>
            <label class="copy-budget-field">Use previous budget
              <select id="copyBudgetSelect">
                <option value="">Select month</option>
                ${previousBudgets.map((budget) => `<option value="${budget.month}">${formatMonth(budget.month)}</option>`).join("")}
              </select>
            </label>
          </div>
          <div class="category-adder">
            <label class="custom-combobox">Category
              <input id="newCategoryName" autocomplete="off" placeholder="Type to search or add">
              <div id="budgetCategoryMenu" class="combo-menu" hidden>
                ${state.budget.categories.map((category) => `<button type="button" data-category-option="${category.name}">${category.name}</button>`).join("")}
              </div>
            </label>
            <button id="addCategoryButton" class="ghost" type="button">Add category</button>
            <button id="deleteCategoryByNameButton" class="danger-button" type="button">Delete selected</button>
          </div>
          <div class="budget-table">
            ${state.budget.categories.map((category, categoryIndex) => `
              <div class="category-row">
                <div class="category-title">
                  <i style="background:${category.color}"></i>
                  <div class="category-name"><strong>${category.name}</strong><small data-category-left="${categoryIndex}">${money.format(category.lines.reduce((sum, line) => sum + Number(line.planned) - spentByLine(line.id), 0))} left</small></div>
                  <span class="category-spent" data-category-spent="${categoryIndex}">${money.format(category.lines.reduce((sum, line) => sum + spentByLine(line.id), 0))} spent</span>
                  <b class="category-planned" data-category-planned="${categoryIndex}">${money.format(category.lines.reduce((sum, line) => sum + Number(line.planned), 0))} planned</b>
                  <button class="category-add-line" data-add-line-category="${categoryIndex}" type="button">+ Add subcategory</button>
                  <button class="icon-button danger-button" data-delete-category="${categoryIndex}" type="button" aria-label="Remove ${category.name}">×</button>
                </div>
              </div>
              ${category.lines.map((line, lineIndex) => {
                const spent = spentByLine(line.id);
                const remaining = Number(line.planned) - spent;
                return `<div class="budget-line">
                  <div class="line-title-stack">
                    <input class="line-name-input" data-budget-line-name="${categoryIndex}:${lineIndex}" value="${line.name}">
                    <label class="due-day-field">Due date <input data-budget-due-date="${categoryIndex}:${lineIndex}" type="date" min="${monthDateMin()}" max="${monthDateMax()}" value="${dueDateValue(line.dueDay)}"></label>
                  </div>
                  <label class="budget-line-value budget-line-planned"><small>Planned</small><input class="money-input" data-budget-line="${categoryIndex}:${lineIndex}" type="number" step="0.01" value="${line.planned}" min="0" aria-label="Planned amount for ${line.name}"></label>
                  <div class="budget-line-value budget-line-spent"><small>Spent</small><span>${exactMoney.format(spent)}</span></div>
                  <div class="budget-line-value budget-line-remaining"><small>Remaining</small><b data-line-remaining="${categoryIndex}:${lineIndex}" class="${remaining < 0 ? "danger" : ""}">${exactMoney.format(remaining)}</b></div>
                  <button class="icon-button danger-button budget-line-delete" data-delete-line="${categoryIndex}:${lineIndex}" type="button" aria-label="Remove ${line.name}">×</button>
                </div>`;
              }).join("")}
            `).join("")}
          </div>
        </section>
      </div>
      <aside class="side-stack">
        <section class="card">
          <div class="card-label">Next up</div>
          <h3>Due soon</h3>
          ${dueDateRows().slice(0, 5).map((item) => compactRow(item.name, item.date, item.type)).join("")}
        </section>
        <section class="card">
          <div class="card-label">Insights</div>
          <h3>Margin moves</h3>
          ${(() => {
            const { margin, count } = lowerActivityMargin();
            return count ? compactRow(`${money.format(margin)} flexible margin`, `Available across ${count} lower-activity line${count === 1 ? "" : "s"}`, "Info") : "";
          })()}
          ${(() => {
            const tightest = tightestBudgetLine();
            if (!tightest) return "";
            return compactRow(`${escapeHtml(tightest.line.name)} has ${money.format(tightest.remaining)} left`, "Tightest line this month", tightest.remaining < 0 ? "Over" : "Watch");
          })()}
          ${(() => {
            const { count, payees } = unassignedTransactionSummary();
            if (!count) return compactRow("No unassigned transactions", "You're all caught up", "Done");
            return `<div class="compact-row"><div><strong>${count} unassigned transaction${count === 1 ? "" : "s"}</strong><small>${escapeHtml(payees.join(", "))}</small></div><button class="pill-button" data-goto-view="transactions" type="button">Assign</button></div>`;
          })()}
        </section>
      </aside>
    </section>
  `;
}

function renderTransactions() {
  ensureAccountsData();
  const imported = transactionInboxItems().filter((transaction) => !(state.transactionInboxDone || []).includes(transaction.id));
  const unassignedLedger = [];
  const lineOptions = (selectedLineId) => allLines().map((line) => `<option value="${line.id}" ${line.id === selectedLineId ? "selected" : ""}>${line.category} - ${line.name}</option>`).join("");
  const firstCategory = state.budget.categories[0];
  return `
    <section class="work-grid">
      <div class="main-stack">
        <section class="card soft-card"><div class="card-label">Transactions</div><h3>Connected accounts</h3><div class="sync-empty">Connect a bank to import transactions</div></section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">Budget setup</span><h3>Manage subcategories from Transactions</h3></div></div>
          <div class="transaction-subcategory-adder">
            <label>Category<select id="transactionParentCategory">${state.budget.categories.map((category, index) => `<option value="${index}">${category.name}</option>`).join("")}</select></label>
            <label class="custom-combobox">Subcategory
              <input id="transactionSubcategoryName" autocomplete="off" placeholder="Type to search or add">
              <div id="transactionSubcategoryMenu" class="combo-menu" hidden>
                ${(firstCategory?.lines || []).map((line) => `<button type="button" data-subcategory-option="${line.name}">${line.name}</button>`).join("")}
              </div>
            </label>
            <button id="addTransactionSubcategoryButton" class="ghost" type="button">Add subcategory</button>
            <button id="deleteTransactionSubcategoryButton" class="danger-button" type="button">Delete selected</button>
          </div>
        </section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">Bank expense</span><h3>Bank stream</h3></div><button id="addTransactionButton" type="button">+ Add transaction</button></div>
          ${imported.map((transaction) => `
            <div class="assign-row">
              <div><strong>${transaction.payee}</strong><small>${formatShortDate(transaction.date)}</small></div>
              <b>${exactMoney.format(transaction.amount)}</b>
              <label>Budget line<select>${lineOptions(transaction.lineId)}</select></label>
              <button class="icon-button" data-accept-import="${transaction.id}" type="button">✓</button>
              <button class="icon-button danger-button" data-dismiss-import="${transaction.id}" type="button">×</button>
            </div>
          `).join("") || `<div class="empty-inline">No bank stream items waiting</div>`}
        </section>
      </div>
      <aside class="side-stack">
        <section class="card">
          <div class="card-label">Entries</div><h3>Ledger</h3>
          <form id="transactionForm" class="mini-form transaction-entry-form">
            <label>Payee<input name="payee" placeholder="Coffee House" required></label>
            <label>Amount<input name="amount" type="number" step="0.01" placeholder="18.72" required></label>
            <label>Subcategory<select name="lineId">${allLines().map((line) => `<option value="${line.id}">${line.category} - ${line.name}</option>`).join("")}</select></label>
            ${state.accounts.length ? `<label>Account<select name="accountId"><option value="">Not linked</option>${accountOptions("")}</select></label>` : ""}
            <button type="submit">Split</button>
          </form>
          ${unassignedLedger.map((transaction) => `
            <div class="ledger-assign-row">
              <div><strong>${transaction.payee}</strong><small>${formatShortDate(transaction.date)}</small></div>
              <b>-${exactMoney.format(transaction.amount).replace("$", "$")}</b>
              <label>Assign to<select data-ledger-line="${transaction.id}">${lineOptions("")}</select></label>
              <button data-assign-ledger="${transaction.id}:${transaction.payee}:${transaction.amount}:${transaction.date}" type="button">Assign</button>
            </div>
          `).join("")}
          ${state.transactions.length ? state.transactions
            .map((transaction, index) => ({ payee: transaction.payee, amount: -transaction.amount, date: transaction.date, tag: transactionAssignmentLabel(transaction), index }))
            .slice(0, 6)
            .map((transaction) => compactRow(transaction.payee, formatShortDate(transaction.date), `${exactMoney.format(transaction.amount)} · ${transaction.tag}`, "", `data-delete-transaction="${transaction.index}" aria-label="Delete ${escapeHtml(transaction.payee)}"`))
            .join("") : `<div class="empty-inline">No transactions yet</div>`}
        </section>
      </aside>
    </section>`;
}

function renderPaychecks() {
  ensurePaycheckRecurrenceData();
  ensureAccountsData();
  const paycheckOptions = state.paychecks.map((paycheck) => `<option value="${paycheck.date}">${paycheck.name} - ${money.format(paycheck.amount)}</option>`).join("");
  const lineOptions = allLines().map((line) => `<option value="${line.id}">${line.category} - ${line.name}</option>`).join("");
  const amountOptions = [50, 100, 150, 200, 250, 300, 350, 450, 520, 620, 850, 1850].map((amount) => `<option value="${amount}">${money.format(amount)}</option>`).join("");
  return `
    <section class="work-grid">
      <div class="main-stack">
        <section class="card">
          <div class="section-head"><div><span class="card-label">Cash flow</span><h3>Paycheck/Income plan</h3></div><button id="addPaycheckButton" type="button">+ Add paycheck/income</button></div>
          <div class="paycheck-builder">
            <label>Paycheck/Income<select id="paycheckSelect">${paycheckOptions}</select></label>
            <label>Budget line<select id="paycheckLineSelect">${lineOptions}</select></label>
            <label>Amount<select id="paycheckAmountSelect">${amountOptions}</select></label>
            <button id="assignBillButton" type="button">Assign bill</button>
          </div>
          <div class="paycheck-grid">
            ${state.paychecks.map((paycheck, index) => {
              const assigned = paycheckAssignedAmount(paycheck);
              return `<article class="paycheck-card">
                <div class="paycheck-card-header">
                  <input class="paycheck-name-input" data-income-name="${index}" value="${escapeHtml(paycheck.name)}" aria-label="Name for this paycheck/income entry">
                  <div class="paycheck-card-actions">
                    <input class="money-input paycheck-amount-input" data-paycheck-amount="${index}" type="number" step="0.01" value="${paycheck.amount}" aria-label="Amount for ${escapeHtml(paycheck.name)}">
                    <button class="icon-button danger-button" data-delete-paycheck="${index}" type="button" aria-label="Delete ${escapeHtml(paycheck.name)}">×</button>
                  </div>
                </div>
                <small>${paycheck.date}</small>
                <label class="paycheck-recurrence-field">Repeat<select data-paycheck-recurrence="${index}" aria-label="How often ${escapeHtml(paycheck.name)} repeats">${Object.entries(paycheckRecurrenceLabels).map(([value, label]) => `<option value="${value}" ${paycheck.recurrence === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
                ${state.accounts.length ? `<label class="paycheck-recurrence-field">Deposit to<select data-paycheck-deposit-account="${index}" aria-label="Deposit account for ${escapeHtml(paycheck.name)}"><option value="">Not linked</option>${accountOptions(paycheck.depositAccountId || "", { excludeType: "credit_card" })}</select></label>` : ""}
                <div class="mini-tags">${paycheck.assignedLineIds.map((id) => `<span>${lineName(id)}</span>`).join("")}</div>
                <div class="split-stat" data-paycheck-split="${index}"><span>Income ${money.format(paycheck.amount)}</span><b>Assigned ${money.format(assigned)}</b></div>
              </article>`;
            }).join("")}
          </div>
        </section>
      </div>
      <aside class="side-stack">
        <section class="card"><div class="card-label">Calendar</div><h3>Due-date flow</h3>${dueDateRows().map((item) => compactRow(item.name, item.date, item.type)).join("")}</section>
        <section class="card"><div class="card-label">Reminders</div><h3>Bills and goals</h3>${
          billAndGoalReminders().length
            ? billAndGoalReminders().map((reminder) => `<div class="compact-row"><div><strong>${escapeHtml(reminder.title)}</strong><small>${escapeHtml(reminder.detail)}</small></div><button class="pill-button" data-dismiss-reminder="${escapeHtml(reminder.id)}" type="button">Done</button></div>`).join("")
            : `<div class="empty-inline">No open bills or goals right now</div>`
        }</section>
      </aside>
    </section>`;
}

function calendarAssigneeOptions() {
  const members = [];
  const seen = new Set();
  for (const member of [...sharedCalendarMembers, ...(sharingAccess?.members || [])]) {
    const key = (member.email || member.name || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    members.push({ name: member.name, email: member.email, status: member.status || "active" });
  }
  if (!members.some((member) => member.email === sessionUser?.email)) {
    members.unshift({ name: sessionUser?.name || "Household owner", email: sessionUser?.email || "", status: "active" });
  }
  return members;
}

function assigneeKey(member) {
  return member?.email || member?.name || "";
}

// Turns a list of selected keys (from the assign-to checkboxes) into full
// {key, name, email} records, resolving names/emails from the current
// household member list so display stays correct even if a key is later
// renamed. Falls back to using the key itself as the name/email if the
// member can no longer be found (e.g. they left the household).
function resolveAssignees(keys) {
  const options = calendarAssigneeOptions();
  const unique = [...new Set((keys || []).map((key) => String(key || "").trim()).filter(Boolean))];
  return unique.map((key) => {
    const member = options.find((candidate) => assigneeKey(candidate) === key);
    return { key, name: member?.name || key, email: member?.email || (key.includes("@") ? key : "") };
  });
}

// Lazily upgrades chores/events created before multi-assignee support
// (single assignee/owner fields) into the new assignees array, following the
// same one-way migration convention used elsewhere (e.g. ensureAnnualEventRecurrenceData).
function ensureAssigneesData() {
  state.calendar.chores.forEach((chore) => {
    if (chore.assignees) return;
    chore.assignees = chore.assignee ? resolveAssignees([chore.assignee]).map((assignee) => ({ ...assignee, name: chore.assigneeName || assignee.name })) : [];
  });
  state.calendar.events.forEach((event) => {
    if (event.assignees) return;
    event.assignees = event.owner ? resolveAssignees([event.owner]).map((assignee) => ({ ...assignee, name: event.ownerName || assignee.name })) : [];
  });
}

function assigneeNames(assignees) {
  return (assignees || []).map((assignee) => assignee.name).filter(Boolean).join(", ");
}

// Several small dots (one per assignee) instead of one, so a jointly-assigned
// chore/event visibly shows everyone it belongs to, not just the first person.
function assigneeDots(assignees) {
  return (assignees || [])
    .map((assignee) => `<span class="member-dot" style="background:${memberColor(assignee.key)}" title="${escapeHtml(assignee.name)}" aria-hidden="true"></span>`)
    .join("");
}

const memberColorPalette = ["#2f6fed", "#e05252", "#13936d", "#d99a24", "#8a5cf6", "#0891b2", "#c2410c", "#be185d"];
function memberColor(ownerKey) {
  const key = String(ownerKey || "").trim().toLowerCase();
  if (!key) return "#9aa5b1";
  // Assign by each member's stable position in the household's member list,
  // not a hash of their key — a hash mod the palette size can (and did) put
  // two different people on the exact same or a barely-distinguishable
  // color purely by chance. Position-based assignment guarantees every real
  // member gets a distinct, maximally-different color as long as the
  // household has no more members than the palette has colors.
  const index = calendarAssigneeOptions().findIndex((member) => (member.email || member.name || "").trim().toLowerCase() === key);
  if (index >= 0) return memberColorPalette[index % memberColorPalette.length];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return memberColorPalette[hash % memberColorPalette.length];
}

function renderCalendar() {
  ensureAssigneesData();
  const calendarMembers = calendarAssigneeOptions();
  const today = dateKey(new Date());
  // Personalizes the two "what's due" panels to the signed-in user: once
  // they've marked their own part done, it drops off their view even if
  // other assignees on the same chore/birthday haven't finished theirs yet.
  const viewerKey = sessionUser?.email || "";
  const choreRows = state.calendar.chores
    .map((chore, index) => ({ chore, index, occurrence: nextPendingChoreOccurrence(chore, viewerKey) }))
    .filter((row) => row.occurrence)
    .sort((a, b) => a.occurrence.date.localeCompare(b.occurrence.date))
    .slice(0, UPCOMING_LIST_LIMIT);
  const annualRows = state.calendar.events
    .filter((event) => ANNUAL_EVENT_TYPES.includes(event.type))
    .map((event) => ({ event, occurrence: nextPendingAnnualEventOccurrence(event, new Date(), viewerKey) }))
    .filter((row) => row.occurrence)
    .sort((a, b) => a.occurrence.date.localeCompare(b.occurrence.date))
    .slice(0, UPCOMING_LIST_LIMIT);
  return `
    <section class="work-grid calendar-layout">
      <div class="main-stack">
        <section class="card calendar-main-card">
          <div class="section-head">
            <div><span class="card-label">Household calendar</span><h3>Chores, birthdays, anniversaries and reminders</h3></div>
            <div class="button-row"><button id="addChoreButton" class="ghost" type="button">+ Add chore</button><button id="addBirthdayButton" class="ghost" type="button">+ Add birthday/anniversary</button><button id="addReminderButton" class="ghost" type="button">+ Add reminder</button></div>
          </div>
          <div class="calendar-member-filter" role="group" aria-label="Filter calendar by person">
            <button type="button" class="member-chip ${calendarFilterOwner ? "" : "active"}" data-calendar-filter-owner="">All people</button>
            ${calendarMembers.map((member) => {
              const key = member.email || member.name;
              return `<button type="button" class="member-chip ${calendarFilterOwner === key ? "active" : ""}" data-calendar-filter-owner="${escapeHtml(key)}"><span class="member-dot" style="background:${memberColor(key)}" aria-hidden="true"></span>${escapeHtml(member.name)}</button>`;
            }).join("")}
          </div>
          <form id="calendarQuickAdd" class="calendar-quick-add">
            <input name="editingKind" type="hidden">
            <input name="editingId" type="hidden">
            <label>Type<select name="type"><option value="chore">Chore</option><option value="birthday">Birthday</option><option value="anniversary">Anniversary</option><option value="reminder">Reminder</option></select></label>
            <label>Title<input name="title" placeholder="Mom birthday reminder" required></label>
            <label><span>Date<span data-date-label-suffix> and time</span></span><input name="date" type="datetime-local" value="${state.budget.month}-01T09:00" required></label>
            <label data-annual-time-field hidden>Remind me at<input name="annualTime" type="time" value="09:00"></label>
            <label data-plain-reminder-field hidden>Remind me on<input name="reminderAt" type="datetime-local"></label>
            <div class="assign-to-field custom-combobox">
              <span class="assign-to-label">Assign to</span>
              <button type="button" id="assigneeComboTrigger" class="assignee-combo-trigger"></button>
              <div id="assigneeMenu" class="combo-menu assignee-menu" hidden>
                ${calendarMembers.map((member) => {
                  const key = member.email || member.name;
                  return `<label class="assignee-menu-option"><input type="checkbox" name="assignees" value="${escapeHtml(key)}" ${key === (sessionUser?.email || "") ? "checked" : ""}><span class="member-dot" style="background:${memberColor(key)}" aria-hidden="true"></span>${escapeHtml(member.name)}${member.status && member.status !== "active" ? " (invited)" : ""}</label>`;
                }).join("")}
              </div>
            </div>
            <label data-chore-recurrence-field>Repeat<select name="recurrence"><option value="once">Once</option><option value="weekly" selected>Weekly</option><option value="biweekly">Every 2 weeks</option><option value="triweekly">Every 3 weeks</option><option value="monthly">Monthly</option></select></label>
            <label data-chore-end-date-field hidden>End date (optional)<input name="choreEndDate" type="date"></label>
            <label data-annual-reminder-field hidden>Remind before<select name="reminderDays"><option value="0">Same day</option><option value="1" selected>1 day</option><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="-1">Don't remind</option></select></label>
            <button data-calendar-submit type="submit">Add</button>
            <button data-calendar-delete class="danger-button" type="button" hidden>Delete</button>
            <button data-calendar-cancel class="ghost" type="button" hidden>Cancel</button>
            <p class="calendar-form-status" role="status">${escapeHtml(calendarFeedback || "")}</p>
          </form>
          <div class="calendar-grid">
            ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<div class="calendar-weekday">${day}</div>`).join("")}
            ${calendarCells().map((cell) => `
            <div class="day-cell ${cell.muted ? "muted-cell" : ""} ${cell.currentMonth ? "" : "outside-month"} ${cell.dateKey === dateKey(new Date()) ? "today-cell" : ""}" data-calendar-day="${cell.dateKey}" role="button" tabindex="0" aria-label="Add an item on ${cell.dateKey}">
              <b>${cell.day}</b>
              ${cell.items.map((item) => `<button class="event ${item.eventType || item.type}" style="border-left:3px solid ${memberColor(item.assignees?.[0]?.key)}" data-edit-calendar-item="${item.sourceKind}:${item.sourceId}" type="button" title="Edit ${escapeHtml(item.title)}${assigneeNames(item.assignees) ? ` · ${escapeHtml(assigneeNames(item.assignees))}` : ""}">${escapeHtml(item.title)}</button>`).join("")}
            </div>
          `).join("")}</div>
        </section>
      </div>
      <aside class="side-stack">
        <section class="card"><div class="card-label">Daily planner</div><h3>Upcoming schedule</h3>${upcomingScheduleItems().length ? upcomingScheduleItems().map((item) => calendarManageRow(item)).join("") : `<div class="empty-inline">No events scheduled this month</div>`}</section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">What to do</span><h3>Chore rotation</h3></div><button id="sideAddChoreButton" class="ghost" type="button">Add chore</button></div>
          ${choreRows.length ? choreRows.map(({ chore, index, occurrence }) => {
            const overdue = occurrence.date < today;
            return `<div class="compact-row ${overdue ? "overdue" : ""}">
              <div>${assigneeDots(chore.assignees)}<strong>${escapeHtml(chore.title)}</strong><small>${occurrence.date}${overdue ? " · Past due" : ""} · ${escapeHtml(assigneeNames(chore.assignees) || "Unassigned")} · ${choreCadenceLabel(chore)}</small></div>
              <div class="chore-complete-group">${choreCompletionButtons(chore, index, occurrence.date)}</div>
              <button class="icon-button" data-edit-calendar-item="chore:${chore.id}" type="button" aria-label="Edit ${escapeHtml(chore.title)}">✎</button>
              <button class="icon-button danger-button" data-delete-calendar-item="chore:${chore.id}" type="button" aria-label="Remove ${escapeHtml(chore.title)}">×</button>
            </div>`;
          }).join("") : `<div class="empty-inline">No recurring chores</div>`}
        </section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">Remember</span><h3>Birthdays &amp; anniversaries</h3></div><button id="sideAddBirthdayButton" class="ghost" type="button">Add birthday/anniversary</button></div>
          ${annualRows.length ? annualRows.map(({ event, occurrence }) => {
            const overdue = occurrence.date < today;
            return `<div class="compact-row ${overdue ? "overdue" : ""}">
              <div>${assigneeDots(event.assignees)}<strong>${escapeHtml(annualEventDisplayTitle(event))}</strong><small>${formatAnnualEventMonthDay(event)}${overdue ? " · Not wished yet" : ""} · ${annualEventLabels[event.type] || "Annual"}</small></div>
              <div class="chore-complete-group">${annualEventCompletionButtons(event, occurrence.year)}</div>
              <button class="icon-button" data-edit-calendar-item="event:${event.id}" type="button" aria-label="Edit ${escapeHtml(event.title)}">✎</button>
              <button class="icon-button danger-button" data-delete-calendar-item="event:${event.id}" type="button" aria-label="Remove ${escapeHtml(event.title)}">×</button>
            </div>`;
          }).join("") : `<div class="empty-inline">No birthdays or anniversaries added</div>`}
        </section>
      </aside>
    </section>`;
}

function ensureNotesData() {
  state.notes ||= { activeView: "notes", activeLabel: "", labels: [], entries: [], initialized: false };
  if (!state.notes.initialized) {
    state.notes.labels = [];
    state.notes.entries = [];
    state.notes.initialized = true;
  }
  state.notes.activeView ||= "notes";
  state.notes.activeLabel ||= "";
  state.notes.composerOpen = Boolean(state.notes.composerOpen);
  state.notes.labels ||= [];
  state.notes.entries ||= [];
  const trashCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  state.notes.entries = state.notes.entries.filter((note) => !note.trashed || !note.trashedAt || new Date(note.trashedAt).getTime() > trashCutoff);
  state.notes.entries.forEach((note) => {
    note.checklist ||= [];
    note.checklist.forEach((item) => {
      item.id ||= uniqueId("item");
      item.text ||= "";
      item.done = Boolean(item.done);
      if (item.parentId && !note.checklist.some((candidate) => candidate.id === item.parentId)) item.parentId = "";
    });
    note.labels ||= [];
    note.pinned = Boolean(note.pinned);
    note.archived = Boolean(note.archived);
    note.trashed = Boolean(note.trashed);
    if (note.trashed && !note.trashedAt) note.trashedAt = new Date().toISOString();
    note.showChecklist = note.showChecklist !== false;
    note.color ||= "#ffffff";
    note.createdAt ||= new Date().toISOString();
  });
}

function visibleNotes() {
  ensureNotesData();
  const query = String(state.notes.search || "").trim().toLowerCase();
  return state.notes.entries.filter((note) => {
    if (state.notes.activeView === "archive" && !note.archived) return false;
    if (state.notes.activeView === "trash" && !note.trashed) return false;
    if (state.notes.activeView === "notes" && (note.archived || note.trashed)) return false;
    if (state.notes.activeView === "reminders" && (note.archived || note.trashed || !note.reminder)) return false;
    if (state.notes.activeView === "label" && (note.archived || note.trashed || !note.labels.includes(state.notes.activeLabel))) return false;
    if (!query) return true;
    return [note.title, note.body, ...note.labels, ...note.checklist.map((item) => item.text)]
      .join(" ")
      .toLowerCase()
      .includes(query);
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

function noteChecklistSuggestions() {
  ensureNotesData();
  const seen = new Set();
  return state.notes.entries.flatMap((note) => note.checklist || [])
    .map((item) => String(item.text || "").trim())
    .filter((text) => {
      const key = text.toLowerCase();
      if (!text || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.localeCompare(b));
}

function matchingChecklistSuggestions(query, limit = 6) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return [];
  const matchRank = (text) => {
    const candidate = text.toLowerCase();
    if (candidate.startsWith(normalized)) return 0;
    if (candidate.includes(normalized)) return 1;
    if (normalized.length < 3) return 3;
    const prefix = candidate.slice(0, normalized.length);
    const differences = [...normalized].filter((letter, index) => letter !== prefix[index]).length;
    return differences <= 1 ? 2 : 3;
  };
  return noteChecklistSuggestions()
    .filter((text) => matchRank(text) < 3)
    .sort((a, b) => matchRank(a) - matchRank(b) || a.localeCompare(b))
    .slice(0, limit);
}

function addOrRestoreChecklistItem(note, text, parentId = "") {
  const normalized = String(text || "").trim().toLowerCase();
  if (!note || !normalized) return false;
  const existing = findChecklistDuplicate(note.checklist, text, parentId);
  if (existing) {
    existing.done = false;
    return true;
  }
  const canonical = noteChecklistSuggestions().find((item) => item.toLowerCase() === normalized) || String(text).trim();
  note.checklist.push({ id: uniqueId("item"), text: canonical, done: false, parentId: parentId || "" });
  return true;
}

function renderNotes() {
  ensureNotesData();
  const notes = visibleNotes();
  const pinned = notes.filter((note) => note.pinned);
  const others = notes.filter((note) => !note.pinned);
  const canCompose = !["archive", "trash"].includes(state.notes.activeView);
  const emptyMessage = state.notes.activeView === "reminders"
    ? "Notes with upcoming reminders appear here."
    : state.notes.activeView === "trash"
      ? "Trash is empty."
      : "No notes match this view.";
  return `
    <section class="notes-layout">
      <aside class="notes-filter-panel">
        <button class="${state.notes.activeView === "notes" ? "active" : ""}" data-notes-view="notes" type="button">Notes</button>
        <button class="${state.notes.activeView === "reminders" ? "active" : ""}" data-notes-view="reminders" type="button">Reminders</button>
        <div class="notes-filter-label">Labels</div>
        ${state.notes.labels.map((label) => `<button class="${state.notes.activeView === "label" && state.notes.activeLabel === label ? "active" : ""}" data-notes-label="${escapeHtml(label)}" type="button">${escapeHtml(label)}</button>`).join("")}
        <button id="editNoteLabelsButton" class="notes-edit-labels" type="button">Edit labels</button>
        <button class="${state.notes.activeView === "archive" ? "active" : ""}" data-notes-view="archive" type="button">Archive</button>
        <button class="${state.notes.activeView === "trash" ? "active" : ""}" data-notes-view="trash" type="button">Trash</button>
      </aside>
      <div class="notes-workspace">
        <div class="notes-search">
          <span aria-hidden="true">⌕</span>
          <input id="notesSearch" placeholder="Search household notes" value="${state.notes.search || ""}">
        </div>
        ${state.notes.activeView === "trash" ? `<div class="notes-trash-banner"><span>Notes in Trash are permanently deleted after 7 days.</span><button id="emptyNotesTrashButton" type="button" ${notes.length ? "" : "disabled"}>Empty Trash</button></div>` : ""}
        ${canCompose && !state.notes.composerOpen ? `<button id="openNoteComposerButton" class="note-composer-compact" type="button"><span>Take a note...</span><span aria-hidden="true">☑</span></button>` : ""}
        ${canCompose && state.notes.composerOpen ? `<form id="noteComposer" class="note-composer">
          <input name="title" placeholder="Title">
          <textarea name="body" rows="2" placeholder="Take a note..."></textarea>
          <div class="note-composer-checklist">
            <div data-composer-checklist-items></div>
            <div class="note-composer-add-item">
              <input data-composer-item-input placeholder="Add checklist item" aria-label="Add checklist item" autocomplete="off">
            </div>
            <input name="items" type="hidden">
          </div>
          <div class="note-composer-row">
            <div class="note-label-picker-field"><span>Labels</span>${renderNoteLabelPicker()}</div>
            <label>Color<select name="color"><option value="#ffffff">White</option><option value="#fff7d6">Yellow</option><option value="#eef7ff">Blue</option><option value="#eaf8ef">Green</option><option value="#fff0ee">Coral</option></select></label>
            ${state.notes.activeView === "reminders" ? `<label>Reminder date and time<input name="reminder" type="datetime-local" required></label>` : ""}
            <input name="pinned" type="checkbox" hidden>
            <button class="note-pin-toggle" data-composer-pin type="button" aria-label="Pin note" aria-pressed="false" title="Pin note">⌖</button>
            <button id="closeNoteComposerButton" class="ghost" type="button">Close</button>
            <button type="submit">${state.notes.activeView === "reminders" ? "Add reminder" : "Add note"}</button>
          </div>
        </form>` : ""}
        ${notes.length ? `
          ${pinned.length ? `<section class="notes-result-section"><div class="notes-section-label">Pinned</div><div class="notes-board">${pinned.map(renderNoteCard).join("")}</div></section>` : ""}
          ${others.length ? `<section class="notes-result-section"><div class="notes-section-label">${pinned.length ? "Others" : "Notes"}</div><div class="notes-board">${others.map(renderNoteCard).join("")}</div></section>` : ""}
        ` : `<div class="notes-empty">${emptyMessage}</div>`}
      </div>
      <dialog id="noteLabelsDialog" class="app-dialog note-labels-dialog">
        <div class="note-labels-dialog-content">
          <div class="section-head">
            <h2>Edit labels</h2>
            <button id="closeNoteLabelsDialogButton" class="icon-button ghost" type="button" aria-label="Close label editor">×</button>
          </div>
          <form id="noteLabelForm" class="note-label-create-form">
            <input name="label" placeholder="Create new label" aria-label="Create new label" required>
            <button type="submit" aria-label="Add new label">✓</button>
          </form>
          <div class="note-label-manager-list">
            ${state.notes.labels.length ? state.notes.labels.map((label, index) => `<form class="note-label-manager-row" data-rename-note-label="${index}">
              <span class="note-label-row-leading">
                <span class="note-label-tag-icon" aria-hidden="true">◆</span>
                <button type="button" class="icon-button danger-button note-label-hover-delete" data-delete-note-label="${index}" aria-label="Delete ${escapeHtml(label)} label" title="Delete label">×</button>
              </span>
              <input name="label" value="${escapeHtml(label)}" aria-label="Rename ${escapeHtml(label)} label" required>
              <button type="submit" class="icon-button ghost" aria-label="Save ${escapeHtml(label)} label">✓</button>
            </form>`).join("") : `<p class="note-label-manager-empty">No labels created yet.</p>`}
          </div>
          <div class="dialog-actions"><button id="doneNoteLabelsButton" type="button">Done</button></div>
        </div>
      </dialog>
    </section>`;
}

function reopenNoteLabelsDialog() {
  render();
  $("#noteLabelsDialog")?.showModal();
}

function renderNoteLabelPicker(note = null, compact = false) {
  const selected = new Set(note?.labels || []);
  const count = selected.size;
  const summary = compact
    ? `<summary title="Add label" aria-label="${count ? `${count} labels selected` : "Add label"}">◇</summary>`
    : `<summary>${count ? `${count} selected` : "No labels"}</summary>`;
  return `<details class="note-label-picker ${compact ? "note-label-picker-compact" : ""}">
    ${summary}
    <div class="note-label-picker-options">
      ${state.notes.labels.length ? state.notes.labels.map((label) => `<label>
        <input type="checkbox" ${note ? `data-note-label-toggle="${note.id}"` : `name="labels"`} value="${escapeHtml(label)}" ${selected.has(label) ? "checked" : ""}>
        <span>${escapeHtml(label)}</span>
      </label>`).join("") : `<small>No labels created yet</small>`}
    </div>
  </details>`;
}

function renderNoteCard(note) {
  const { open, completed } = bucketChecklistItems(note.checklist);
  const checklistRow = (item) => `<div class="note-check-row ${item.done ? "done" : ""} ${item.parentId ? "child-item" : ""}">
    <input data-note-check="${note.id}:${item.id}" type="checkbox" aria-label="Complete ${escapeHtml(item.text)}" ${item.done ? "checked" : ""}>
    <div class="note-check-combobox">
      <input class="note-check-text" data-note-check-text="${note.id}:${item.id}" value="${escapeHtml(item.text)}" placeholder="Checklist item" aria-label="Checklist item" aria-autocomplete="list" aria-expanded="false" autocomplete="off">
      <div class="note-item-suggestions" data-note-check-suggestions="${note.id}:${item.id}" role="listbox" hidden></div>
    </div>
    <button class="note-check-level" data-indent-note-item="${note.id}:${item.id}" type="button" aria-label="${item.parentId ? "Move checklist item to top level" : "Make checklist item a sub-item"}" title="${item.parentId ? "Move to top level" : "Make sub-item"}">${item.parentId ? "←" : "→"}</button>
    <button class="note-check-plan" data-add-checklist-to-plan="${note.id}:${item.id}" type="button" aria-label="Add to today's Plan" title="Add to today's Plan">◫</button>
    <button class="note-check-delete" data-delete-note-item="${note.id}:${item.id}" type="button" aria-label="Delete checklist item">×</button>
  </div>`;
  return `<article class="note-card" data-note-id="${note.id}" style="background:${note.color}">
    <div class="note-card-head">
      <input class="note-title-input" data-note-title="${note.id}" value="${escapeHtml(note.title || "")}" placeholder="Untitled note" aria-label="Note title">
      <button class="note-icon-button ${note.pinned ? "active" : ""}" data-pin-note="${note.id}" type="button" aria-label="${note.pinned ? "Unpin note" : "Pin note"}">⌖</button>
    </div>
    <textarea class="note-body-input" data-note-body="${note.id}" rows="${note.body ? "2" : "1"}" placeholder="Take a note..." aria-label="Note body">${escapeHtml(note.body || "")}</textarea>
    ${note.reminder ? `<div class="note-reminder">Reminder · ${formatDateTime(note.reminder)}</div>` : ""}
    ${note.showChecklist ? open.map(checklistRow).join("") : ""}
    ${note.showChecklist ? `<form class="note-add-item-form" data-add-note-item="${note.id}">
      <div class="note-item-combobox">
        <input name="item" data-note-item-input="${note.id}" placeholder="Add checklist item" aria-label="Add checklist item" aria-autocomplete="list" aria-expanded="false" autocomplete="off">
        <div class="note-item-suggestions" data-note-item-suggestions="${note.id}" role="listbox" hidden></div>
      </div>
    </form>` : ""}
    ${note.showChecklist && completed.length ? `<details class="note-completed"><summary>${completed.length} completed ${completed.length === 1 ? "item" : "items"}</summary>${completed.map(checklistRow).join("")}</details>` : ""}
    <div class="note-labels" data-note-label-list="${note.id}">${note.labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div>
    ${note.trashed ? `<div class="note-card-actions"><button data-restore-note="${note.id}" type="button">Restore</button><button class="danger-button" data-delete-note-forever="${note.id}" type="button">Delete permanently</button></div>` : `<div class="note-card-toolbar">
      <label class="note-color-control" title="Change color"><span aria-hidden="true">◉</span><select data-note-color="${note.id}" aria-label="Change note color"><option value="#ffffff" ${note.color === "#ffffff" ? "selected" : ""}>White</option><option value="#fff7d6" ${note.color === "#fff7d6" ? "selected" : ""}>Yellow</option><option value="#eef7ff" ${note.color === "#eef7ff" ? "selected" : ""}>Blue</option><option value="#eaf8ef" ${note.color === "#eaf8ef" ? "selected" : ""}>Green</option><option value="#fff0ee" ${note.color === "#fff0ee" ? "selected" : ""}>Coral</option></select></label>
      <details class="note-toolbar-popover"><summary title="Set reminder" aria-label="Set reminder">◷</summary><div class="note-toolbar-popover-panel"><label>Reminder date and time<input type="datetime-local" data-note-reminder="${note.id}" value="${escapeHtml(note.reminder || "")}"></label></div></details>
      <div class="note-toolbar-labels">${renderNoteLabelPicker(note, true)}</div>
      <button data-archive-note="${note.id}" type="button" title="${note.archived ? "Unarchive" : "Archive"}" aria-label="${note.archived ? "Unarchive note" : "Archive note"}">↓</button>
      <details class="note-more-menu"><summary title="More actions" aria-label="More actions">⋮</summary><div class="note-more-menu-panel">
        <button data-duplicate-note="${note.id}" type="button">Make a copy</button>
        <button data-toggle-note-checklist="${note.id}" type="button">${note.showChecklist ? "Hide checkboxes" : "Show checkboxes"}</button>
        <button class="danger-button" data-trash-note="${note.id}" type="button">Delete note</button>
      </div></details>
    </div>`}
  </article>`;
}

function syncNoteComposerChecklist(form) {
  const hidden = form?.querySelector('input[name="items"]');
  if (!hidden) return;
  hidden.value = [...form.querySelectorAll("[data-composer-check-text]")]
    .map((input) => input.value.trim())
    .filter(Boolean)
    .join("\n");
}

function addNoteComposerChecklistItem(form, text) {
  const value = String(text || "").trim();
  const list = form?.querySelector("[data-composer-checklist-items]");
  if (!value || !list) return false;
  const row = document.createElement("div");
  row.className = "note-composer-check-row";
  row.innerHTML = `<input type="checkbox" disabled aria-label="Checklist item not yet completed">
    <input data-composer-check-text value="${escapeHtml(value)}" aria-label="Checklist item">
    <button class="note-check-delete" type="button" aria-label="Remove checklist item">×</button>`;
  row.querySelector("[data-composer-check-text]").addEventListener("input", () => syncNoteComposerChecklist(form));
  row.querySelector("button").addEventListener("click", () => {
    row.remove();
    syncNoteComposerChecklist(form);
  });
  list.append(row);
  syncNoteComposerChecklist(form);
  return true;
}

function commitNoteComposerDraft(form) {
  const input = form?.querySelector("[data-composer-item-input]");
  if (!input || !input.value.trim()) return;
  if (addNoteComposerChecklistItem(form, input.value)) input.value = "";
}

function setupNoteComposerChecklist() {
  const form = $("#noteComposer");
  if (!form) return;
  const input = form.querySelector("[data-composer-item-input]");
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitNoteComposerDraft(form);
  });
  const pinButton = form.querySelector("[data-composer-pin]");
  const pinInput = form.querySelector('input[name="pinned"]');
  pinButton?.addEventListener("click", () => {
    pinInput.checked = !pinInput.checked;
    pinButton.classList.toggle("active", pinInput.checked);
    pinButton.setAttribute("aria-pressed", String(pinInput.checked));
    pinButton.setAttribute("aria-label", pinInput.checked ? "Unpin note" : "Pin note");
    pinButton.title = pinInput.checked ? "Unpin note" : "Pin note";
  });
}

const journalMoods = ["Happy", "Calm", "Neutral", "Stressed", "Sad", "Grateful", "Excited"];

function ensureJournalData() {
  privateData.journal ||= { entries: [] };
  privateData.journal.entries ||= [];
}

function sortedJournalEntries() {
  return [...privateData.journal.entries].sort((a, b) =>
    (b.entryDate || "").localeCompare(a.entryDate || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function moodOptions(selected) {
  return `<option value="">No mood</option>${journalMoods.map((mood) => `<option value="${mood}" ${selected === mood ? "selected" : ""}>${mood}</option>`).join("")}`;
}

function renderJournal() {
  if (!privateData) return "";
  ensureJournalData();
  const entries = sortedJournalEntries();
  return `
    <section class="journal-layout">
      <div class="section-head"><div><span class="card-label">Journal</span><h3>Your private journal</h3><p class="private-note">Private to you — never shared with other household members.</p></div></div>
      <form id="journalComposer" class="journal-composer card">
        <label>Date<input name="entryDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
        <label>Title<input name="title" placeholder="Give today a title"></label>
        <label>Mood<select name="mood">${moodOptions("")}</select></label>
        <label>Tags<input name="tags" placeholder="travel, family, work"></label>
        <textarea name="body" rows="3" placeholder="What happened today?"></textarea>
        <label class="journal-photo-picker">+ Add photos<input name="photos" type="file" accept="image/*" multiple></label>
        <button type="submit">Add entry</button>
      </form>
      <div class="journal-entries">
        ${entries.length ? entries.map(renderJournalEntry).join("") : `<div class="empty-inline">No journal entries yet. Write your first one above.</div>`}
      </div>
    </section>`;
}

function renderJournalEntry(entry) {
  return `<article class="journal-entry card" data-journal-id="${entry.id}">
    <div class="journal-entry-head">
      <input class="journal-date-input" data-journal-date="${entry.id}" type="date" value="${entry.entryDate || ""}" aria-label="Entry date">
      <input class="journal-title-input" data-journal-title="${entry.id}" value="${escapeHtml(entry.title || "")}" placeholder="Untitled entry" aria-label="Entry title">
      <button class="icon-button danger-button" data-delete-journal-entry="${entry.id}" type="button" aria-label="Delete entry">×</button>
    </div>
    <textarea class="journal-body-input" data-journal-body="${entry.id}" rows="3" placeholder="Write here..." aria-label="Entry body">${escapeHtml(entry.body || "")}</textarea>
    <div class="journal-entry-row">
      <label>Mood<select data-journal-mood="${entry.id}" aria-label="Mood">${moodOptions(entry.mood || "")}</select></label>
      <input class="journal-tags-input" data-journal-tags="${entry.id}" value="${escapeHtml((entry.tags || []).join(", "))}" placeholder="Tags" aria-label="Tags">
    </div>
    ${entry.tags?.length ? `<div class="journal-tags">${entry.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    ${entry.photos?.length ? `<div class="journal-photos">${entry.photos.map((photo) => `<div class="journal-photo"><img src="${photo.dataUrl}" alt="Journal photo"><button class="icon-button danger-button" data-delete-journal-photo="${entry.id}:${photo.id}" type="button" aria-label="Remove photo">×</button></div>`).join("")}</div>` : ""}
    <label class="journal-photo-picker ghost">+ Add photo<input data-journal-photo-input="${entry.id}" type="file" accept="image/*" multiple></label>
  </article>`;
}

function resizeImageFile(file, maxWidth = 1280, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not read photo"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not read photo"));
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function filesToJournalPhotos(fileList) {
  const files = fileList ? [...fileList].slice(0, 8) : [];
  const photos = [];
  for (const file of files) {
    try {
      const dataUrl = await resizeImageFile(file);
      photos.push({ id: uniqueId("photo"), dataUrl, createdAt: new Date().toISOString() });
    } catch (error) {
      console.warn("Could not process photo", error);
    }
  }
  return photos;
}

const planBuckets = ["daily", "weekly", "monthly"];
const planBucketLabels = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
const planRecurrenceLabels = { none: "Does not repeat", daily: "Every day", weekdays: "Every weekday", weekly: "Every week", monthly: "Every month" };
let planActiveBucket = "daily";
let planSelectedDate = dateKey(new Date());
let planDragState = null;
let planEditingDailyTaskId = null;
let planEditingActualLogId = null;

const PLAN_TIMELINE_START_HOUR = 6;
const PLAN_TIMELINE_END_HOUR = 23;
const PLAN_PIXELS_PER_MINUTE = 2;

function ensurePlanData() {
  privateData.plans ||= { tasks: [] };
  privateData.plans.tasks ||= [];
  privateData.plans.actualLogs ||= {};
}

function actualLogsForDate(dateKey) {
  return privateData.plans.actualLogs?.[dateKey] || [];
}

function defaultPlanAnchorDate(bucket) {
  const now = new Date();
  if (bucket === "monthly") return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (bucket === "daily") return planSelectedDate;
  return now.toISOString().slice(0, 10);
}

function formatPlanAnchorDate(task) {
  if (!task.anchorDate) return "";
  if (task.bucket === "monthly") {
    const [year, month] = task.anchorDate.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  return new Date(`${task.anchorDate}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function renderPlan() {
  if (!privateData) return "";
  ensurePlanData();
  if (planActiveBucket === "daily") return renderDailyPlan();
  const tasks = groupPlanTasksByBucket(privateData.plans.tasks)[planActiveBucket];
  const bucketLabel = planBucketLabels[planActiveBucket].toLowerCase();
  return `
    <section class="plan-layout">
      ${renderPlanHead()}
      <form id="planTaskForm" class="plan-task-form card">
        <input name="title" placeholder="Add a ${bucketLabel} task" required>
        <input name="anchorDate" type="${planActiveBucket === "monthly" ? "month" : "date"}" value="${defaultPlanAnchorDate(planActiveBucket)}">
        <button type="submit">Add</button>
      </form>
      <div class="plan-task-list">
        ${tasks.length ? tasks.map(renderPlanTask).join("") : `<div class="empty-inline">No ${bucketLabel} tasks yet.</div>`}
      </div>
    </section>`;
}

function renderPlanHead() {
  return `<p class="private-note">Private to you — never shared with other household members.</p>
    <div class="plan-bucket-tabs">${planBuckets.map((bucket) => `<button class="${planActiveBucket === bucket ? "active" : ""}" data-plan-bucket="${bucket}" type="button">${planBucketLabels[bucket]}</button>`).join("")}</div>`;
}

function renderPlanTask(task) {
  return `<div class="plan-task-row ${task.done ? "done" : ""}" data-plan-task-id="${task.id}">
    <input type="checkbox" data-plan-task-check="${task.id}" ${task.done ? "checked" : ""} aria-label="Complete ${escapeHtml(task.title)}">
    <div class="plan-task-copy">
      <input class="plan-task-title" data-plan-task-title="${task.id}" value="${escapeHtml(task.title)}" aria-label="Task title">
      <small>${escapeHtml(formatPlanAnchorDate(task))}</small>
    </div>
    <button class="icon-button danger-button" data-delete-plan-task="${task.id}" type="button" aria-label="Delete task">×</button>
  </div>${renderSubtasks(task)}`;
}

function renderDailyPlan() {
  const dailyTasks = privateData.plans.tasks
    .filter((task) => task.bucket === "daily" && dailyTaskOccursOnDate(task, planSelectedDate))
    .slice()
    .sort((a, b) => (a.startTime ? timeToMinutes(a.startTime) : Infinity) - (b.startTime ? timeToMinutes(b.startTime) : Infinity));
  const scheduled = dailyTasks.filter((task) => task.startTime);
  const unscheduled = dailyTasks.filter((task) => !task.startTime);
  const dayLabel = new Date(`${planSelectedDate}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const hours = [];
  for (let hour = PLAN_TIMELINE_START_HOUR; hour <= PLAN_TIMELINE_END_HOUR; hour += 1) hours.push(hour);
  const timelineHeight = (PLAN_TIMELINE_END_HOUR - PLAN_TIMELINE_START_HOUR + 1) * 60 * PLAN_PIXELS_PER_MINUTE;
  const editingTask = planEditingDailyTaskId ? dailyTasks.find((task) => task.id === planEditingDailyTaskId) : null;
  if (!editingTask) planEditingDailyTaskId = null;
  const formDuration = Number(editingTask?.durationMinutes || 30);
  const formEndTime = editingTask?.startTime ? minutesToTime(timeToMinutes(editingTask.startTime) + formDuration) : "";
  const logsToday = actualLogsForDate(planSelectedDate);
  const editingLog = planEditingActualLogId ? logsToday.find((log) => log.id === planEditingActualLogId) : null;
  if (!editingLog) planEditingActualLogId = null;

  return `
    <section class="plan-layout">
      ${renderPlanHead()}
      <div class="plan-day-nav">
        <button class="icon-button" data-plan-day="prev" type="button" aria-label="Previous day">‹</button>
        <strong>${dayLabel}</strong>
        <button class="icon-button" data-plan-day="next" type="button" aria-label="Next day">›</button>
        <button class="ghost" data-plan-day="today" type="button">Today</button>
      </div>
      <div class="plan-form-row">
        <form id="planTaskForm" class="plan-task-form plan-task-form-daily card">
          <input name="title" placeholder="Add a task for this day" value="${escapeHtml(editingTask?.title || "")}" required>
          <label>Start time (optional)<input name="startTime" type="time" value="${editingTask?.startTime || ""}"></label>
          <label>Duration (min)<input name="durationMinutes" type="number" min="5" step="5" value="${formDuration}"></label>
          <label>End time<input name="endTimeDisplay" type="time" value="${formEndTime}" readonly tabindex="-1"></label>
          <label>Repeat<select name="recurrence">${Object.entries(planRecurrenceLabels).map(([value, label]) => `<option value="${value}" ${editingTask && editingTask.recurrence === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
          <button type="submit">${editingTask ? "Save changes" : "Add"}</button>
          ${editingTask ? `<button class="ghost" id="cancelPlanTaskEditButton" type="button">Cancel</button>` : ""}
        </form>
        <form id="actualLogForm" class="plan-task-form plan-task-form-daily card plan-actual-log-form">
          <span class="plan-form-col-label">${editingLog ? "Edit what actually happened" : "Log what actually happened"} (${dayLabel})</span>
          <label>Start time<input name="logStartTime" type="time" value="${editingLog?.startTime || ""}" required></label>
          <label>End time<input name="logEndTime" type="time" value="${editingLog?.endTime || ""}" required></label>
          <input name="logNote" placeholder="What did you actually do?" value="${escapeHtml(editingLog?.note || "")}" required>
          ${dailyTasks.length ? `
            <details class="plan-log-link-tasks" ${editingLog?.linkedTaskIds?.length ? "open" : ""}>
              <summary>Link to planned task(s) — optional${editingLog?.linkedTaskIds?.length ? ` (${editingLog.linkedTaskIds.length} selected)` : ""}</summary>
              ${dailyTasks.map((task) => `<label class="plan-log-link-option"><input type="checkbox" name="linkedTaskIds" value="${task.id}" ${editingLog?.linkedTaskIds?.includes(task.id) ? "checked" : ""}> ${escapeHtml(task.title)}</label>`).join("")}
            </details>` : ""}
          <div class="plan-form-actions">
            <button type="submit">${editingLog ? "Save changes" : "Log it"}</button>
            ${editingLog ? `<button class="ghost" id="cancelActualLogEditButton" type="button">Cancel</button><button class="danger-button" id="deleteActualLogButton" type="button">Delete</button>` : ""}
          </div>
        </form>
      </div>
      ${unscheduled.length ? `<div class="plan-unscheduled"><h4>Unscheduled</h4>${unscheduled.map((task) => renderPlanTaskDaily(task)).join("")}</div>` : ""}
      <div class="plan-timeline" style="height:${timelineHeight + 28}px">
        <div class="plan-timeline-hours-label"></div>
        <div class="plan-timeline-col-label plan-timeline-col-label-planned">Planned</div>
        <div class="plan-timeline-col-label plan-timeline-col-label-actual">Actual</div>
        <div class="plan-timeline-hours">${hours.map((hour) => `<div class="plan-timeline-hour" style="height:${60 * PLAN_PIXELS_PER_MINUTE}px">${formatHourLabel(hour)}</div>`).join("")}</div>
        <div class="plan-timeline-body plan-timeline-body-planned" style="height:${timelineHeight}px" data-plan-timeline>
          ${(() => {
            const layout = layoutTimelineBlocks(scheduled.map((task) => ({
              id: task.id,
              start: timeToMinutes(task.startTime),
              end: timeToMinutes(task.startTime) + Number(task.durationMinutes || 30)
            })));
            const layoutById = new Map(layout.map((item) => [item.id, item]));
            return scheduled.map((task) => renderTimelineBlock(task, layoutById.get(task.id))).join("");
          })()}
        </div>
        <div class="plan-timeline-body plan-timeline-body-actual" style="height:${timelineHeight}px">
          ${(() => {
            const layout = layoutTimelineBlocks(logsToday.map((log) => ({
              id: log.id,
              start: timeToMinutes(log.startTime),
              end: timeToMinutes(log.endTime)
            })));
            const layoutById = new Map(layout.map((item) => [item.id, item]));
            const tasksById = new Map(dailyTasks.map((task) => [task.id, task]));
            return logsToday.map((log) => renderActualLogBlock(log, tasksById, layoutById.get(log.id))).join("");
          })()}
        </div>
      </div>
      ${scheduled.length ? `<div class="plan-timeline-details">${scheduled.map((task) => `<div class="plan-timeline-detail"><h4>${escapeHtml(task.title)}</h4>${renderSubtasks(task)}</div>`).join("")}</div>` : ""}
    </section>`;
}

function formatHourLabel(hour) {
  const period = hour < 12 || hour === 24 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour} ${period}`;
}

function describeLinkedActualLogs(task, linkedLogs) {
  if (!linkedLogs.length) return { deviationClass: "", label: "" };
  if (linkedLogs.length === 1) {
    const log = linkedLogs[0];
    const { startDeltaMinutes, durationDeltaMinutes } = comparePlannedToActual({
      plannedStartTime: task.startTime,
      plannedDurationMinutes: Number(task.durationMinutes || 30),
      actualStartTime: log.startTime,
      actualEndTime: log.endTime
    });
    const parts = [`Actual ${log.startTime || "?"}–${log.endTime || "?"}`];
    if (startDeltaMinutes) parts.push(`started ${Math.abs(startDeltaMinutes)} min ${startDeltaMinutes > 0 ? "late" : "early"}`);
    if (durationDeltaMinutes) parts.push(`ran ${Math.abs(durationDeltaMinutes)} min ${durationDeltaMinutes > 0 ? "over" : "under"}`);
    if (log.note) parts.push(log.note);
    return { deviationClass: startDeltaMinutes || durationDeltaMinutes ? "deviated" : "on-time", label: parts.join(" · ") };
  }
  return { deviationClass: "deviated", label: `Overlaps: ${linkedLogs.map((log) => log.note).join(", ")}` };
}

function renderTimelineBlock(task, layoutInfo) {
  const startMinutes = timeToMinutes(task.startTime) - PLAN_TIMELINE_START_HOUR * 60;
  const duration = Number(task.durationMinutes || 30);
  const endTime = minutesToTime(timeToMinutes(task.startTime) + duration);
  const top = Math.max(0, startMinutes * PLAN_PIXELS_PER_MINUTE);
  const height = Math.max(24, duration * PLAN_PIXELS_PER_MINUTE);
  const compact = height < 56;
  const compactSubtitle = compact && height >= 34;
  const done = isDailyTaskDoneOnDate(task, planSelectedDate);
  const editing = task.id === planEditingDailyTaskId;
  const columns = layoutInfo?.columns || 1;
  const column = layoutInfo?.column || 0;
  const gutter = 6;
  const gap = columns > 1 ? 4 : 0;
  const left = `calc(${gutter}px + (100% - ${gutter * 2}px) * ${column} / ${columns})`;
  const width = `calc((100% - ${gutter * 2}px) / ${columns} - ${gap}px)`;
  const timeRangeLabel = `${task.startTime}–${endTime}`;
  const linkedLogs = actualLogsForDate(planSelectedDate).filter((log) => (log.linkedTaskIds || []).includes(task.id));
  const { deviationClass, label: actualComparison } = describeLinkedActualLogs(task, linkedLogs);
  const tooltip = actualComparison ? `${task.title}: ${timeRangeLabel} · ${actualComparison}` : `${task.title}: ${timeRangeLabel}`;
  return `<div class="plan-timeline-block ${done ? "done" : ""} ${compact ? "compact" : ""} ${editing ? "editing" : ""} ${actualComparison ? `has-actual ${deviationClass}` : ""}" data-plan-task-id="${task.id}" style="top:${top}px;height:${height}px;left:${left};width:${width}" title="${escapeHtml(tooltip)}">
    <input type="checkbox" data-plan-task-check="${task.id}" ${done ? "checked" : ""} aria-label="Complete ${escapeHtml(task.title)}">
    <div class="plan-block-copy">
      <input class="plan-task-title" data-plan-task-title="${task.id}" value="${escapeHtml(task.title)}" aria-label="Task title">
      ${compact
        ? (compactSubtitle ? `<small>${escapeHtml(timeRangeLabel)}</small>` : "")
        : `<small>${escapeHtml(timeRangeLabel)} · ${duration} min${task.recurrence && task.recurrence !== "none" ? ` · ${planRecurrenceLabels[task.recurrence]}` : ""}${task.subtasks?.length ? ` · ${task.subtasks.filter((item) => item.done).length}/${task.subtasks.length} subtasks` : ""}</small>`}
    </div>
    <button class="icon-button danger-button" data-delete-plan-task="${task.id}" type="button" aria-label="Delete task">×</button>
    <div class="plan-block-resize-handle" data-plan-resize="${task.id}"></div>
  </div>`;
}

function renderActualLogBlock(log, tasksById, layoutInfo) {
  const startMinutes = timeToMinutes(log.startTime) - PLAN_TIMELINE_START_HOUR * 60;
  const duration = timeToMinutes(log.endTime) - timeToMinutes(log.startTime);
  const top = Math.max(0, startMinutes * PLAN_PIXELS_PER_MINUTE);
  const height = Math.max(24, duration * PLAN_PIXELS_PER_MINUTE);
  const compact = height < 56;
  const compactSubtitle = compact && height >= 34;
  const columns = layoutInfo?.columns || 1;
  const column = layoutInfo?.column || 0;
  const gutter = 6;
  const gap = columns > 1 ? 4 : 0;
  const left = `calc(${gutter}px + (100% - ${gutter * 2}px) * ${column} / ${columns})`;
  const width = `calc((100% - ${gutter * 2}px) / ${columns} - ${gap}px)`;
  const timeRangeLabel = `${log.startTime}–${log.endTime}`;
  const linkedTasks = (log.linkedTaskIds || []).map((id) => tasksById.get(id)).filter(Boolean);
  let deviationClass = "unplanned";
  let deviationLabel = "";
  if (linkedTasks.length === 1) {
    const task = linkedTasks[0];
    const { startDeltaMinutes, durationDeltaMinutes } = comparePlannedToActual({
      plannedStartTime: task.startTime,
      plannedDurationMinutes: Number(task.durationMinutes || 30),
      actualStartTime: log.startTime,
      actualEndTime: log.endTime
    });
    const parts = [];
    if (startDeltaMinutes) parts.push(`started ${Math.abs(startDeltaMinutes)} min ${startDeltaMinutes > 0 ? "late" : "early"}`);
    if (durationDeltaMinutes) parts.push(`ran ${Math.abs(durationDeltaMinutes)} min ${durationDeltaMinutes > 0 ? "over" : "under"}`);
    deviationLabel = parts.join(" · ");
    deviationClass = deviationLabel ? "deviated" : "on-time";
  } else if (linkedTasks.length > 1) {
    deviationClass = "deviated";
    deviationLabel = `Overlaps: ${linkedTasks.map((task) => task.title).join(", ")}`;
  }
  const tooltip = [`${log.note}: ${timeRangeLabel}`, deviationLabel].filter(Boolean).join(" · ");
  return `<div class="plan-timeline-block plan-actual-block ${compact ? "compact" : ""} ${deviationClass}" data-edit-actual-log="${log.id}" role="button" tabindex="0" aria-label="Edit actual entry ${escapeHtml(log.note)}" style="top:${top}px;height:${height}px;left:${left};width:${width}" title="${escapeHtml(tooltip)}">
    <div class="plan-block-copy">
      <strong class="plan-actual-title">${escapeHtml(log.note)}</strong>
      ${compact
        ? (compactSubtitle ? `<small>${escapeHtml(timeRangeLabel)}</small>` : "")
        : `<small>${escapeHtml(timeRangeLabel)}${deviationLabel ? ` · ${escapeHtml(deviationLabel)}` : ""}</small>`}
    </div>
  </div>`;
}

function renderPlanTaskDaily(task) {
  const done = isDailyTaskDoneOnDate(task, planSelectedDate);
  const linkedLogs = actualLogsForDate(planSelectedDate).filter((log) => (log.linkedTaskIds || []).includes(task.id));
  const { label: actualLabel } = describeLinkedActualLogs(task, linkedLogs);
  return `<div class="plan-task-row ${done ? "done" : ""}" data-plan-task-id="${task.id}">
    <input type="checkbox" data-plan-task-check="${task.id}" ${done ? "checked" : ""} aria-label="Complete ${escapeHtml(task.title)}">
    <div class="plan-task-copy">
      <input class="plan-task-title" data-plan-task-title="${task.id}" value="${escapeHtml(task.title)}" aria-label="Task title">
      ${task.recurrence && task.recurrence !== "none" ? `<small>${planRecurrenceLabels[task.recurrence]}</small>` : ""}
      ${actualLabel ? `<small>${escapeHtml(actualLabel)}</small>` : ""}
    </div>
    <button class="icon-button danger-button" data-delete-plan-task="${task.id}" type="button" aria-label="Delete task">×</button>
  </div>${renderSubtasks(task)}`;
}

function renderSubtasks(task) {
  const subtasks = task.subtasks || [];
  return `<div class="plan-subtasks">
    ${subtasks.map((subtask) => `<div class="plan-subtask-row ${subtask.done ? "done" : ""}">
      <input type="checkbox" data-plan-subtask-check="${task.id}:${subtask.id}" ${subtask.done ? "checked" : ""} aria-label="Complete ${escapeHtml(subtask.text)}">
      <span>${escapeHtml(subtask.text)}</span>
      <button class="icon-button danger-button" data-delete-plan-subtask="${task.id}:${subtask.id}" type="button" aria-label="Delete subtask">×</button>
    </div>`).join("")}
    <form class="plan-add-subtask-form" data-add-plan-subtask="${task.id}">
      <input name="text" placeholder="Add a subtask" aria-label="Add a subtask">
    </form>
  </div>`;
}

function documentsFolderPath(folderId) {
  const folders = documentsData?.folders || [];
  const path = [];
  let cursor = folders.find((folder) => folder.id === folderId);
  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parentId ? folders.find((folder) => folder.id === cursor.parentId) : null;
  }
  return path;
}

function documentsFolderFullPath(folderId) {
  return documentsFolderPath(folderId).map((folder) => folder.name).join(" / ");
}

// A folder tagged to a wealth item implicitly tags every document inside it
// (and inside any of its subfolders), so you can tag a whole property's
// folder once instead of tagging each deed/patta/receipt individually.
function documentsLinkedToWealthItem(wealthItemType, wealthItemId) {
  if (!documentsData) return [];
  const folders = documentsData.folders;
  const inScope = new Set(folders.filter((folder) => folder.wealthItemType === wealthItemType && folder.wealthItemId === wealthItemId).map((folder) => folder.id));
  let changed = true;
  while (changed) {
    changed = false;
    folders.forEach((folder) => {
      if (folder.parentId && inScope.has(folder.parentId) && !inScope.has(folder.id)) {
        inScope.add(folder.id);
        changed = true;
      }
    });
  }
  return documentsData.documents.filter((document) =>
    (document.wealthItemType === wealthItemType && document.wealthItemId === wealthItemId) ||
    (document.folderId && inScope.has(document.folderId))
  );
}

function formatFileSize(sizeBytes) {
  const size = Number(sizeBytes) || 0;
  if (size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function renderDocumentNoteLinkPicker(document) {
  const notes = state.notes.entries.filter((note) => !note.trashed);
  const count = document.noteId ? 1 : 0;
  return `<details class="note-label-picker document-note-link-picker">
    <summary title="Link to a property note" aria-label="${count ? "Linked to a note" : "Link to a note"}">⚯</summary>
    <div class="note-label-picker-options">
      <label>
        <input type="radio" name="document-note-${document.id}" data-document-note-link="${document.id}" value="" ${!document.noteId ? "checked" : ""}>
        <span>No linked note</span>
      </label>
      ${notes.length ? notes.map((note) => `<label>
        <input type="radio" name="document-note-${document.id}" data-document-note-link="${document.id}" value="${note.id}" ${document.noteId === note.id ? "checked" : ""}>
        <span>${escapeHtml(note.title || "Untitled note")}</span>
      </label>`).join("") : `<small>No notes created yet</small>`}
    </div>
  </details>`;
}

function wealthItemLabel(wealthItemType, wealthItemId) {
  if (!wealthItemId) return null;
  const collection = wealthItemType === "liability" ? state.goals.netWorth.liabilities : state.goals.netWorth.assets;
  const item = collection.find((candidate) => candidate.id === wealthItemId);
  return item ? `${wealthItemType === "liability" ? "Liability" : "Asset"}: ${item.name}` : null;
}

function documentsWealthItemLabel(document) {
  return wealthItemLabel(document.wealthItemType, document.wealthItemId);
}

function wealthLinkPickerOptions(currentValue) {
  const assets = state.goals.netWorth.assets;
  const liabilities = state.goals.netWorth.liabilities;
  return { assets, liabilities, hasAny: Boolean(assets.length || liabilities.length), currentValue };
}

function renderDocumentWealthLinkPicker(document) {
  const currentValue = document.wealthItemId ? `${document.wealthItemType}:${document.wealthItemId}` : "";
  const { assets, liabilities, hasAny } = wealthLinkPickerOptions(currentValue);
  return `<details class="note-label-picker document-wealth-link-picker">
    <summary title="Tag to a wealth item" aria-label="${currentValue ? "Tagged to a wealth item" : "Tag to a wealth item"}">⛁</summary>
    <div class="note-label-picker-options">
      <label>
        <input type="radio" name="document-wealth-${document.id}" data-document-wealth-link="${document.id}" value="" ${!currentValue ? "checked" : ""}>
        <span>Not tagged</span>
      </label>
      ${hasAny ? "" : `<small>No assets or liabilities yet</small>`}
      ${assets.map((asset) => `<label>
        <input type="radio" name="document-wealth-${document.id}" data-document-wealth-link="${document.id}" value="asset:${asset.id}" ${currentValue === `asset:${asset.id}` ? "checked" : ""}>
        <span>Asset: ${escapeHtml(asset.name)}</span>
      </label>`).join("")}
      ${liabilities.map((liability) => `<label>
        <input type="radio" name="document-wealth-${document.id}" data-document-wealth-link="${document.id}" value="liability:${liability.id}" ${currentValue === `liability:${liability.id}` ? "checked" : ""}>
        <span>Liability: ${escapeHtml(liability.name)}</span>
      </label>`).join("")}
    </div>
  </details>`;
}

function renderFolderWealthLinkPicker(folder) {
  const currentValue = folder.wealthItemId ? `${folder.wealthItemType}:${folder.wealthItemId}` : "";
  const { assets, liabilities, hasAny } = wealthLinkPickerOptions(currentValue);
  return `<details class="note-label-picker document-wealth-link-picker">
    <summary title="Tag folder to a wealth item" aria-label="${currentValue ? "Folder tagged to a wealth item" : "Tag folder to a wealth item"}">⛁</summary>
    <div class="note-label-picker-options">
      <label>
        <input type="radio" name="folder-wealth-${folder.id}" data-folder-wealth-link="${folder.id}" value="" ${!currentValue ? "checked" : ""}>
        <span>Not tagged</span>
      </label>
      ${hasAny ? "" : `<small>No assets or liabilities yet</small>`}
      ${assets.map((asset) => `<label>
        <input type="radio" name="folder-wealth-${folder.id}" data-folder-wealth-link="${folder.id}" value="asset:${asset.id}" ${currentValue === `asset:${asset.id}` ? "checked" : ""}>
        <span>Asset: ${escapeHtml(asset.name)}</span>
      </label>`).join("")}
      ${liabilities.map((liability) => `<label>
        <input type="radio" name="folder-wealth-${folder.id}" data-folder-wealth-link="${folder.id}" value="liability:${liability.id}" ${currentValue === `liability:${liability.id}` ? "checked" : ""}>
        <span>Liability: ${escapeHtml(liability.name)}</span>
      </label>`).join("")}
    </div>
  </details>`;
}

function renderDocumentRow(document) {
  const linkedNote = document.noteId ? state.notes.entries.find((note) => note.id === document.noteId) : null;
  const wealthLabel = documentsWealthItemLabel(document);
  return `<div class="documents-file-row" data-document-id="${document.id}" draggable="true" data-drag-type="document" data-drag-id="${document.id}">
    <div class="documents-file-info">
      <strong>${escapeHtml(document.name)}</strong>
      <small>${[formatFileSize(document.sizeBytes), document.status === "pending" ? "Uploading…" : document.contentType].filter(Boolean).join(" · ")}</small>
      ${linkedNote ? `<small class="documents-linked-note">Linked to “${escapeHtml(linkedNote.title || "Untitled note")}”</small>` : ""}
      ${wealthLabel ? `<small class="documents-linked-note">Tagged to ${escapeHtml(wealthLabel)}</small>` : ""}
    </div>
    <div class="documents-file-actions">
      <select class="documents-move-select" data-documents-move="${document.id}" aria-label="Move to folder">
        <option value="">All documents (root)</option>
        ${documentsData.folders.map((folder) => `<option value="${folder.id}" ${document.folderId === folder.id ? "selected" : ""}>${escapeHtml(documentsFolderFullPath(folder.id))}</option>`).join("")}
      </select>
      ${renderDocumentNoteLinkPicker(document)}
      ${renderDocumentWealthLinkPicker(document)}
      <button type="button" class="documents-icon-btn" data-documents-download="${document.id}" title="Download" aria-label="Download ${escapeHtml(document.name)}">⇩</button>
      <button type="button" class="documents-icon-btn danger-button" data-documents-delete="${document.id}" title="Delete" aria-label="Delete ${escapeHtml(document.name)}">×</button>
    </div>
  </div>`;
}

function renderDocuments() {
  if (ensureDebtNetWorthSync()) autosaveState();
  if (!documentsData) return `<p class="muted">Loading documents…</p>`;
  const folders = documentsData.folders;
  const documents = documentsData.documents;
  const currentFolderId = documentsCurrentFolderId || null;
  const subfolders = folders.filter((folder) => (folder.parentId || null) === currentFolderId);
  const currentDocuments = documents.filter((item) => (item.folderId || null) === currentFolderId);
  const breadcrumb = documentsFolderPath(currentFolderId);
  return `<section class="documents-layout">
    <p class="muted">Shared with your whole household — deeds, patta, tax receipts and other property documents.</p>
    <div class="documents-toolbar">
      <div class="documents-breadcrumb">
        <button type="button" data-documents-open-folder="" data-documents-drop-target="" class="${!currentFolderId ? "active" : ""}">All documents</button>
        ${breadcrumb.map((folder) => `<span aria-hidden="true">/</span><button type="button" data-documents-open-folder="${folder.id}" data-documents-drop-target="${folder.id}" class="${currentFolderId === folder.id ? "active" : ""}">${escapeHtml(folder.name)}</button>`).join("")}
      </div>
      <div class="documents-actions">
        <button type="button" data-documents-new-folder>+ New folder</button>
        <label class="documents-upload-button ${documentsUploading ? "disabled" : ""}">
          ${documentsUploading ? "Uploading…" : "+ Upload"}
          <input type="file" data-documents-file-input ${documentsUploading ? "disabled" : ""}>
        </label>
      </div>
    </div>
    ${subfolders.length ? `<div class="documents-folder-grid">
      ${subfolders.map((folder) => `<div class="documents-folder-card" draggable="true" data-drag-type="folder" data-drag-id="${folder.id}" data-documents-drop-target="${folder.id}">
        <div class="documents-folder-card-row">
          <button type="button" class="documents-folder-open" data-documents-open-folder="${folder.id}">▢ ${escapeHtml(folder.name)}</button>
          <button type="button" class="documents-icon-btn" data-documents-rename-folder="${folder.id}" title="Rename folder" aria-label="Rename ${escapeHtml(folder.name)} folder">✎</button>
          ${renderFolderWealthLinkPicker(folder)}
          <button type="button" class="documents-icon-btn danger-button" data-documents-delete-folder="${folder.id}" title="Delete folder" aria-label="Delete ${escapeHtml(folder.name)} folder">×</button>
        </div>
        ${folder.wealthItemId ? `<small class="documents-linked-note">Tagged to ${escapeHtml(wealthItemLabel(folder.wealthItemType, folder.wealthItemId) || "")}</small>` : ""}
      </div>`).join("")}
    </div>` : ""}
    ${currentDocuments.length ? `<div class="documents-file-list">${currentDocuments.map(renderDocumentRow).join("")}</div>` : `<p class="muted">No documents in this folder yet.</p>`}
  </section>`;
}

function ensureDecisionsData() {
  state.decisions ||= [];
  state.decisions.forEach((decision) => {
    decision.id ||= uniqueId("decision");
    decision.notes ||= "";
    decision.status ||= "open";
    decision.outcome ||= "";
    decision.decidedAt ||= "";
    decision.pros ||= [];
    decision.cons ||= [];
    decision.attachments ||= [];
    decision.createdAt ||= new Date().toISOString();
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

const DECISION_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const DECISION_ATTACHMENT_MAX_COUNT = 5;

// Attachments are stored inline as data URLs (like Journal photos) rather than
// through the separate Documents/GCS pipeline, because decisions sync across
// a user's whole set of households (see ensureDecisionsData's caller) while
// documents are scoped to a single household — keeping attachments inline
// avoids that mismatch entirely.
async function filesToDecisionAttachments(fileList, existingCount) {
  const files = fileList ? [...fileList].slice(0, Math.max(0, DECISION_ATTACHMENT_MAX_COUNT - existingCount)) : [];
  const attachments = [];
  for (const file of files) {
    if (file.size > DECISION_ATTACHMENT_MAX_BYTES) {
      window.alert(`${file.name} is larger than 5MB and was skipped.`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      attachments.push({ id: uniqueId("attachment"), name: file.name, contentType: file.type || "application/octet-stream", sizeBytes: file.size, dataUrl, createdAt: new Date().toISOString() });
    } catch (error) {
      console.warn("Could not process attachment", error);
    }
  }
  return attachments;
}

function decisionAttachmentRow(decisionId, attachment) {
  return `<div class="decision-attachment">
    <a class="decision-attachment-link" href="${attachment.dataUrl}" download="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</a>
    <small>${formatFileSize(attachment.sizeBytes)}</small>
    <button class="icon-button danger-button" data-delete-decision-attachment="${decisionId}:${attachment.id}" type="button" aria-label="Remove ${escapeHtml(attachment.name)}">×</button>
  </div>`;
}

function decisionItemRow(decisionId, listKey, item, index, total) {
  const kind = listKey === "pros" ? "pro" : "con";
  return `<li class="decision-item">
    <span class="member-dot" style="background:${memberColor(item.authorKey)}" title="${escapeHtml(item.authorName)}" aria-hidden="true"></span>
    <input class="decision-item-input" data-decision-item-text="${decisionId}:${listKey}:${item.id}" value="${escapeHtml(item.text)}" aria-label="Edit this ${kind}">
    <div class="decision-item-actions">
      <button class="documents-icon-btn" data-decision-item-move="${decisionId}:${listKey}:${item.id}:up" type="button" aria-label="Move this ${kind} up in rank" ${index === 0 ? "disabled" : ""}>↑</button>
      <button class="documents-icon-btn" data-decision-item-move="${decisionId}:${listKey}:${item.id}:down" type="button" aria-label="Move this ${kind} down in rank" ${index === total - 1 ? "disabled" : ""}>↓</button>
      <button class="documents-icon-btn danger-button" data-delete-decision-item="${decisionId}:${listKey}:${item.id}" type="button" aria-label="Remove this ${kind}">×</button>
    </div>
  </li>`;
}

function renderDecisionCard(decision) {
  const isDecided = decision.status === "decided";
  return `<div class="card decision-card ${isDecided ? "is-decided" : ""}">
    <div class="decision-card-header">
      <input class="decision-title-input" data-decision-title="${decision.id}" value="${escapeHtml(decision.title)}" aria-label="Decision title">
      <span class="pill ${isDecided ? "" : "pill-open"}">${isDecided ? "Decided" : "Open"}</span>
      <button class="icon-button danger-button" data-delete-decision="${decision.id}" type="button" aria-label="Delete ${escapeHtml(decision.title)}">×</button>
    </div>
    <textarea class="decision-notes-input" data-decision-notes="${decision.id}" placeholder="Any context worth remembering (optional)">${escapeHtml(decision.notes)}</textarea>
    <div class="decision-attachments">
      ${decision.attachments.map((attachment) => decisionAttachmentRow(decision.id, attachment)).join("")}
      ${decision.attachments.length < DECISION_ATTACHMENT_MAX_COUNT ? `<label class="decision-attachment-picker ghost">+ Attach a file<input data-decision-attachment-input="${decision.id}" type="file" multiple></label>` : ""}
    </div>
    ${isDecided ? `<div class="decision-outcome">
      <strong>Outcome:</strong> ${escapeHtml(decision.outcome) || "<em>No outcome noted</em>"}
      <small>${decision.decidedAt ? ` · ${decision.decidedAt.slice(0, 10)}` : ""}</small>
      <button class="ghost" data-reopen-decision="${decision.id}" type="button">Reopen</button>
    </div>` : ""}
    <div class="decision-columns">
      <div class="decision-column decision-column-pro">
        <h4>Pros</h4>
        <ul class="decision-item-list">${decision.pros.map((item, index) => decisionItemRow(decision.id, "pros", item, index, decision.pros.length)).join("")}</ul>
        <form class="decision-add-item-form" data-decision-add="${decision.id}:pros">
          <input name="text" placeholder="Add a pro" required>
          <button type="submit">+</button>
        </form>
      </div>
      <div class="decision-column decision-column-con">
        <h4>Cons</h4>
        <ul class="decision-item-list">${decision.cons.map((item, index) => decisionItemRow(decision.id, "cons", item, index, decision.cons.length)).join("")}</ul>
        <form class="decision-add-item-form" data-decision-add="${decision.id}:cons">
          <input name="text" placeholder="Add a con" required>
          <button type="submit">+</button>
        </form>
      </div>
    </div>
    ${!isDecided ? `<form class="decision-decide-form" data-decision-decide="${decision.id}">
      <input name="outcome" placeholder="What did you decide? (optional)">
      <button type="submit">Mark decided</button>
    </form>` : ""}
  </div>`;
}

function renderDecisions() {
  ensureDecisionsData();
  const decisions = [...state.decisions].sort((a, b) => {
    if ((a.status === "decided") !== (b.status === "decided")) return a.status === "decided" ? 1 : -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return `<section class="decisions-layout">
    <p class="muted">Weigh a family decision together — add pros and cons, then mark it decided once you've chosen.</p>
    <div class="card">
      <div class="card-label">New decision</div>
      <form id="decisionForm" class="decision-form">
        <label>Question<input name="title" placeholder="Should we move to a bigger apartment?" required></label>
        <label>Notes (optional)<textarea name="notes" placeholder="Any context worth remembering"></textarea></label>
        <button type="submit">Add decision</button>
      </form>
    </div>
    ${decisions.length ? decisions.map(renderDecisionCard).join("") : `<p class="muted">No decisions yet — add one above to start weighing it together.</p>`}
  </section>`;
}

function renderMeals() {
  const meals = ["Breakfast", "Lunch", "Dinner", "Snack"];
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  ensureMealWeekData();
  const weeks = mealWeeksForMonth(state.budget.month);
  const selectedWeek = selectedMealWeek();
  const selectedWeekInfo = weeks.find((week) => week.number === selectedWeek) || weeks[0];
  const selectedRecipe = recipeById(state.meals.selectedRecipeId) || state.meals.recipes[0];
  state.meals.selectedRecipeId = selectedRecipe?.id || "";
  return `
    <section class="meal-layout">
      <div class="work-grid">
        <div class="main-stack">
          <section class="card">
            <div class="section-head"><div><span class="card-label">Meal plan</span><h3>Household meal plan</h3></div><div class="button-row"><button id="saveMealWeekButton" class="ghost" type="button">Save week</button><button id="postGroceriesButton" class="ghost" type="button">Post groceries</button></div></div>
            <p class="meal-feedback" role="status">${escapeHtml(mealsFeedback || "")}</p>
            <form id="mealPlanForm" class="meal-toolbar">
              <label>Day<select name="day">${days.map((day) => `<option value="${day}">${day}</option>`).join("")}</select></label>
              <label>Meal<select name="slot">${meals.map((meal) => `<option value="${meal}">${meal}</option>`).join("")}</select></label>
              <label class="custom-combobox meal-recipe-combobox">Recipe
                <input id="mealRecipeName" autocomplete="off" placeholder="Search recipes or type any meal" value="${selectedRecipe?.name || ""}">
                <input id="mealRecipeId" name="recipeId" type="hidden" value="${selectedRecipe?.id || ""}">
                <div id="mealRecipeMenu" class="combo-menu" hidden>
                  ${state.meals.recipes.map((recipe) => `<button type="button" data-meal-recipe-option="${recipe.id}">${recipe.name}</button>`).join("")}
                </div>
              </label>
              <label>Servings<input name="servings" type="number" min="1" max="99" step="1" value="3" required></label>
              <button id="addMealRecipeButton" class="ghost" type="button">Add recipe</button>
              <button id="planMealButton" type="button">Plan meal</button>
            </form>
            <div class="meal-week-caption"><strong>Week ${selectedWeek}</strong><span>${selectedWeekInfo.label} · ${monthLabel()}</span></div>
            <div class="meal-grid">
              ${days.map((day, dayIndex) => {
                const dayDate = new Date(selectedWeekInfo.start);
                dayDate.setDate(dayDate.getDate() + dayIndex);
                const dayDateLabel = dayDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                return `<div class="meal-day"><h4><span>${day}</span></h4><div class="meal-day-date">${dayDateLabel}</div>${meals.map((meal) => {
                const plannedItems = plannedMeals(day, meal);
                const slots = plannedItems.map((planned) => {
                  const plannedIndex = state.meals.plannedWeek.indexOf(planned);
                  return `<div class="meal-slot meal-slot-planned" data-edit-planned-meal="${plannedIndex}" role="button" tabindex="0" aria-label="Edit ${escapeHtml(planned.meal)} for ${day} ${meal}">
                    <div class="meal-slot-head"><small>${meal}</small><button class="meal-remove-button" data-remove-planned-meal="${plannedIndex}" type="button" aria-label="Remove ${meal} from ${day}">×</button></div>
                    <strong>${escapeHtml(planned.meal)}</strong>
                    <em>${escapeHtml(recipeIngredients(planned.recipeId).slice(0, 2).join(", "))}</em>
                    <label class="meal-servings-field">Servings<input data-meal-servings="${plannedIndex}" type="number" min="1" max="99" step="1" value="${planned.servings || 1}"></label>
                  </div>`;
                }).join("");
                const openSlot = plannedItems.length === 0
                  ? `<button class="meal-slot meal-slot-open" data-open-meal="${day}:${meal}" type="button"><small>${meal}</small><strong>Open</strong></button>`
                  : "";
                return `${slots}${openSlot}`;
              }).join("")}</div>`;
              }).join("")}
            </div>
          </section>
        </div>
        <aside class="side-stack">
          <section class="card"><div class="card-label">Nutrition</div><h3>Calories and protein goals</h3>${progressNumberBlock("Daily calories", 1780, state.meals.nutritionGoals.calories, "kcal")}${progressNumberBlock("Daily protein", 130, state.meals.nutritionGoals.protein, "g")}</section>
          <section class="card"><div class="card-label">Smart grocery list</div><h3>Auto-built from meals</h3>${groceryList().slice(0, 10).map((item) => compactRow(item, "from meal plan", "1x")).join("")}</section>
        </aside>
      </div>
    </section>`;
}

function renderRecipes() {
  const editingRecipe = recipeById(state.meals.editingRecipeId);
  return `
    <section class="recipe-library">
      <section class="card">
        <div class="section-head"><div><span class="card-label">Recipe setup</span><h3>${editingRecipe ? "Update recipe" : "Add a recipe"}</h3></div></div>
        <form id="recipeForm" class="recipe-builder">
          <input name="recipeId" type="hidden" value="${editingRecipe?.id || ""}">
          <label>Name<input name="name" placeholder="Vegetable curry" value="${editingRecipe?.name || ""}" required></label>
          <label>Ingredients<input name="ingredients" placeholder="onion, tomato, lentils" value="${editingRecipe?.ingredients.join(", ") || ""}" required></label>
          <label>Calories<input name="calories" type="number" min="0" value="${editingRecipe?.calories ?? 400}"></label>
          <label>Protein (g)<input name="protein" type="number" min="0" value="${editingRecipe?.protein ?? 20}"></label>
          <div class="recipe-form-actions">
            ${editingRecipe ? `<button id="cancelRecipeEditButton" class="ghost" type="button">Cancel</button>` : ""}
            <button type="submit">${editingRecipe ? "Update recipe" : "Add recipe"}</button>
          </div>
        </form>
      </section>
      <section class="card">
        <div class="section-head">
          <div><span class="card-label">Saved recipes</span><h3>Recipes, ingredients and grocery-ready meals</h3></div>
        </div>
        <div class="recipe-grid">
          ${state.meals.recipes.map((recipe) => `
            <article class="recipe-card">
              <div class="section-head">
                <div><strong>${recipe.name}</strong><small>${recipe.calories} calories · ${recipe.protein}g protein</small></div>
                <span class="pill">${recipe.ingredients.length} items</span>
              </div>
              <div class="mini-tags">${recipe.ingredients.map((ingredient) => `<span>${ingredient}</span>`).join("")}</div>
              <div class="recipe-actions">
                <button class="ghost" type="button" data-select-recipe="${recipe.id}">Use in Meals</button>
                <button class="ghost" type="button" data-edit-recipe="${recipe.id}">Edit</button>
                <button class="icon-button danger-button" data-delete-recipe="${recipe.id}" type="button">×</button>
              </div>
            </article>
          `).join("")}
        </div>
      </section>
    </section>`;
}

function renderGoals() {
  return `
    <section class="narrow-layout">
      <section class="card">
        <div class="section-head"><div><span class="card-label">Funding</span><h3>Sinking funds and goals</h3></div><button id="addGoalButton" type="button">+ Add goal</button></div>
        ${state.goals.sinkingFunds.length ? state.goals.sinkingFunds.map((fund, index) => `
          <article class="goal-card">
            <div class="goal-edit-grid">
              <label class="goal-name-field">Goal name<input data-goal-name="${index}" value="${escapeHtml(fund.name || "")}" placeholder="Emergency fund"></label>
              <label>Target amount<input data-goal-target="${index}" type="number" min="0" step="0.01" value="${Number(fund.target || 0)}"></label>
              <label>Saved so far<input data-goal-saved="${index}" type="number" min="0" step="0.01" value="${Number(fund.saved || 0)}"></label>
              <label>Target date<input data-goal-date="${index}" type="date" value="${fund.targetDate || ""}"></label>
              <button class="icon-button danger-button" data-delete-goal="${index}" type="button" aria-label="Remove ${escapeHtml(fund.name || "goal")}">×</button>
            </div>
            ${progressBlock("Progress", fund.saved, fund.target)}
            <div class="split-stat"><span>${Math.round((fund.saved / Math.max(fund.target, 1)) * 100)}%</span><b>${money.format(fund.target - fund.saved)} remaining</b></div>
          </article>
        `).join("") : `<div class="onboarding-empty compact-onboarding"><div class="empty-symbol" aria-hidden="true">◎</div><h3>Create your first goal</h3><p>Give it a target amount and date, then update the saved balance as you make progress.</p><button id="emptyAddGoalButton" type="button">Add a goal</button></div>`}
      </section>
    </section>`;
}

function renderWealth() {
  if (ensureDebtNetWorthSync()) autosaveState();
  ensureAccountsData();
  return `
    <section class="work-grid wealth-layout">
      <div class="main-stack">
        <section class="card">
          <div class="section-head"><div><span class="card-label">Cash flow</span><h3>Accounts</h3></div><button id="addAccountButton" type="button">+ Add account</button></div>
          ${state.accounts.length ? state.accounts.map((account, index) => accountItemRow(account, index)).join("") : `<div class="onboarding-empty compact-onboarding"><div class="empty-symbol" aria-hidden="true">▥</div><h3>Add your first account</h3><p>Track a checking account your paycheck deposits into, and a credit card whose purchases it pays off.</p></div>`}
        </section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">Cash flow</span><h3>Transfers</h3></div></div>
          ${state.accounts.length >= 2 ? `<form id="transferForm" class="mini-form">
            <label>From<select name="fromAccountId">${accountOptions("")}</select></label>
            <label>To<select name="toAccountId">${accountOptions("")}</select></label>
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" placeholder="620.00" required></label>
            <label>Date<input name="date" type="date" value="${dateKey(new Date())}"></label>
            <label>Memo<input name="memo" placeholder="Credit card payment"></label>
            <button type="submit">Transfer</button>
          </form>` : `<div class="empty-inline">Add at least two accounts to record a transfer, like paying a credit card from checking.</div>`}
          ${state.transfers.length ? state.transfers.map((transfer, index) => transferRow(transfer, index)).join("") : ""}
        </section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">Debt snowball</span><h3>Debt payoff tracker</h3></div><button id="addDebtButton" type="button">+ Add debt</button></div>
          ${state.goals.debts.length ? state.goals.debts.map((debt, index) => `<article class="debt-card">
            <div class="debt-edit-grid">
              <label class="debt-name-field">Debt name<input data-debt-name="${index}" value="${escapeHtml(debt.name)}" aria-label="Debt name"></label>
              <label>Current balance<input data-debt-balance="${index}" type="number" min="0" step="0.01" inputmode="decimal" value="${Number(debt.balance || 0)}" aria-label="Current balance for ${escapeHtml(debt.name)}"></label>
              <label>Interest rate (APR %)<input data-debt-rate="${index}" type="number" min="0" step="0.01" inputmode="decimal" value="${Number(debt.rate || 0)}" aria-label="Interest rate for ${escapeHtml(debt.name)}"></label>
              <label>Monthly EMI<input data-debt-minimum="${index}" type="number" min="0" step="0.01" inputmode="decimal" value="${Number(debt.minimum || 0)}" aria-label="Monthly EMI for ${escapeHtml(debt.name)}"></label>
              <label>Loan term (months)<input data-debt-term="${index}" type="number" min="0" step="1" inputmode="numeric" value="${Number(debt.termMonths || 0)}" aria-label="Loan term for ${escapeHtml(debt.name)}"></label>
              <label class="debt-asset-field">Secured by asset<select data-debt-asset="${index}" aria-label="Asset assigned to ${escapeHtml(debt.name)}">${debtAssetOptions(debt)}</select></label>
            </div>
            <div class="debt-payoff-summary"><span><b>Estimated payoff</b>${termLabel(payoffMonths(debt))}</span><span><b>Suggested EMI</b>${debt.termMonths ? money.format(suggestedEmi(debt)) : "Set a loan term"}</span>${debt.termMonths ? `<button class="ghost" data-use-suggested-emi="${index}" type="button">Use suggested EMI</button>` : ""}</div>
            <div class="bar"><span style="width:${Math.max(4, Math.min(95, Math.round((1 - debt.balance / 15000) * 100)))}%"></span></div>
            <div class="payment-row"><label>Additional payment<input data-debt-payment="${index}" value="0" type="number" min="0" step="0.01"></label><button class="ghost" data-apply-debt-payment="${index}" type="button" ${Number(debt.minimum || 0) <= 0 ? "disabled" : ""}>Record EMI payment</button><button class="icon-button danger-button" data-delete-debt="${index}" type="button" aria-label="Delete ${escapeHtml(debt.name)}">×</button></div>
            ${debt.payments?.length ? `<details class="payment-history"><summary>Payment history (${debt.payments.length})</summary>${debt.payments.slice(0, 8).map((payment) => `<div><span>${formatShortDate(payment.date)}</span><span>${money.format(payment.amount)} paid</span><span>${money.format(payment.principal)} principal</span><span>${money.format(payment.interest)} interest</span></div>`).join("")}</details>` : ""}
          </article>`).join("") : `<div class="onboarding-empty compact-onboarding"><div class="empty-symbol" aria-hidden="true">↓</div><h3>Add a debt when you are ready</h3><p>Track its balance, rate, payment, and the asset it secures.</p></div>`}
        </section>
      </div>
      <section class="card wealth-holdings"><div class="section-head"><div><span class="card-label">Net worth</span><h3>Assets, investments and liabilities</h3></div><button id="addNetWorthItemButton" type="button">+ Add holding</button></div><div class="net-worth-strip"><strong data-net-worth-total>${money.format(netWorth().total)}</strong><span>Assets <b data-net-worth-assets>${money.format(netWorth().assets)}</b> Liabilities <b data-net-worth-liabilities>${money.format(netWorth().liabilities)}</b></span></div><div class="net-worth-items">${state.goals.netWorth.assets.map((asset, index) => netWorthItemRow(asset, "asset", index)).join("")}${state.goals.netWorth.liabilities.map((item, index) => netWorthItemRow(item, "liability", index)).join("")}</div>${state.goals.netWorth.assets.length || state.goals.netWorth.liabilities.length ? "" : `<div class="empty-inline">No assets, investments or liabilities yet</div>`}</section>
    </section>`;
}

function accountItemRow(account, index) {
  const balance = currentAccountBalance(account.id);
  const isLiability = account.type === "credit_card";
  const typeLabels = { checking: "Checking", savings: "Savings", cash: "Cash", credit_card: "Credit card", other: "Other" };
  return `<article class="account-item ${isLiability ? "liability" : ""}">
    <div class="debt-edit-grid">
      <label class="debt-name-field">Account name<input data-account-name="${index}" value="${escapeHtml(account.name)}" aria-label="Account name"></label>
      <label>Type<select data-account-type="${index}" aria-label="Type for ${escapeHtml(account.name)}">${Object.entries(typeLabels).map(([value, label]) => `<option value="${value}" ${account.type === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label>Opening balance<input data-account-opening-balance="${index}" type="number" step="0.01" inputmode="decimal" value="${account.openingBalance}" aria-label="Opening balance for ${escapeHtml(account.name)}"></label>
    </div>
    <div class="account-balance-row">
      <div class="split-stat"><span>${isLiability ? "Owed" : "Balance"}</span><b class="${isLiability && balance > 0 ? "danger" : ""}">${money.format(balance)}</b></div>
      <button class="icon-button danger-button" data-delete-account="${index}" type="button" aria-label="Remove ${escapeHtml(account.name)}">×</button>
    </div>
  </article>`;
}

function transferRow(transfer, index) {
  return compactRow(
    `${escapeHtml(accountName(transfer.fromAccountId))} → ${escapeHtml(accountName(transfer.toAccountId))}`,
    `${formatShortDate(transfer.date)}${transfer.memo ? ` · ${escapeHtml(transfer.memo)}` : ""}`,
    money.format(transfer.amount),
    "",
    `data-delete-transfer="${index}" aria-label="Delete transfer"`
  );
}

function netWorthItemRow(item, type, index) {
  const isLiability = type === "liability";
  const isStock = !isLiability && item.assetClass === "stock";
  const wealthKey = `${type}:${item.id}`;
  const linkedDocuments = documentsLinkedToWealthItem(type, item.id);
  return `<div class="net-worth-item ${isLiability ? "liability" : ""} ${isStock ? "stock" : ""}">
    <label class="net-worth-name">Name<input data-net-worth-name="${type}:${index}" value="${escapeHtml(item.name)}" aria-label="${isLiability ? "Liability" : "Asset"} name"></label>
    <label>Type<select data-net-worth-type="${type}:${index}" aria-label="Item type"><option value="asset" ${isLiability ? "" : "selected"}>Asset</option><option value="liability" ${isLiability ? "selected" : ""}>Liability</option></select></label>
    ${isLiability ? "" : `<label>Asset class<select data-asset-class="${index}" aria-label="Asset class for ${escapeHtml(item.name)}"><option value="other" ${item.assetClass === "other" ? "selected" : ""}>Other asset</option><option value="cash" ${item.assetClass === "cash" ? "selected" : ""}>Cash</option><option value="property" ${item.assetClass === "property" ? "selected" : ""}>Property</option><option value="retirement" ${item.assetClass === "retirement" ? "selected" : ""}>Retirement</option><option value="stock" ${isStock ? "selected" : ""}>Stock</option></select></label>`}
    ${isStock
      ? `<label>Symbol<input data-stock-symbol="${index}" value="${escapeHtml(item.symbol || "")}" placeholder="AAPL" aria-label="Stock symbol for ${escapeHtml(item.name)}"></label><label>Shares<input data-stock-shares="${index}" type="number" min="0" step="0.0001" inputmode="decimal" value="${Number(item.shares || 0)}" aria-label="Number of shares for ${escapeHtml(item.name)}"></label><label>Price per share<input data-stock-price="${index}" type="number" min="0" step="0.01" inputmode="decimal" value="${Number(item.price || 0)}" aria-label="Share price for ${escapeHtml(item.name)}"></label><div class="stock-market-value"><span>Market value</span><strong data-stock-market-value="${index}">${money.format(assetValue(item))}</strong><button type="button" class="ghost stock-refresh-button" data-refresh-stock-price="${index}" aria-label="Pull live price for ${escapeHtml(item.symbol || item.name)}">↻ Live price</button>${stockPriceFeedback[item.id] ? `<small class="${stockPriceFeedback[item.id].isError ? "stock-price-error" : ""}">${escapeHtml(stockPriceFeedback[item.id].message)}</small>` : ""}</div>`
      : isAccountLinked(type, item.id)
        ? `<div class="net-worth-linked-value"><span>Amount (from account)</span><strong>${money.format(Number(item.value || 0))}</strong></div>`
        : `<label>Amount<input data-net-worth-value="${type}:${index}" type="number" min="0" step="0.01" inputmode="decimal" value="${Number(item.value || 0)}" aria-label="${isLiability ? "Liability" : "Asset"} amount"></label>`}
    <button class="icon-button danger-button" data-delete-${type}="${index}" type="button" aria-label="Remove ${escapeHtml(item.name)}">×</button>
    <button type="button" class="wealth-doc-chip" data-wealth-doc-toggle="${wealthKey}" title="Documents tagged to ${escapeHtml(item.name)}">📄 ${linkedDocuments.length}</button>
    ${wealthDocsExpandedKey === wealthKey ? `<div class="wealth-doc-list">
      ${linkedDocuments.length ? linkedDocuments.map((document) => `<div class="wealth-doc-list-row">
        <span>${escapeHtml(document.name)}</span>
        <button type="button" data-documents-download="${document.id}" title="Download" aria-label="Download ${escapeHtml(document.name)}">⇩</button>
      </div>`).join("") : `<small class="muted">No documents tagged to this ${isLiability ? "liability" : "asset"} yet — tag one from the Documents section.</small>`}
    </div>` : ""}
  </div>`;
}

function renderSharing() {
  const accessRoles = ["Co-owner, full edit", "Adult, budget and calendar", "Viewer, read only", "Meals and chores only"];
  const allScopes = [
    "Budget",
    "Transactions",
    "Bank sync",
    "Paychecks",
    "Calendar",
    "Chores",
    "Birthday reminders",
    "Anniversary reminders",
    "Notes",
    "Documents",
    "Meals",
    "Grocery lists",
    "Reminders",
    "Goals",
    "Debt payoff",
    "Net worth",
    "Reports"
  ];
  const sharedScopes = state.household.sharedScopes || [];
  const members = sharingAccess?.members || state.household.members.map((member, index) => ({
    ...member,
    status: member.role.includes("Invited") ? "pending" : "active",
    isOwner: index === 0
  }));
  return `
    <section class="work-grid">
      <div class="main-stack">
        <section class="card">
          <div class="section-head"><div><span class="card-label">Household</span><h3>Complete household sharing</h3></div><button id="inviteButton" type="button">Generate invite</button></div>
          <div class="invite-box"><span>Invite code</span><strong>${state.household.inviteCode || "No invite yet"}</strong></div>
          <div class="shared-box">
            <div class="section-head">
              <div>
                <h3>${state.household.name}</h3>
                <p>Share the complete household workspace, or choose exactly which areas members can access.</p>
              </div>
              <label class="share-all-toggle"><input id="shareEverythingToggle" type="checkbox" ${sharedScopes.length === allScopes.length ? "checked" : ""}> Share everything</label>
            </div>
            <div class="scope-grid">
              ${allScopes.map((scope) => `<label class="scope-toggle"><input data-share-scope="${scope}" type="checkbox" ${sharedScopes.includes(scope) ? "checked" : ""}> <span>${scope}</span></label>`).join("")}
            </div>
          </div>
          <form id="inviteMemberForm" class="invite-form">
            <label>Name<input name="name" placeholder="Household member" required></label>
            <label>Email<input name="email" type="email" placeholder="name@example.com" required></label>
            <label>Access<select name="role">${accessRoles.map((role) => `<option value="${role}">${role}</option>`).join("")}</select></label>
            ${households.filter((household) => household.role === "owner").length > 1 ? `
              <div class="invite-household-picker">
                <span>Also invite to</span>
                ${households.filter((household) => household.role === "owner").map((household) => `
                  <label class="invite-household-option">
                    <input type="checkbox" name="householdIds" value="${household.id}" ${household.selected ? "checked" : ""}>
                    ${escapeHtml(household.name)}${household.selected ? " (current)" : ""}
                  </label>`).join("")}
              </div>` : ""}
            <button type="submit">Send invite</button>
            <p id="inviteEmailStatus" class="form-message invite-email-status">${inviteEmailStatus}</p>
          </form>
          <div class="sharing-member-list">
            ${members.map((member) => {
              const otherOwnedHouseholds = households.filter((household) => household.role === "owner" && !household.selected);
              const canAddHousehold = sharingAccess?.canManage && !member.isOwner && otherOwnedHouseholds.length > 0;
              return `<div class="sharing-member-row">
              <div><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.email)}</small></div>
              <span class="pill">${escapeHtml(member.role)} · ${member.status === "pending" ? "Invited" : "Active"}${member.isOwner ? " · Owner" : ""}</span>
              <div class="sharing-member-actions">
                ${canAddHousehold ? `<details class="member-add-household-picker">
                  <summary class="ghost-summary">+ Add household</summary>
                  <div class="member-add-household-panel" data-member-email="${escapeHtml(member.email)}" data-member-name="${escapeHtml(member.name)}">
                    ${otherOwnedHouseholds.map((household) => `<label><input type="checkbox" value="${household.id}"> ${escapeHtml(household.name)}</label>`).join("")}
                    <label>Access<select>${accessRoles.map((role) => `<option value="${role}">${role}</option>`).join("")}</select></label>
                    <button type="button" class="ghost" data-send-additional-invite>Send invite</button>
                  </div>
                </details>` : ""}
                ${sharingAccess?.canManage && !member.isOwner ? `<button class="danger-button revoke-access-button" data-revoke-household-access="${escapeHtml(member.email)}" type="button">Revoke access</button>` : ""}
              </div>
            </div>`;
            }).join("")}
          </div>
        </section>
      </div>
      <aside class="side-stack">
        <section class="card">
          <div class="card-label">Shared access</div>
          <h3>Included areas</h3>
          ${sharedScopes.map((scope) => compactRow(scope, "Shared with household members", "On")).join("")}
        </section>
        <section class="card"><div class="card-label">Shared activity</div><h3>Household changes</h3>${state.household.activity.map((item) => compactRow(item, "May 21", "Log")).join("")}</section>
      </aside>
    </section>`;
}

function renderReports() {
  const categories = reportCategories();
  return `
    <section class="work-grid">
      <div class="main-stack">
        <section class="card"><div class="card-label">Spending</div><h3>Category report</h3>${categories.map((category) => `<div class="report-row"><strong>${category.name}</strong><div class="report-bar"><span style="width:${category.percent}%; background:${category.color}"></span></div><b>${money.format(category.value)}</b></div>`).join("")}</section>
      </div>
      <aside class="side-stack">
        <section class="card"><div class="card-label">Budget health</div><h3>Snapshot</h3><div class="snapshot-grid"><span>Pending <b>${money.format(61)}</b></span><span>Cash left <b>${money.format(remainingTotal())}</b></span><span>Savings and debt <b>${money.format(1220)}</b></span><span>Zero balance <b>${money.format(0)}</b></span></div><div class="donut"></div>${[[3460, "Essentials"], [1220, "Savings and debt"], [520, "Giving"]].map(([value, label]) => compactRow(`${label} - ${money.format(value)}`, "", "")).join("")}</section>
      </aside>
    </section>`;
}

function renderProfile() {
  const isDemo = sessionUser?.email === "demo@familyloop.net";
  return `<section class="profile-layout">
    <div class="card">
      <div class="card-label">Account</div>
      <h3>Your profile</h3>
      ${isDemo ? `<p class="muted">The demo account is shared by every visitor, so its name and password can't be changed here.</p>` : `
      <form id="profileNameForm" class="profile-form">
        <label>Name<input name="name" value="${escapeHtml(sessionUser?.name || "")}" required></label>
        <label>Email<input value="${escapeHtml(sessionUser?.email || "")}" disabled></label>
        <button type="submit">Save name</button>
        <p class="form-message ${profileNameFeedbackIsError ? "" : "success"}" data-profile-name-message>${escapeHtml(profileNameFeedback)}</p>
      </form>
      <div class="profile-verify-status">
        ${sessionUser?.emailVerified
          ? `<p class="form-message success">Email verified ✓</p>`
          : `<p class="form-message">Email not verified yet.</p><button type="button" class="ghost" data-resend-verification>Resend verification email</button>`}
        <p class="form-message ${profileVerifyFeedbackIsError ? "" : "success"}" data-profile-verify-message>${escapeHtml(profileVerifyFeedback)}</p>
      </div>`}
    </div>
    ${isDemo ? "" : `<div class="card">
      <div class="card-label">Security</div>
      <h3>Change password</h3>
      <form id="profilePasswordForm" class="profile-form">
        <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
        <label>New password<input name="newPassword" type="password" minlength="8" autocomplete="new-password" required></label>
        <label>Confirm new password<input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></label>
        <button type="submit">Update password</button>
        <p class="form-message ${profilePasswordFeedbackIsError ? "" : "success"}" data-profile-password-message>${escapeHtml(profilePasswordFeedback)}</p>
      </form>
    </div>`}
  </section>`;
}

function renderHelp() {
  const guides = [
    ["◈", "Households", "Switch households from the Current household dropdown in the sidebar — each one keeps entirely separate budgets, calendars, notes, and records. + Add creates another (one household per currency; you'll be blocked if you already have one in that currency). Set as default marks which household loads automatically the next time you sign in — it's a preference for you personally, not something that changes what other members see. Remove deletes a household outright and is blocked if it's your only one."],
    ["▦", "Budget", "Set your month's income, then create categories and the subcategories (budget lines) under them, each with a planned amount and an optional due day. Spent and Remaining update automatically as you assign transactions to a line. Use the copy-previous-budget option to reuse last month's categories instead of starting from scratch, and switch months from the picker in the header."],
    ["☰", "Transactions", "Add a transaction by payee and amount, then assign it to a budget line so Spent updates in Budget. If you've linked a bank account under Wealth, also link the transaction to that account so its running balance stays accurate. Transactions from a connected bank stream land in a review queue — accept or dismiss each one before it counts."],
    ["☑", "Paycheck/Income", "Add each paycheck with an amount and how often it repeats (one-time, bonus, weekly, biweekly, or monthly), then use the assign form to route pieces of it to specific budget lines. Set a paycheck's Deposit to account (under Wealth) so that account's balance reflects the deposit automatically instead of needing a matching manual transaction."],
    ["⌂", "Calendar", "Chores repeat on a schedule (weekly, every 2 or 3 weeks, or monthly) and rotate through the Chore rotation panel — mark one Complete to reveal its next occurrence, and anything overdue turns red as \"Past due.\" Birthdays and anniversaries recur every year automatically; set Remind before (or Don't remind) and Remind me at to control when the reminder email fires, and Mark wished once you've reached out. Plain Reminders have their own independent Remind me on time, fully separate from the event's own date/time — so an event at noon can remind you an hour earlier. Filter the whole calendar by household member using the chips above the grid."],
    ["✎", "Notes", "Create notes with labels, colors, and checklists — checklist items can be nested and will suggest matches from ones you've typed before. Pin the notes you check often, archive the ones you're done with but might need later, and anything trashed is permanently removed after 7 days."],
    ["✒", "Journal", "A private day-by-day journal for mood, tags, photos, and free text. It is never shared with other household members, even ones with full access to everything else."],
    ["◫", "Plan", "A private daily/weekly/monthly task planner with its own timeline view — schedule tasks with a start time and duration, then log what actually happened afterward to compare planned versus actual. Like Journal, this is yours alone; nobody else in the household can see it."],
    ["▢", "Documents", "Upload and organize household files into folders. Link a folder or an individual document to a specific asset or liability in Wealth (for example, a mortgage folder linked to your home) so the paperwork behind a number is easy to find later."],
    ["♨", "Meals and recipes", "Save reusable recipes with ingredients and nutrition info in Recipes, then drop them into the weekly Meals planner by day and slot. Planned ingredients automatically build your grocery list, and you can post it straight to a budget line."],
    ["◎", "Goals", "Track sinking funds — savings goals with a target amount and, optionally, a target date. Update Saved so far as you contribute, and the progress bar and remaining balance recalculate automatically."],
    ["▥", "Wealth", "Add real bank or credit-card Accounts with an opening balance; their balance is always computed live from linked transactions, paychecks, and transfers between accounts, never entered by hand. Link an account to a Net worth asset or liability and that entry updates with it automatically. The Debt payoff tracker estimates a payoff date and suggested payment from balance, rate, and term."],
    ["♙", "Sharing", "Generate a one-time invite code for someone to join your household, choosing a preset role (co-owner, adult, viewer, or meals/chores-only) or picking exact areas to share instead. Codes are single-use — resend a new one if theirs lapsed or was already used. Revoke access for any member from the member list at any time."],
    ["◷", "Reports and export", "Review spending by category and overall budget health for the selected month. Use the download button in the header to export whatever you're currently viewing — Budget, Transactions, Calendar, Wealth, and more — as a CSV file."]
  ];
  return `
    <section class="help-layout">
      <section class="help-visual-hero">
        <div>
          <span class="card-label">FamilyLoop guide</span>
          <h3>One household plan, shared clearly</h3>
          <p>Follow practical steps for money, meals, schedules, notes, and family access.</p>
        </div>
      </section>
      <section class="help-journey" aria-label="Getting started workflow">
        <article><span>1</span><div><strong>Choose a household</strong><small>Keep currencies and records separate; set one as your default.</small></div></article>
        <article><span>2</span><div><strong>Add what is real</strong><small>Start empty and enter only your data.</small></div></article>
        <article><span>3</span><div><strong>Review together</strong><small>Share access and revisit the plan.</small></div></article>
      </section>
      <section class="help-grid">
        ${guides.map(([icon, title, copy]) => `
          <article class="help-topic">
            <span class="help-topic-icon">${icon}</span>
            <div><h3>${title}</h3><p>${copy}</p></div>
          </article>
        `).join("")}
      </section>
      <section class="help-visual-feature">
        <img src="assets/familyloop-help-calendar-meals.jpg" alt="A shared weekly calendar, meal plan, and grocery checklist">
        <div><span class="card-label">Plan once, use it everywhere</span><h3>Connect the weekly details</h3><p>Add recurring chores in Calendar, save reusable recipes, then plan meals and groceries for the selected week. Each area stays editable by the household.</p></div>
      </section>
      <section class="help-columns">
        <article>
          <span class="card-label">Invitation help</span>
          <h3>Joining a shared household</h3>
          <ol>
            <li>Open the acceptance link in the invitation email, or select <strong>Accept invitation</strong> on the sign-in screen.</li>
            <li>Use the exact email address that received the invitation.</li>
            <li>Enter the invite code. New users create a 12+ character password; existing users enter their current password.</li>
            <li>Select <strong>Join household</strong>. The shared household opens automatically.</li>
          </ol>
          <p class="help-note">A code is single-use. Ask the household owner to resend the invitation if it was already accepted or replaced.</p>
        </article>
        <article>
          <span class="card-label">Account help</span>
          <h3>Password and sign-in</h3>
          <ol>
            <li>Select <strong>Forgot password?</strong> on the sign-in screen.</li>
            <li>Open the one-time reset link sent by FamilyLoop. It expires after 30 minutes.</li>
            <li>Choose a password with at least 12 characters, then sign in normally.</li>
          </ol>
          <p class="help-note">Check Spam and All Mail if a FamilyLoop email is not visible in the inbox.</p>
        </article>
      </section>
      <section class="help-footer">
        <div><span class="card-label">Need assistance?</span><h3>Contact the household owner first</h3></div>
        <p>Household owners manage invitations and shared access. Application administrators manage login availability.</p>
      </section>
    </section>`;
}

function renderAdmin() {
  const users = adminData?.users || [];
  const monthly = adminData?.monthly || [];
  return `
    <section class="admin-layout">
      <section class="card">
        <div class="section-head">
          <div><span class="card-label">Owner controls</span><h3>Application administration</h3></div>
          <button id="refreshAdminButton" class="ghost" type="button">Refresh stats</button>
        </div>
        <div class="admin-stat-grid">
          ${[
            ["Registered users", adminData?.stats?.users || 0],
            ["Enabled logins", adminData?.stats?.activeUsers || 0],
            ["Admin users", adminData?.stats?.admins || 0],
            ["Households", adminData?.stats?.households || 0],
            ["Total sign-ins", adminData?.stats?.totalLogins || 0],
            ["30-day login users", adminData?.stats?.recentLogins || 0]
          ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("")}
        </div>
      </section>
      <section class="card">
        <div class="section-head"><div><span class="card-label">Logins</span><h3>User access</h3></div></div>
        ${adminData ? `
          <div class="admin-table">
            <div class="admin-table-head">
              <span>User</span><span>Status</span><span>Logins</span><span>Last login</span><span>Controls</span>
            </div>
            ${users.map((user) => `
              <div class="admin-user-row">
                <div><strong>${user.name}</strong><small>${user.email}</small></div>
                <span class="pill ${user.disabled ? "danger" : ""}">${user.disabled ? "Disabled" : user.isAdmin ? "Admin" : "Active"}</span>
                <b>${user.loginCount}</b>
                <small>${user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Never"}</small>
                <div class="admin-actions">
                  <button class="ghost" data-admin-toggle-disabled="${user.id}" type="button">${user.disabled ? "Enable" : "Disable"}</button>
                  <button class="ghost" data-admin-reset-password="${user.id}" type="button">Reset password</button>
                </div>
              </div>
            `).join("")}
          </div>
        ` : `<div class="empty-inline">Loading admin statistics</div>`}
      </section>
      <section class="card">
        <div class="section-head"><div><span class="card-label">Month level statistics</span><h3>Application activity by month</h3></div></div>
        ${adminData ? `
          <div class="admin-month-table">
            <div class="admin-month-head">
              <span>Month</span><span>New users</span><span>New households</span><span>Logins</span><span>Users logged in</span>
            </div>
            ${monthly.map((row) => `
              <div class="admin-month-row">
                <strong>${row.label}</strong>
                <span>${row.usersCreated}</span>
                <span>${row.householdsCreated}</span>
                <span>${row.logins}</span>
                <span>${row.uniqueLoginUsers}</span>
              </div>
            `).join("")}
          </div>
        ` : `<div class="empty-inline">Loading monthly statistics</div>`}
      </section>
    </section>`;
}

function compactRow(title, detail, badge, tone = "", actionAttrs = "") {
  return `<div class="compact-row ${tone}"><div><strong>${title}</strong>${detail ? `<small>${detail}</small>` : ""}</div>${badge ? `<span class="pill">${badge}</span>` : ""}${actionAttrs ? `<button class="icon-button danger-button" ${actionAttrs} type="button">×</button>` : ""}</div>`;
}

function calendarManageRow(item) {
  const { title, sourceKind: kind, sourceId: id, assignees } = item;
  const detail = item.displayDate || item.date;
  const badge = item.label || item.type;
  // Plain reminders get the same per-assignee completion control chores use
  // (see reminderCompletionControl) — birthdays/anniversaries and chores
  // already have their own dedicated panels with this, so this only applies
  // to one-time reminders shown here.
  const isReminder = kind === "event" && item.type === "reminder";
  const reminderEvent = isReminder ? state.calendar.events.find((event) => event.id === id) : null;
  return `<div class="compact-row">
    <div>${assigneeDots(assignees)}<strong>${escapeHtml(title)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>
    ${badge ? `<span class="pill">${escapeHtml(badge)}</span>` : ""}
    ${reminderEvent ? `<div class="chore-complete-group">${reminderCompletionControl(reminderEvent)}</div>` : ""}
    <button class="icon-button" data-edit-calendar-item="${kind}:${id}" type="button" aria-label="Edit ${escapeHtml(title)}">✎</button>
    <button class="icon-button danger-button" data-delete-calendar-item="${kind}:${id}" type="button" aria-label="Remove ${escapeHtml(title)}">×</button>
  </div>`;
}

function progressBlock(label, value, target) {
  const pct = Math.min(100, Math.round((value / Math.max(target, 1)) * 100));
  return `<div class="progress-block"><div><span>${label}</span><b>${money.format(value)} / ${money.format(target)}</b></div><div class="bar"><span style="width:${pct}%"></span></div></div>`;
}

function progressNumberBlock(label, value, target, unit) {
  const pct = Math.min(100, Math.round((Number(value || 0) / Math.max(Number(target || 0), 1)) * 100));
  return `<div class="progress-block"><div><span>${label}</span><b>${Number(value || 0).toLocaleString()}${unit ? ` ${unit}` : ""} / ${Number(target || 0).toLocaleString()}${unit ? ` ${unit}` : ""}</b></div><div class="bar"><span style="width:${pct}%"></span></div></div>`;
}

function dueDateRows() {
  return allLines()
    .filter((line) => line.dueDay)
    .sort((a, b) => a.dueDay - b.dueDay)
    .map((line) => ({
      name: line.name,
      date: `${String(line.dueDay).padStart(2, "0")} · Bill ${money.format(line.planned)}`,
      type: spentByLine(line.id) >= Number(line.planned || 0) ? "Paid" : "Due"
    }));
}

function scheduleItems() {
  ensureAnnualEventRecurrenceData();
  ensureChoreRecurrenceData();
  ensureAssigneesData();
  const selectedMonth = state.budget.month;
  const oneTimeEvents = state.calendar.events
    .filter((event) => !ANNUAL_EVENT_TYPES.includes(event.type) && event.date?.startsWith(selectedMonth) && !isReminderComplete(event))
    .map((event) => ({ title: event.title, date: event.date.slice(5), displayDate: `${event.date.slice(5)}${event.dateTime ? ` · ${formatReminderTime(event.dateTime)}` : ""}`, type: event.type, sourceKind: "event", sourceId: event.id, assignees: event.assignees || [] }));
  const chores = state.calendar.chores.flatMap((chore) =>
    choreOccurrencesForMonth(chore).map((occurrence) => ({
      title: chore.title,
      date: occurrence.date.slice(5),
      type: "Chore",
      label: `${choreCadenceLabel(chore)} chore`,
      eventType: "chore",
      sourceKind: "chore",
      sourceId: chore.id,
      assignees: chore.assignees || []
    }))
  );
  const annualEvents = annualEventScheduleItems();
  return [...oneTimeEvents, ...chores, ...annualEvents]
    .sort((a, b) => a.date.localeCompare(b.date));
}

const paycheckRecurrenceLabels = { once: "One-time", bonus: "Bonus (one-time)", weekly: "Weekly", biweekly: "Biweekly", monthly: "Monthly" };

function ensurePaycheckRecurrenceData() {
  state.paychecks.forEach((paycheck) => {
    paycheck.recurrence ||= "monthly";
  });
}

function ensureChoreRecurrenceData() {
  // Needed before the completedDates -> completedBy migration below, which
  // records each current assignee against every already-completed date.
  ensureAssigneesData();
  state.calendar.chores.forEach((chore) => {
    chore.id ||= uniqueId("chore");
    chore.startDate ||= chore.nextDue;
    chore.recurrence ||= String(chore.cadence || "Once").toLowerCase() === "weekly" ? "weekly" : "once";
    chore.endDate ||= "";
    chore.cadence = choreCadenceLabel(chore);
    // Completion used to be a single shared flag per occurrence date (anyone
    // marking it done finished it for the whole household). Multi-assignee
    // chores now require every assignee to mark it done individually, so
    // completion is tracked per assignee per date instead. Existing completed
    // dates are attributed to every current assignee so already-finished
    // occurrences don't reappear as pending after this upgrade.
    if (!chore.completedBy) {
      chore.completedBy = {};
      (chore.completedDates || []).forEach((date) => {
        chore.completedBy[date] = chore.assignees.map((assignee) => assignee.key);
      });
    }
    delete chore.completedDates;
    chore.notifyAt = choreNotifyAt(chore);
  });
}

function isChoreOccurrenceComplete(chore, date) {
  const assigneeKeys = (chore.assignees || []).map((assignee) => assignee.key);
  const completedKeys = (chore.completedBy || {})[date] || [];
  if (!assigneeKeys.length) return completedKeys.length > 0;
  return assigneeKeys.every((key) => completedKeys.includes(key));
}

// Whether a given occurrence still belongs on viewerKey's own pending list.
// Once a specific assignee has marked their own button for this date, it
// drops off THEIR view even if other assignees haven't finished their part
// yet — the shared "is everyone done" check only applies when there's no
// particular viewer to personalize for (or the viewer isn't an assignee).
function isChoreOccurrencePendingFor(chore, date, viewerKey) {
  const assigneeKeys = (chore.assignees || []).map((assignee) => assignee.key);
  if (viewerKey && assigneeKeys.includes(viewerKey)) {
    const completedKeys = (chore.completedBy || {})[date] || [];
    return !completedKeys.includes(viewerKey);
  }
  return !isChoreOccurrenceComplete(chore, date);
}

// A single button tied to whoever is actually signed in — never a menu of
// every assignee's own checkbox, which would let one person mark the chore
// done on someone else's behalf. A jointly-assigned chore only counts as
// fully done for a given occurrence once every assignee has marked their own
// button (see isChoreOccurrenceComplete), but each person can only ever
// toggle their own.
function choreCompletionButtons(chore, index, occurrenceDate) {
  const completedKeys = (chore.completedBy || {})[occurrenceDate] || [];
  const assignees = chore.assignees || [];
  const viewerKey = sessionUser?.email || "";
  const viewerIsAssignee = assignees.some((assignee) => assignee.key === viewerKey);
  // A handful of legacy chores predate the assignee system and have nobody
  // assigned at all — fall back to a single shared button rather than
  // rendering nothing and leaving them impossible to ever mark done.
  const effectiveKey = (assignees.length && viewerIsAssignee) ? viewerKey : "household";
  const done = completedKeys.includes(effectiveKey);
  if (assignees.length && !viewerIsAssignee) {
    // Signed in as someone not assigned to this chore (e.g. an admin just
    // observing) — show status only, nothing for them to toggle on others'
    // behalf.
    return `<span class="chore-complete-status">${completedKeys.length}/${assignees.length} done</span>`;
  }
  const suffix = assignees.length > 1 ? ` (${completedKeys.length}/${assignees.length})` : "";
  return `<button class="ghost chore-complete-button ${done ? "is-done" : ""}" data-complete-chore-assignee="${index}:${occurrenceDate}:${escapeHtml(effectiveKey)}" type="button" aria-pressed="${done}">${done ? "✓ Done" : "Mark done"}${suffix}</button>`;
}

// A plain reminder has only one occurrence ever, so completion is a flat
// list of who's marked it done rather than the date-keyed map chores use.
function isReminderComplete(event) {
  const assigneeKeys = (event.assignees || []).map((assignee) => assignee.key);
  const completedKeys = event.completedBy || [];
  if (!assigneeKeys.length) return completedKeys.length > 0;
  return assigneeKeys.every((key) => completedKeys.includes(key));
}

// Same single-button-tied-to-the-signed-in-user pattern as choreCompletionButtons.
function reminderCompletionControl(event) {
  const completedKeys = event.completedBy || [];
  const assignees = event.assignees || [];
  const viewerKey = sessionUser?.email || "";
  const viewerIsAssignee = assignees.some((assignee) => assignee.key === viewerKey);
  const effectiveKey = (assignees.length && viewerIsAssignee) ? viewerKey : "household";
  const done = completedKeys.includes(effectiveKey);
  if (assignees.length && !viewerIsAssignee) {
    return `<span class="chore-complete-status">${completedKeys.length}/${assignees.length} done</span>`;
  }
  const suffix = assignees.length > 1 ? ` (${completedKeys.length}/${assignees.length})` : "";
  return `<button class="ghost chore-complete-button ${done ? "is-done" : ""}" data-complete-reminder="${event.id}:${escapeHtml(effectiveKey)}" type="button" aria-pressed="${done}">${done ? "✓ Done" : "Mark done"}${suffix}</button>`;
}

// Recomputed every render (mirrors annualEventNotifyAt for birthdays) so the
// reminder always points at the next occurrence nobody has fully completed
// yet, instead of staying pinned to whichever date the chore was first
// created with and never firing again for later occurrences.
function choreNotifyAt(chore) {
  const pending = nextPendingChoreOccurrence(chore);
  if (!pending) return "";
  const [hour, minute] = String(chore.time || "09:00").split(":").map(Number);
  const notifyDate = new Date(`${pending.date}T00:00:00`);
  notifyDate.setHours(hour, minute, 0, 0);
  return notifyDate.toISOString();
}

function choreCadenceLabel(chore) {
  const recurrence = chore.recurrence || "once";
  const base = {
    once: "Once",
    weekly: "Weekly",
    biweekly: "Every 2 weeks",
    triweekly: "Every 3 weeks",
    monthly: "Monthly"
  }[recurrence] || "Once";
  return chore.endDate ? `${base} until ${chore.endDate}` : base;
}

function choreOccurrencesForMonth(chore) {
  ensureChoreRecurrenceData();
  const start = new Date(`${chore.startDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) return [];
  const [year, month] = state.budget.month.split("-").map(Number);
  const monthStart = new Date(year, month - 1, 1);
  let monthEnd = new Date(year, month, 0);
  // Clamp the search window to the chore's end date, if any, so no
  // occurrence past it is ever generated.
  const choreEnd = chore.endDate ? new Date(`${chore.endDate}T00:00:00`) : null;
  if (choreEnd && choreEnd < monthEnd) monthEnd = choreEnd;
  const dates = [];

  if (chore.recurrence === "once") {
    const key = dateKey(start);
    return key.startsWith(state.budget.month) && !isChoreOccurrenceComplete(chore, key) ? [{ date: key }] : [];
  }

  if (chore.recurrence === "monthly") {
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= monthEnd) {
      const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const occurrence = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(start.getDate(), lastDay));
      if (occurrence >= start && occurrence >= monthStart && occurrence <= monthEnd) {
        const key = dateKey(occurrence);
        if (!isChoreOccurrenceComplete(chore, key)) dates.push({ date: key });
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return dates;
  }

  const intervalDays = chore.recurrence === "triweekly" ? 21 : chore.recurrence === "biweekly" ? 14 : 7;
  const cursor = new Date(start);
  if (cursor < monthStart) {
    const daysUntilMonth = Math.floor((monthStart - cursor) / 86400000);
    cursor.setDate(cursor.getDate() + Math.max(0, Math.floor(daysUntilMonth / intervalDays) * intervalDays));
    while (cursor < monthStart) cursor.setDate(cursor.getDate() + intervalDays);
  }
  while (cursor <= monthEnd) {
    const key = dateKey(cursor);
    if (!isChoreOccurrenceComplete(chore, key)) dates.push({ date: key });
    cursor.setDate(cursor.getDate() + intervalDays);
  }
  return dates;
}

function nextChoreOccurrenceInMonth(chore) {
  return choreOccurrencesForMonth(chore)[0] || null;
}

const UPCOMING_LIST_LIMIT = 5;

// The side-panel "what's due" row for a chore — the earliest occurrence that
// hasn't been marked complete yet, regardless of which month is displayed.
// If that date is already in the past it's the same row, just overdue,
// rather than a whole backlog of missed rows piling up. Pass viewerKey (the
// signed-in user's own assignee key) to personalize this to their own
// completion instead of the whole household's.
function nextPendingChoreOccurrence(chore, viewerKey) {
  const recurrence = chore.recurrence || "once";
  const start = new Date(`${chore.startDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  // Once an occurrence would fall after the chore's end date, the chore has
  // finished repeating — there is nothing left to be pending.
  const choreEnd = chore.endDate ? new Date(`${chore.endDate}T00:00:00`) : null;

  if (recurrence === "once") {
    const key = dateKey(start);
    return isChoreOccurrencePendingFor(chore, key, viewerKey) ? { date: key } : null;
  }

  if (recurrence === "monthly") {
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    for (let i = 0; i < 240; i += 1) {
      const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const occurrence = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(start.getDate(), lastDay));
      if (occurrence >= start) {
        if (choreEnd && occurrence > choreEnd) return null;
        const key = dateKey(occurrence);
        if (isChoreOccurrencePendingFor(chore, key, viewerKey)) return { date: key };
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return null;
  }

  const intervalDays = recurrence === "triweekly" ? 21 : recurrence === "biweekly" ? 14 : 7;
  const cursor = new Date(start);
  for (let i = 0; i < 3650; i += 1) {
    if (choreEnd && cursor > choreEnd) return null;
    const key = dateKey(cursor);
    if (isChoreOccurrencePendingFor(chore, key, viewerKey)) return { date: key };
    cursor.setDate(cursor.getDate() + intervalDays);
  }
  return null;
}

const ANNUAL_EVENT_TYPES = ["birthday", "anniversary"];
const annualEventLabels = { birthday: "Birthday", anniversary: "Anniversary" };

function ensureAnnualEventRecurrenceData() {
  // Needed before the wishedYears -> wishedBy migration below, which records
  // each current assignee against every already-wished year.
  ensureAssigneesData();
  state.calendar.events.forEach((event) => {
    event.id ||= uniqueId("event");
    if (!ANNUAL_EVENT_TYPES.includes(event.type)) {
      // Plain one-time reminders get the same per-assignee completion
      // tracking as chores, just without an occurrence date to key by since
      // there's only ever the one occurrence.
      if (event.type === "reminder") event.completedBy ||= [];
      return;
    }
    event.monthDay ||= event.date?.slice(5);
    event.annual = true;
    event.reminderDays = Number(event.reminderDays ?? 1);
    // "Wished" used to be a single shared flag per year (anyone marking it
    // finished it for the whole household). Multi-assignee birthdays/
    // anniversaries now require every assignee to mark it individually, so
    // it's tracked per assignee per year instead. Existing wished years are
    // attributed to every current assignee so they don't reappear as pending.
    if (!event.wishedBy) {
      event.wishedBy = {};
      (event.wishedYears || []).forEach((year) => {
        event.wishedBy[year] = event.assignees.map((assignee) => assignee.key);
      });
    }
    delete event.wishedYears;
    // Recomputed every render so the reminder always points at the next upcoming
    // occurrence instead of staying pinned to whatever year the event was first
    // saved with (e.g. a birth year) — otherwise it looks permanently overdue and
    // fires immediately instead of waiting for the actual date to approach.
    event.notifyAt = annualEventNotifyAt(event);
  });
}

function isAnnualEventYearComplete(event, year) {
  const assigneeKeys = (event.assignees || []).map((assignee) => assignee.key);
  const completedKeys = (event.wishedBy || {})[String(year)] || [];
  if (!assigneeKeys.length) return completedKeys.length > 0;
  return assigneeKeys.every((key) => completedKeys.includes(key));
}

// Whether a given year still belongs on viewerKey's own pending list — mirrors
// isChoreOccurrencePendingFor. Once a specific assignee has marked their own
// button wished, it drops off THEIR view even if other assignees haven't yet.
function isAnnualEventYearPendingFor(event, year, viewerKey) {
  const assigneeKeys = (event.assignees || []).map((assignee) => assignee.key);
  if (viewerKey && assigneeKeys.includes(viewerKey)) {
    const completedKeys = (event.wishedBy || {})[String(year)] || [];
    return !completedKeys.includes(viewerKey);
  }
  return !isAnnualEventYearComplete(event, year);
}

// A single button tied to whoever is actually signed in — never a menu of
// every assignee's own checkbox, which would let one person mark it wished on
// someone else's behalf. A jointly-assigned birthday/anniversary only counts
// as fully wished for a given year once every assignee has marked their own
// button (see isAnnualEventYearComplete), but each person can only ever
// toggle their own.
function annualEventCompletionButtons(event, year) {
  const completedKeys = (event.wishedBy || {})[String(year)] || [];
  const assignees = event.assignees || [];
  const viewerKey = sessionUser?.email || "";
  const viewerIsAssignee = assignees.some((assignee) => assignee.key === viewerKey);
  // A handful of legacy birthdays/anniversaries predate the assignee system
  // and have nobody assigned at all — fall back to a single shared button
  // rather than rendering nothing and leaving them impossible to mark wished.
  const effectiveKey = (assignees.length && viewerIsAssignee) ? viewerKey : "household";
  const done = completedKeys.includes(effectiveKey);
  if (assignees.length && !viewerIsAssignee) {
    return `<span class="chore-complete-status">${completedKeys.length}/${assignees.length} wished</span>`;
  }
  const suffix = assignees.length > 1 ? ` (${completedKeys.length}/${assignees.length})` : "";
  return `<button class="ghost chore-complete-button ${done ? "is-done" : ""}" data-mark-wished-assignee="${event.id}:${year}:${escapeHtml(effectiveKey)}" type="button" aria-pressed="${done}">${done ? "✓ Wished" : "Mark wished"}${suffix}</button>`;
}

// The side-panel "what's due" row for a birthday/anniversary — the earliest
// year that hasn't been marked wished yet. If this year's occurrence already
// passed and nobody marked it wished, that's the row that shows (overdue),
// instead of silently skipping ahead to next year. Pass viewerKey (the
// signed-in user's own assignee key) to personalize this to their own
// completion instead of the whole household's.
function nextPendingAnnualEventOccurrence(event, referenceDate = new Date(), viewerKey) {
  let year = referenceDate.getFullYear();
  for (let i = 0; i < 200; i += 1) {
    if (isAnnualEventYearPendingFor(event, year, viewerKey)) return { date: dateKey(annualEventDate(event, year)), year };
    year += 1;
  }
  return null;
}

// annualEventDate / nextAnnualEventDate / annualEventNotifyAt come from
// lib/shared-logic.js (loaded as a global script alongside this file) so the
// client and server always agree on how a birthday/anniversary's next
// occurrence and reminder due date are computed.

// Everything on the Home dashboard that has an actual calendar date and is
// either already overdue or due today — chores, birthdays/anniversaries, and
// plain reminders. Personalized to the signed-in viewer the same way the
// Calendar tab's own side panels are (see nextPendingChoreOccurrence),
// so a jointly-assigned item drops off once the viewer has done their part.
function homeActionItems() {
  ensureChoreRecurrenceData();
  ensureAnnualEventRecurrenceData();
  const today = dateKey(new Date());
  const viewerKey = sessionUser?.email || "";

  const choreItems = state.calendar.chores
    .map((chore, index) => ({ chore, index, occurrence: nextPendingChoreOccurrence(chore, viewerKey) }))
    .filter((row) => row.occurrence && row.occurrence.date <= today)
    .map((row) => ({
      date: row.occurrence.date,
      overdue: row.occurrence.date < today,
      title: row.chore.title,
      kind: "Chore",
      detail: `${assigneeNames(row.chore.assignees) || "Unassigned"} · ${choreCadenceLabel(row.chore)}`,
      gotoView: "calendar",
      completion: choreCompletionButtons(row.chore, row.index, row.occurrence.date)
    }));

  const annualItems = state.calendar.events
    .filter((event) => ANNUAL_EVENT_TYPES.includes(event.type))
    .map((event) => ({ event, occurrence: nextPendingAnnualEventOccurrence(event, new Date(), viewerKey) }))
    .filter((row) => row.occurrence && row.occurrence.date <= today)
    .map((row) => ({
      date: row.occurrence.date,
      overdue: row.occurrence.date < today,
      title: annualEventDisplayTitle(row.event),
      kind: annualEventLabels[row.event.type] || "Annual",
      detail: assigneeNames(row.event.assignees) || "Household",
      gotoView: "calendar",
      completion: annualEventCompletionButtons(row.event, row.occurrence.year)
    }));

  const reminderItems = state.calendar.events
    .filter((event) => event.type === "reminder" && event.date && event.date <= today && !isReminderComplete(event))
    .map((event) => ({
      date: event.date,
      overdue: event.date < today,
      title: event.title,
      kind: "Reminder",
      detail: event.dateTime ? formatReminderTime(event.dateTime) : (assigneeNames(event.assignees) || "Household"),
      gotoView: "calendar",
      completion: reminderCompletionControl(event)
    }));

  return [...choreItems, ...annualItems, ...reminderItems].sort((a, b) => a.date.localeCompare(b.date));
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function annualEventOccurrencesForMonth() {
  ensureAnnualEventRecurrenceData();
  const year = Number(state.budget.month.slice(0, 4));
  return state.calendar.events
    .filter((event) => ANNUAL_EVENT_TYPES.includes(event.type))
    .map((event) => ({ event, date: annualEventDate(event, year) }))
    .filter(({ date }) => dateKey(date).startsWith(state.budget.month));
}

// One schedule item per annual event, always the actual day it falls on —
// the advance "remind before" setting only controls when the notification
// email fires, it doesn't add a second calendar/schedule entry.
function annualEventScheduleItems() {
  const selectedYear = Number(state.budget.month.slice(0, 4));
  return state.calendar.events
    .filter((event) => ANNUAL_EVENT_TYPES.includes(event.type))
    .flatMap((event) => {
      const occursOn = annualEventDate(event, selectedYear);
      if (!dateKey(occursOn).startsWith(state.budget.month)) return [];
      const title = annualEventDisplayTitle(event);
      const label = annualEventLabels[event.type] || "Annual event";
      return [{ title, date: dateKey(occursOn).slice(5), type: event.type, label, eventType: event.type, sourceKind: "event", sourceId: event.id, assignees: event.assignees || [] }];
    });
}

function annualEventDisplayTitle(event) {
  const fallback = annualEventLabels[event.type] || "Event";
  return String(event.title || fallback).replace(/\s+reminder$/i, "").trim();
}

function formatAnnualEventMonthDay(event) {
  ensureAnnualEventRecurrenceData();
  const date = annualEventDate(event, 2000);
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

function visibleScheduleItems() {
  const items = scheduleItems();
  if (!calendarFilterOwner) return items;
  return items.filter((item) => (item.assignees || []).some((assignee) => assignee.key === calendarFilterOwner));
}

// The "Upcoming schedule" side-panel is meant to be forward-looking only —
// unlike the calendar grid (which must keep showing every day of the month,
// past and future, since it's a literal calendar), and unlike the dedicated
// Chore rotation / Birthdays panels (which intentionally keep surfacing
// overdue, not-yet-actioned items). Once a date has passed, it drops off
// this list even if nobody completed/wished it — that's what the other
// panels are for.
function upcomingScheduleItems() {
  const today = dateKey(new Date());
  return visibleScheduleItems().filter((item) => `${state.budget.month}-${item.date.slice(3)}` >= today);
}

function calendarCells() {
  const eventMap = new Map();
  visibleScheduleItems().forEach((item) => {
    const day = Number(item.date.split("-")[1]);
    eventMap.set(day, [...(eventMap.get(day) || []), item]);
  });
  const [year, month] = state.budget.month.split("-").map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const previousMonthLastDay = new Date(year, month - 1, 0).getDate();
  const leadingDays = firstDay.getDay();
  const totalVisibleDays = leadingDays + lastDay.getDate();
  const cellCount = totalVisibleDays <= 35 ? 35 : 42;
  const cells = [];
  for (let index = 0; index < cellCount; index += 1) {
    const relativeDay = index - leadingDays + 1;
    const cellDateKey = dateKey(new Date(year, month - 1, relativeDay));
    if (relativeDay < 1) {
      cells.push({ day: previousMonthLastDay + relativeDay, currentMonth: false, muted: true, items: [], dateKey: cellDateKey });
    } else if (relativeDay > lastDay.getDate()) {
      cells.push({ day: relativeDay - lastDay.getDate(), currentMonth: false, muted: true, items: [], dateKey: cellDateKey });
    } else {
      cells.push({ day: relativeDay, currentMonth: true, muted: false, items: eventMap.get(relativeDay) || [], dateKey: cellDateKey });
    }
  }
  return cells;
}

function groceryList() {
  ensureMealWeekData();
  return [...new Set(currentMealPlans().flatMap((planned) => state.meals.recipes.find((recipe) => recipe.id === planned.recipeId)?.ingredients || []))];
}

// Recipes don't carry per-ingredient prices, so this is a rough per-item
// average (roughly in line with the $360-400/month Groceries budget lines
// in the seed data) rather than exact pricing — but it scales with what's
// actually planned instead of a fixed guess regardless of the meal plan.
const GROCERY_ITEM_ESTIMATE = 7;

function groceryEstimateAmount() {
  return groceryList().length * GROCERY_ITEM_ESTIMATE;
}

function plannedMeal(day, slot) {
  return plannedMeals(day, slot)[0];
}

function plannedMeals(day, slot) {
  return currentMealPlans().filter((planned) => planned.day === day && (planned.slot === slot || (!planned.slot && slot === "Dinner")));
}

function ensureMealWeekData() {
  state.meals.selectedWeekByMonth ||= {};
  state.meals.plannedWeek ||= [];
  state.meals.plannedWeek.forEach((planned) => {
    planned.month ||= state.budget.month;
    planned.week ||= 1;
    planned.servings ||= 3;
  });
  const weeks = mealWeeksForMonth(state.budget.month);
  const selected = Number(state.meals.selectedWeekByMonth[state.budget.month] || 1);
  state.meals.selectedWeekByMonth[state.budget.month] = Math.min(Math.max(selected, 1), weeks.length);
}

function selectedMealWeek() {
  return Number(state.meals.selectedWeekByMonth?.[state.budget.month] || 1);
}

function currentMealPlans() {
  return state.meals.plannedWeek.filter((planned) =>
    planned.month === state.budget.month && Number(planned.week || 1) === selectedMealWeek()
  );
}

function plannedServingsTotal() {
  return currentMealPlans().reduce((sum, planned) => sum + Number(planned.servings || 1), 0);
}

function planMealFromCurrentForm() {
  const form = $("#mealPlanForm");
  if (!form) return;
  const data = {
    day: form.querySelector('[name="day"]')?.value || "Monday",
    slot: form.querySelector('[name="slot"]')?.value || "Dinner",
    servings: form.querySelector('[name="servings"]')?.value || "3",
    recipeId: $("#mealRecipeId")?.value || ""
  };
  const recipe = recipeById(data.recipeId);
  const mealName = recipe ? recipe.name : ($("#mealRecipeName")?.value || "").trim();
  if (!mealName) {
    mealsFeedback = "Enter a meal name or choose a saved recipe before planning the meal.";
    render();
    return;
  }
  const week = selectedMealWeek();
  const existing = data.slot === "Snack" ? null : state.meals.plannedWeek.find((planned) =>
    planned.month === state.budget.month
    && Number(planned.week || 1) === week
    && planned.day === data.day
    && (planned.slot === data.slot || (!planned.slot && data.slot === "Dinner"))
  );
  const planned = { month: state.budget.month, week, day: data.day, slot: data.slot, meal: mealName, recipeId: recipe?.id || "", servings: Number(data.servings || 1) };
  if (existing) Object.assign(existing, planned);
  else state.meals.plannedWeek.push(planned);
  mealsFeedback = `${mealName} planned for ${data.day} ${data.slot}.`;
  render();
}

function recipeById(recipeId) {
  return state.meals.recipes.find((recipe) => recipe.id === recipeId);
}

function recipeIngredients(recipeId) {
  return recipeById(recipeId)?.ingredients || [];
}

function reportCategories() {
  const max = Math.max(...state.budget.categories.map((category) => category.lines.reduce((sum, line) => sum + spentByLine(line.id), 0)), 1);
  return state.budget.categories.map((category) => {
    const value = category.lines.reduce((sum, line) => sum + spentByLine(line.id), 0);
    return { name: category.name, value, color: category.color, percent: Math.max(2, Math.round((value / max) * 100)) };
  });
}

function transactionInboxItems() {
  return [...(state.transactionInboxDrafts || [])];
}

function bindViewEvents() {
  $("#startBudgetButton")?.addEventListener("click", () => {
    state.budget.setupStarted = true;
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-goto-view]").forEach((button) => {
    button.addEventListener("click", () => {
      currentView = button.dataset.gotoView;
      render();
    });
  });

  document.querySelectorAll("[data-dismiss-reminder]").forEach((button) => {
    button.addEventListener("click", () => dismissBudgetReminder(button.dataset.dismissReminder));
  });

  $("#notesSearch")?.addEventListener("input", (event) => {
    const query = event.currentTarget.value.trim().toLowerCase();
    state.notes.search = event.currentTarget.value;
    document.querySelectorAll(".note-card[data-note-id]").forEach((card) => {
      const note = state.notes.entries.find((item) => item.id === card.dataset.noteId);
      const searchable = note
        ? [note.title, note.body, ...note.labels, ...note.checklist.map((item) => item.text)].join(" ").toLowerCase()
        : "";
      card.hidden = Boolean(query) && !searchable.includes(query);
    });
    document.querySelectorAll(".notes-result-section").forEach((section) => {
      section.hidden = ![...section.querySelectorAll(".note-card")].some((card) => !card.hidden);
    });
    autosaveState();
  });

  document.querySelectorAll("[data-notes-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.notes.activeView = button.dataset.notesView;
      state.notes.activeLabel = "";
      render();
    });
  });

  document.querySelectorAll("[data-notes-label]").forEach((button) => {
    button.addEventListener("click", () => {
      state.notes.activeView = "label";
      state.notes.activeLabel = button.dataset.notesLabel;
      render();
    });
  });

  $("#openNoteComposerButton")?.addEventListener("click", () => {
    state.notes.composerOpen = true;
    render();
  });

  $("#closeNoteComposerButton")?.addEventListener("click", () => {
    state.notes.composerOpen = false;
    render();
  });

  $("#emptyNotesTrashButton")?.addEventListener("click", () => {
    state.notes.entries = state.notes.entries.filter((note) => !note.trashed);
    render();
  });

  $("#editNoteLabelsButton")?.addEventListener("click", () => $("#noteLabelsDialog")?.showModal());
  $("#closeNoteLabelsDialogButton")?.addEventListener("click", () => $("#noteLabelsDialog")?.close());
  $("#doneNoteLabelsButton")?.addEventListener("click", () => $("#noteLabelsDialog")?.close());

  $("#noteLabelForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const label = String(new FormData(event.currentTarget).get("label") || "").trim();
    if (!label || state.notes.labels.some((item) => item.toLowerCase() === label.toLowerCase())) return;
    state.notes.labels.push(label);
    reopenNoteLabelsDialog();
  });

  document.querySelectorAll("[data-rename-note-label]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const index = Number(form.dataset.renameNoteLabel);
      const previousLabel = state.notes.labels[index];
      const nextLabel = String(new FormData(form).get("label") || "").trim();
      if (!previousLabel || !nextLabel) return;
      if (state.notes.labels.some((label, labelIndex) => labelIndex !== index && label.toLowerCase() === nextLabel.toLowerCase())) return;
      state.notes.labels[index] = nextLabel;
      state.notes.entries.forEach((note) => {
        note.labels = note.labels.map((label) => label === previousLabel ? nextLabel : label);
      });
      if (state.notes.activeLabel === previousLabel) state.notes.activeLabel = nextLabel;
      reopenNoteLabelsDialog();
    });
  });

  document.querySelectorAll("[data-delete-note-label]").forEach((button) => {
    button.addEventListener("click", () => {
      const label = state.notes.labels[Number(button.dataset.deleteNoteLabel)];
      if (!label) return;
      state.notes.labels = state.notes.labels.filter((item) => item !== label);
      state.notes.entries.forEach((note) => {
        note.labels = note.labels.filter((item) => item !== label);
      });
      if (state.notes.activeLabel === label) {
        state.notes.activeView = "notes";
        state.notes.activeLabel = "";
      }
      reopenNoteLabelsDialog();
    });
  });

  $("#noteComposer")?.addEventListener("submit", (event) => {
    event.preventDefault();
    commitNoteComposerDraft(event.currentTarget);
    const formData = new FormData(event.currentTarget);
    const data = Object.fromEntries(formData);
    const checklist = String(data.items || "").split("\n").map((item) => item.trim()).filter(Boolean);
    if (!String(data.title || "").trim() && !String(data.body || "").trim() && checklist.length === 0) return;
    state.notes.entries.unshift({
      id: uniqueId("note"),
      title: String(data.title || "").trim(),
      body: String(data.body || "").trim(),
      checklist: checklist.map((text) => ({ id: uniqueId("item"), text, done: false })),
      labels: formData.getAll("labels"),
      reminder: data.reminder || "",
      reminderAt: data.reminder ? new Date(data.reminder).toISOString() : "",
      color: data.color || "#ffffff",
      pinned: data.pinned === "on",
      archived: false,
      trashed: false,
      showChecklist: true,
      createdAt: new Date().toISOString()
    });
    state.notes.composerOpen = false;
    state.notes.activeView = "notes";
    state.notes.activeLabel = "";
    render();
  });

  setupNoteComposerChecklist();

  document.querySelectorAll("[data-note-title]").forEach((input) => {
    input.addEventListener("input", () => {
      const note = state.notes.entries.find((item) => item.id === input.dataset.noteTitle);
      if (!note) return;
      note.title = input.value;
      autosaveState();
    });
  });

  document.querySelectorAll("[data-note-body]").forEach((input) => {
    input.addEventListener("input", () => {
      const note = state.notes.entries.find((item) => item.id === input.dataset.noteBody);
      if (!note) return;
      note.body = input.value;
      autosaveState();
    });
  });

  document.querySelectorAll("[data-note-check]").forEach((input) => {
    input.addEventListener("change", () => {
      const [noteId, itemId] = input.dataset.noteCheck.split(":");
      const note = state.notes.entries.find((item) => item.id === noteId);
      if (!note) return;
      note.checklist = applyChecklistToggle(note.checklist, itemId, input.checked);
      render();
    });
  });

  document.querySelectorAll("[data-note-check-text]").forEach((input) => {
    input.addEventListener("input", () => {
      const [noteId, itemId] = input.dataset.noteCheckText.split(":");
      const note = state.notes.entries.find((item) => item.id === noteId);
      const checklistItem = note?.checklist.find((item) => item.id === itemId);
      if (!checklistItem) return;
      checklistItem.text = input.value;
      const suggestions = document.querySelector(`[data-note-check-suggestions="${input.dataset.noteCheckText}"]`);
      const matches = matchingChecklistSuggestions(input.value)
        .filter((text) => text.toLowerCase() !== input.value.trim().toLowerCase());
      suggestions.innerHTML = matches.map((text) => `<button type="button" role="option" data-note-check-suggestion="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("");
      suggestions.hidden = matches.length === 0;
      input.setAttribute("aria-expanded", String(matches.length > 0));
      suggestions.querySelectorAll("[data-note-check-suggestion]").forEach((button) => {
        button.addEventListener("click", () => {
          const selectedText = button.dataset.noteCheckSuggestion;
          const duplicate = note.checklist.find((item) => item.id !== itemId && item.text.trim().toLowerCase() === selectedText.toLowerCase());
          if (duplicate) {
            duplicate.done = false;
            note.checklist = note.checklist.filter((item) => item.id !== itemId);
          } else {
            checklistItem.text = selectedText;
          }
          render();
        });
      });
      autosaveState();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const suggestions = document.querySelector(`[data-note-check-suggestions="${input.dataset.noteCheckText}"]`);
      suggestions.hidden = true;
      input.setAttribute("aria-expanded", "false");
    });
  });

  document.querySelectorAll("[data-note-label-toggle]").forEach((input) => {
    input.addEventListener("change", () => {
      const note = state.notes.entries.find((item) => item.id === input.dataset.noteLabelToggle);
      if (!note) return;
      if (input.checked && !note.labels.includes(input.value)) note.labels.push(input.value);
      if (!input.checked) note.labels = note.labels.filter((label) => label !== input.value);
      const list = document.querySelector(`[data-note-label-list="${note.id}"]`);
      if (list) list.innerHTML = note.labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("");
      const summary = input.closest(".note-label-picker")?.querySelector("summary");
      if (summary) summary.textContent = note.labels.length ? `${note.labels.length} selected` : "No labels";
      autosaveState();
    });
  });

  document.querySelectorAll("[data-add-note-item]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const note = state.notes.entries.find((item) => item.id === form.dataset.addNoteItem);
      const text = String(new FormData(form).get("item") || "").trim();
      if (!addOrRestoreChecklistItem(note, text)) return;
      render();
    });
  });

  document.querySelectorAll("[data-note-item-input]").forEach((input) => {
    const suggestions = document.querySelector(`[data-note-item-suggestions="${input.dataset.noteItemInput}"]`);
    input.addEventListener("input", () => {
      const matches = matchingChecklistSuggestions(input.value);
      suggestions.innerHTML = matches.map((text) => {
        const note = state.notes.entries.find((item) => item.id === input.dataset.noteItemInput);
        const existing = note ? findChecklistDuplicate(note.checklist, text) : null;
        const status = existing?.done ? "Completed in this note" : existing ? "Already in this note" : "Previous checklist item";
        return `<button type="button" role="option" data-note-item-suggestion="${escapeHtml(text)}"><span>${escapeHtml(text)}</span><small>${status}</small></button>`;
      }).join("");
      suggestions.hidden = matches.length === 0;
      input.setAttribute("aria-expanded", String(matches.length > 0));
      suggestions.querySelectorAll("[data-note-item-suggestion]").forEach((button) => {
        button.addEventListener("click", () => {
          const note = state.notes.entries.find((item) => item.id === input.dataset.noteItemInput);
          if (!addOrRestoreChecklistItem(note, button.dataset.noteItemSuggestion)) return;
          render();
        });
      });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const note = state.notes.entries.find((item) => item.id === input.dataset.noteItemInput);
        if (addOrRestoreChecklistItem(note, input.value)) render();
        return;
      }
      if (event.key === "Escape") {
        suggestions.hidden = true;
        input.setAttribute("aria-expanded", "false");
      }
    });
  });

  document.querySelectorAll("[data-delete-note-item]").forEach((button) => {
    button.addEventListener("click", () => {
      const [noteId, itemId] = button.dataset.deleteNoteItem.split(":");
      const note = state.notes.entries.find((item) => item.id === noteId);
      if (!note) return;
      note.checklist = note.checklist.filter((item) => item.id !== itemId);
      note.checklist.forEach((item) => {
        if (item.parentId === itemId) item.parentId = "";
      });
      render();
    });
  });

  document.querySelectorAll("[data-add-checklist-to-plan]").forEach((button) => {
    button.addEventListener("click", () => {
      const [noteId, itemId] = button.dataset.addChecklistToPlan.split(":");
      const note = state.notes.entries.find((item) => item.id === noteId);
      const checklistItem = note?.checklist.find((item) => item.id === itemId);
      if (!checklistItem || !privateData) return;
      privateData.plans ||= { tasks: [] };
      privateData.plans.tasks ||= [];
      privateData.plans.tasks.push({
        id: uniqueId("plan"),
        title: checklistItem.text,
        notes: "",
        bucket: "daily",
        anchorDate: dateKey(new Date()),
        createdAt: new Date().toISOString(),
        subtasks: [],
        startTime: "",
        durationMinutes: 30,
        recurrence: "none",
        completedDates: []
      });
      autosavePlans();
      const originalLabel = button.textContent;
      button.textContent = "✓";
      button.disabled = true;
      setTimeout(() => {
        button.textContent = originalLabel;
        button.disabled = false;
      }, 1400);
    });
  });

  document.querySelectorAll("[data-indent-note-item]").forEach((button) => {
    button.addEventListener("click", () => {
      const [noteId, itemId] = button.dataset.indentNoteItem.split(":");
      const note = state.notes.entries.find((item) => item.id === noteId);
      const index = note?.checklist.findIndex((item) => item.id === itemId) ?? -1;
      if (!note || index < 0) return;
      const item = note.checklist[index];
      if (item.parentId) {
        item.parentId = "";
      } else {
        const parent = [...note.checklist.slice(0, index)].reverse().find((candidate) => !candidate.parentId);
        if (!parent) return;
        item.parentId = parent.id;
      }
      render();
    });
  });

  document.querySelectorAll("[data-pin-note]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = state.notes.entries.find((item) => item.id === button.dataset.pinNote);
      if (!note) return;
      note.pinned = !note.pinned;
      render();
    });
  });

  document.querySelectorAll("[data-archive-note]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = state.notes.entries.find((item) => item.id === button.dataset.archiveNote);
      if (!note) return;
      note.archived = !note.archived;
      note.trashed = false;
      note.trashedAt = "";
      render();
    });
  });

  document.querySelectorAll("[data-note-reminder]").forEach((input) => {
    input.addEventListener("change", () => {
      const note = state.notes.entries.find((item) => item.id === input.dataset.noteReminder);
      if (!note) return;
      note.reminder = input.value;
      note.reminderAt = input.value ? new Date(input.value).toISOString() : "";
      render();
    });
  });

  document.querySelectorAll("[data-note-color]").forEach((select) => {
    select.addEventListener("change", () => {
      const note = state.notes.entries.find((item) => item.id === select.dataset.noteColor);
      if (!note) return;
      note.color = select.value;
      render();
    });
  });

  document.querySelectorAll("[data-duplicate-note]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = state.notes.entries.find((item) => item.id === button.dataset.duplicateNote);
      if (!note) return;
      const idMap = new Map(note.checklist.map((item) => [item.id, uniqueId("item")]));
      state.notes.entries.unshift({
        ...note,
        id: uniqueId("note"),
        title: `${note.title || "Untitled note"} copy`,
        checklist: note.checklist.map((item) => ({
          ...item,
          id: idMap.get(item.id),
          parentId: item.parentId && idMap.has(item.parentId) ? idMap.get(item.parentId) : ""
        })),
        labels: [...note.labels],
        pinned: false,
        archived: false,
        trashed: false,
        trashedAt: "",
        createdAt: new Date().toISOString()
      });
      render();
    });
  });

  document.querySelectorAll("[data-toggle-note-checklist]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = state.notes.entries.find((item) => item.id === button.dataset.toggleNoteChecklist);
      if (!note) return;
      note.showChecklist = !note.showChecklist;
      render();
    });
  });

  document.querySelectorAll("[data-trash-note]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = state.notes.entries.find((item) => item.id === button.dataset.trashNote);
      if (!note) return;
      note.trashed = true;
      note.trashedAt = new Date().toISOString();
      note.archived = false;
      note.pinned = false;
      render();
    });
  });

  document.querySelectorAll("[data-restore-note]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = state.notes.entries.find((item) => item.id === button.dataset.restoreNote);
      if (!note) return;
      note.trashed = false;
      note.trashedAt = "";
      render();
    });
  });

  document.querySelectorAll("[data-delete-note-forever]").forEach((button) => {
    button.addEventListener("click", () => {
      state.notes.entries = state.notes.entries.filter((note) => note.id !== button.dataset.deleteNoteForever);
      render();
    });
  });

  $("#journalComposer")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const fileInput = form.querySelector('input[name="photos"]');
    const photos = await filesToJournalPhotos(fileInput?.files);
    const now = new Date().toISOString();
    privateData.journal.entries.push({
      id: uniqueId("journal"),
      entryDate: data.entryDate || now.slice(0, 10),
      title: data.title || "",
      body: data.body || "",
      mood: data.mood || "",
      tags: String(data.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
      photos,
      createdAt: now,
      updatedAt: now
    });
    autosaveJournal();
    render();
  });

  document.querySelectorAll("[data-journal-date]").forEach((input) => {
    input.addEventListener("change", () => {
      const entry = privateData.journal.entries.find((item) => item.id === input.dataset.journalDate);
      if (!entry) return;
      entry.entryDate = input.value;
      autosaveJournal();
      render();
    });
  });

  document.querySelectorAll("[data-journal-title]").forEach((input) => {
    input.addEventListener("input", () => {
      const entry = privateData.journal.entries.find((item) => item.id === input.dataset.journalTitle);
      if (!entry) return;
      entry.title = input.value;
      autosaveJournal();
    });
  });

  document.querySelectorAll("[data-journal-body]").forEach((input) => {
    input.addEventListener("input", () => {
      const entry = privateData.journal.entries.find((item) => item.id === input.dataset.journalBody);
      if (!entry) return;
      entry.body = input.value;
      autosaveJournal();
    });
  });

  document.querySelectorAll("[data-journal-mood]").forEach((select) => {
    select.addEventListener("change", () => {
      const entry = privateData.journal.entries.find((item) => item.id === select.dataset.journalMood);
      if (!entry) return;
      entry.mood = select.value;
      autosaveJournal();
    });
  });

  document.querySelectorAll("[data-journal-tags]").forEach((input) => {
    input.addEventListener("change", () => {
      const entry = privateData.journal.entries.find((item) => item.id === input.dataset.journalTags);
      if (!entry) return;
      entry.tags = input.value.split(",").map((tag) => tag.trim()).filter(Boolean);
      autosaveJournal();
      render();
    });
  });

  document.querySelectorAll("[data-journal-photo-input]").forEach((input) => {
    input.addEventListener("change", async () => {
      const entry = privateData.journal.entries.find((item) => item.id === input.dataset.journalPhotoInput);
      if (!entry) return;
      const photos = await filesToJournalPhotos(input.files);
      entry.photos = [...(entry.photos || []), ...photos].slice(0, 8);
      autosaveJournal();
      render();
    });
  });

  document.querySelectorAll("[data-delete-journal-photo]").forEach((button) => {
    button.addEventListener("click", () => {
      const [entryId, photoId] = button.dataset.deleteJournalPhoto.split(":");
      const entry = privateData.journal.entries.find((item) => item.id === entryId);
      if (!entry) return;
      entry.photos = (entry.photos || []).filter((photo) => photo.id !== photoId);
      autosaveJournal();
      render();
    });
  });

  document.querySelectorAll("[data-delete-journal-entry]").forEach((button) => {
    button.addEventListener("click", () => {
      privateData.journal.entries = privateData.journal.entries.filter((entry) => entry.id !== button.dataset.deleteJournalEntry);
      autosaveJournal();
      render();
    });
  });

  document.querySelectorAll("[data-plan-bucket]").forEach((button) => {
    button.addEventListener("click", () => {
      planActiveBucket = button.dataset.planBucket;
      planEditingDailyTaskId = null;
      planEditingActualLogId = null;
      render();
    });
  });

  document.querySelectorAll("[data-plan-day]").forEach((button) => {
    button.addEventListener("click", () => {
      const date = new Date(`${planSelectedDate}T00:00:00`);
      planEditingDailyTaskId = null;
      planEditingActualLogId = null;
      if (button.dataset.planDay === "prev") date.setDate(date.getDate() - 1);
      else if (button.dataset.planDay === "next") date.setDate(date.getDate() + 1);
      else { planSelectedDate = dateKey(new Date()); render(); return; }
      planSelectedDate = dateKey(date);
      render();
    });
  });

  $("#cancelPlanTaskEditButton")?.addEventListener("click", () => {
    planEditingDailyTaskId = null;
    render();
  });

  $("#cancelActualLogEditButton")?.addEventListener("click", () => {
    planEditingActualLogId = null;
    render();
  });

  $("#deleteActualLogButton")?.addEventListener("click", () => {
    if (!planEditingActualLogId) return;
    const logs = actualLogsForDate(planSelectedDate);
    privateData.plans.actualLogs[planSelectedDate] = logs.filter((log) => log.id !== planEditingActualLogId);
    planEditingActualLogId = null;
    autosavePlans();
    render();
  });

  document.querySelectorAll("[data-edit-actual-log]").forEach((block) => {
    const toggleEditor = () => {
      const logId = block.dataset.editActualLog;
      if (planEditingActualLogId === logId) {
        planEditingActualLogId = null;
        render();
        return;
      }
      planEditingActualLogId = logId;
      render();
      $("#actualLogForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    block.addEventListener("click", toggleEditor);
    block.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleEditor(); }
    });
  });

  $("#actualLogForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const startTime = (data.get("logStartTime") || "").trim();
    const endTime = (data.get("logEndTime") || "").trim();
    const note = (data.get("logNote") || "").trim();
    if (!startTime || !endTime || !note) return;
    const linkedTaskIds = data.getAll("linkedTaskIds");
    ensurePlanData();
    const logs = actualLogsForDate(planSelectedDate);
    if (planEditingActualLogId) {
      const entry = logs.find((log) => log.id === planEditingActualLogId);
      if (entry) Object.assign(entry, { startTime, endTime, note, linkedTaskIds });
    } else {
      logs.push({ id: uniqueId("actual"), startTime, endTime, note, linkedTaskIds });
    }
    privateData.plans.actualLogs[planSelectedDate] = logs;
    planEditingActualLogId = null;
    autosavePlans();
    render();
  });

  (() => {
    const form = $("#planTaskForm");
    if (!form || planActiveBucket !== "daily") return;
    const startInput = form.querySelector('[name="startTime"]');
    const durationInput = form.querySelector('[name="durationMinutes"]');
    const endDisplay = form.querySelector('[name="endTimeDisplay"]');
    const updateEndTime = () => {
      if (!endDisplay) return;
      if (!startInput.value) { endDisplay.value = ""; return; }
      endDisplay.value = minutesToTime(timeToMinutes(startInput.value) + Number(durationInput.value || 30));
    };
    startInput?.addEventListener("input", updateEndTime);
    durationInput?.addEventListener("input", updateEndTime);
  })();

  $("#planTaskForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    if (!data.title || !data.title.trim()) return;
    if (planActiveBucket === "daily" && planEditingDailyTaskId) {
      const task = privateData.plans.tasks.find((item) => item.id === planEditingDailyTaskId);
      if (task) {
        task.title = data.title.trim();
        task.startTime = data.startTime || "";
        task.durationMinutes = Math.max(5, Number(data.durationMinutes || 30));
        task.recurrence = data.recurrence || "none";
      }
      planEditingDailyTaskId = null;
      autosavePlans();
      render();
      return;
    }
    const task = {
      id: uniqueId("plan"),
      title: data.title.trim(),
      notes: "",
      bucket: planActiveBucket,
      anchorDate: data.anchorDate || defaultPlanAnchorDate(planActiveBucket),
      createdAt: new Date().toISOString(),
      subtasks: []
    };
    if (planActiveBucket === "daily") {
      task.startTime = data.startTime || "";
      task.durationMinutes = Math.max(5, Number(data.durationMinutes || 30));
      task.recurrence = data.recurrence || "none";
      task.completedDates = [];
    } else {
      task.done = false;
    }
    privateData.plans.tasks.push(task);
    autosavePlans();
    render();
  });

  document.querySelectorAll("[data-plan-task-check]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const task = privateData.plans.tasks.find((item) => item.id === checkbox.dataset.planTaskCheck);
      if (!task) return;
      if (task.bucket === "daily") {
        const updated = toggleDailyTaskDoneOnDate(task, planSelectedDate);
        Object.assign(task, updated);
      } else {
        task.done = checkbox.checked;
      }
      autosavePlans();
      render();
    });
  });

  document.querySelectorAll("[data-plan-task-title]").forEach((input) => {
    input.addEventListener("input", () => {
      const task = privateData.plans.tasks.find((item) => item.id === input.dataset.planTaskTitle);
      if (!task) return;
      task.title = input.value;
      autosavePlans();
    });
  });

  document.querySelectorAll("[data-add-plan-subtask]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = form.querySelector('input[name="text"]');
      if (!input || !input.value.trim()) return;
      const task = privateData.plans.tasks.find((item) => item.id === form.dataset.addPlanSubtask);
      if (!task) return;
      task.subtasks ||= [];
      task.subtasks.push({ id: uniqueId("subtask"), text: input.value.trim(), done: false });
      autosavePlans();
      render();
    });
  });

  document.querySelectorAll("[data-plan-subtask-check]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const [taskId, subtaskId] = checkbox.dataset.planSubtaskCheck.split(":");
      const task = privateData.plans.tasks.find((item) => item.id === taskId);
      const subtask = task?.subtasks?.find((item) => item.id === subtaskId);
      if (!subtask) return;
      subtask.done = checkbox.checked;
      autosavePlans();
      render();
    });
  });

  document.querySelectorAll("[data-delete-plan-subtask]").forEach((button) => {
    button.addEventListener("click", () => {
      const [taskId, subtaskId] = button.dataset.deletePlanSubtask.split(":");
      const task = privateData.plans.tasks.find((item) => item.id === taskId);
      if (!task) return;
      task.subtasks = (task.subtasks || []).filter((item) => item.id !== subtaskId);
      autosavePlans();
      render();
    });
  });

  document.querySelectorAll(".plan-timeline-block").forEach((block) => {
    block.addEventListener("pointerdown", (event) => {
      if (event.target.closest("[data-plan-resize]") || event.target.closest("input") || event.target.closest("button")) return;
      const task = privateData.plans.tasks.find((item) => item.id === block.dataset.planTaskId);
      if (!task) return;
      try { block.setPointerCapture(event.pointerId); } catch (_error) { /* capture is a convenience; drag still works without it */ }
      planDragState = { mode: "move", taskId: task.id, pointerId: event.pointerId, startY: event.clientY, startMinutes: timeToMinutes(task.startTime), moved: false, block };
    });
    block.addEventListener("pointermove", (event) => {
      if (!planDragState || planDragState.pointerId !== event.pointerId || planDragState.mode !== "move") return;
      const deltaY = event.clientY - planDragState.startY;
      if (Math.abs(deltaY) > 3) planDragState.moved = true;
      const rawMinutes = planDragState.startMinutes + deltaY / PLAN_PIXELS_PER_MINUTE;
      const snapped = Math.max(PLAN_TIMELINE_START_HOUR * 60, Math.min((PLAN_TIMELINE_END_HOUR + 1) * 60 - 5, snapMinutes(rawMinutes)));
      block.style.top = `${(snapped - PLAN_TIMELINE_START_HOUR * 60) * PLAN_PIXELS_PER_MINUTE}px`;
      planDragState.pendingMinutes = snapped;
    });
    block.addEventListener("pointerup", (event) => {
      if (!planDragState || planDragState.pointerId !== event.pointerId || planDragState.mode !== "move") return;
      const task = privateData.plans.tasks.find((item) => item.id === planDragState.taskId);
      if (task && planDragState.moved && planDragState.pendingMinutes != null) {
        task.startTime = minutesToTime(planDragState.pendingMinutes);
        autosavePlans();
      } else if (task && !planDragState.moved) {
        planEditingDailyTaskId = planEditingDailyTaskId === task.id ? null : task.id;
      }
      planDragState = null;
      render();
    });
  });

  document.querySelectorAll("[data-plan-resize]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      const block = handle.closest(".plan-timeline-block");
      const task = privateData.plans.tasks.find((item) => item.id === handle.dataset.planResize);
      if (!task || !block) return;
      try { handle.setPointerCapture(event.pointerId); } catch (_error) { /* capture is a convenience; drag still works without it */ }
      planDragState = { mode: "resize", taskId: task.id, pointerId: event.pointerId, startY: event.clientY, startDuration: Number(task.durationMinutes || 30), moved: false, block };
    });
    handle.addEventListener("pointermove", (event) => {
      if (!planDragState || planDragState.pointerId !== event.pointerId || planDragState.mode !== "resize") return;
      const deltaY = event.clientY - planDragState.startY;
      if (Math.abs(deltaY) > 3) planDragState.moved = true;
      const rawDuration = planDragState.startDuration + deltaY / PLAN_PIXELS_PER_MINUTE;
      const snapped = Math.max(15, snapMinutes(rawDuration));
      planDragState.block.style.height = `${snapped * PLAN_PIXELS_PER_MINUTE}px`;
      planDragState.pendingDuration = snapped;
    });
    handle.addEventListener("pointerup", (event) => {
      if (!planDragState || planDragState.pointerId !== event.pointerId || planDragState.mode !== "resize") return;
      const task = privateData.plans.tasks.find((item) => item.id === planDragState.taskId);
      if (task && planDragState.moved && planDragState.pendingDuration != null) {
        task.durationMinutes = planDragState.pendingDuration;
        autosavePlans();
      }
      planDragState = null;
      render();
    });
  });

  document.querySelectorAll("[data-delete-plan-task]").forEach((button) => {
    button.addEventListener("click", () => {
      privateData.plans.tasks = privateData.plans.tasks.filter((task) => task.id !== button.dataset.deletePlanTask);
      if (planEditingDailyTaskId === button.dataset.deletePlanTask) planEditingDailyTaskId = null;
      autosavePlans();
      render();
    });
  });

  document.querySelectorAll("[data-budget-line]").forEach((input) => {
    input.addEventListener("input", () => {
      const [categoryIndex, lineIndex] = input.dataset.budgetLine.split(":").map(Number);
      state.budget.categories[categoryIndex].lines[lineIndex].planned = Number(input.value || 0);
      refreshBudgetTotals(categoryIndex, lineIndex);
      refreshIncomeTotals();
      autosaveState();
    });
    input.addEventListener("change", () => {
      render();
    });
  });

  document.querySelectorAll("[data-budget-line-name]").forEach((input) => {
    input.addEventListener("input", () => {
      const [categoryIndex, lineIndex] = input.dataset.budgetLineName.split(":").map(Number);
      state.budget.categories[categoryIndex].lines[lineIndex].name = input.value || "Budget line";
      autosaveState();
    });
    input.addEventListener("change", () => {
      const [categoryIndex, lineIndex] = input.dataset.budgetLineName.split(":").map(Number);
      state.budget.categories[categoryIndex].lines[lineIndex].name = input.value || "Budget line";
      render();
    });
  });

  document.querySelectorAll("[data-budget-due-date]").forEach((input) => {
    input.addEventListener("input", () => {
      const [categoryIndex, lineIndex] = input.dataset.budgetDueDate.split(":").map(Number);
      state.budget.categories[categoryIndex].lines[lineIndex].dueDay = dueDayFromDate(input.value);
      autosaveState();
    });
    input.addEventListener("change", () => {
      render();
    });
  });

  document.querySelectorAll("[data-income-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.dataset.incomeAmount);
      state.paychecks[index].amount = Number(input.value || 0);
      state.budget.income = state.paychecks.reduce((sum, paycheck) => sum + Number(paycheck.amount || 0), 0);
      refreshIncomeTotals();
      autosaveState();
    });
    input.addEventListener("change", () => {
      render();
    });
  });

  document.querySelectorAll("[data-income-name]").forEach((input) => {
    input.addEventListener("input", () => {
      state.paychecks[Number(input.dataset.incomeName)].name = input.value || "Income";
      autosaveState();
    });
    input.addEventListener("change", () => {
      state.paychecks[Number(input.dataset.incomeName)].name = input.value || "Income";
      render();
    });
  });

  document.querySelectorAll("[data-income-recurrence]").forEach((select) => {
    select.addEventListener("change", () => {
      const paycheck = state.paychecks[Number(select.dataset.incomeRecurrence)];
      if (paycheck) paycheck.recurrence = select.value;
      autosaveState();
    });
  });

  $("#copyBudgetSelect")?.addEventListener("change", (event) => {
    if (!event.currentTarget.value) return;
    copyBudgetFromMonth(event.currentTarget.value);
    render();
  });

  $("#transactionForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    state.transactions.unshift(makeTransaction({ date: new Date().toISOString().slice(0, 10), payee: data.payee, lineId: data.lineId, amount: Number(data.amount), memo: "Manual split", accountId: data.accountId || "" }));
    render();
  });

  $("#addIncomeButton")?.addEventListener("click", () => {
    state.paychecks.push({ date: new Date().toISOString().slice(0, 10), name: `Income ${state.paychecks.length + 1}`, amount: 0, assignedLineIds: [] });
    state.budget.income = state.paychecks.reduce((sum, paycheck) => sum + Number(paycheck.amount || 0), 0);
    render();
  });

  document.querySelectorAll("[data-add-line-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const category = state.budget.categories[Number(button.dataset.addLineCategory)];
      category.lines.push({ id: uniqueId(category.name), name: "New subcategory", planned: 0, dueDay: 28 });
      render();
    });
  });

  $("#addCategoryButton")?.addEventListener("click", () => {
    const name = ($("#newCategoryName")?.value || "New category").trim();
    if (!name) return;
    if (state.budget.categories.some((category) => category.name.toLowerCase() === name.toLowerCase())) return;
    state.budget.categories.push({ name, color: "#13936d", lines: [{ id: uniqueId(name), name: "New subcategory", planned: 0, dueDay: 28 }] });
    render();
  });

  $("#deleteCategoryByNameButton")?.addEventListener("click", () => {
    const name = ($("#newCategoryName")?.value || "").trim().toLowerCase();
    const categoryIndex = state.budget.categories.findIndex((category) => category.name.toLowerCase() === name);
    if (categoryIndex < 0) return;
    state.budget.categories[categoryIndex].lines.forEach((line) => {
      snapshotTransactionsForLine({ ...line, category: state.budget.categories[categoryIndex].name });
    });
    state.budget.categories.splice(categoryIndex, 1);
    render();
  });

  $("#newCategoryName")?.addEventListener("focus", () => {
    refreshBudgetCategoryMenu();
    $("#budgetCategoryMenu").hidden = false;
  });

  $("#newCategoryName")?.addEventListener("input", () => {
    refreshBudgetCategoryMenu();
    $("#budgetCategoryMenu").hidden = false;
  });

  $("#budgetCategoryMenu")?.addEventListener("click", (event) => {
    const option = event.target.closest("[data-category-option]");
    if (!option) return;
    $("#newCategoryName").value = option.dataset.categoryOption;
    $("#budgetCategoryMenu").hidden = true;
  });

  $("#addTransactionSubcategoryButton")?.addEventListener("click", () => {
    const name = ($("#transactionSubcategoryName")?.value || "New subcategory").trim();
    const category = state.budget.categories[Number($("#transactionParentCategory")?.value || 0)];
    if (!name) return;
    if (category.lines.some((line) => line.name.toLowerCase() === name.toLowerCase())) return;
    category.lines.push({ id: uniqueId(name), name, planned: 0, dueDay: 28 });
    state.household.activity.unshift(`Added ${name} subcategory under ${category.name} from Transactions`);
    render();
  });

  $("#deleteTransactionSubcategoryButton")?.addEventListener("click", () => {
    const categoryIndex = Number($("#transactionParentCategory")?.value || 0);
    const category = state.budget.categories[categoryIndex];
    const name = ($("#transactionSubcategoryName")?.value || "").trim().toLowerCase();
    const lineIndex = category?.lines?.findIndex((line) => line.name.toLowerCase() === name) ?? -1;
    const line = lineIndex >= 0 ? category.lines[lineIndex] : null;
    if (!category || !line) return;
    snapshotTransactionsForLine({ ...line, category: category.name });
    category.lines.splice(lineIndex, 1);
    state.household.activity.unshift(`Deleted ${line.name} subcategory from ${category.name}`);
    render();
  });

  $("#transactionParentCategory")?.addEventListener("change", () => {
    const input = $("#transactionSubcategoryName");
    if (input) input.value = "";
    refreshTransactionSubcategoryMenu();
  });

  $("#transactionSubcategoryName")?.addEventListener("focus", () => {
    refreshTransactionSubcategoryMenu();
    $("#transactionSubcategoryMenu").hidden = false;
  });

  $("#transactionSubcategoryName")?.addEventListener("input", () => {
    refreshTransactionSubcategoryMenu();
    $("#transactionSubcategoryMenu").hidden = false;
  });

  $("#transactionSubcategoryMenu")?.addEventListener("click", (event) => {
    const option = event.target.closest("[data-subcategory-option]");
    if (!option) return;
    $("#transactionSubcategoryName").value = option.dataset.subcategoryOption;
    $("#transactionSubcategoryMenu").hidden = true;
  });

  document.querySelectorAll("[data-delete-line]").forEach((button) => {
    button.addEventListener("click", () => {
      const [categoryIndex, lineIndex] = button.dataset.deleteLine.split(":").map(Number);
      snapshotTransactionsForLine({ ...state.budget.categories[categoryIndex].lines[lineIndex], category: state.budget.categories[categoryIndex].name });
      state.budget.categories[categoryIndex].lines.splice(lineIndex, 1);
      if (state.budget.categories[categoryIndex].lines.length === 0) state.budget.categories.splice(categoryIndex, 1);
      render();
    });
  });

  document.querySelectorAll("[data-delete-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const category = state.budget.categories[Number(button.dataset.deleteCategory)];
      category.lines.forEach((line) => snapshotTransactionsForLine({ ...line, category: category.name }));
      state.budget.categories.splice(Number(button.dataset.deleteCategory), 1);
      render();
    });
  });

  $("#addTransactionButton")?.addEventListener("click", () => {
    state.transactionInboxDrafts ||= [];
    state.transactionInboxDrafts.unshift({
      id: uniqueId("manual-bank-stream"),
      payee: "New bank stream item",
      amount: 0,
      lineId: allLines()[0]?.id || "",
      date: new Date().toISOString().slice(0, 10)
    });
    render();
  });

  document.querySelectorAll("[data-assign-ledger]").forEach((button) => {
    button.addEventListener("click", () => {
      const [id, payee, amount, date] = button.dataset.assignLedger.split(":");
      const lineId = document.querySelector(`[data-ledger-line="${id}"]`)?.value || allLines()[0]?.id;
      state.transactions.unshift(makeTransaction({ date, payee, amount: Number(amount), lineId, memo: "Assigned from ledger" }));
      state.household.activity.unshift(`Assigned ${payee} to ${transactionAssignmentLabel({ lineId })}`);
      render();
    });
  });

  $("#addPaycheckButton")?.addEventListener("click", () => {
    state.paychecks.push({ date: new Date().toISOString().slice(0, 10), name: `Paycheck/Income ${state.paychecks.length + 1}`, amount: 0, assignedLineIds: [], recurrence: "monthly" });
    render();
  });

  document.querySelectorAll("[data-delete-paycheck]").forEach((button) => {
    button.addEventListener("click", () => {
      state.paychecks.splice(Number(button.dataset.deletePaycheck), 1);
      state.budget.income = state.paychecks.reduce((sum, paycheck) => sum + Number(paycheck.amount || 0), 0);
      render();
    });
  });

  document.querySelectorAll("[data-paycheck-recurrence]").forEach((select) => {
    select.addEventListener("change", () => {
      const paycheck = state.paychecks[Number(select.dataset.paycheckRecurrence)];
      if (paycheck) paycheck.recurrence = select.value;
      render();
    });
  });

  document.querySelectorAll("[data-paycheck-deposit-account]").forEach((select) => {
    select.addEventListener("change", () => {
      const paycheck = state.paychecks[Number(select.dataset.paycheckDepositAccount)];
      if (paycheck) paycheck.depositAccountId = select.value;
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-paycheck-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.dataset.paycheckAmount);
      const paycheck = state.paychecks[index];
      if (!paycheck) return;
      paycheck.amount = Number(input.value || 0);
      state.budget.income = state.paychecks.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      const splitEl = document.querySelector(`[data-paycheck-split="${index}"]`);
      if (splitEl) {
        const assigned = paycheckAssignedAmount(paycheck);
        splitEl.innerHTML = `<span>Income ${money.format(paycheck.amount)}</span><b>Assigned ${money.format(assigned)}</b>`;
      }
      autosaveState();
    });
    input.addEventListener("change", () => {
      render();
    });
  });

  $("#assignBillButton")?.addEventListener("click", () => {
    const paycheck = state.paychecks.find((item) => item.date === $("#paycheckSelect")?.value);
    const lineId = $("#paycheckLineSelect")?.value;
    if (!paycheck || !lineId) return;
    if (!paycheck.assignedLineIds.includes(lineId)) paycheck.assignedLineIds.push(lineId);
    render();
  });

  // Once the user starts a new meals action, clear the leftover confirmation
  // message so it doesn't look stuck/stale while they're doing something else
  // (mirrors the same pattern used for the calendar quick-add form).
  const mealFeedbackStatus = $(".meal-feedback");
  ["input", "change"].forEach((eventName) => {
    $(".meal-layout")?.addEventListener(eventName, () => {
      if (!mealsFeedback) return;
      mealsFeedback = "";
      if (mealFeedbackStatus) mealFeedbackStatus.textContent = "";
    });
  });

  $("#postGroceriesButton")?.addEventListener("click", async () => {
    const groceryLine = allLines().find((line) => line.name.toLowerCase().includes("grocer"));
    if (!groceryLine) {
      mealsFeedback = "Add a Groceries subcategory in Budget before posting the grocery list.";
      render();
      return;
    }
    if (groceryList().length === 0) {
      mealsFeedback = "Plan at least one meal this week before posting a grocery estimate.";
      render();
      return;
    }
    const amount = Math.max(0, Number(state.meals.groceryEstimate || groceryEstimateAmount()));
    state.transactions.unshift(makeTransaction({ date: new Date().toISOString().slice(0, 10), payee: "Meal plan groceries", lineId: groceryLine.id, amount, memo: `Posted from Week ${selectedMealWeek()} grocery list` }));
    mealsFeedback = `${exactMoney.format(amount)} posted to ${groceryLine.category} · ${groceryLine.name}.`;
    state.household.activity.unshift(mealsFeedback);
    await saveStateNow();
    render();
  });

  $("#mealRecipeName")?.addEventListener("focus", () => {
    refreshMealRecipeMenu();
    $("#mealRecipeMenu").hidden = false;
  });

  $("#mealRecipeName")?.addEventListener("input", () => {
    $("#mealRecipeId").value = "";
    refreshMealRecipeMenu();
    $("#mealRecipeMenu").hidden = false;
  });

  $("#mealRecipeMenu")?.addEventListener("click", (event) => {
    const option = event.target.closest("[data-meal-recipe-option]");
    if (!option) return;
    const recipe = recipeById(option.dataset.mealRecipeOption);
    if (!recipe) return;
    state.meals.selectedRecipeId = recipe.id;
    $("#mealRecipeName").value = recipe.name;
    $("#mealRecipeId").value = recipe.id;
    $("#mealRecipeMenu").hidden = true;
    autosaveState();
  });

  $("#addMealRecipeButton")?.addEventListener("click", () => {
    const name = ($("#mealRecipeName")?.value || "").trim();
    if (!name) {
      mealsFeedback = "Type a recipe name before adding it.";
      render();
      return;
    }
    const existing = state.meals.recipes.find((recipe) => recipe.name.toLowerCase() === name.toLowerCase());
    const recipe = existing || {
      id: uniqueId(name),
      name,
      ingredients: ["ingredient"],
      calories: 400,
      protein: 20
    };
    if (!existing) state.meals.recipes.push(recipe);
    state.meals.selectedRecipeId = recipe.id;
    mealsFeedback = existing
      ? `${recipe.name} is already saved — selected it for this meal.`
      : `${recipe.name} added to your recipes. Edit its ingredients and nutrition in the Recipes tab.`;
    render();
  });

  document.querySelectorAll("[data-open-meal]").forEach((button) => {
    button.addEventListener("click", () => {
      const separator = button.dataset.openMeal.indexOf(":");
      const form = $("#mealPlanForm");
      form.day.value = button.dataset.openMeal.slice(0, separator);
      form.slot.value = button.dataset.openMeal.slice(separator + 1);
      form.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  document.querySelectorAll("[data-edit-planned-meal]").forEach((slot) => {
    const openEditor = (event) => {
      if (event.target.closest("button, input")) return;
      const planned = state.meals.plannedWeek[Number(slot.dataset.editPlannedMeal)];
      const form = $("#mealPlanForm");
      if (!planned || !form) return;
      form.day.value = planned.day;
      form.slot.value = planned.slot || "Dinner";
      form.servings.value = planned.servings || 3;
      $("#mealRecipeId").value = planned.recipeId || "";
      $("#mealRecipeName").value = planned.meal || "";
      form.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    slot.addEventListener("click", openEditor);
    slot.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") openEditor(event);
    });
  });

  document.querySelectorAll("[data-remove-planned-meal]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.removePlannedMeal);
      if (!Number.isInteger(index) || !state.meals.plannedWeek[index]) return;
      state.meals.plannedWeek.splice(index, 1);
      render();
    });
  });

  document.querySelectorAll("[data-meal-servings]").forEach((input) => {
    input.addEventListener("input", () => {
      const planned = state.meals.plannedWeek[Number(input.dataset.mealServings)];
      if (!planned) return;
      planned.servings = Math.max(1, Number(input.value || 1));
      autosaveState();
      refreshMealMetrics();
    });
  });

  $("#saveMealWeekButton")?.addEventListener("click", async () => {
    const label = `${monthLabel()} · Week ${selectedMealWeek()}`;
    if (!state.meals.savedWeeks.includes(label)) state.meals.savedWeeks.push(label);
    mealsFeedback = `${label} saved.`;
    state.household.activity.unshift(`Saved meal week: ${label}`);
    await saveStateNow();
    render();
  });

  $("#recipeForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const name = String(data.name || "").trim();
    if (!name) return;
    const duplicate = state.meals.recipes.find((recipe) =>
      recipe.id !== data.recipeId && recipe.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicate) return;
    const editingRecipe = recipeById(data.recipeId);
    if (editingRecipe) {
      editingRecipe.name = name;
      editingRecipe.ingredients = String(data.ingredients || "").split(",").map((item) => item.trim()).filter(Boolean);
      editingRecipe.calories = Number(data.calories || 0);
      editingRecipe.protein = Number(data.protein || 0);
      state.meals.plannedWeek.forEach((planned) => {
        if (planned.recipeId === editingRecipe.id) planned.meal = editingRecipe.name;
      });
      state.meals.editingRecipeId = "";
    } else {
      state.meals.recipes.push({
        id: uniqueId(name),
        name,
        ingredients: String(data.ingredients || "").split(",").map((item) => item.trim()).filter(Boolean),
        calories: Number(data.calories || 0),
        protein: Number(data.protein || 0)
      });
    }
    render();
  });

  $("#cancelRecipeEditButton")?.addEventListener("click", () => {
    state.meals.editingRecipeId = "";
    render();
  });

  document.querySelectorAll("[data-edit-recipe]").forEach((button) => {
    button.addEventListener("click", () => {
      state.meals.editingRecipeId = button.dataset.editRecipe;
      render();
      $("#recipeForm input[name='name']")?.focus();
    });
  });

  document.querySelectorAll("[data-select-recipe]").forEach((button) => {
    button.addEventListener("click", () => {
      const form = $("#mealPlanForm");
      state.meals.selectedRecipeId = button.dataset.selectRecipe;
      currentView = "meals";
      render();
      $("#mealPlanForm")?.day.focus();
    });
  });

  document.querySelectorAll("[data-delete-recipe]").forEach((button) => {
    button.addEventListener("click", () => {
      state.meals.recipes = state.meals.recipes.filter((recipe) => recipe.id !== button.dataset.deleteRecipe);
      if (state.meals.editingRecipeId === button.dataset.deleteRecipe) state.meals.editingRecipeId = "";
      if (state.meals.selectedRecipeId === button.dataset.deleteRecipe) {
        state.meals.selectedRecipeId = state.meals.recipes[0]?.id || "";
      }
      render();
    });
  });

  const addGoal = () => {
    state.goals.sinkingFunds.push({ name: "", target: 0, saved: 0, targetDate: "" });
    autosaveState();
    render();
    document.querySelector(`[data-goal-name="${state.goals.sinkingFunds.length - 1}"]`)?.focus();
  };
  $("#addGoalButton")?.addEventListener("click", addGoal);
  $("#emptyAddGoalButton")?.addEventListener("click", addGoal);

  document.querySelectorAll("[data-goal-name], [data-goal-target], [data-goal-saved], [data-goal-date]").forEach((input) => {
    input.addEventListener("input", () => {
      const datasetKey = Object.keys(input.dataset).find((key) => key.startsWith("goal"));
      const index = Number(input.dataset[datasetKey]);
      const fund = state.goals.sinkingFunds[index];
      if (!fund) return;
      if (datasetKey === "goalName") fund.name = input.value;
      if (datasetKey === "goalTarget") fund.target = Math.max(0, Number(input.value || 0));
      if (datasetKey === "goalSaved") fund.saved = Math.max(0, Number(input.value || 0));
      if (datasetKey === "goalDate") fund.targetDate = input.value;
      autosaveState();
    });
    input.addEventListener("change", () => render());
  });

  document.querySelectorAll("[data-delete-goal]").forEach((button) => {
    button.addEventListener("click", () => {
      state.goals.sinkingFunds.splice(Number(button.dataset.deleteGoal), 1);
      render();
    });
  });

  $("#addDebtButton")?.addEventListener("click", () => {
    const name = `New debt ${state.goals.debts.length + 1}`;
    const id = uniqueId(name);
    state.goals.debts.push({ id, name, balance: 1000, rate: 0, minimum: 0, termMonths: 12, assetId: "", payments: [] });
    state.goals.netWorth.liabilities.push({ id, name, value: 1000 });
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-debt-asset]").forEach((select) => {
    select.addEventListener("change", () => {
      const debt = state.goals.debts[Number(select.dataset.debtAsset)];
      debt.assetId = select.value;
      const asset = state.goals.netWorth.assets.find((item) => item.id === debt.assetId);
      state.household.activity.unshift(asset
        ? `Linked ${debt.name} to ${asset.name}`
        : `Marked ${debt.name} as unsecured`);
      autosaveState();
    });
  });

  document.querySelectorAll("[data-debt-name]").forEach((input) => {
    input.addEventListener("input", () => {
      const debt = state.goals.debts[Number(input.dataset.debtName)];
      debt.name = input.value;
      const liability = liabilityForDebt(debt);
      if (liability) liability.name = input.value;
      autosaveState();
    });
    input.addEventListener("change", () => {
      const debt = state.goals.debts[Number(input.dataset.debtName)];
      debt.name = input.value.trim() || "Untitled debt";
      const liability = liabilityForDebt(debt);
      if (liability) liability.name = debt.name;
      input.value = debt.name;
      autosaveState();
    });
  });

  [
    ["debtBalance", "balance"],
    ["debtRate", "rate"],
    ["debtMinimum", "minimum"],
    ["debtTerm", "termMonths"]
  ].forEach(([datasetKey, property]) => {
    document.querySelectorAll(`[data-${datasetKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`).forEach((input) => {
      input.addEventListener("input", () => {
        const index = Number(input.dataset[datasetKey]);
        const debt = state.goals.debts[index];
        debt[property] = property === "termMonths"
          ? Math.max(0, Math.round(Number(input.value || 0)))
          : Math.max(0, Number(input.value || 0));
        if (property === "balance") {
          const liability = liabilityForDebt(debt);
          if (liability) liability.value = debt.balance;
          refreshNetWorthTotals();
        }
        autosaveState();
      });
      input.addEventListener("change", () => render());
    });
  });

  document.querySelectorAll("[data-use-suggested-emi]").forEach((button) => {
    button.addEventListener("click", () => {
      const debt = state.goals.debts[Number(button.dataset.useSuggestedEmi)];
      debt.minimum = Math.round(suggestedEmi(debt) * 100) / 100;
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-apply-debt-payment]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.applyDebtPayment);
      const debt = state.goals.debts[index];
      const extra = Math.max(0, Number(document.querySelector(`[data-debt-payment="${index}"]`)?.value || 0));
      const emi = Math.max(0, Number(debt.minimum || 0));
      if (!emi || !debt.balance) return;
      const interest = Math.min(debt.balance, debt.balance * Math.max(0, Number(debt.rate || 0)) / 1200);
      const amount = Math.min(debt.balance + interest, emi + extra);
      const principal = Math.max(0, amount - interest);
      debt.balance = Math.max(0, debt.balance - principal);
      debt.payments ||= [];
      debt.payments.unshift({ id: uniqueId("payment"), date: new Date().toISOString().slice(0, 10), amount, principal, interest, extra, balance: debt.balance });
      const liability = liabilityForDebt(debt);
      if (liability) liability.value = debt.balance;
      state.household.activity.unshift(`Recorded ${money.format(amount)} EMI payment for ${debt.name}`);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-debt]").forEach((button) => {
    button.addEventListener("click", () => {
      const [debt] = state.goals.debts.splice(Number(button.dataset.deleteDebt), 1);
      if (debt) state.goals.netWorth.liabilities = state.goals.netWorth.liabilities.filter((liability) => liability.id !== debt.id);
      autosaveState();
      render();
    });
  });

  $("#addNetWorthItemButton")?.addEventListener("click", () => {
    const name = `New asset ${state.goals.netWorth.assets.length + 1}`;
    state.goals.netWorth.assets.push({ id: uniqueId(name), name, value: 0, assetClass: "other" });
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-net-worth-name]").forEach((input) => {
    input.addEventListener("input", () => {
      const [type, indexValue] = input.dataset.netWorthName.split(":");
      const collection = type === "asset" ? state.goals.netWorth.assets : state.goals.netWorth.liabilities;
      const item = collection[Number(indexValue)];
      item.name = input.value;
      if (type === "liability") {
        const debt = state.goals.debts.find((entry) => entry.id === item.id);
        if (debt) debt.name = input.value;
      }
      autosaveState();
    });
    input.addEventListener("change", () => {
      if (!input.value.trim()) input.value = "Untitled item";
      const [type, indexValue] = input.dataset.netWorthName.split(":");
      const collection = type === "asset" ? state.goals.netWorth.assets : state.goals.netWorth.liabilities;
      const item = collection[Number(indexValue)];
      item.name = input.value.trim();
      if (type === "liability") {
        const debt = state.goals.debts.find((entry) => entry.id === item.id);
        if (debt) debt.name = item.name;
      }
      autosaveState();
    });
  });

  document.querySelectorAll("[data-net-worth-value]").forEach((input) => {
    input.addEventListener("input", () => {
      const [type, indexValue] = input.dataset.netWorthValue.split(":");
      const collection = type === "asset" ? state.goals.netWorth.assets : state.goals.netWorth.liabilities;
      const item = collection[Number(indexValue)];
      item.value = Math.max(0, Number(input.value || 0));
      if (type === "liability") {
        const debt = state.goals.debts.find((entry) => entry.id === item.id);
        if (debt) debt.balance = item.value;
      }
      refreshNetWorthTotals();
      autosaveState();
    });
  });

  document.querySelectorAll("[data-asset-class]").forEach((select) => {
    select.addEventListener("change", () => {
      const asset = state.goals.netWorth.assets[Number(select.dataset.assetClass)];
      asset.assetClass = select.value;
      if (select.value === "stock") {
        asset.symbol ||= "";
        asset.shares ||= 0;
        asset.price ||= 0;
        asset.value = assetValue(asset);
      }
      autosaveState();
      render();
    });
  });

  const refreshStockValue = (index) => {
    const asset = state.goals.netWorth.assets[index];
    asset.value = assetValue(asset);
    const marketValue = document.querySelector(`[data-stock-market-value="${index}"]`);
    if (marketValue) marketValue.textContent = money.format(asset.value);
    refreshNetWorthTotals();
    autosaveState();
  };
  document.querySelectorAll("[data-stock-symbol]").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.dataset.stockSymbol);
      state.goals.netWorth.assets[index].symbol = input.value.toUpperCase();
      autosaveState();
    });
  });
  document.querySelectorAll("[data-stock-shares]").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.dataset.stockShares);
      state.goals.netWorth.assets[index].shares = Math.max(0, Number(input.value || 0));
      refreshStockValue(index);
    });
  });
  document.querySelectorAll("[data-stock-price]").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.dataset.stockPrice);
      state.goals.netWorth.assets[index].price = Math.max(0, Number(input.value || 0));
      refreshStockValue(index);
    });
  });
  document.querySelectorAll("[data-refresh-stock-price]").forEach((button) => {
    button.addEventListener("click", async () => {
      const index = Number(button.dataset.refreshStockPrice);
      const asset = state.goals.netWorth.assets[index];
      const symbol = (asset.symbol || "").trim().toUpperCase();
      if (!symbol) {
        stockPriceFeedback[asset.id] = { message: "Enter a stock symbol first.", isError: true };
        render();
        return;
      }
      button.disabled = true;
      try {
        const result = await api(`/api/stock-quote?symbol=${encodeURIComponent(symbol)}`);
        asset.price = result.price;
        refreshStockValue(index);
        stockPriceFeedback[asset.id] = { message: `Updated to ${money.format(result.price)} per share.`, isError: false };
      } catch (error) {
        stockPriceFeedback[asset.id] = { message: error.message, isError: true };
      }
      render();
    });
  });

  document.querySelectorAll("[data-net-worth-type]").forEach((select) => {
    select.addEventListener("change", () => {
      const [type, indexValue] = select.dataset.netWorthType.split(":");
      if (select.value === type) return;
      const source = type === "asset" ? state.goals.netWorth.assets : state.goals.netWorth.liabilities;
      const destination = select.value === "asset" ? state.goals.netWorth.assets : state.goals.netWorth.liabilities;
      const [item] = source.splice(Number(indexValue), 1);
      if (item) {
        destination.push(item);
        if (select.value === "liability") {
          state.goals.debts.forEach((debt) => {
            if (debt.assetId === item.id) debt.assetId = "";
          });
          state.goals.debts.push({ id: item.id, name: item.name, balance: Number(item.value || 0), rate: 0, minimum: 0, termMonths: 0, payments: [] });
        } else {
          state.goals.debts = state.goals.debts.filter((debt) => debt.id !== item.id);
        }
      }
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-asset]").forEach((button) => {
    button.addEventListener("click", () => {
      const [asset] = state.goals.netWorth.assets.splice(Number(button.dataset.deleteAsset), 1);
      if (asset) {
        state.goals.debts.forEach((debt) => {
          if (debt.assetId === asset.id) debt.assetId = "";
        });
      }
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-liability]").forEach((button) => {
    button.addEventListener("click", () => {
      const [liability] = state.goals.netWorth.liabilities.splice(Number(button.dataset.deleteLiability), 1);
      if (liability) state.goals.debts = state.goals.debts.filter((debt) => debt.id !== liability.id);
      autosaveState();
      render();
    });
  });

  $("#addAccountButton")?.addEventListener("click", () => {
    const name = `New account ${state.accounts.length + 1}`;
    const netWorthId = uniqueId(name);
    state.goals.netWorth.assets.push({ id: netWorthId, name, value: 0, assetClass: "cash" });
    state.accounts.push({
      id: uniqueId(name), name, type: "checking", openingBalance: 0,
      netWorthAssetId: netWorthId, netWorthLiabilityId: "", createdAt: dateKey(new Date())
    });
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-account-name]").forEach((input) => {
    const syncName = (name) => {
      const account = state.accounts[Number(input.dataset.accountName)];
      account.name = name;
      const asset = state.goals.netWorth.assets.find((item) => item.id === account.netWorthAssetId);
      if (asset) asset.name = name;
      const liability = state.goals.netWorth.liabilities.find((item) => item.id === account.netWorthLiabilityId);
      if (liability) liability.name = name;
    };
    input.addEventListener("input", () => {
      syncName(input.value);
      autosaveState();
    });
    input.addEventListener("change", () => {
      const account = state.accounts[Number(input.dataset.accountName)];
      syncName(input.value.trim() || "Untitled account");
      input.value = account.name;
      autosaveState();
    });
  });

  document.querySelectorAll("[data-account-type]").forEach((select) => {
    select.addEventListener("change", () => {
      const account = state.accounts[Number(select.dataset.accountType)];
      const wasLiability = account.type === "credit_card";
      const isLiability = select.value === "credit_card";
      account.type = select.value;
      if (wasLiability !== isLiability) {
        if (isLiability) {
          const assetIndex = state.goals.netWorth.assets.findIndex((item) => item.id === account.netWorthAssetId);
          if (assetIndex >= 0) {
            const [item] = state.goals.netWorth.assets.splice(assetIndex, 1);
            state.goals.netWorth.liabilities.push({ id: item.id, name: item.name, value: 0 });
            account.netWorthLiabilityId = item.id;
          } else {
            const id = uniqueId(account.name);
            state.goals.netWorth.liabilities.push({ id, name: account.name, value: 0 });
            account.netWorthLiabilityId = id;
          }
          account.netWorthAssetId = "";
        } else {
          const liabilityIndex = state.goals.netWorth.liabilities.findIndex((item) => item.id === account.netWorthLiabilityId);
          if (liabilityIndex >= 0) {
            const [item] = state.goals.netWorth.liabilities.splice(liabilityIndex, 1);
            state.goals.netWorth.assets.push({ id: item.id, name: item.name, value: 0, assetClass: "cash" });
            account.netWorthAssetId = item.id;
          } else {
            const id = uniqueId(account.name);
            state.goals.netWorth.assets.push({ id, name: account.name, value: 0, assetClass: "cash" });
            account.netWorthAssetId = id;
          }
          account.netWorthLiabilityId = "";
        }
      }
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-account-opening-balance]").forEach((input) => {
    input.addEventListener("input", () => {
      const account = state.accounts[Number(input.dataset.accountOpeningBalance)];
      account.openingBalance = Number(input.value || 0);
      refreshNetWorthTotals();
      autosaveState();
    });
    input.addEventListener("change", () => render());
  });

  document.querySelectorAll("[data-delete-account]").forEach((button) => {
    button.addEventListener("click", () => {
      const [account] = state.accounts.splice(Number(button.dataset.deleteAccount), 1);
      if (account) {
        state.transactions.forEach((transaction) => {
          if (transaction.accountId === account.id) transaction.accountId = "";
        });
        state.paychecks.forEach((paycheck) => {
          if (paycheck.depositAccountId === account.id) paycheck.depositAccountId = "";
        });
        // Deliberately leave state.transfers untouched: a transfer that already
        // moved money out of/into a surviving account is a historical fact that
        // must keep affecting that account's balance, even after the other side
        // of the transfer is deleted. accountBalance() only looks up the account
        // currently being computed, so a transfer referencing a deleted account
        // id on the *other* side is simply inert going forward, never an error.
      }
      autosaveState();
      render();
    });
  });

  $("#transferForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const amount = Number(data.amount || 0);
    if (!data.fromAccountId || !data.toAccountId || data.fromAccountId === data.toAccountId || amount <= 0) return;
    state.transfers.unshift({
      id: uniqueId("transfer"),
      date: data.date || dateKey(new Date()),
      fromAccountId: data.fromAccountId,
      toAccountId: data.toAccountId,
      amount,
      memo: (data.memo || "").trim()
    });
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-delete-transfer]").forEach((button) => {
    button.addEventListener("click", () => {
      state.transfers.splice(Number(button.dataset.deleteTransfer), 1);
      autosaveState();
      render();
    });
  });

  $("#calendarQuickAdd")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const data = Object.fromEntries(formData);
    const selectedKeys = formData.getAll("assignees");
    const assignees = selectedKeys.length
      ? resolveAssignees(selectedKeys)
      : resolveAssignees([sessionUser?.email || "Household owner"]);
    const selectedDateTime = String(data.date || "");
    const selectedDate = selectedDateTime.slice(0, 10);
    const editingKind = data.editingKind;
    const editingId = data.editingId;
    const wasEditing = Boolean(editingKind && editingId);
    if (editingKind === "event" && data.type === "chore") {
      state.calendar.events = state.calendar.events.filter((item) => item.id !== editingId);
    }
    if (editingKind === "chore" && data.type !== "chore") {
      state.calendar.chores = state.calendar.chores.filter((item) => item.id !== editingId);
    }
    if (data.type === "chore") {
      const recurrence = data.recurrence || "once";
      // An end date only applies to a chore that repeats — a one-time chore
      // is dropped even if a stale value lingers in the (hidden) field.
      const endDate = recurrence === "once" ? "" : String(data.choreEndDate || "").trim();
      const existing = editingKind === "chore" ? state.calendar.chores.find((chore) => chore.id === editingId) : null;
      const chore = {
        id: existing?.id || uniqueId("chore"),
        title: data.title,
        assignees,
        cadence: choreCadenceLabel({ recurrence, endDate }),
        recurrence,
        endDate,
        startDate: selectedDate,
        nextDue: selectedDate,
        time: selectedDateTime.slice(11, 16) || "09:00",
        notifyAt: selectedDateTime ? new Date(selectedDateTime).toISOString() : "",
        completedBy: existing?.completedBy || {}
      };
      if (existing) {
        delete existing.assignee;
        delete existing.assigneeName;
        Object.assign(existing, chore);
      } else state.calendar.chores.push(chore);
    } else {
      const isAnnual = ANNUAL_EVENT_TYPES.includes(data.type);
      const monthDay = isAnnual ? selectedDate.slice(5) : undefined;
      const reminderDays = isAnnual ? Number(data.reminderDays ?? 1) : undefined;
      const annualTime = String(data.annualTime || "09:00");
      // A plain reminder's notification time is fully independent of the
      // event's own date/time (e.g. "PickUp Robotics 12PM" but remind at
      // 11AM) -- falls back to the event's own time if left blank.
      const reminderAt = !isAnnual ? String(data.reminderAt || selectedDateTime) : "";
      const existing = editingKind === "event" ? state.calendar.events.find((item) => item.id === editingId) : null;
      const calendarEvent = {
        id: existing?.id || uniqueId("event"),
        title: data.title,
        date: selectedDate,
        dateTime: isAnnual ? `${selectedDate}T${annualTime}` : (selectedDateTime || `${selectedDate}T09:00`),
        // Annual events (birthday/anniversary) always notify off the NEXT upcoming
        // occurrence, not the literal date entered (which is often a birth year
        // decades in the past and would make the reminder look permanently overdue).
        notifyAt: isAnnual
          ? annualEventNotifyAt({ monthDay, reminderDays, dateTime: `${selectedDate}T${annualTime}` })
          : (reminderAt ? new Date(reminderAt).toISOString() : ""),
        reminderAt: isAnnual ? undefined : reminderAt,
        monthDay,
        type: isAnnual ? data.type : "reminder",
        annual: isAnnual,
        reminderDays,
        assignees
      };
      if (existing) {
        delete existing.owner;
        delete existing.ownerName;
        Object.assign(existing, calendarEvent);
      } else state.calendar.events.push(calendarEvent);
    }
    calendarFeedback = `${data.type === "chore" ? "Chore" : annualEventLabels[data.type] || "Reminder"} ${wasEditing ? "updated" : "added"}.`;
    render();
  });

  $("#calendarQuickAdd select[name='type']")?.addEventListener("change", updateCalendarQuickAddFields);
  $("#calendarQuickAdd select[name='recurrence']")?.addEventListener("change", updateCalendarQuickAddFields);
  updateCalendarQuickAddFields();

  $("#assigneeComboTrigger")?.addEventListener("click", () => {
    const menu = $("#assigneeMenu");
    if (menu) menu.hidden = !menu.hidden;
  });
  $("#assigneeMenu")?.addEventListener("change", updateAssigneeSummary);
  updateAssigneeSummary();

  // Once the user starts editing the form again after a completed add/update,
  // clear the leftover confirmation message so it doesn't look stuck/stale
  // while they're drafting a different entry.
  const calendarStatus = $("#calendarQuickAdd .calendar-form-status");
  ["input", "change"].forEach((eventName) => {
    $("#calendarQuickAdd")?.addEventListener(eventName, () => {
      if (!calendarFeedback) return;
      calendarFeedback = "";
      if (calendarStatus) calendarStatus.textContent = "";
    });
  });

  document.querySelectorAll("[data-complete-chore-assignee]").forEach((button) => {
    button.addEventListener("click", () => {
      const raw = button.dataset.completeChoreAssignee;
      const first = raw.indexOf(":");
      const second = raw.indexOf(":", first + 1);
      const index = Number(raw.slice(0, first));
      const occurrenceDate = raw.slice(first + 1, second);
      const assigneeKey = raw.slice(second + 1);
      const chore = state.calendar.chores[index];
      if (!chore || !occurrenceDate || !assigneeKey) return;
      chore.completedBy ||= {};
      chore.completedBy[occurrenceDate] ||= [];
      const already = chore.completedBy[occurrenceDate].includes(assigneeKey);
      // A jointly-assigned chore only counts as done for this occurrence once
      // every assignee has toggled their own button on.
      chore.completedBy[occurrenceDate] = already
        ? chore.completedBy[occurrenceDate].filter((key) => key !== assigneeKey)
        : [...chore.completedBy[occurrenceDate], assigneeKey];
      if (!already && isChoreOccurrenceComplete(chore, occurrenceDate)) {
        state.household.activity.unshift(`Completed ${chore.title} for ${occurrenceDate}`);
      }
      render();
    });
  });

  document.querySelectorAll("[data-complete-reminder]").forEach((button) => {
    button.addEventListener("click", () => {
      const raw = button.dataset.completeReminder;
      const separator = raw.indexOf(":");
      const eventId = raw.slice(0, separator);
      const key = raw.slice(separator + 1);
      const event = state.calendar.events.find((item) => item.id === eventId);
      if (!event || !key) return;
      event.completedBy ||= [];
      const already = event.completedBy.includes(key);
      event.completedBy = already
        ? event.completedBy.filter((item) => item !== key)
        : [...event.completedBy, key];
      render();
    });
  });

  document.querySelectorAll("[data-mark-wished-assignee]").forEach((button) => {
    button.addEventListener("click", () => {
      const raw = button.dataset.markWishedAssignee;
      const first = raw.indexOf(":");
      const second = raw.indexOf(":", first + 1);
      const eventId = raw.slice(0, first);
      const year = raw.slice(first + 1, second);
      const assigneeKey = raw.slice(second + 1);
      const event = state.calendar.events.find((item) => item.id === eventId);
      if (!event || !year || !assigneeKey) return;
      event.wishedBy ||= {};
      event.wishedBy[year] ||= [];
      const already = event.wishedBy[year].includes(assigneeKey);
      // A jointly-assigned birthday/anniversary only counts as wished for this
      // year once every assignee has toggled their own button on.
      event.wishedBy[year] = already
        ? event.wishedBy[year].filter((key) => key !== assigneeKey)
        : [...event.wishedBy[year], assigneeKey];
      if (!already && isAnnualEventYearComplete(event, year)) {
        state.household.activity.unshift(`Wished ${annualEventDisplayTitle(event)} for ${year}`);
      }
      render();
    });
  });

  document.querySelectorAll("[data-delete-calendar-item]").forEach((button) => {
    button.addEventListener("click", () => {
      const separator = button.dataset.deleteCalendarItem.indexOf(":");
      const kind = button.dataset.deleteCalendarItem.slice(0, separator);
      const id = button.dataset.deleteCalendarItem.slice(separator + 1);
      if (kind === "event") state.calendar.events = state.calendar.events.filter((event) => event.id !== id);
      if (kind === "chore") state.calendar.chores = state.calendar.chores.filter((chore) => chore.id !== id);
      render();
    });
  });

  document.querySelectorAll("[data-edit-calendar-item]").forEach((button) => {
    button.addEventListener("click", () => editCalendarItem(button.dataset.editCalendarItem));
  });

  document.querySelectorAll("[data-calendar-day]").forEach((cell) => {
    const applyDay = (event) => {
      if (event.target.closest(".event")) return;
      const dateInput = $("#calendarQuickAdd [name='date']");
      if (!dateInput) return;
      if (dateInput.type === "date") {
        dateInput.value = cell.dataset.calendarDay;
      } else {
        const existingTime = dateInput.value.includes("T") ? dateInput.value.split("T")[1] : "09:00";
        dateInput.value = `${cell.dataset.calendarDay}T${existingTime}`;
      }
      $("#calendarQuickAdd [name='title']")?.focus();
    };
    cell.addEventListener("click", applyDay);
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); applyDay(event); }
    });
  });

  $("[data-calendar-cancel]")?.addEventListener("click", resetCalendarEditor);

  $("[data-calendar-delete]")?.addEventListener("click", () => {
    const form = $("#calendarQuickAdd");
    const kind = form?.editingKind.value;
    const id = form?.editingId.value;
    if (!kind || !id) return;
    if (kind === "event") state.calendar.events = state.calendar.events.filter((item) => item.id !== id);
    if (kind === "chore") state.calendar.chores = state.calendar.chores.filter((item) => item.id !== id);
    calendarFeedback = "Calendar item deleted.";
    render();
  });

  $("#addChoreButton")?.addEventListener("click", () => focusCalendarType("chore"));
  $("#sideAddChoreButton")?.addEventListener("click", () => focusCalendarType("chore"));
  $("#addBirthdayButton")?.addEventListener("click", () => focusCalendarType("birthday"));
  $("#sideAddBirthdayButton")?.addEventListener("click", () => focusCalendarType("birthday"));
  $("#addReminderButton")?.addEventListener("click", () => focusCalendarType("reminder"));

  document.querySelectorAll("[data-calendar-filter-owner]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.calendarFilterOwner;
      calendarFilterOwner = calendarFilterOwner === key ? "" : key;
      render();
    });
  });

  document.querySelectorAll("[data-share-scope]").forEach((input) => {
    input.addEventListener("change", () => {
      const scope = input.dataset.shareScope;
      const scopes = new Set(state.household.sharedScopes || []);
      if (input.checked) scopes.add(scope);
      else scopes.delete(scope);
      state.household.sharedScopes = [...scopes];
      render();
    });
  });

  $("#shareEverythingToggle")?.addEventListener("change", (event) => {
    const allScopes = [...document.querySelectorAll("[data-share-scope]")].map((input) => input.dataset.shareScope);
    state.household.sharedScopes = event.currentTarget.checked ? allScopes : [];
    render();
  });

  $("#inviteButton")?.addEventListener("click", () => {
    state.household.inviteCode = `HUB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    state.household.activity.unshift(`Generated invite code ${state.household.inviteCode}`);
    render();
  });

  $("#inviteMemberForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const householdIds = new FormData(form).getAll("householdIds");
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    inviteEmailStatus = "Sending invitation...";
    $("#inviteEmailStatus").textContent = inviteEmailStatus;
    try {
      await saveStateNow();
      const result = await api("/api/households/invitations", {
        method: "POST",
        body: JSON.stringify({
          name: data.name,
          email: data.email,
          role: data.role,
          scopes: state.household.sharedScopes || [],
          householdIds: householdIds.length ? householdIds : undefined
        })
      });
      const invitations = result.invitations || [result.invitation];
      const currentInvitation = invitations.find((item) => item.householdName === state.household.name) || invitations[0];
      if (currentInvitation.inviteCode) state.household.inviteCode = currentInvitation.inviteCode;
      const member = state.household.members.find((item) => item.email.toLowerCase() === currentInvitation.email.toLowerCase());
      const invitedRole = `${currentInvitation.role} - Invited`;
      if (member) {
        Object.assign(member, { name: currentInvitation.name, email: currentInvitation.email, role: invitedRole });
      } else {
        state.household.members.push({ name: currentInvitation.name, email: currentInvitation.email, role: invitedRole });
      }
      state.household.activity.unshift(invitations.length > 1
        ? `${currentInvitation.name} was invited to ${invitations.length} households`
        : `${currentInvitation.name} was invited to ${state.household.name}`);
      const householdNames = invitations.map((item) => item.householdName).filter(Boolean);
      inviteEmailStatus = result.email.queued
        ? `Invitation${invitations.length > 1 ? "s" : ""} queued by the email provider for ${currentInvitation.email}${householdNames.length > 1 ? ` (${householdNames.join(", ")})` : ""}. Check Inbox, Spam, and All Mail.`
        : result.email.preview
          ? `Invitation saved. SMTP is not configured, so a local email preview was created for ${currentInvitation.email}.`
          : `Invitation saved, but the email provider did not accept mail for ${currentInvitation.email}.`;
      await saveStateNow();
      sharingAccess = null;
      await loadSharingAccess(false);
      render();
    } catch (error) {
      inviteEmailStatus = error.message;
      $("#inviteEmailStatus").textContent = inviteEmailStatus;
      submitButton.disabled = false;
    }
  });

  document.querySelectorAll("[data-revoke-household-access]").forEach((button) => {
    button.addEventListener("click", async () => {
      const email = button.dataset.revokeHouseholdAccess;
      if (!window.confirm(`Revoke household access for ${email}?`)) return;
      button.disabled = true;
      try {
        const result = await api("/api/households/access", {
          method: "DELETE",
          body: JSON.stringify({ email })
        });
        state.household.members = state.household.members.filter((member) => member.email.toLowerCase() !== email.toLowerCase());
        state.household.activity.unshift(`Access revoked for ${email}`);
        inviteEmailStatus = result.email.queued
          ? `Access revoked and an email was queued for ${email}.`
          : result.email.preview
            ? `Access revoked. SMTP is not configured, so a local email preview was created for ${email}.`
            : `Access revoked, but the email provider did not accept mail for ${email}.`;
        await saveStateNow();
        sharingAccess = null;
        await loadSharingAccess(false);
        render();
      } catch (error) {
        inviteEmailStatus = error.message;
        button.disabled = false;
        render();
      }
    });
  });

  document.querySelectorAll("[data-send-additional-invite]").forEach((button) => {
    button.addEventListener("click", async () => {
      const panel = button.closest(".member-add-household-panel");
      const email = panel.dataset.memberEmail;
      const name = panel.dataset.memberName;
      const role = panel.querySelector("select").value;
      const householdIds = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map((checkbox) => checkbox.value);
      if (!householdIds.length) {
        inviteEmailStatus = "Choose at least one household to add.";
        $("#inviteEmailStatus").textContent = inviteEmailStatus;
        return;
      }
      button.disabled = true;
      try {
        const result = await api("/api/households/invitations", {
          method: "POST",
          body: JSON.stringify({ name, email, role, scopes: state.household.sharedScopes || [], householdIds })
        });
        const invitations = result.invitations || [result.invitation];
        const householdNames = invitations.map((item) => item.householdName).filter(Boolean);
        state.household.activity.unshift(`${name} was invited to ${householdNames.join(", ") || "another household"}`);
        inviteEmailStatus = result.email.queued
          ? `Invitation queued by the email provider for ${email}${householdNames.length ? ` (${householdNames.join(", ")})` : ""}. Check Inbox, Spam, and All Mail.`
          : result.email.preview
            ? `Invitation saved. SMTP is not configured, so a local email preview was created for ${email}.`
            : `Invitation saved, but the email provider did not accept mail for ${email}.`;
        await saveStateNow();
        render();
      } catch (error) {
        inviteEmailStatus = error.message;
        button.disabled = false;
        render();
      }
    });
  });

  $("#refreshAdminButton")?.addEventListener("click", () => {
    adminData = null;
    render();
  });

  document.querySelectorAll("[data-admin-toggle-disabled]").forEach((button) => {
    button.addEventListener("click", async () => {
      const user = adminData?.users?.find((item) => item.id === button.dataset.adminToggleDisabled);
      if (!user) return;
      await updateAdminUser(user.id, { disabled: !user.disabled });
    });
  });

  document.querySelectorAll("[data-admin-reset-password]").forEach((button) => {
    button.addEventListener("click", async () => {
      const password = window.prompt("Enter a new password with at least 8 characters");
      if (!password || password.length < 8) return;
      await updateAdminUser(button.dataset.adminResetPassword, { password });
    });
  });

  document.querySelectorAll("[data-documents-open-folder]").forEach((button) => {
    button.addEventListener("click", () => {
      documentsCurrentFolderId = button.dataset.documentsOpenFolder || null;
      render();
    });
  });

  $("[data-documents-new-folder]")?.addEventListener("click", async () => {
    const name = window.prompt("Folder name");
    if (!name || !name.trim()) return;
    try {
      await api("/api/documents/folders", { method: "POST", body: JSON.stringify({ name: name.trim(), parentId: documentsCurrentFolderId || null }) });
      await loadDocumentsData(false);
      render();
    } catch (error) {
      window.alert(error.message);
    }
  });

  document.querySelectorAll("[data-documents-delete-folder]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("Delete this folder? It must be empty.")) return;
      try {
        await api(`/api/documents/folders/${button.dataset.documentsDeleteFolder}`, { method: "DELETE" });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-documents-rename-folder]").forEach((button) => {
    button.addEventListener("click", async () => {
      const folderId = button.dataset.documentsRenameFolder;
      const folder = documentsData?.folders.find((item) => item.id === folderId);
      const name = window.prompt("Rename folder", folder?.name || "");
      if (!name || !name.trim() || name.trim() === folder?.name) return;
      try {
        await api(`/api/documents/folders/${folderId}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-documents-file-input]").forEach((input) => {
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      documentsUploading = true;
      render();
      try {
        const { documentId, uploadUrl } = await api("/api/documents/upload-url", {
          method: "POST",
          body: JSON.stringify({
            name: file.name,
            contentType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            folderId: documentsCurrentFolderId || null
          })
        });
        // In MEMORY_DB (test/preview) mode the server returns a placeholder
        // URL rather than a real signed GCS URL, since there is no bucket to
        // upload to — only real deployments with GCS_BUCKET configured issue
        // an http(s) signed URL that this PUT actually reaches.
        if (/^https?:\/\//.test(uploadUrl)) {
          const uploadResponse = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
          if (!uploadResponse.ok) throw new Error("Upload to storage failed");
        }
        await api(`/api/documents/${documentId}/confirm`, { method: "POST" });
        await loadDocumentsData(false);
      } catch (error) {
        window.alert(error.message || "Upload failed");
      } finally {
        documentsUploading = false;
        render();
      }
    });
  });

  document.querySelectorAll("[data-documents-move]").forEach((select) => {
    select.addEventListener("change", async () => {
      try {
        await api(`/api/documents/${select.dataset.documentsMove}`, { method: "PATCH", body: JSON.stringify({ folderId: select.value || null }) });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-document-note-link]").forEach((input) => {
    input.addEventListener("change", async () => {
      try {
        await api(`/api/documents/${input.dataset.documentNoteLink}`, { method: "PATCH", body: JSON.stringify({ noteId: input.value || null }) });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-document-wealth-link]").forEach((input) => {
    input.addEventListener("change", async () => {
      const [wealthItemType, wealthItemId] = input.value ? input.value.split(":") : [null, null];
      try {
        await api(`/api/documents/${input.dataset.documentWealthLink}`, { method: "PATCH", body: JSON.stringify({ wealthItemType, wealthItemId }) });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-folder-wealth-link]").forEach((input) => {
    input.addEventListener("change", async () => {
      const [wealthItemType, wealthItemId] = input.value ? input.value.split(":") : [null, null];
      try {
        await api(`/api/documents/folders/${input.dataset.folderWealthLink}`, { method: "PATCH", body: JSON.stringify({ wealthItemType, wealthItemId }) });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-documents-download]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const { url } = await api(`/api/documents/${button.dataset.documentsDownload}/download-url`);
        window.open(url, "_blank", "noopener");
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-wealth-doc-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.wealthDocToggle;
      wealthDocsExpandedKey = wealthDocsExpandedKey === key ? null : key;
      render();
    });
  });

  document.querySelectorAll("[data-documents-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("Delete this document? This cannot be undone.")) return;
      try {
        await api(`/api/documents/${button.dataset.documentsDelete}`, { method: "DELETE" });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  document.querySelectorAll("[data-drag-type]").forEach((element) => {
    element.addEventListener("dragstart", (event) => {
      documentsDragPayload = { type: element.dataset.dragType, id: element.dataset.dragId };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", element.dataset.dragId);
      element.classList.add("dragging");
    });
    element.addEventListener("dragend", () => {
      documentsDragPayload = null;
      element.classList.remove("dragging");
      document.querySelectorAll(".documents-drop-target-active").forEach((target) => target.classList.remove("documents-drop-target-active"));
    });
  });

  document.querySelectorAll("[data-documents-drop-target]").forEach((target) => {
    target.addEventListener("dragover", (event) => {
      if (!documentsDragPayload) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    target.addEventListener("dragenter", (event) => {
      if (!documentsDragPayload) return;
      event.preventDefault();
      target.classList.add("documents-drop-target-active");
    });
    target.addEventListener("dragleave", () => {
      target.classList.remove("documents-drop-target-active");
    });
    target.addEventListener("drop", async (event) => {
      event.preventDefault();
      target.classList.remove("documents-drop-target-active");
      const payload = documentsDragPayload;
      documentsDragPayload = null;
      if (!payload) return;
      const targetFolderId = target.dataset.documentsDropTarget || null;
      try {
        if (payload.type === "folder") {
          if (payload.id === targetFolderId) return;
          const cycleCandidates = documentsData.folders.map((folder) => ({ id: folder.id, parentId: folder.parentId }));
          if (wouldCreateFolderCycle(cycleCandidates, payload.id, targetFolderId)) {
            window.alert("Can't move a folder into itself or one of its own subfolders.");
            return;
          }
          await api(`/api/documents/folders/${payload.id}`, { method: "PATCH", body: JSON.stringify({ parentId: targetFolderId }) });
        } else if (payload.type === "document") {
          await api(`/api/documents/${payload.id}`, { method: "PATCH", body: JSON.stringify({ folderId: targetFolderId }) });
        }
        await loadDocumentsData(false);
        render();
      } catch (error) {
        window.alert(error.message);
      }
    });
  });

  $("#decisionForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const title = String(formData.get("title") || "").trim();
    if (!title) return;
    state.decisions.push({
      id: uniqueId("decision"),
      title,
      notes: String(formData.get("notes") || "").trim(),
      status: "open",
      outcome: "",
      decidedAt: "",
      pros: [],
      cons: [],
      createdAt: new Date().toISOString()
    });
    event.currentTarget.reset();
    render();
  });

  document.querySelectorAll("[data-decision-title]").forEach((input) => {
    const decision = state.decisions.find((item) => item.id === input.dataset.decisionTitle);
    input.addEventListener("input", () => { if (decision) decision.title = input.value; autosaveState(); });
    input.addEventListener("change", () => { if (decision) decision.title = input.value.trim() || decision.title; render(); });
  });

  document.querySelectorAll("[data-decision-notes]").forEach((textarea) => {
    const decision = state.decisions.find((item) => item.id === textarea.dataset.decisionNotes);
    textarea.addEventListener("input", () => { if (decision) decision.notes = textarea.value; autosaveState(); });
  });

  document.querySelectorAll("[data-decision-attachment-input]").forEach((input) => {
    input.addEventListener("change", async () => {
      const decision = state.decisions.find((item) => item.id === input.dataset.decisionAttachmentInput);
      if (!decision) return;
      const newAttachments = await filesToDecisionAttachments(input.files, decision.attachments.length);
      decision.attachments.push(...newAttachments);
      render();
    });
  });

  document.querySelectorAll("[data-delete-decision-attachment]").forEach((button) => {
    button.addEventListener("click", () => {
      const [decisionId, attachmentId] = button.dataset.deleteDecisionAttachment.split(":");
      const decision = state.decisions.find((item) => item.id === decisionId);
      if (!decision) return;
      decision.attachments = decision.attachments.filter((attachment) => attachment.id !== attachmentId);
      render();
    });
  });

  document.querySelectorAll("[data-delete-decision]").forEach((button) => {
    button.addEventListener("click", () => {
      state.decisions = state.decisions.filter((item) => item.id !== button.dataset.deleteDecision);
      render();
    });
  });

  document.querySelectorAll("[data-decision-add]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const [decisionId, listKey] = form.dataset.decisionAdd.split(":");
      const decision = state.decisions.find((item) => item.id === decisionId);
      const input = form.querySelector('input[name="text"]');
      const text = input.value.trim();
      if (!decision || !text) return;
      decision[listKey].push({
        id: uniqueId("item"),
        text,
        authorKey: sessionUser?.email || "",
        authorName: sessionUser?.name || "Household member"
      });
      render();
    });
  });

  document.querySelectorAll("[data-decision-item-text]").forEach((input) => {
    const [decisionId, listKey, itemId] = input.dataset.decisionItemText.split(":");
    const entry = state.decisions.find((item) => item.id === decisionId)?.[listKey]?.find((item) => item.id === itemId);
    input.addEventListener("input", () => { if (entry) entry.text = input.value; autosaveState(); });
    input.addEventListener("change", () => { if (entry) entry.text = input.value.trim() || entry.text; render(); });
  });

  document.querySelectorAll("[data-decision-item-move]").forEach((button) => {
    button.addEventListener("click", () => {
      const [decisionId, listKey, itemId, direction] = button.dataset.decisionItemMove.split(":");
      const list = state.decisions.find((item) => item.id === decisionId)?.[listKey];
      if (!list) return;
      const index = list.findIndex((item) => item.id === itemId);
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (index === -1 || targetIndex < 0 || targetIndex >= list.length) return;
      [list[index], list[targetIndex]] = [list[targetIndex], list[index]];
      render();
    });
  });

  document.querySelectorAll("[data-delete-decision-item]").forEach((button) => {
    button.addEventListener("click", () => {
      const [decisionId, listKey, itemId] = button.dataset.deleteDecisionItem.split(":");
      const decision = state.decisions.find((item) => item.id === decisionId);
      if (!decision) return;
      decision[listKey] = decision[listKey].filter((item) => item.id !== itemId);
      render();
    });
  });

  document.querySelectorAll("[data-decision-decide]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const decision = state.decisions.find((item) => item.id === form.dataset.decisionDecide);
      if (!decision) return;
      decision.status = "decided";
      decision.outcome = String(new FormData(form).get("outcome") || "").trim();
      decision.decidedAt = new Date().toISOString();
      render();
    });
  });

  document.querySelectorAll("[data-reopen-decision]").forEach((button) => {
    button.addEventListener("click", () => {
      const decision = state.decisions.find((item) => item.id === button.dataset.reopenDecision);
      if (!decision) return;
      decision.status = "open";
      decision.outcome = "";
      decision.decidedAt = "";
      render();
    });
  });

  $("#profileNameForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    try {
      const updated = await api("/api/auth/me", { method: "PATCH", body: JSON.stringify({ name }) });
      sessionUser = { ...sessionUser, ...updated };
      profileNameFeedback = "Saved.";
      profileNameFeedbackIsError = false;
    } catch (error) {
      profileNameFeedback = error.message;
      profileNameFeedbackIsError = true;
    }
    render();
  });

  $("#profilePasswordForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const newPassword = formData.get("newPassword");
    const confirmPassword = formData.get("confirmPassword");
    if (newPassword !== confirmPassword) {
      profilePasswordFeedback = "New passwords don't match.";
      profilePasswordFeedbackIsError = true;
      render();
      return;
    }
    try {
      await api("/api/auth/me", { method: "PATCH", body: JSON.stringify({ currentPassword: formData.get("currentPassword"), newPassword }) });
      profilePasswordFeedback = "Password updated.";
      profilePasswordFeedbackIsError = false;
    } catch (error) {
      profilePasswordFeedback = error.message;
      profilePasswordFeedbackIsError = true;
    }
    render();
  });

  $("[data-resend-verification]")?.addEventListener("click", async () => {
    try {
      const result = await api("/api/auth/verify-email/resend", { method: "POST", body: "{}" });
      profileVerifyFeedback = result.message || "Verification email sent.";
      profileVerifyFeedbackIsError = false;
    } catch (error) {
      profileVerifyFeedback = error.message;
      profileVerifyFeedbackIsError = true;
    }
    render();
  });
}

function focusCalendarType(type) {
  const form = $("#calendarQuickAdd");
  if (!form) return;
  resetCalendarEditor();
  form.type.value = type;
  updateCalendarQuickAddFields();
  form.title.focus();
}

function editCalendarItem(reference) {
  const form = $("#calendarQuickAdd");
  if (!form || !reference) return;
  const separator = reference.indexOf(":");
  const kind = reference.slice(0, separator);
  const id = reference.slice(separator + 1);
  const item = kind === "chore"
    ? state.calendar.chores.find((chore) => chore.id === id)
    : state.calendar.events.find((event) => event.id === id);
  if (!item) return;

  form.editingKind.value = kind;
  form.editingId.value = id;
  form.type.value = kind === "chore" ? "chore" : ANNUAL_EVENT_TYPES.includes(item.type) ? item.type : "reminder";
  // Switch the date input's type (date-only vs datetime-local) before assigning
  // its value below, so the value we set matches the format the input expects.
  updateCalendarQuickAddFields();
  form.title.value = item.title || "";
  form.date.value = kind === "chore"
    ? `${item.startDate || item.nextDue || `${state.budget.month}-01`}T${item.time || "09:00"}`
    : ANNUAL_EVENT_TYPES.includes(item.type)
      ? item.date || `${state.budget.month}-01`
      : item.dateTime || `${item.date || `${state.budget.month}-01`}T09:00`;
  const selectedAssigneeKeys = new Set((item.assignees || []).map((assignee) => assignee.key));
  form.querySelectorAll('input[name="assignees"]').forEach((checkbox) => {
    checkbox.checked = selectedAssigneeKeys.has(checkbox.value);
  });
  updateAssigneeSummary();
  form.recurrence.value = kind === "chore" ? item.recurrence || "once" : "once";
  form.choreEndDate.value = kind === "chore" ? item.endDate || "" : "";
  form.reminderDays.value = kind === "event" && ANNUAL_EVENT_TYPES.includes(item.type) ? String(item.reminderDays ?? 1) : "1";
  form.annualTime.value = kind === "event" && ANNUAL_EVENT_TYPES.includes(item.type) ? (item.dateTime?.slice(11, 16) || "09:00") : "09:00";
  form.reminderAt.value = kind === "event" && item.type === "reminder" ? (item.reminderAt || item.dateTime || form.date.value) : "";
  form.querySelector("[data-calendar-submit]").textContent = "Save changes";
  form.querySelector("[data-calendar-delete]").textContent = `Delete ${form.type.value === "chore" ? "chore" : annualEventLabels[form.type.value]?.toLowerCase() || "reminder"}`;
  form.querySelector("[data-calendar-delete]").hidden = false;
  form.querySelector("[data-calendar-cancel]").hidden = false;
  calendarFeedback = "";
  form.querySelector(".calendar-form-status").textContent = "";
  updateCalendarQuickAddFields();
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  form.title.focus();
}

function resetCalendarEditor() {
  const form = $("#calendarQuickAdd");
  if (!form) return;
  form.reset();
  form.editingKind.value = "";
  form.editingId.value = "";
  form.date.value = `${state.budget.month}-01T09:00`;
  form.querySelector("[data-calendar-submit]").textContent = "Add";
  form.querySelector("[data-calendar-delete]").hidden = true;
  form.querySelector("[data-calendar-cancel]").hidden = true;
  calendarFeedback = "";
  form.querySelector(".calendar-form-status").textContent = "";
  updateCalendarQuickAddFields();
  updateAssigneeSummary();
  const assigneeMenu = $("#assigneeMenu");
  if (assigneeMenu) assigneeMenu.hidden = true;
}

function updateAssigneeSummary() {
  const trigger = $("#assigneeComboTrigger");
  const menu = $("#assigneeMenu");
  if (!trigger || !menu) return;
  const names = [...menu.querySelectorAll('input[name="assignees"]:checked')]
    .map((checkbox) => checkbox.closest(".assignee-menu-option")?.textContent.trim())
    .filter(Boolean);
  trigger.textContent = names.length ? names.join(", ") : "Select people";
}

function updateCalendarQuickAddFields() {
  const form = $("#calendarQuickAdd");
  if (!form) return;
  const type = form.type.value;
  const isAnnual = ANNUAL_EVENT_TYPES.includes(type);
  const recurrenceField = form.querySelector("[data-chore-recurrence-field]");
  const endDateField = form.querySelector("[data-chore-end-date-field]");
  const reminderField = form.querySelector("[data-annual-reminder-field]");
  const timeField = form.querySelector("[data-annual-time-field]");
  const plainReminderField = form.querySelector("[data-plain-reminder-field]");
  if (recurrenceField) recurrenceField.hidden = type !== "chore";
  // An end date only means something for a chore that actually repeats —
  // a one-time chore already stops after its single occurrence.
  if (endDateField) endDateField.hidden = type !== "chore" || form.recurrence.value === "once";
  if (reminderField) reminderField.hidden = !isAnnual;
  if (timeField) timeField.hidden = !isAnnual;
  if (plainReminderField) {
    plainReminderField.hidden = type !== "reminder";
    // Default the reminder time to match the event's own date/time the first
    // time this field appears, so it's not empty — the user can then move it
    // earlier (or later) independent of when the event itself happens.
    if (type === "reminder" && !form.reminderAt.value) form.reminderAt.value = form.date.value;
  }
  // Birthdays/anniversaries only need a plain calendar date — asking for a
  // year and time invites entering an actual birth year, which used to make
  // the reminder look permanently overdue (see annualEventNotifyAt).
  const dateInput = form.date;
  const dateLabelSuffix = form.querySelector("[data-date-label-suffix]");
  if (dateInput) {
    if (isAnnual && dateInput.type !== "date") {
      dateInput.type = "date";
      dateInput.value = dateInput.value.slice(0, 10);
    } else if (!isAnnual && dateInput.type !== "datetime-local") {
      dateInput.type = "datetime-local";
      dateInput.value = `${dateInput.value.slice(0, 10) || `${state.budget.month}-01`}T09:00`;
    }
  }
  if (dateLabelSuffix) dateLabelSuffix.textContent = isAnnual ? "" : " and time";
  const deleteButton = form.querySelector("[data-calendar-delete]");
  if (deleteButton && !deleteButton.hidden) deleteButton.textContent = `Delete ${type === "chore" ? "chore" : annualEventLabels[type]?.toLowerCase() || "reminder"}`;
}

function refreshBudgetTotals(categoryIndex, lineIndex) {
  const category = state.budget.categories[categoryIndex];
  if (!category) return;

  const line = category.lines[lineIndex];
  if (line) {
    const remaining = Number(line.planned || 0) - spentByLine(line.id);
    const remainingEl = document.querySelector(`[data-line-remaining="${categoryIndex}:${lineIndex}"]`);
    if (remainingEl) {
      remainingEl.textContent = exactMoney.format(remaining);
      remainingEl.classList.toggle("danger", remaining < 0);
    }
  }

  const spent = category.lines.reduce((sum, item) => sum + spentByLine(item.id), 0);
  const planned = category.lines.reduce((sum, item) => sum + Number(item.planned || 0), 0);
  const left = planned - spent;
  const leftEl = document.querySelector(`[data-category-left="${categoryIndex}"]`);
  const spentEl = document.querySelector(`[data-category-spent="${categoryIndex}"]`);
  const plannedEl = document.querySelector(`[data-category-planned="${categoryIndex}"]`);
  if (leftEl) leftEl.textContent = `${money.format(left)} left`;
  if (spentEl) spentEl.textContent = `${money.format(spent)} spent`;
  if (plannedEl) plannedEl.textContent = `${money.format(planned)} planned`;
}

function refreshIncomeTotals() {
  // Refresh every row (not just the one edited) since assigning or changing a
  // budget line's planned amount can shift the "Remaining" figure on any
  // paycheck that line is assigned to, not only the paycheck being typed into.
  state.paychecks.forEach((paycheck, paycheckIndex) => {
    const remainingEl = document.querySelector(`[data-income-remaining="${paycheckIndex}"]`);
    if (remainingEl) remainingEl.textContent = exactMoney.format(Number(paycheck.amount || 0) - paycheckAssignedAmount(paycheck));
  });

  const left = state.budget.income - plannedTotal();
  const leftEl = document.querySelector("[data-income-left]");
  if (leftEl) leftEl.textContent = `${money.format(left)} left to budget`;

  const metrics = $("#metrics");
  if (metrics) {
    metrics.innerHTML = metricsForView().map(([label, value, note]) => `
      <article class="metric">
        <span>${label}</span>
        <strong>${value}</strong>
        ${note ? `<small>${note}</small>` : ""}
      </article>
    `).join("");
  }
}

function refreshMealMetrics() {
  if (currentView !== "meals") return;
  const metrics = $("#metrics");
  if (!metrics) return;
  metrics.innerHTML = metricsForView().map(([label, value, note]) => `
    <article class="metric">
      <span>${label}</span>
      <strong>${value}</strong>
      ${note ? `<small>${note}</small>` : ""}
    </article>
  `).join("");
}

function refreshBudgetCategoryMenu() {
  const menu = $("#budgetCategoryMenu");
  const input = $("#newCategoryName");
  if (!menu || !input) return;
  const query = input.value.trim().toLowerCase();
  const matches = state.budget.categories.filter((category) => category.name.toLowerCase().includes(query));
  menu.innerHTML = matches.length
    ? matches.map((category) => `<button type="button" data-category-option="${category.name}">${category.name}</button>`).join("")
    : `<div class="combo-empty">No matching category</div>`;
}

function transactionSelectedCategory() {
  return state.budget.categories[Number($("#transactionParentCategory")?.value || 0)];
}

function refreshTransactionSubcategoryMenu() {
  const menu = $("#transactionSubcategoryMenu");
  const input = $("#transactionSubcategoryName");
  const category = transactionSelectedCategory();
  if (!menu || !input || !category) return;

  const query = input.value.trim().toLowerCase();
  const matches = category.lines.filter((line) => line.name.toLowerCase().includes(query));
  menu.innerHTML = matches.length
    ? matches.map((line) => `<button type="button" data-subcategory-option="${line.name}">${line.name}</button>`).join("")
    : `<div class="combo-empty">No matching subcategory</div>`;
}

function refreshMealRecipeMenu() {
  const menu = $("#mealRecipeMenu");
  const input = $("#mealRecipeName");
  if (!menu || !input) return;
  const query = input.value.trim().toLowerCase();
  const matches = state.meals.recipes.filter((recipe) => recipe.name.toLowerCase().includes(query));
  menu.innerHTML = matches.length
    ? matches.map((recipe) => `<button type="button" data-meal-recipe-option="${recipe.id}">${recipe.name}</button>`).join("")
    : `<div class="combo-empty">No matching recipe. Use Add recipe.</div>`;
}

function uniqueId(seed) {
  return String(seed || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + Math.random().toString(36).slice(2, 7);
}

view.addEventListener("click", (event) => {
  if (event.target.closest("#planMealButton")) planMealFromCurrentForm();
});

nav.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  if (button.dataset.view === "admin") {
    button.disabled = true;
    try {
      const validation = await api("/api/admin/session");
      sessionUser = validation.user;
      adminData = null;
    } catch (error) {
      sessionUser = { ...sessionUser, isAdmin: false };
      currentView = "home";
      render();
      window.alert(error.message);
      return;
    } finally {
      button.disabled = false;
    }
  }
  currentView = button.dataset.view;
  render();
});

view.addEventListener("click", (event) => {
  const acceptButton = event.target.closest("[data-accept-import]");
  if (acceptButton) {
    acceptImportTransaction(acceptButton);
    return;
  }

  const dismissButton = event.target.closest("[data-dismiss-import]");
  if (dismissButton) {
    dismissImportTransaction(dismissButton);
    return;
  }

  const deleteTransactionButton = event.target.closest("[data-delete-transaction]");
  if (deleteTransactionButton) {
    state.transactions.splice(Number(deleteTransactionButton.dataset.deleteTransaction), 1);
    autosaveState();
    render();
    return;
  }

  if (!event.target.closest(".custom-combobox")) {
    const subcategoryMenu = $("#transactionSubcategoryMenu");
    const categoryMenu = $("#budgetCategoryMenu");
    const recipeMenu = $("#mealRecipeMenu");
    const assigneeMenu = $("#assigneeMenu");
    if (subcategoryMenu) subcategoryMenu.hidden = true;
    if (categoryMenu) categoryMenu.hidden = true;
    if (recipeMenu) recipeMenu.hidden = true;
    if (assigneeMenu) assigneeMenu.hidden = true;
  }
});

function acceptImportTransaction(button) {
  let inboxItem = transactionInboxItems().find((item) => item.id === button.dataset.acceptImport);

  if (!inboxItem && button.dataset.acceptImport?.includes(":")) {
    const [payee, amount] = button.dataset.acceptImport.split(":");
    inboxItem = { id: uniqueId(payee), payee, amount: Number(amount), date: new Date().toISOString().slice(0, 10) };
  }

  if (!inboxItem) return;
  const lineId = button.closest(".assign-row")?.querySelector("select")?.value || allLines()[0]?.id;
  state.transactions.unshift(makeTransaction({ date: inboxItem.date, payee: inboxItem.payee, amount: Number(inboxItem.amount), lineId, memo: "Accepted bank stream item" }));
  state.transactionInboxDone ||= [];
  if (!state.transactionInboxDone.includes(inboxItem.id)) state.transactionInboxDone.push(inboxItem.id);
  state.transactionInboxDrafts = (state.transactionInboxDrafts || []).filter((item) => item.id !== inboxItem.id);
  state.household.activity.unshift(`Assigned ${inboxItem.payee} to ${transactionAssignmentLabel({ lineId })}`);
  render();
}

function dismissImportTransaction(button) {
  const inboxItem = transactionInboxItems().find((item) => item.id === button.dataset.dismissImport);
  state.transactionInboxDone ||= [];
  if (!state.transactionInboxDone.includes(button.dataset.dismissImport)) state.transactionInboxDone.push(button.dataset.dismissImport);
  state.transactionInboxDrafts = (state.transactionInboxDrafts || []).filter((item) => item.id !== button.dataset.dismissImport);
  state.household.activity.unshift(`Dismissed bank stream item: ${inboxItem?.payee || button.dataset.dismissImport}`);
  render();
}

$("#signinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/auth/signin", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    await loadApp();
  } catch (error) {
    $("#authMessage").textContent = error.message;
  }
});

function showSigninForm() {
  $("#signinForm").hidden = false;
  $("#signupForm").hidden = false;
  $("#passwordResetRequestForm").hidden = true;
  $("#passwordResetConfirmForm").hidden = true;
  $("#invitationAcceptForm").hidden = true;
  setAuthShell("Sign in");
}

$("#forgotPasswordButton").addEventListener("click", () => {
  $("#signinForm").hidden = true;
  $("#signupForm").hidden = true;
  $("#passwordResetRequestForm").hidden = false;
  setAuthShell("Reset password");
});

function showInvitationForm(email = "", inviteCode = "") {
  $("#signinForm").hidden = true;
  $("#signupForm").hidden = true;
  $("#passwordResetRequestForm").hidden = true;
  $("#passwordResetConfirmForm").hidden = true;
  $("#invitationAcceptForm").hidden = false;
  $("#invitationAcceptForm [name=email]").value = email;
  $("#invitationAcceptForm [name=inviteCode]").value = inviteCode;
  setAuthShell("Accept invitation");
}

$("#showInvitationButton").addEventListener("click", () => showInvitationForm());

document.querySelectorAll("[data-show-signin]").forEach((button) => {
  button.addEventListener("click", showSigninForm);
});

$("#passwordResetRequestForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = event.currentTarget.querySelector("[data-reset-message]");
  try {
    const result = await api("/api/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
    });
    message.textContent = result.message;
  } catch (error) {
    message.textContent = error.message;
  }
});

$("#passwordResetConfirmForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const message = event.currentTarget.querySelector("[data-reset-message]");
  if (data.password !== data.passwordConfirmation) {
    message.textContent = "Passwords do not match";
    return;
  }
  try {
    await api("/api/auth/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ email: data.email, token: data.token, password: data.password })
    });
    history.replaceState({}, "", location.pathname);
    showSigninForm();
    $("#signinForm [name=email]").value = data.email;
    $("#authMessage").textContent = "Password updated. Sign in with your new password.";
  } catch (error) {
    message.textContent = error.message;
  }
});

$("#invitationAcceptForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = event.currentTarget.querySelector("[data-invitation-message]");
  try {
    await api("/api/auth/invitations/accept", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
    });
    history.replaceState({}, "", location.pathname);
    await loadApp();
  } catch (error) {
    message.textContent = error.message;
  }
});

$("#demoLoginButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  $("#authMessage").textContent = "";
  try {
    await api("/api/auth/demo", { method: "POST", body: "{}" });
    await loadApp();
  } catch (error) {
    $("#authMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/auth/signup", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    await loadApp();
  } catch (error) {
    $("#authMessage").textContent = error.message;
  }
});

$("#signOutButton").addEventListener("click", async () => {
  await api("/api/auth/signout", { method: "POST", body: "{}" });
  state = null;
  sessionUser = null;
  adminData = null;
  sharingAccess = null;
  households = [];
  calendarFeedback = "";
  $("#householdWorkspaceControl").hidden = true;
  $("#workspace").hidden = true;
  $("#authPanel").hidden = false;
  showSigninForm();
});

$("#downloadCsvButton").addEventListener("click", () => {
  downloadCsv();
});

$("#syncButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    await saveStateNow();
    await reloadSelectedHousehold();
  } catch (error) {
    console.warn("Refresh failed", error);
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
  }
});

$("#monthPicker").addEventListener("change", (event) => {
  rememberCurrentBudgetSnapshot();
  state.budget.month = event.target.value;
  state.budget.monthPreferenceSet = true;
  autosaveState();
  render();
});

$("#mealWeekHeaderSelect").addEventListener("change", (event) => {
  state.meals.selectedWeekByMonth ||= {};
  state.meals.selectedWeekByMonth[state.budget.month] = Number(event.target.value);
  render();
});

$("#householdPicker").addEventListener("change", async (event) => {
  const picker = event.currentTarget;
  const message = $("#householdWorkspaceMessage");
  const previousValue = households.find((household) => household.selected)?.id || "";
  if (message) message.textContent = "";
  picker.disabled = true;
  try {
    await saveStateNow();
    await api("/api/households/select", {
      method: "POST",
      body: JSON.stringify({ householdId: picker.value })
    });
    sharingAccess = null;
    await reloadSelectedHousehold();
  } catch (error) {
    picker.value = previousValue;
    if (message) message.textContent = error.message;
  } finally {
    picker.disabled = false;
  }
});

$("#defaultHouseholdButton").addEventListener("click", async () => {
  const selected = households.find((household) => household.selected);
  if (!selected || selected.isDefault) return;
  const button = $("#defaultHouseholdButton");
  const message = $("#householdWorkspaceMessage");
  if (message) message.textContent = "";
  button.disabled = true;
  try {
    await api("/api/households/default", {
      method: "POST",
      body: JSON.stringify({ householdId: selected.id })
    });
    households.forEach((household) => {
      household.isDefault = household.id === selected.id;
    });
  } catch (error) {
    if (message) message.textContent = error.message;
  } finally {
    renderShell();
  }
});

$("#addHouseholdButton").addEventListener("click", () => {
  const dialog = $("#householdDialog");
  const form = $("#householdForm");
  form.reset();
  $("#householdDialogMessage").textContent = "";
  dialog.showModal();
  form.name.focus();
});

$("#removeHouseholdButton").addEventListener("click", () => {
  const selected = households.find((household) => household.selected);
  if (!selected) return;
  $("#removeHouseholdName").textContent = `${selected.name} (${selected.country})`;
  $("#removeHouseholdDialogMessage").textContent = "";
  $("#removeHouseholdDialog").showModal();
});

$("#closeHouseholdDialogButton").addEventListener("click", () => $("#householdDialog").close());
$("#cancelHouseholdButton").addEventListener("click", () => $("#householdDialog").close());
$("#closeRemoveHouseholdDialogButton").addEventListener("click", () => $("#removeHouseholdDialog").close());
$("#cancelRemoveHouseholdButton").addEventListener("click", () => $("#removeHouseholdDialog").close());

$("#householdForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  $("#householdDialogMessage").textContent = "";
  try {
    const selectedCountry = countryCatalog.find((country) => country.code === data.country);
    const duplicateCurrency = households.find((household) => household.currency === selectedCountry?.currency);
    if (duplicateCurrency) {
      throw new Error(`You already belong to a household using ${selectedCountry.currency}`);
    }
    await saveStateNow();
    await api("/api/households", {
      method: "POST",
      body: JSON.stringify({ name: data.name.trim(), country: data.country })
    });
    $("#householdDialog").close();
    await reloadSelectedHousehold();
  } catch (error) {
    $("#householdDialogMessage").textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

$("#removeHouseholdForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const selected = households.find((household) => household.selected);
  if (!selected) return;
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  submitButton.disabled = true;
  $("#removeHouseholdDialogMessage").textContent = "";
  try {
    await api(`/api/households/${selected.id}`, { method: "DELETE" });
    $("#removeHouseholdDialog").close();
    await reloadSelectedHousehold();
  } catch (error) {
    $("#removeHouseholdDialogMessage").textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

function populateCountrySelects() {
  document.querySelectorAll("[data-country-select]").forEach((select) => {
    const previousValue = select.value || "US";
    select.replaceChildren(...countryCatalog.map((country) => {
      const option = document.createElement("option");
      option.value = country.code;
      option.textContent = `${country.name} (${country.code}) · ${country.currency}`;
      return option;
    }));
    select.value = countryCatalog.some((country) => country.code === previousValue) ? previousValue : "US";
  });
}

function populateCarrierSelects() {
  document.querySelectorAll("[data-carrier-select]").forEach((select) => {
    const previousValue = select.value || "";
    const blankOption = document.createElement("option");
    blankOption.value = "";
    blankOption.textContent = "No text reminders";
    select.replaceChildren(blankOption, ...SMS_CARRIERS.map((carrier) => {
      const option = document.createElement("option");
      option.value = carrier.value;
      option.textContent = carrier.label;
      return option;
    }));
    select.value = SMS_CARRIERS.some((carrier) => carrier.value === previousValue) ? previousValue : "";
  });
}

// Polls briefly for the Google Identity Services script to finish loading
// (it's fetched async, so it may not be ready the instant loadApp() runs)
// before wiring up the "Sign in with Google" button. A no-op if the server
// has no GOOGLE_CLIENT_ID configured, so the button just never appears.
function initGoogleSignIn(clientId, attempt = 0) {
  if (!clientId || googleSignInInitialized) return;
  if (!window.google?.accounts?.id) {
    if (attempt < 20) setTimeout(() => initGoogleSignIn(clientId, attempt + 1), 150);
    return;
  }
  googleSignInInitialized = true;
  google.accounts.id.initialize({ client_id: clientId, callback: handleGoogleCredential });
  const container = $("#googleSigninButton");
  if (container) google.accounts.id.renderButton(container, { theme: "outline", size: "large", width: 300 });
  const divider = $("#googleSigninDivider");
  if (divider) divider.hidden = false;
}

async function handleGoogleCredential(response) {
  try {
    await api("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: response.credential }) });
    await loadApp();
  } catch (error) {
    $("#authMessage").textContent = error.message;
  }
}

async function loadApp() {
  const session = await api("/api/session");
  initGoogleSignIn(session.googleClientId);
  if (!session.authenticated) {
    sessionUser = null;
    households = [];
    document.body.classList.add("auth-mode");
    $("#authPanel").hidden = false;
    $("#workspace").hidden = true;
    return;
  }
  document.body.classList.remove("auth-mode");
  sessionUser = session.user;
  sharingAccess = null;
  [households, state, privateData] = await Promise.all([
    api("/api/households"),
    api("/api/state"),
    api("/api/private-data")
  ]);
  if (migrateInitialMonth()) autosaveState();
  $("#authPanel").hidden = true;
  $("#workspace").hidden = false;
  render();
}

function setAuthShell(title) {
  document.body.classList.add("auth-mode");
  $("#householdName").textContent = "FamilyLoop";
  $("#viewTitle").textContent = title;
}

async function reloadSelectedHousehold() {
  const session = await api("/api/session");
  sessionUser = session.user;
  // privateData is scoped to the user, not the household, so it stays the same across
  // this reload — refetched here anyway for simplicity, since it's cheap and correct.
  [households, state, privateData] = await Promise.all([
    api("/api/households"),
    api("/api/state"),
    api("/api/private-data")
  ]);
  if (migrateInitialMonth()) autosaveState();
  adminData = null;
  sharingAccess = null;
  sharedCalendarMembers = [];
  calendarFeedback = "";
  render();
}

async function loadSharingAccess(shouldRender = true) {
  if (!sessionUser) return;
  try {
    sharingAccess = await api("/api/households/access");
    if (shouldRender && ["sharing", "calendar"].includes(currentView)) render();
  } catch (error) {
    inviteEmailStatus = error.message;
    sharingAccess = { canManage: false, members: [] };
    if (shouldRender && ["sharing", "calendar"].includes(currentView)) render();
  }
}

async function loadCalendarMembers(shouldRender = true) {
  if (!sessionUser) return;
  try {
    sharedCalendarMembers = await api("/api/calendar/members");
    if (shouldRender && currentView === "calendar") render();
  } catch (error) {
    console.warn("Unable to load shared calendar members", error);
    sharedCalendarMembers = [];
  }
}

async function loadDocumentsData(shouldRender = true) {
  if (!sessionUser) return;
  try {
    documentsData = await api("/api/documents");
    if (shouldRender && currentView === "documents") render();
  } catch (error) {
    console.warn("Unable to load documents", error);
    documentsData = { folders: [], documents: [] };
    if (shouldRender && currentView === "documents") render();
  }
}

async function loadAdminData() {
  if (!sessionUser?.isAdmin) return;
  try {
    const [validation, stats, users, monthly] = await Promise.all([
      api("/api/admin/session"),
      api("/api/admin/stats"),
      api("/api/admin/users"),
      api("/api/admin/monthly-stats")
    ]);
    sessionUser = validation.user;
    adminData = { stats, users, monthly };
    render();
  } catch (error) {
    sessionUser = { ...sessionUser, isAdmin: false };
    adminData = null;
    currentView = "home";
    render();
    window.alert(error.message);
  }
}

async function updateAdminUser(userId, patch) {
  await api(`/api/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(patch) });
  adminData = null;
  await loadAdminData();
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
}

function downloadCsv() {
  if (!state) return;
  const rowsByView = {
    budget: () => [["month", "category", "subcategory", "due_date", "planned", "spent", "remaining"], ...allLines().map((line) => {
      const spent = spentByLine(line.id);
      return [state.budget.month, line.category, line.name, dueDateValue(line.dueDay), Number(line.planned || 0).toFixed(2), spent.toFixed(2), (Number(line.planned || 0) - spent).toFixed(2)];
    })],
    transactions: () => [["date", "payee", "amount", "category", "subcategory", "memo"], ...state.transactions.map((transaction) => {
      const line = allLines().find((item) => item.id === transaction.lineId);
      return [transaction.date, transaction.payee, Number(transaction.amount || 0).toFixed(2), line?.category || transaction.categoryName || "", line?.name || "Unassigned", transaction.memo || ""];
    })],
    paychecks: () => [["date", "paycheck_income", "amount", "assigned_subcategories"], ...state.paychecks.map((paycheck) => [paycheck.date, paycheck.name, Number(paycheck.amount || 0).toFixed(2), (paycheck.assignedLineIds || []).map((id) => allLines().find((line) => line.id === id)?.name || id).join("; ")])],
    calendar: () => [["kind", "title", "date_time", "assigned_to", "repeat"], ...state.calendar.events.map((item) => [item.type, item.title, item.dateTime || item.date, assigneeNames(item.assignees), item.annual ? "Yearly" : "Once"]), ...state.calendar.chores.map((item) => ["chore", item.title, `${item.startDate || item.nextDue}T${item.time || "09:00"}`, assigneeNames(item.assignees), choreCadenceLabel(item)])],
    meals: () => [["month", "week", "day", "meal", "recipe", "servings"], ...state.meals.plannedWeek.map((item) => [item.month || state.budget.month, item.week || 1, item.day, item.slot || "Dinner", item.meal, item.servings])],
    recipes: () => [["recipe", "calories", "protein_g", "ingredients"], ...state.meals.recipes.map((recipe) => [recipe.name, recipe.calories, recipe.protein, (recipe.ingredients || []).join("; ")])],
    goals: () => [["goal", "target_date", "target", "saved", "remaining"], ...state.goals.sinkingFunds.map((goal) => [goal.name, goal.targetDate || "", goal.target, goal.saved, Math.max(0, Number(goal.target || 0) - Number(goal.saved || 0))])],
    wealth: () => [["record_type", "name", "class_or_apr", "shares_or_term", "price_or_emi", "value_or_balance"], ...state.goals.netWorth.assets.map((asset) => ["asset", asset.name, asset.assetClass || "other", asset.shares || "", asset.price || "", assetValue(asset)]), ...state.goals.debts.map((debt) => ["debt", debt.name, debt.rate, debt.termMonths || "", debt.minimum || 0, debt.balance])],
    reports: () => [["metric", "value"], ["Income", state.budget.income], ["Assigned", plannedTotal()], ["Spent", spentTotal()], ["Available", state.budget.income - plannedTotal()], ["Cash left", remainingTotal()], ...state.budget.categories.map((category) => [`Category: ${category.name}`, category.lines.reduce((sum, line) => sum + spentByLine(line.id), 0)])],
    sharing: () => [["name", "email", "role", "status"], ...(sharingAccess?.members || []).map((member) => [member.name, member.email, member.role, member.status])]
  };
  const rows = (rowsByView[currentView] || rowsByView.budget)();

  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `familyloop-${currentView}-${state.budget.month}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function initializeApp() {
  countryCatalog = await api("/api/countries");
  populateCountrySelects();
  populateCarrierSelects();
  const resetParams = new URLSearchParams(location.search);
  const resetToken = resetParams.get("resetToken");
  const resetEmail = resetParams.get("email");
  const inviteCode = resetParams.get("inviteCode");
  const verifyToken = resetParams.get("verifyToken");
  if (verifyToken && resetEmail) {
    history.replaceState({}, "", location.pathname);
    try {
      await api("/api/auth/verify-email/confirm", { method: "POST", body: JSON.stringify({ email: resetEmail, token: verifyToken }) });
      $("#authMessage").textContent = "Email verified. Sign in to continue.";
    } catch (error) {
      $("#authMessage").textContent = error.message;
    }
    $("#signinForm [name=email]").value = resetEmail;
    setAuthShell("Sign in");
  } else if (resetToken && resetEmail) {
    $("#signinForm").hidden = true;
    $("#signupForm").hidden = true;
    $("#passwordResetConfirmForm").hidden = false;
    $("#passwordResetConfirmForm [name=email]").value = resetEmail;
    $("#passwordResetConfirmForm [name=token]").value = resetToken;
    setAuthShell("Reset password");
  } else if (inviteCode && resetEmail) {
    showInvitationForm(resetEmail, inviteCode);
  } else {
    setAuthShell("Sign in");
  }
  await loadApp();
}

initializeApp().catch((error) => {
  $("#authMessage").textContent = error.message;
});
