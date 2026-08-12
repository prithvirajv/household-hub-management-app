const views = [
  ["home", "Home", "🏠"],
  ["budget", "Budget", "📊"],
  ["bills", "Bills", "🧾"],
  ["transactions", "Transactions", "💳"],
  ["paychecks", "Paycheck/Income", "💵"],
  ["calendar", "Calendar", "📅"],
  ["notes", "Notes", "📝"],
  ["journal", "Journal", "📔"],
  ["plan", "Plan", "📋"],
  ["documents", "Documents", "📁"],
  ["decisions", "Decisions", "⚖️"],
  ["ious", "Shared Expenses", "💸"],
  ["meals", "Meals", "🍲"],
  ["recipes", "Recipes", "📖"],
  ["goals", "Goals", "🎯"],
  ["wealth", "Wealth", "🏦"],
  ["sharing", "Sharing", "🤝"],
  ["reports", "Reports", "📈"],
  ["profile", "Profile", "👤"],
  ["help", "Help", "💬"],
  ["admin", "Admin", "🛠️"]
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
let googleMapsApiKey = "";
let googleMapsLoadPromise = null;
let calendarFilterOwner = "";
// Recent transactions defaults to newest-first regardless of the order rows
// were entered/edited in — an ephemeral view preference (like
// calendarFilterOwner), not household data, so it isn't persisted to state
// and resets to the date-desc default on reload.
let transactionSort = { field: "date", direction: "desc" };
// Bank stream's own sort state, separate from transactionSort above since the
// two lists (Recent transactions vs Bank stream) sort independently - the
// same field/direction pair for one shouldn't force a reorder of the other.
let bankStreamSort = { field: "date", direction: "desc" };
let selectedTransactionTag = "";
// null until the Reports page is first opened, at which point it syncs to
// the currently-viewed budget month - once the user picks a range/year
// explicitly it's left alone, so switching months elsewhere doesn't stomp on
// a deliberately-chosen report scope.
let reportsScope = null;
let reportsCardFilter = "all";
let reportsSelectedTag = "";
let reportsExpandedSankeyLineKey = null;
let reportsSelectedCategoryLine = "";
// Reports' own appearance settings - a per-viewer display preference, not
// household data, so these stay session-local (like reportsCardFilter)
// rather than round-tripping through autosaveState().
let reportsDensity = "comfortable";
let reportsColorTheme = "fresh";
let reportsCategoryStyle = "bars";
let reportsExpandedRingCategory = null;
let reportsCompareLastYear = false;
// Wealth's own display currency - a per-viewer preference, not household
// data, so it stays session-local like reportsDensity above. Rates are
// fetched once per session from a real FX API (see /api/fx-rates) and
// cached client-side; never a fabricated conversion rate.
let wealthCurrency = "USD";
let wealthFxRates = null;
let wealthFxLoading = false;
// A guided-navigation overlay, not a form of its own - each step hands off
// to the real screen/button that already does the work (Add account,
// Invite, Start planning), rather than duplicating that logic here.
let onboardingStep = 1;
let onboardingAutoShown = false;
// Three full curated palettes (accent + negative color + a 5-color chart
// palette) a viewer can swap between on the Reports page - independent of
// each category's own stored .color (that's the app-wide Budget-page
// assignment; Reports charts intentionally re-color by theme+index instead
// so switching themes here never touches Budget's own category colors).
const REPORTS_THEMES = {
  fresh: { accent: "#13936d", negative: "#e05252", palette: ["#13936d", "#3569d4", "#c9891e", "#e05252", "#7c5cff"] },
  sunset: { accent: "#d2601a", negative: "#b0304f", palette: ["#d2601a", "#b0304f", "#d99a24", "#8a3f9c", "#3d8f8a"] },
  ocean: { accent: "#0d6e91", negative: "#b0413e", palette: ["#0d6e91", "#4d5fd1", "#0f9e8e", "#b0413e", "#7a5cc7"] }
};
// Which decision card has its pros/cons/notes/attachments expanded - one at
// a time (accordion), same convention as Reports' expandedRingCategory.
let expandedDecisionId = null;
// Bills page's own filter pill (all/due/overdue) - session-local display
// state, same convention as Reports' reportsScope/reportsDensity.
let billsFilter = "all";
// "all" or a member key (assigneeKey) - narrows the Budget page's category
// table to just that member's subcategories, same session-local convention
// as billsFilter/reportsScope.
let budgetMemberFilter = "all";
// Indices (into state.transactions) checked via the Ledger's row checkboxes
// for bulk categorize - session-local, cleared after every apply/render of
// a different month so a stale selection never silently reapplies.
let ledgerSelectedIndices = new Set();
let splitBillType = "equal";
let splitBillRows = [];
// The payer's own row in the Split-a-bill card, shown alongside the friend
// rows so the total isn't just "whatever's left over" - the user can type
// their own percent/shares/amount directly, including 0 to fully exclude
// themselves. Kept as one object (not three separate variables) so switching
// splitBillType back and forth doesn't lose whatever was already typed for
// the other types.
let splitBillYou = { amount: 0, percent: 0, shares: 1 };
let calendarFeedback = "";
// Kept out of state (like calendarFeedback) so a confirmation message never
// gets saved into the shared household blob and replayed for every login.
let mealsFeedback = "";
let bankImportFeedback = "";
let ledgerAcceptFeedback = "";
let transactionValidationFeedback = "";
// Holds { lineIds, perform } between opening the delete-subcategory
// confirmation dialog and the user actually confirming/cancelling it — never
// persisted, it only ever lives for the duration of one confirmation.
let pendingBudgetLineDeletion = null;
// Holds { onConfirm, onCancel } between opening the account rename/delete
// confirmation dialog and the user actually confirming/cancelling it.
let pendingAccountAction = null;
let pendingIouSource = null;
let pendingTransferMoveSource = null;
let profileNameFeedback = "";
let profileNameFeedbackIsError = false;
let profilePasswordFeedback = "";
let profilePasswordFeedbackIsError = false;
let profileVerifyFeedback = "";
let profileVerifyFeedbackIsError = false;
// Keyed by asset id (not index, since rows can reorder/delete) so a stale
// "Refresh price" result never gets attributed to the wrong stock row.
let stockPriceFeedback = {};
// Fetches a fresh quote for every symbol-bearing holding in the list,
// mutating price/value in place. A single bad symbol or rate limit only
// drops that one holding's update, never aborts the batch - used by the
// per-group "Live price" button, the holdings modal's "Refresh all", and
// the background auto-poll below, so all three share one failure behavior.
async function refreshHoldingQuotes(items) {
  await Promise.all(items.map(async (asset) => {
    const symbol = (asset.symbol || "").trim().toUpperCase();
    if (!symbol) return;
    try {
      const result = await api(`/api/stock-quote?symbol=${encodeURIComponent(symbol)}`);
      asset.price = result.price;
      asset.value = assetValue(asset);
    } catch {
      // leave this one holding's price as-is
    }
  }));
}

// Real wall-clock timestamps (not a session-local "did this fire yet?"
// flag) so a grouped holding card's caption survives a reload and can show
// an actual age instead of a permanent "just now" after the first click.
function markStockGroupRefreshed(groupId) {
  state.goals.netWorth.priceLastUpdated = state.goals.netWorth.priceLastUpdated || {};
  state.goals.netWorth.priceLastUpdated[groupId] = new Date().toISOString();
}

function formatRelativeTime(isoString) {
  if (!isoString) return null;
  const elapsedMs = Date.now() - new Date(isoString).getTime();
  if (elapsedMs < 60000) return "just now";
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Runs every few minutes while the Wealth page is open (see the setInterval
// near the bottom of this file) so live-price captions stay fresh without
// the household needing to click "Live price" on every visit.
async function refreshAllStockGroupPrices() {
  const groups = groupStockHoldings(state.goals.netWorth.assets);
  const groupsWithSymbols = groups.filter((group) => group.items.some((item) => (item.symbol || "").trim()));
  if (!groupsWithSymbols.length) return;
  await Promise.all(groupsWithSymbols.map(async (group) => {
    await refreshHoldingQuotes(group.items);
    markStockGroupRefreshed(group.groupId);
  }));
  autosaveState();
  render();
}
// Which stock/retirement group the Manage holdings modal currently has
// open, if any - every field in that modal writes straight to the matching
// asset in state.goals.netWorth.assets (autosaved immediately), so this is
// just which group's rows to render, not a staging area.
let currentHoldingsModalGroupId = null;
// privateData is scoped to the signed-in user (not the household) and is never part
// of `state` or autosaveState() — it must never reach the shared household blob.
let privateData = null;
let journalTimer = null;
let planTimer = null;
// Holds { text, isError, loading } for the composer's on-demand AI
// reflection - never persisted, and never auto-inserted into the entry;
// the user has to click "Use this" to actually put it in the body.
let journalReflection = null;
// The composer form has no value= attributes (nothing needed them before -
// no other action ever called render() while it was mid-edit). The
// reflection feature does call render() mid-edit, so whatever's currently
// typed has to be captured into here first or it gets wiped by the fresh
// template. Cleared once the entry is actually saved.
let journalComposerDraft = null;
// documentsData is household-shared (like Notes/Calendar), backed by real Postgres
// rows and Google Cloud Storage, not part of `state`/autosaveState().
let documentsData = null;
let documentsCurrentFolderId = null;
let documentsUploading = false;
let documentsDragPayload = null;
let documentsUploadProgress = null;
// documentId -> { kind: "image"|"badge", src?, label?, color? }. Rasterized
// once per session (not persisted - regenerating on reload is cheap and
// avoids storing derived thumbnail bytes anywhere).
const documentsThumbnailCache = new Map();
let documentsInfoExpandedId = null;
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
function setAuthMessage(text, isSuccess = false) {
  $("#authMessage").textContent = text;
  $("#authMessage").classList.toggle("success", isSuccess);
}
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
  $("#mobileTabBar").hidden = true;
  document.body.classList.remove("mobile-sidebar-open");
  showSigninForm();
  setAuthMessage("Your session expired. Please sign in again.");
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin"
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

// The server rejects a view-only member's writes regardless (requireEditAccess
// on PUT /api/state) - this just skips the doomed round-trip client-side and
// tells them once why, instead of a silent failed save or a toast on every
// single keystroke.
let viewOnlyToastShownAt = 0;

// Set for the duration of a household switch (app.js's #householdPicker
// change handler) so a stray edit/poll on the still-visible previous
// household's screen can't schedule a save that lands after the cookie has
// already flipped to the new household - see currentHouseholdId() below.
let householdSwitchInProgress = false;

function currentHouseholdId() {
  return households.find((household) => household.selected)?.id || null;
}

// The debounce/flush below exist to survive a household switch (or a second
// browser tab switching households, since hh_household is one cookie shared
// by the whole browser) without silently overwriting the *other* household's
// data: household id is captured at schedule time, re-checked at send time,
// and sent as a header the server double-checks against the session's
// current household before writing (server/index.js's PUT /api/state).
// First line of defense against ever saving a malformed/incomplete state -
// the server rejects the same shape too (see PUT /api/state), but catching
// it here avoids even sending the doomed request, and protects the also
// affected in-memory `state` from being blindly trusted downstream.
// Mirrors the server's REQUIRED_STATE_KEYS (derived from defaultState) -
// every one of these must be present, not just the handful that happen to
// crash loudest. A save missing only `notes`/`meals` used to slip past a
// narrower check here and silently corrupt user_shared_modules with an
// empty {} for those fields, which then clobbered good household data on
// every subsequent load via applySharedModules().
const REQUIRED_STATE_KEYS = [
  "household", "budget", "budgetHistory", "transactions", "paychecks",
  "calendar", "notes", "decisions", "ious", "meals", "goals", "accounts",
  "transfers", "recurringExpenses"
];

function looksLikeCompleteState(candidate) {
  return Boolean(candidate) && REQUIRED_STATE_KEYS.every((key) => key in candidate);
}

function autosaveState() {
  if (!state) return;
  if (householdSwitchInProgress) return;
  if (!looksLikeCompleteState(state)) {
    console.error("Refusing to autosave - state looks incomplete", state);
    return;
  }
  if (sessionUser?.accessLevel === "view") {
    if (Date.now() - viewOnlyToastShownAt > 10000) {
      viewOnlyToastShownAt = Date.now();
      showToast("You have view-only access - changes here won't be saved.", { type: "info" });
    }
    return;
  }
  const householdIdAtSchedule = currentHouseholdId();
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (currentHouseholdId() !== householdIdAtSchedule) return;
    // Re-check at fire time, not just at schedule time above - `state` is a
    // mutable global and 350ms is long enough for something else (a
    // household reload, a stale reference from a prior render) to have
    // reassigned it to something incomplete in between.
    if (!looksLikeCompleteState(state)) {
      console.error("Refusing to autosave - state looks incomplete at fire time", state);
      return;
    }
    api("/api/state", {
      method: "PUT",
      headers: { "X-Household-Id": householdIdAtSchedule || "" },
      body: JSON.stringify(state)
    }).catch((error) => {
      console.warn("Autosave failed", error);
    });
  }, 350);
}

async function saveStateNow() {
  if (!state) return;
  if (!looksLikeCompleteState(state)) {
    console.error("Refusing to save - state looks incomplete", state);
    return;
  }
  const householdIdAtCall = currentHouseholdId();
  clearTimeout(autosaveTimer);
  await api("/api/state", {
    method: "PUT",
    headers: { "X-Household-Id": householdIdAtCall || "" },
    body: JSON.stringify(state)
  });
}

function showToast(message, { type = "error" } = {}) {
  const container = $("#toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", "status");
  toast.textContent = message;
  const dismiss = () => {
    toast.classList.remove("toast-visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  };
  toast.addEventListener("click", dismiss);
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  setTimeout(dismiss, 6000);
}

// Promise-based replacement for window.confirm() using the shared
// #confirmDialog - the dialog's returnValue is set by the OK/Cancel button
// handlers before .close() is called (wired once, near the other static
// dialog wiring), so a single "close" listener here covers both buttons and
// the native Escape-to-cancel behavior for free.
function showConfirm(message, { title = "Confirm", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = true } = {}) {
  const dialog = $("#confirmDialog");
  $("#confirmDialogTitle").textContent = title;
  $("#confirmDialogMessage").textContent = message;
  const okButton = $("#confirmDialogOkButton");
  okButton.textContent = confirmLabel;
  okButton.className = danger ? "danger-button" : "";
  $("#confirmDialogCancelButton").textContent = cancelLabel;
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "confirmed");
    };
    dialog.addEventListener("close", onClose);
    dialog.returnValue = "";
    dialog.showModal();
  });
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

// Sorted alphabetically by category, then by subcategory within each
// category - used for every subcategory dropdown/lookup across the app.
// Budget's own management page still shows categories/lines in the order
// the household created them (an intentional layout the household chose),
// so this only re-sorts the flattened copy every dropdown reads from, not
// state.budget.categories itself.
function allLines() {
  return [...state.budget.categories]
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((category) => [...category.lines]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((line) => ({ ...line, category: category.name, color: category.color })));
}

// AI fallback for a payee suggestSubcategoryFromHistory has never seen
// before. Deliberately not called automatically for every unmatched row in
// a batch import (a 200-row statement would mean 200 paid API calls) - only
// ever fired by an explicit click, one payee at a time.
async function suggestSubcategoryWithAI(payee) {
  return api("/api/transactions/suggest-subcategory", {
    method: "POST",
    body: JSON.stringify({
      payee,
      lines: allLines().map((line) => ({ id: line.id, label: `${line.category} - ${line.name}` }))
    })
  });
}

// Same AI fallback pattern as suggestSubcategoryWithAI, for which Wealth
// account a payee belongs to - deliberately a separate call/button (not
// bundled into the subcategory suggestion) since the two questions are
// independent and a household may only need one or the other.
async function suggestAccountWithAI(payee) {
  return api("/api/transactions/suggest-account", {
    method: "POST",
    body: JSON.stringify({
      payee,
      accounts: state.accounts.filter((account) => !account.closedAt).map((account) => ({ id: account.id, label: account.type ? `${account.name} (${account.type})` : account.name }))
    })
  });
}

function allTransactionTagLabels() {
  return groupTransactionsByTag(state.transactions).map((group) => group.label);
}

// Shared by the Ledger and Bank stream rows: a full-width row of its own
// (not squeezed into a shared grid/flex column) so a transaction can carry
// several chips plus an inline add-input with real room to breathe.
// removeAttr/addAttr are dataset attribute names, keyed by `ref` (a ledger
// row's index, or a bank stream draft's id) - the add-tag handler reads the
// ref straight off the input, and the remove-chip handler reads which exact
// tag to drop off the chip's own data-tag attribute instead of encoding it
// into the dataset value, so a tag containing ":" or other punctuation is
// never at risk of being mis-parsed.
function tagChipsHtml(tags, removeAttr, addAttr, ref) {
  const chips = (tags || []).map((tag) => `
    <span class="tag-chip" data-tag="${escapeHtml(tag)}">
      ${escapeHtml(tag)}
      <button type="button" class="tag-chip-remove" ${removeAttr}="${ref}" aria-label="Remove tag ${escapeHtml(tag)}">×</button>
    </span>`).join("");
  return `
    <div class="tag-chip-row">
      ${chips}
      <input class="tag-chip-input" list="transactionTagOptions" placeholder="+ Add tag" ${addAttr}="${ref}">
    </div>`;
}

// Unlike allLines(), which copies each line ({ ...line, ... }) to attach its
// parent category's name/color, this returns the live line object itself so
// callers can mutate it (e.g. setting .planned) and have it stick.
function findLineById(lineId) {
  for (const category of state.budget.categories) {
    const line = category.lines.find((item) => item.id === lineId);
    if (line) return line;
  }
  return null;
}

function lineName(lineId) {
  const line = allLines().find((item) => item.id === lineId);
  if (line) return line.name;
  // A paycheck's bill assignment survives into every month (even ones whose
  // own categories don't happen to carry that exact line id — e.g. a month
  // snapshotted before categories started carrying forward automatically),
  // so fall back to any earlier saved month that still has it rather than
  // showing the raw internal id.
  for (const budget of state.budgetHistory || []) {
    const historicalLine = (budget.categories || []).flatMap((category) => category.lines || []).find((item) => item.id === lineId);
    if (historicalLine) return historicalLine.name;
  }
  return lineId;
}

function lineSnapshot(lineId) {
  const line = allLines().find((item) => item.id === lineId);
  return {
    categoryName: line?.category || "Deleted category",
    subcategoryName: line?.name || lineId || "Deleted subcategory"
  };
}

function transactionAssignmentLabel(transaction) {
  if (transaction.splits?.length) return `Split (${transaction.splits.length} categories)`;
  const liveLine = allLines().find((line) => line.id === transaction.lineId);
  const category = liveLine?.category || transaction.categoryName || "Deleted category";
  const subcategory = liveLine?.name || transaction.subcategoryName || transaction.lineId || "Deleted subcategory";
  return `${category} - ${subcategory}`;
}

// A split transaction has no single lineId of its own - each of its splits
// carries its own lineId instead - so anywhere that filters transactions "on
// line X" (Sankey drill-down, category report drill-down) needs to check
// every split's lineId, not just the transaction's own (empty) one.
function transactionHasLine(transaction, lineIds) {
  if (transaction.splits?.length) return transaction.splits.some((split) => lineIds.includes(split.lineId));
  return lineIds.includes(transaction.lineId);
}

function makeTransaction({ date, payee, amount, lineId, memo, accountId = "", orderNumber = "", tags = [] }) {
  return { date, payee, amount, lineId, memo, accountId, orderNumber, tags, ...lineSnapshot(lineId) };
}

// Shared by every place a tags input gets saved (add-transaction form, ledger
// row, bank stream row) - a plain comma-separated text field is the simplest
// entry point, split/trimmed into the array the rest of the app works with.
function parseTagsInput(value) {
  return String(value || "").split(",").map((tag) => tag.trim()).filter(Boolean);
}

// Used by the chip "+ Add tag" inputs: appends one or more comma-separated
// tags to an existing list, skipping any that already match case/whitespace
// insensitively (normalizeTag) - typing "florida trip" again when "Florida
// trip" is already a chip shouldn't add a visually-duplicate second chip.
function addTagsDeduped(existingTags, value) {
  const tags = [...(existingTags || [])];
  parseTagsInput(value).forEach((tag) => {
    const key = normalizeTag(tag);
    if (!tags.some((existing) => normalizeTag(existing) === key)) tags.push(tag);
  });
  return tags;
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

// Everything that would be orphaned (or silently left pointing at a dead
// id) by deleting the given subcategory/subcategories: real ledger
// transactions, recurring bills, anything linked from Wealth (a debt
// tracked against this line), unaccepted Bank Stream drafts already
// assigned to it, paychecks with money allocated to it, and this month's
// own planned budget amount - a line can have real money budgeted against
// it with zero transactions yet (nothing to "link" at all), which would
// otherwise delete with no warning and just silently vanish.
// Used to decide whether a delete needs confirmation at all, and what to
// show in that confirmation.
function budgetDeletionImpact(lineIds) {
  const lineIdSet = new Set(lineIds);
  const plannedAmount = allLines()
    .filter((line) => lineIdSet.has(line.id))
    .reduce((sum, line) => sum + Number(line.planned || 0), 0);
  return {
    transactions: state.transactions.filter((transaction) => lineIdSet.has(transaction.lineId)),
    recurringExpenses: state.recurringExpenses.filter((recurring) => lineIdSet.has(recurring.lineId)),
    debts: state.goals.debts.filter((debt) => lineIdSet.has(debt.lineId)),
    drafts: (state.transactionInboxDrafts || []).filter((draft) => lineIdSet.has(draft.lineId)),
    paychecks: state.paychecks.filter((paycheck) => (paycheck.assignedLineIds || []).some((id) => lineIdSet.has(id))),
    plannedAmount
  };
}

// Deletes with nothing linked to them go through immediately - the dialog
// only interrupts when there's something the household would otherwise lose
// track of. `perform` is the actual splice (category or single line),
// deferred until the user confirms (or is skipped straight through here).
function openDeleteBudgetLineDialog({ title, lineIds, perform }) {
  const impact = budgetDeletionImpact(lineIds);
  const totalImpacted = impact.transactions.length + impact.recurringExpenses.length + impact.debts.length + impact.drafts.length + impact.paychecks.length + (impact.plannedAmount > 0 ? 1 : 0);
  if (totalImpacted === 0) {
    perform();
    render();
    return;
  }
  pendingBudgetLineDeletion = { lineIds, perform };
  const summaryParts = [];
  if (impact.plannedAmount > 0) summaryParts.push(`${money.format(impact.plannedAmount)} planned this month`);
  if (impact.transactions.length) summaryParts.push(`${impact.transactions.length} transaction${impact.transactions.length === 1 ? "" : "s"}`);
  if (impact.drafts.length) summaryParts.push(`${impact.drafts.length} Bank Stream draft${impact.drafts.length === 1 ? "" : "s"}`);
  if (impact.recurringExpenses.length) summaryParts.push(`${impact.recurringExpenses.length} recurring bill${impact.recurringExpenses.length === 1 ? "" : "s"}`);
  if (impact.debts.length) summaryParts.push(`${impact.debts.length} item${impact.debts.length === 1 ? "" : "s"} in Wealth`);
  if (impact.paychecks.length) summaryParts.push(`${impact.paychecks.length} paycheck${impact.paychecks.length === 1 ? "" : "s"}`);
  $("#deleteBudgetLineTitle").textContent = title;
  $("#deleteBudgetLineSummary").textContent = `${summaryParts.join(", ")} still linked to this. Reassign them below, or leave them unassigned.`;
  const listSections = [];
  if (impact.plannedAmount > 0) {
    listSections.push(`<div class="delete-budget-line-impact-group"><h4>Budget</h4><ul><li>${money.format(impact.plannedAmount)} planned this month, not yet spent</li></ul></div>`);
  }
  if (impact.transactions.length) {
    const shown = impact.transactions.slice(0, 15);
    listSections.push(`<div class="delete-budget-line-impact-group"><h4>Transactions</h4><ul>${shown.map((transaction) => `<li>${escapeHtml(transaction.payee)} — ${exactMoney.format(transaction.amount)} on ${formatShortDate(transaction.date)}</li>`).join("")}${impact.transactions.length > shown.length ? `<li>+${impact.transactions.length - shown.length} more</li>` : ""}</ul></div>`);
  }
  if (impact.drafts.length) {
    const shown = impact.drafts.slice(0, 15);
    listSections.push(`<div class="delete-budget-line-impact-group"><h4>Bank Stream</h4><ul>${shown.map((draft) => `<li>${escapeHtml(draft.payee)} — ${exactMoney.format(draft.amount)} on ${formatShortDate(draft.date)}</li>`).join("")}${impact.drafts.length > shown.length ? `<li>+${impact.drafts.length - shown.length} more</li>` : ""}</ul></div>`);
  }
  if (impact.recurringExpenses.length) {
    listSections.push(`<div class="delete-budget-line-impact-group"><h4>Recurring bills</h4><ul>${impact.recurringExpenses.map((recurring) => `<li>${escapeHtml(recurring.payee)} — ${exactMoney.format(recurring.amount)}</li>`).join("")}</ul></div>`);
  }
  if (impact.debts.length) {
    listSections.push(`<div class="delete-budget-line-impact-group"><h4>Wealth</h4><ul>${impact.debts.map((debt) => `<li>${escapeHtml(debt.name)}</li>`).join("")}</ul></div>`);
  }
  if (impact.paychecks.length) {
    listSections.push(`<div class="delete-budget-line-impact-group"><h4>Paycheck/Income</h4><ul>${impact.paychecks.map((paycheck) => `<li>${escapeHtml(paycheck.name)}</li>`).join("")}</ul></div>`);
  }
  $("#deleteBudgetLineImpactList").innerHTML = listSections.join("");
  const excludeSet = new Set(lineIds);
  const otherLines = allLines().filter((line) => !excludeSet.has(line.id));
  $("#deleteBudgetLineReassignSelect").innerHTML = `<option value="">Leave unassigned</option>${otherLines.map((line) => `<option value="${line.id}">${escapeHtml(line.category)} - ${escapeHtml(line.name)}</option>`).join("")}`;
  $("#deleteBudgetLineDialog").showModal();
}

function plannedTotal() {
  return allLines().reduce((sum, line) => sum + Number(line.planned || 0), 0);
}

function budgetIncomeFromPaychecks() {
  const monthStart = `${state.budget.month}-01`;
  const monthEnd = monthEndDateKey(state.budget.month);
  const oneTimeIncome = state.paychecks
    .filter((paycheck) => ["once", "bonus"].includes(paycheck.recurrence || "once"))
    .reduce((sum, paycheck) => sum + Number(paycheck.amount || 0) * paycheckOccurrencesInRange(paycheck, monthStart, monthEnd), 0);
  const recurringIncome = (state.paycheckOccurrences || [])
    .filter((occurrence) => occurrence.date >= monthStart && occurrence.date <= monthEnd)
    .reduce((sum, occurrence) => sum + Number(occurrence.amount || 0), 0);
  return oneTimeIncome + recurringIncome;
}

function paycheckAssignedAmount(paycheck) {
  return paycheck.assignedLineIds.reduce((sum, id) => sum + (allLines().find((line) => line.id === id)?.planned || 0), 0);
}

// How much of this paycheck actually lands in the currently viewed budget
// month — not just its flat per-occurrence amount — so a paycheck past its
// end date (or simply not due this month) correctly shows $0 instead of the
// series' amount forever.
function paycheckMonthlyIncome(paycheck) {
  const monthStart = `${state.budget.month}-01`;
  const monthEnd = monthEndDateKey(state.budget.month);
  const isRecurring = !["once", "bonus"].includes(paycheck.recurrence || "once");
  if (isRecurring) {
    return (state.paycheckOccurrences || [])
      .filter((occurrence) => occurrence.seriesId === paycheck.id && occurrence.date >= monthStart && occurrence.date <= monthEnd)
      .reduce((sum, occurrence) => sum + Number(occurrence.amount || 0), 0);
  }
  return Number(paycheck.amount || 0) * paycheckOccurrencesInRange(paycheck, monthStart, monthEnd);
}

// Whether this paycheck is still a live income source for the given month —
// a one-time/bonus paycheck only counts in the month it lands, and a
// recurring one drops out once its end date falls before that month (or it
// hasn't started yet), so an ended series stops showing up as active income.
function paycheckActiveInMonth(paycheck, monthStart, monthEnd) {
  const isRecurring = !["once", "bonus"].includes(paycheck.recurrence || "once");
  if (!isRecurring) return paycheckOccurrencesInRange(paycheck, monthStart, monthEnd) > 0;
  if (!paycheck.date || paycheck.date > monthEnd) return false;
  if (paycheck.endDate && paycheck.endDate < monthStart) return false;
  return true;
}

// Same idea as paycheckActiveInMonth: a recurring bill drops out of the
// Recurring bills list once its end date falls before the month being
// viewed (or it hasn't started yet), instead of listing every recurring
// bill ever created regardless of whether it still applies.
function recurringExpenseActiveInMonth(recurring, monthStart, monthEnd) {
  if (!recurring.anchorDate || recurring.anchorDate > monthEnd) return false;
  if (recurring.endDate && recurring.endDate < monthStart) return false;
  return true;
}

function spentByLine(lineId) {
  return spentByLineInMonth(state.transactions, lineId, state.budget.month);
}

function spentTotal() {
  return state.transactions
    .filter((transaction) => transaction.date?.slice(0, 7) === state.budget.month)
    .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
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

// The Bills page is a dedicated view over the exact same recurring budget
// lines Home's "Bills & Goals" card and the Paycheck page's Due-date flow
// already read (allLines() + dueDay + spentByLine) - not a second, separate
// place to enter bills - so "paid" here is the same signal those use: real
// spending against the line, or a manual dismiss via the shared
// dismissedReminders/"bill:<id>" mechanism (the same "Done" a household
// already uses on Home). Marking a bill paid here also clears it from
// Home's reminder list, and vice versa, since it's the same underlying id.
function billsRows() {
  const dismissed = state.budget.dismissedReminders?.[state.budget.month] || [];
  return allLines()
    .filter((line) => line.dueDay)
    .map((line) => {
      const spent = spentByLine(line.id);
      const planned = Number(line.planned || 0);
      const paid = spent >= planned || dismissed.includes(`bill:${line.id}`);
      const frequency = line.recurringBill?.enabled && recurringBudgetFrequencyMonths[line.recurringBill.frequency]
        ? line.recurringBill.frequency
        : "monthly";
      return {
        id: line.id,
        name: line.name,
        category: line.category,
        color: line.color,
        planned,
        dueDay: line.dueDay,
        frequency,
        paid
      };
    })
    .sort((a, b) => a.dueDay - b.dueDay);
}

function remainingTotal() {
  return state.budget.income - spentTotal();
}

function netWorth() {
  const assets = state.goals.netWorth.assets.reduce((sum, item) => sum + assetValue(item), 0);
  const liabilities = state.goals.netWorth.liabilities.reduce((sum, item) => sum + Number(item.value || 0), 0);
  return { assets, liabilities, total: assets - liabilities };
}

// Converts using a real fetched rate (see /api/fx-rates) - falls back to
// the plain USD formatter whenever a rate isn't loaded yet, rather than
// guessing at a conversion. This only reformats the Wealth net-worth
// strip's headline numbers, not every dollar amount on the page - a
// deliberately smaller scope than converting every account/holding row.
function wealthMoney(amount) {
  if (wealthCurrency === "USD" || !wealthFxRates?.[wealthCurrency]) return money.format(amount);
  const converted = amount * wealthFxRates[wealthCurrency];
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: wealthCurrency }).format(converted);
  } catch (_error) {
    return money.format(amount);
  }
}

async function setWealthCurrency(currency) {
  wealthCurrency = currency;
  if (currency !== "USD" && !wealthFxRates && !wealthFxLoading) {
    wealthFxLoading = true;
    try {
      const response = await api("/api/fx-rates");
      wealthFxRates = response.rates;
    } catch (error) {
      console.warn("Failed to load exchange rates", error);
    } finally {
      wealthFxLoading = false;
    }
  }
  if (currentView === "wealth") render();
}

function refreshNetWorthTotals() {
  const totals = netWorth();
  const total = document.querySelector("[data-net-worth-total]");
  const assets = document.querySelector("[data-net-worth-assets]");
  const liabilities = document.querySelector("[data-net-worth-liabilities]");
  if (total) total.textContent = wealthMoney(totals.total);
  if (assets) assets.textContent = wealthMoney(totals.assets);
  if (liabilities) liabilities.textContent = wealthMoney(totals.liabilities);

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

function transactionSignature(transaction) {
  return `${transaction.date}|${transaction.amount}`;
}

// The shared interest/principal math behind every debt payment, however it
// was triggered (the "Record EMI payment" button, or a Ledger transaction
// posted to the debt's linked subcategory) — one formula, so the two can
// never compute a payoff differently.
function applyDebtPayment(debt, rawAmount, date) {
  if (!debt.balance) return null;
  const interest = Math.min(debt.balance, (debt.balance * Math.max(0, Number(debt.rate || 0))) / 1200);
  const amount = Math.min(debt.balance + interest, Math.max(0, Number(rawAmount || 0)));
  const principal = Math.max(0, amount - interest);
  debt.balance = Math.max(0, debt.balance - principal);
  const payment = { id: uniqueId("payment"), date, amount, principal, interest, extra: 0, balance: debt.balance };
  debt.payments ||= [];
  debt.payments.unshift(payment);
  const liability = liabilityForDebt(debt);
  if (liability) liability.value = debt.balance;
  return payment;
}

// A debt linked to a budget subcategory (debt.lineId) auto-applies any
// Ledger transaction posted there as an EMI payment, instead of requiring
// the "Record EMI payment" button every time — including transactions that
// already existed at the moment you linked it (e.g. an EMI you'd been
// posting to the Ledger for months before ever setting up the debt
// tracker), so linking a debt catches it up immediately rather than only
// counting payments from that point forward. appliedPaymentSignatures still
// guards against re-applying the same transaction twice on a later render,
// and the "Record EMI payment" button marks its own created transaction the
// same way so the two paths never double-count each other.
function ensureDebtPaymentsAppliedFromLedger() {
  state.goals.debts.forEach((debt) => {
    if (!debt.lineId) return;
    debt.appliedPaymentSignatures ||= [];
    state.transactions
      .filter((transaction) => transaction.lineId === debt.lineId && !debt.appliedPaymentSignatures.includes(transactionSignature(transaction)))
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach((transaction) => {
        applyDebtPayment(debt, transaction.amount, transaction.date);
        debt.appliedPaymentSignatures.push(transactionSignature(transaction));
      });
  });
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
    account.closedAt ||= "";
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
    paycheckOccurrences: state.paycheckOccurrences,
    transfers: state.transfers,
    ious: state.ious || []
  }, dateKey(new Date()));
}

function accountName(accountId) {
  return state.accounts.find((account) => account.id === accountId)?.name || "";
}

// Everything referencing this account by id: real transactions, recurring
// bills, and paycheck deposits. Used to decide whether a rename/delete needs
// confirmation at all, and what to show in that confirmation.
function accountUsage(accountId) {
  return {
    transactions: state.transactions.filter((transaction) => transaction.accountId === accountId),
    recurringExpenses: (state.recurringExpenses || []).filter((recurring) => recurring.accountId === accountId),
    paychecks: state.paychecks.filter((paycheck) => paycheck.depositAccountId === accountId)
  };
}

// Shared confirmation for a wealth-account rename or delete that would
// otherwise silently touch real transactions/recurring bills/paycheck
// deposits linked to it. `reassignable` offers a "reassign to a different
// account" dropdown (delete); a rename never needs it since the account id
// itself never changes, so nothing linked to it is actually affected -
// this is confirmation for awareness, not data safety.
function openAccountActionConfirm({ title, summarySuffix, account, reassignable, confirmLabel, onConfirm, onCancel }) {
  const usage = accountUsage(account.id);
  const totalUsed = usage.transactions.length + usage.recurringExpenses.length + usage.paychecks.length;
  if (totalUsed === 0) {
    onConfirm("");
    return;
  }
  pendingAccountAction = { onConfirm, onCancel };
  const summaryParts = [];
  if (usage.transactions.length) summaryParts.push(`${usage.transactions.length} transaction${usage.transactions.length === 1 ? "" : "s"}`);
  if (usage.recurringExpenses.length) summaryParts.push(`${usage.recurringExpenses.length} recurring bill${usage.recurringExpenses.length === 1 ? "" : "s"}`);
  if (usage.paychecks.length) summaryParts.push(`${usage.paychecks.length} paycheck deposit${usage.paychecks.length === 1 ? "" : "s"}`);
  $("#accountActionConfirmTitle").textContent = title;
  $("#accountActionConfirmSummary").textContent = `${summaryParts.join(", ")} still linked to this account. ${summarySuffix}`;
  const listSections = [];
  if (usage.transactions.length) {
    const shown = usage.transactions.slice(0, 15);
    listSections.push(`<div class="delete-budget-line-impact-group"><h4>Transactions</h4><ul>${shown.map((transaction) => `<li>${escapeHtml(transaction.payee)} — ${exactMoney.format(transaction.amount)} on ${formatShortDate(transaction.date)}</li>`).join("")}${usage.transactions.length > shown.length ? `<li>+${usage.transactions.length - shown.length} more</li>` : ""}</ul></div>`);
  }
  if (usage.recurringExpenses.length) {
    listSections.push(`<div class="delete-budget-line-impact-group"><h4>Recurring bills</h4><ul>${usage.recurringExpenses.map((recurring) => `<li>${escapeHtml(recurring.payee)} — ${exactMoney.format(recurring.amount)}</li>`).join("")}</ul></div>`);
  }
  if (usage.paychecks.length) {
    listSections.push(`<div class="delete-budget-line-impact-group"><h4>Paycheck deposits</h4><ul>${usage.paychecks.map((paycheck) => `<li>${escapeHtml(paycheck.name)} — ${exactMoney.format(paycheck.amount)}</li>`).join("")}</ul></div>`);
  }
  $("#accountActionConfirmImpactList").innerHTML = listSections.join("");
  const reassignField = $("#accountActionReassignField");
  reassignField.hidden = !reassignable;
  if (reassignable) {
    const otherAccounts = state.accounts.filter((item) => item.id !== account.id);
    $("#accountActionReassignSelect").innerHTML = `<option value="">Leave unassigned</option>${otherAccounts.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("")}`;
  }
  const confirmButton = $("#confirmAccountActionConfirmButton");
  confirmButton.textContent = confirmLabel;
  confirmButton.className = reassignable ? "danger-button" : "";
  $("#accountActionConfirmDialog").showModal();
}

function transactionSortValue(transaction, field) {
  if (field === "amount") return Number(transaction.amount || 0);
  if (field === "date") return transaction.date || "";
  if (field === "subcategory") return lineName(transaction.lineId).toLowerCase();
  if (field === "account") return accountName(transaction.accountId).toLowerCase();
  return String(transaction.payee || "").toLowerCase();
}

function sortByTransactionField(entries, field, direction) {
  const sign = direction === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    const valueA = transactionSortValue(a.transaction, field);
    const valueB = transactionSortValue(b.transaction, field);
    if (valueA < valueB) return -sign;
    if (valueA > valueB) return sign;
    return 0;
  });
}

// Bank stream drafts are flat objects (unlike Recent transactions' {transaction,
// index} pairs, needed there only so edits can find their original array slot -
// Bank stream rows are already keyed by .id), so this sorts them directly with
// the same transactionSortValue used above.
function sortTransactionsByField(entries, field, direction) {
  const sign = direction === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    const valueA = transactionSortValue(a, field);
    const valueB = transactionSortValue(b, field);
    if (valueA < valueB) return -sign;
    if (valueA > valueB) return sign;
    return 0;
  });
}

// The little ▲/▼ next to whichever Recent transactions column is currently
// driving the sort, so it's clear both which field is active and which
// direction — otherwise clicking a header and seeing the list reorder gives
// no lasting indication of why.
function transactionSortIndicator(field) {
  if (transactionSort.field !== field) return "";
  return transactionSort.direction === "asc" ? " ▲" : " ▼";
}

// Same as transactionSortIndicator above, but for Bank stream's independent
// sort state.
function bankStreamSortIndicator(field) {
  if (bankStreamSort.field !== field) return "";
  return bankStreamSort.direction === "asc" ? " ▲" : " ▼";
}

function isAccountLinked(type, id) {
  return type === "asset"
    ? state.accounts.some((account) => account.netWorthAssetId === id)
    : state.accounts.some((account) => account.netWorthLiabilityId === id);
}

function accountOptions(selectedId, { excludeType } = {}) {
  return state.accounts
    .filter((account) => !excludeType || account.type !== excludeType)
    .map((account) => `<option value="${account.id}" ${account.id === selectedId ? "selected" : ""}>${escapeHtml(account.name)}${account.closedAt ? " (closed)" : ""}</option>`)
    .join("");
}

// A closed account can still take backdated entries (catching up on
// something missed before it was closed) but nothing dated after the
// close date - an unlinked accountId ("") is never restricted.
function accountAllowsDate(accountId, dateValue) {
  if (!accountId) return true;
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account?.closedAt) return true;
  return Boolean(dateValue) && dateValue <= account.closedAt;
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

function debtLineOptions(debt) {
  return [
    `<option value="">Not linked</option>`,
    ...allLines().map((line) =>
      `<option value="${line.id}" ${debt.lineId === line.id ? "selected" : ""}>${line.category} - ${line.name}</option>`
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
    .filter((budget) => budget.month < state.budget.month && Array.isArray(budget.categories) && budget.categories.length > 0)
    .sort((a, b) => b.month.localeCompare(a.month));
}

function ensureBudgetHistory() {
  state.budgetHistory ||= [];
}

function cloneBudgetCategories(categories) {
  return JSON.parse(JSON.stringify(categories)).map((category) => ({
    ...category,
    lines: category.lines.map((line) => ({ ...line }))
  }));
}

// Category and subcategory structure (name, color, due day, recurring bill
// config) is shared across every month — state.budget.categories is the one
// canonical list, never replaced wholesale. Only each line's planned amount
// is month-specific, so switching months / copying a budget only ever
// touches .planned, keyed by the line's stable id, never the line list
// itself. This is what makes a subcategory visible in every past and future
// month instead of only the months it happened to be saved under.
function plannedByLineIdFromSnapshot(snapshot) {
  const plannedByLineId = new Map();
  (snapshot?.categories || []).forEach((category) => {
    category.lines.forEach((line) => plannedByLineId.set(line.id, Number(line.planned || 0)));
  });
  return plannedByLineId;
}

function copyBudgetFromMonth(month) {
  const source = (state.budgetHistory || []).find((budget) => budget.month === month);
  if (!source) return;
  const plannedByLineId = plannedByLineIdFromSnapshot(source);
  state.budget.categories = state.budget.categories.map((category) => ({
    ...category,
    lines: category.lines.map((line) => ({ ...line, planned: plannedByLineId.has(line.id) ? plannedByLineId.get(line.id) : Number(line.planned || 0) }))
  }));
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

// One-time backfill for households that already had different category
// lists saved across different months before structure became shared:
// pulls in any category/line seen in budget history but missing from the
// live (canonical) list, so nothing that used to exist in some month
// disappears the first time this ships. Guarded so it only ever runs once
// per household — after that, deleting a subcategory should actually stick.
function ensureUnifiedBudgetTaxonomy() {
  if (state.budget.taxonomyUnified) return;
  state.budget.taxonomyUnified = true;
  const seenLineIds = new Set(allLines().map((line) => line.id));
  (state.budgetHistory || []).forEach((snapshot) => {
    (snapshot.categories || []).forEach((historyCategory) => {
      historyCategory.lines.forEach((historyLine) => {
        if (seenLineIds.has(historyLine.id)) return;
        seenLineIds.add(historyLine.id);
        let targetCategory = state.budget.categories.find((category) => category.name === historyCategory.name);
        if (!targetCategory) {
          targetCategory = { name: historyCategory.name, color: historyCategory.color, lines: [] };
          state.budget.categories.push(targetCategory);
        }
        targetCategory.lines.push({ ...historyLine, planned: 0 });
      });
    });
  });
}

// Shared by the month picker and anything else that needs to jump the whole
// app to a different month (e.g. accepting a bank stream item dated in a
// month other than the one currently being viewed) — snapshotting the
// month being left has to happen every time a switch occurs, not just from
// the picker.
function switchBudgetMonth(newMonth) {
  if (!newMonth || newMonth === state.budget.month) return;
  const previousMonth = state.budget.month;
  rememberCurrentBudgetSnapshot();
  state.budget.month = newMonth;
  state.budget.monthPreferenceSet = true;
  const existing = (state.budgetHistory || []).find((budget) => budget.month === newMonth);
  const carryForwardSource = existing || availablePreviousBudgets()[0];
  const plannedByLineId = plannedByLineIdFromSnapshot(carryForwardSource);
  // Rollover only applies the first time a new month is actually opened
  // (no snapshot yet, i.e. this isn't just re-visiting a month whose plan
  // was already saved/edited) - otherwise switching away and back would
  // silently keep adding the same leftover in again on every revisit.
  const isFreshMonth = !existing && carryForwardSource?.month === previousMonth;
  state.budget.categories = state.budget.categories.map((category) => ({
    ...category,
    lines: category.lines.map((line) => {
      const carriedPlanned = plannedByLineId.get(line.id) ?? 0;
      if (!isFreshMonth || !line.rolloverEnabled) return { ...line, planned: carriedPlanned, rolloverAmount: 0 };
      const previousPlanned = Number(carryForwardSource.categories.flatMap((c) => c.lines).find((l) => l.id === line.id)?.planned || 0);
      const previousSpent = spentByLineInMonth(state.transactions, line.id, previousMonth);
      const leftover = Math.max(0, Math.round((previousPlanned - previousSpent) * 100) / 100);
      return { ...line, planned: carriedPlanned + leftover, rolloverAmount: leftover };
    })
  }));
  state.budget.income = existing ? Number(existing.income || 0) : 0;
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

const recurringBudgetFrequencyLabels = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly"
};

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function dateKeyToMonthKey(value) {
  return String(value || "").slice(0, 7);
}

function dateFromDateKey(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKeyFromParts(year, monthIndex, day) {
  const firstOfTargetMonth = new Date(year, monthIndex, 1);
  const targetYear = firstOfTargetMonth.getFullYear();
  const targetMonthIndex = firstOfTargetMonth.getMonth();
  const lastDay = new Date(targetYear, targetMonthIndex + 1, 0).getDate();
  const clampedDay = Math.min(Math.max(1, Number(day || 1)), lastDay);
  return `${targetYear}-${String(targetMonthIndex + 1).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

function addMonthsToDateKey(value, months) {
  const date = dateFromDateKey(value);
  if (!date) return "";
  const targetMonthIndex = date.getMonth() + months;
  return dateKeyFromParts(date.getFullYear(), targetMonthIndex, date.getDate());
}

// A recurring reminder doesn't track a parallel per-occurrence completion
// map the way chores do - it just self-advances to its next due date and
// resets to not-done, the same one-shot-then-renew pattern recurring budget
// bills already use (nextRecurringBudgetDueDate) - simpler, and there's only
// ever one live occurrence of a reminder to show at a time anyway.
function advanceReminderDate(value, recurrence) {
  if (recurrence === "weekly") {
    const date = dateFromDateKey(value);
    if (!date) return value;
    date.setDate(date.getDate() + 7);
    return dateKey(date);
  }
  if (recurrence === "monthly") return addMonthsToDateKey(value, 1) || value;
  if (recurrence === "yearly") return addMonthsToDateKey(value, 12) || value;
  return value;
}

function nextRecurringBudgetDueDate(bill, selectedMonth = state.budget.month) {
  if (!bill?.dueDate || !selectedMonth) return "";
  const interval = recurringBudgetFrequencyMonths[bill.frequency] || 12;
  let cursor = validDateKey(bill.dueDate) ? bill.dueDate : `${selectedMonth}-01`;
  while (dateKeyToMonthKey(cursor).localeCompare(selectedMonth) < 0) {
    cursor = addMonthsToDateKey(cursor, interval);
  }
  return cursor;
}

function monthsUntilDueInclusive(selectedMonth, dueDateKey) {
  if (!selectedMonth || !dueDateKey) return 1;
  const [selectedYear, selectedMonthNumber] = selectedMonth.split("-").map(Number);
  const [dueYear, dueMonthNumber] = dateKeyToMonthKey(dueDateKey).split("-").map(Number);
  if (!selectedYear || !selectedMonthNumber || !dueYear || !dueMonthNumber) return 1;
  return Math.max(1, (dueYear - selectedYear) * 12 + (dueMonthNumber - selectedMonthNumber) + 1);
}

function recurringBudgetSetAside(bill, selectedMonth = state.budget.month) {
  const frequency = recurringBudgetFrequencyMonths[bill?.frequency] ? bill.frequency : "yearly";
  const amountDue = Math.max(0, Number(bill?.amount || 0));
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

function applyRecurringBudgetToLine(line) {
  if (!line?.recurringBill?.enabled) return null;
  const summary = recurringBudgetSetAside(line.recurringBill);
  line.recurringBill.amount = summary.amountDue;
  line.recurringBill.frequency = summary.frequency;
  line.recurringBill.dueDate = summary.nextDueDate || line.recurringBill.dueDate || `${state.budget.month}-01`;
  line.planned = summary.monthlyAmount;
  line.dueDay = summary.nextDueDate?.startsWith(`${state.budget.month}-`) ? Number(summary.nextDueDate.slice(-2)) : null;
  return summary;
}

function ensureRecurringBudgetBills() {
  // The sinking-fund set-aside amount is a live plan for "how much to save
  // starting now" - only ever recomputed for the real current month and
  // months after it. A month that has already happened is closed history:
  // re-deriving its planned amount from today's due date would retroactively
  // invent a savings target for a month that had already passed (or, for a
  // brand-new recurring bill, a month before the bill even existed).
  const isPastMonth = state.budget.month < dateKey(new Date()).slice(0, 7);
  state.budget.categories.forEach((category) => {
    category.lines.forEach((line) => {
      if (!line.recurringBill?.enabled) return;
      if (!validDateKey(line.recurringBill.dueDate)) {
        line.recurringBill.dueDate = dueDateValue(line.dueDay) || `${state.budget.month}-01`;
      }
      if (!recurringBudgetFrequencyMonths[line.recurringBill.frequency]) line.recurringBill.frequency = "yearly";
      if (!Number.isFinite(Number(line.recurringBill.amount))) line.recurringBill.amount = Number(line.planned || 0);
      if (isPastMonth) return;
      applyRecurringBudgetToLine(line);
    });
  });
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

// The 📅 emoji glyph is baked into the font — it can't show a real date, so
// the Calendar nav item gets its own small live tear-off-calendar icon (day
// of month) built from the actual current date instead. No month text: a
// 3-letter month abbreviation has no font size that reads cleanly in a 20px
// badge across browsers/displays — it rendered as illegible noise on at
// least one real device even though it looked fine here. A plain color
// strip carries the same "tear-off calendar" look without that risk, and
// the full date is still available via the title tooltip.
function calendarNavIconHtml() {
  const now = new Date();
  const fullLabel = now.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return `<span class="nav-calendar-icon" aria-hidden="true" title="${fullLabel}"><span class="nav-calendar-icon-day">${now.getDate()}</span></span>`;
}

// Mocked-up counts kept intentionally small in scope: unpaid-and-due-soon
// bills, and Bank Stream rows still waiting for review. Both are cheap to
// derive from data already loaded for other views, so no new state needed.
function navBadgeCounts() {
  if (!state) return {};
  const bills = billsRows().filter((bill) => !bill.paid).length;
  const transactions = transactionInboxItems().filter((transaction) => !(state.transactionInboxDone || []).includes(transaction.id)).length;
  return { bills, transactions };
}

// Same overdue-items + open-bills data Home's own status line already
// summarizes (see renderShell's homeStatusLine block) - the bell just makes
// it reachable from every view instead of only from Home.
function notificationBellItems() {
  if (!state) return [];
  const overdueItems = homeActionItems().filter((item) => item.overdue).map((item) => ({
    title: item.title,
    detail: `${item.kind} · Past due`,
    view: "home"
  }));
  const openBills = billsRows().filter((bill) => !bill.paid).map((bill) => ({
    title: bill.name,
    detail: `Bill · Due day ${bill.dueDay}`,
    view: "bills"
  }));
  return [...overdueItems, ...openBills];
}

function renderNotificationBell() {
  const items = notificationBellItems();
  $("#notificationBellDot").hidden = items.length === 0;
  $("#notificationBellDropdown").innerHTML = `
    <div class="notification-bell-header">Notifications</div>
    ${items.length ? items.map((item) => `
      <button type="button" class="notification-bell-item" data-notification-bell-goto="${item.view}">
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.detail)}</small>
      </button>
    `).join("") : `<div class="notification-bell-empty">Nothing needs attention.</div>`}
  `;
}

function renderNav() {
  const badgeCounts = navBadgeCounts();
  nav.innerHTML = views.filter(([key]) => key !== "admin" || sessionUser?.isAdmin).map(([key, label, icon]) => {
    // Bills' count is genuinely urgent (unpaid money owed), so it keeps the
    // coral/red treatment; transactions' count is just "items to review" -
    // informational, not a problem - so it gets a neutral gray badge instead
    // of reading as an alarm.
    const badge = badgeCounts[key] ? `<span class="nav-badge${key === "transactions" ? " nav-badge-neutral" : ""}">${badgeCounts[key] > 99 ? "99+" : badgeCounts[key]}</span>` : "";
    return `
    <button class="nav-button ${key === currentView ? "active" : ""}" data-view="${key}" type="button">
      <span>${key === "calendar" ? calendarNavIconHtml() : icon}</span>${label}${badge}
    </button>
  `;
  }).join("");
}

// Mirrors #nav's active-state logic for the fixed bottom tab bar shown on
// narrow viewports (see styles.css's 760px breakpoint) - "More" opens the
// existing sidebar as a slide-in drawer instead of duplicating its full nav
// list, so it lights up whenever the current view isn't one of the 4 tabs
// that got their own direct button.
function renderMobileTabBar() {
  const tabBar = $("#mobileTabBar");
  tabBar.hidden = false;
  const primaryViews = ["home", "budget", "transactions", "wealth"];
  tabBar.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === currentView);
  });
  $("#mobileMoreButton").classList.toggle("active", !primaryViews.includes(currentView));
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
  const isIousView = currentView === "ious";
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
                      : isIousView
                        ? "Shared expenses & debts"
                        : isProfileView
                          ? "Your profile"
                          : isHomeView
                            ? "Home"
          : `${monthLabel()} plan`;
  $("#householdName").textContent = title.toUpperCase();
  $("#homeStatusLine").hidden = !isHomeView;
  $("#viewOnlyBanner").hidden = sessionUser?.accessLevel !== "view";
  if (isHomeView) {
    const firstName = (sessionUser?.name || "there").trim().split(" ")[0];
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    $("#householdName").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }).toUpperCase();
    $("#viewTitle").textContent = `Good ${timeOfDay}, ${firstName}`;
    const pastDue = homeActionItems().filter((item) => item.overdue).length;
    const dueToday = homeActionItems().length - pastDue;
    const openBillsAndGoals = billAndGoalReminders().length;
    const totalOpen = pastDue + dueToday + openBillsAndGoals;
    $("#homeStatusLine").textContent = totalOpen === 0 ? "You're all caught up — nothing needs attention today." : `${totalOpen} thing${totalOpen === 1 ? "" : "s"} need your attention today.`;
  }
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
  $(".month-control").hidden = isAdminView || isNotesView || isHelpView || isRecipesView || isGoalsView || isWealthView || isJournalView || isPlanView || isDocumentsView || isDecisionsView || isIousView || isProfileView || isHomeView;
  $("#syncButton").hidden = isAdminView || isHelpView;
  $("#downloadCsvButton").hidden = isAdminView || isNotesView || isHelpView || isJournalView || isPlanView || isDocumentsView || isDecisionsView || isIousView || isProfileView || isHomeView;
  renderNav();
  renderMobileTabBar();
  renderNotificationBell();
  const metrics = metricsForView();
  $("#metrics").hidden = metrics.length === 0;
  $("#metrics").innerHTML = metrics.map(([label, value, note, state]) => `
    <article class="metric${state ? ` metric-${state}` : ""}">
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
    const allCaughtUp = pastDue + dueToday + openBillsAndGoals === 0;
    return [
      ["Past due", String(pastDue), "chores, birthdays and reminders", pastDue ? "danger" : "neutral"],
      ["Due today", String(dueToday), "needs action today", dueToday ? "warning" : "neutral"],
      ["Bills & goals", String(openBillsAndGoals), "still open", "neutral"],
      ["All caught up", allCaughtUp ? "Yes" : "Not yet", "across the household", allCaughtUp ? "good" : "neutral"]
    ];
  }
  if (currentView === "calendar") {
    const annualEventsThisMonth = annualEventOccurrencesForMonth().length;
    return [["Chore rotation", String(state.calendar.chores.length), "household chores"], ["Birthdays & anniversaries", String(annualEventsThisMonth), `annual events in ${monthLabel()}`], [`${monthLabel()} events`, String(upcoming), "chores, birthdays, anniversaries and reminders"], ["Shared calendar", "Household", "tasks in every member"]];
  }
  if (currentView === "ious") {
    ensureIOUsData();
    const active = state.ious.filter((iou) => !iou.settled);
    const youOweTotal = active.filter((iou) => iou.direction === "i_owe").reduce((sum, iou) => sum + Number(iou.amount || 0), 0);
    const owedToYouTotal = active.filter((iou) => iou.direction === "owed_to_me").reduce((sum, iou) => sum + Number(iou.amount || 0), 0);
    return [["You owe", money.format(youOweTotal), "to pay back"], ["Owed to you", money.format(owedToYouTotal), "coming back to you"], ["Net", money.format(owedToYouTotal - youOweTotal), "owed to you minus what you owe"], ["Open items", String(active.length), "not yet settled"]];
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
  if (currentView === "reports") return [["Spending", money.format(spentTotal()), "posted transactions"], ["Budget health", money.format(margin), "zero balance target"], ["Net worth", money.format(netWorth().total), "current estimate"], ["Cash left", money.format(remainingTotal()), "after ledger"]];
  if (currentView === "bills") {
    const bills = billsRows();
    const unpaid = bills.filter((bill) => !bill.paid);
    const dueSoon = unpaid.filter((bill) => bill.dueDay <= new Date().getDate() + 7);
    const monthlyTotal = bills.filter((bill) => bill.frequency === "monthly").reduce((sum, bill) => sum + bill.planned, 0);
    const totalDue = bills.reduce((sum, bill) => sum + bill.planned, 0);
    const paidCount = bills.length - unpaid.length;
    return [
      ["Due this week", String(dueSoon.length), dueSoon.length ? dueSoon.map((bill) => bill.name).join(", ") : "nothing due soon"],
      ["Monthly recurring", money.format(monthlyTotal), `${bills.filter((bill) => bill.frequency === "monthly").length} bills`],
      ["Total due", money.format(totalDue), `${bills.length} bills this month`],
      ["Paid this cycle", String(paidCount), `of ${bills.length} total`]
    ];
  }
  if (currentView === "goals") return [["Active goals", String(state.goals.sinkingFunds.length), "sinking funds"], ["Saved", money.format(state.goals.sinkingFunds.reduce((sum, fund) => sum + fund.saved, 0)), "across goals"], ["Remaining", money.format(state.goals.sinkingFunds.reduce((sum, fund) => sum + fund.target - fund.saved, 0)), "to targets"]];
  if (currentView === "wealth") return [["Assets", money.format(netWorth().assets), "tracked"], ["Liabilities", money.format(netWorth().liabilities), "tracked"], ["Net worth", money.format(netWorth().total), "current estimate"], ["Debt accounts", String(state.goals.debts.length), "payoff plan"]];
  if (currentView === "admin") return [];
  return [["Income", money.format(state.budget.income), "ready to assign"], ["Assigned", money.format(plannedTotal()), "planned this month"], ["Available", money.format(state.budget.income - plannedTotal()), "left to budget"], ["Overdue", money.format(0), "no urgent items"]];
}

// Pushes (or replaces, on the very first call) a browser history entry
// whenever the visible view actually changes, so the back/forward buttons
// step through in-app views instead of leaving the SPA entirely — plain
// currentView reassignment never touched browser history on its own.
function syncHistoryToView() {
  if (history.state?.view === currentView) return;
  const method = history.state?.view ? "pushState" : "replaceState";
  history[method]({ view: currentView }, "", `#${currentView}`);
}

function render() {
  if (!state) return;
  // Captured once per household so the server can format reminder-email due
  // times in the household's own timezone instead of the server container's
  // (see notificationCandidates/formatDueLabel in server/index.js).
  state.household.timeZone ||= Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (currentView === "admin" && !sessionUser?.isAdmin) currentView = "home";
  ensureUnifiedBudgetTaxonomy();
  ensureRecurringBudgetBills();
  ensurePaycheckRecurrenceData();
  ensurePaycheckOccurrencesGenerated();
  ensureGoalAutoContributions();
  ensureIOUsData();
  ensureFriendsData();
  state.budget.income = budgetIncomeFromPaychecks();
  syncHistoryToView();
  if (currentView === "wealth") { ensureDebtNetWorthSync(); ensureAccountsData(); ensureDebtPaymentsAppliedFromLedger(); }
  renderShell();
  view.innerHTML = (renderers[currentView] || renderers.budget)();
  bindViewEvents();
  if (currentView === "admin" && !adminData) loadAdminData();
  if (["documents", "wealth"].includes(currentView) && !documentsData) loadDocumentsData();
  if (["sharing", "calendar"].includes(currentView) && !sharingAccess) loadSharingAccess();
  if (currentView === "calendar" && sharedCalendarMembers.length === 0) loadCalendarMembers();
  if (!onboardingAutoShown && shouldShowOnboarding()) {
    onboardingAutoShown = true;
    onboardingStep = 1;
    renderOnboardingWizard();
    $("#onboardingWizardDialog").showModal();
  }
  autosaveState();
}

const renderers = {
  home: renderHome,
  budget: renderBudget,
  bills: renderBills,
  transactions: renderTransactions,
  paychecks: renderPaychecks,
  calendar: renderCalendar,
  notes: renderNotes,
  journal: renderJournal,
  plan: renderPlan,
  documents: renderDocuments,
  decisions: renderDecisions,
  ious: renderIOUs,
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

// A 7-day forward strip merging chores, birthdays/anniversaries, reminders,
// and bills into one day-by-day view - each item appears on its single
// next-due date, same semantics as homeActionItems()/the Calendar side
// panels use everywhere else, just bucketed by day instead of listed flat.
function homeWeekStrip() {
  ensureChoreRecurrenceData();
  ensureAnnualEventRecurrenceData();
  const viewerKey = sessionUser?.email || "";
  const today = new Date();
  const days = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    days.push({ dateKey: dateKey(date), label: date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }), items: [] });
  }
  const dayIndex = new Map(days.map((day) => [day.dateKey, day]));

  state.calendar.chores.forEach((chore) => {
    const occurrence = nextPendingChoreOccurrence(chore, viewerKey);
    if (occurrence && dayIndex.has(occurrence.date) && isRelevantToViewer(chore.assignees, viewerKey)) {
      dayIndex.get(occurrence.date).items.push({ title: chore.title, icon: "🧹" });
    }
  });
  state.calendar.events.filter((event) => ANNUAL_EVENT_TYPES.includes(event.type)).forEach((event) => {
    const occurrence = nextPendingAnnualEventOccurrence(event, new Date(), viewerKey);
    if (occurrence && dayIndex.has(occurrence.date) && isRelevantToViewer(event.assignees, viewerKey)) {
      dayIndex.get(occurrence.date).items.push({ title: annualEventDisplayTitle(event), icon: event.type === "birthday" ? "🎂" : "💍" });
    }
  });
  state.calendar.events.filter((event) => event.type === "reminder" && event.date).forEach((event) => {
    if (isReminderPendingFor(event, viewerKey) && dayIndex.has(event.date) && isRelevantToViewer(event.assignees, viewerKey)) {
      dayIndex.get(event.date).items.push({ title: event.title, icon: "⏰" });
    }
  });
  billsRows().forEach((bill) => {
    if (bill.paid) return;
    const dueKey = dateKey(new Date(today.getFullYear(), today.getMonth(), bill.dueDay));
    if (dayIndex.has(dueKey)) dayIndex.get(dueKey).items.push({ title: bill.name, icon: "🧾" });
  });

  return days;
}

// Combines the entities that carry a real timestamp already (notes,
// decisions, settled IOUs) into one reverse-chronological feed. Bill
// payments aren't included - dismissedReminders only tracks *which* bills
// are marked paid this month, not *when*, so adding them here would mean
// fabricating a timestamp that doesn't exist.
function homeRecentActivity(limit = 8) {
  ensureNotesData();
  const notesActivity = state.notes.entries
    .filter((note) => !note.trashed && note.createdAt)
    .map((note) => ({ at: note.createdAt, title: note.title || "Untitled note", detail: "Note added", icon: "📝" }));
  const decisionsActivity = (state.decisions || []).flatMap((decision) => {
    const rows = [];
    if (decision.createdAt) rows.push({ at: decision.createdAt, title: decision.title || "Untitled decision", detail: "Decision raised", icon: "⚖️" });
    if (decision.decidedAt) rows.push({ at: decision.decidedAt, title: decision.title || "Untitled decision", detail: "Decision made", icon: "⚖️" });
    return rows;
  });
  const iouActivity = (state.ious || [])
    .filter((iou) => iou.settled && iou.settledDate)
    .map((iou) => ({ at: iou.settledDate, title: `Settled with ${iou.person}`, detail: money.format(iou.amount || 0), icon: "💸" }));
  return [...notesActivity, ...decisionsActivity, ...iouActivity]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

// Global search - combines transactions, notes, documents, and decisions
// into one flat list, each result carrying just enough to jump to the
// right screen. Documents are searched only if already loaded (see
// loadDocumentsData) - the search dialog triggers that load on open so
// results are complete even if the viewer hasn't visited Documents yet.
function globalSearchResults(query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (normalized.length < 2) return [];
  const results = [];

  state.transactions.forEach((transaction) => {
    if (String(transaction.payee || "").toLowerCase().includes(normalized)) {
      results.push({ type: "Transaction", icon: "💳", title: transaction.payee, detail: `${money.format(transaction.amount)} · ${formatShortDate(transaction.date)}`, view: "transactions" });
    }
  });

  (state.notes?.entries || []).forEach((note) => {
    if (note.trashed) return;
    const haystack = `${note.title || ""} ${note.body || ""}`.toLowerCase();
    if (haystack.includes(normalized)) {
      results.push({ type: "Note", icon: "📝", title: note.title || "Untitled note", detail: (note.body || "").slice(0, 60), view: "notes" });
    }
  });

  (documentsData?.documents || []).forEach((document) => {
    if (String(document.name || "").toLowerCase().includes(normalized)) {
      results.push({ type: "Document", icon: "📁", title: document.name, detail: "Document", view: "documents" });
    }
  });

  (state.decisions || []).forEach((decision) => {
    if (String(decision.title || "").toLowerCase().includes(normalized)) {
      results.push({ type: "Decision", icon: "⚖️", title: decision.title, detail: decision.decidedAt ? "Decided" : "Open", view: "decisions" });
    }
  });

  return results.slice(0, 40);
}

// Only a genuinely fresh household (no accounts, no budget, no income) is
// offered the wizard automatically - an established household that simply
// has zero accounts by choice (cash-only) won't see it pop up on every
// visit, since state.onboarding.dismissed sticks once set.
function shouldShowOnboarding() {
  if (state.onboarding?.dismissed) return false;
  return state.accounts.length === 0 && state.budget.categories.length === 0 && state.paychecks.length === 0;
}

function dismissOnboarding() {
  state.onboarding = { dismissed: true };
  autosaveState();
  $("#onboardingWizardDialog").close();
}

const ONBOARDING_STEPS = [
  { title: "Link an account", body: "Add a real bank or credit-card account so balances update themselves as you go, instead of tracking everything by hand.", goto: "wealth", cta: "Add an account" },
  { title: "Invite your household", body: "Bring in the rest of the household - everyone sees the same budget, calendar, and shared expenses.", goto: "sharing", cta: "Invite someone" },
  { title: "Set a starting budget", body: "Add your income and a first category or two - you can always add more later.", goto: "budget", cta: "Start planning" },
  { title: "You're set", body: "That's the basics - explore the rest of FamilyLoop whenever you're ready.", goto: "home", cta: "Go to Home" }
];

function renderOnboardingWizard() {
  const step = ONBOARDING_STEPS[onboardingStep - 1];
  $("#onboardingWizardContent").innerHTML = `
    <div class="section-head">
      <div><span class="card-label">Getting started · Step ${onboardingStep} of ${ONBOARDING_STEPS.length}</span><h2>${escapeHtml(step.title)}</h2></div>
      <button id="closeOnboardingWizardButton" class="icon-button ghost" type="button" aria-label="Close">×</button>
    </div>
    <p class="muted">${escapeHtml(step.body)}</p>
    <div class="dialog-actions">
      ${onboardingStep > 1 ? `<button id="onboardingBackButton" class="ghost" type="button">Back</button>` : ""}
      <button id="onboardingSkipButton" class="ghost" type="button">${onboardingStep === ONBOARDING_STEPS.length ? "Close" : "Skip for now"}</button>
      <button data-onboarding-goto="${step.goto}" type="button">${escapeHtml(step.cta)}</button>
    </div>
  `;
}

function renderHome() {
  const items = homeActionItems();
  const billsAndGoals = billAndGoalReminders();
  const noteReminders = homeNoteReminders();
  const planTasks = homeTodayPlanTasks();
  const weekStrip = homeWeekStrip();
  const recentActivity = homeRecentActivity();
  return `
    <section class="work-grid">
      <div class="main-stack">
        <section class="card">
          <div class="card-label">Quick add</div><h3>Jump straight to adding something</h3>
          <div class="button-row">
            <button id="homeAddChoreButton" class="ghost" type="button">+ Add chore</button>
            <button id="homeAddReminderButton" class="ghost" type="button">+ Add reminder</button>
            <button id="homeAddBirthdayButton" class="ghost" type="button">+ Add birthday</button>
            <button id="homeAddAnniversaryButton" class="ghost" type="button">+ Add anniversary</button>
            <button id="homeAddTransactionButton" class="ghost" type="button">+ Add transaction</button>
            <button id="homeAddIncomeButton" class="ghost" type="button">+ Add income</button>
          </div>
        </section>
        <section class="card home-week-strip-card">
          <div class="card-label">This week</div><h3>Chores, bills, birthdays and reminders</h3>
          <div class="home-week-strip">
            ${weekStrip.map((day) => `
              <div class="home-week-day ${day.dateKey === dateKey(new Date()) ? "today" : ""}">
                <span class="home-week-day-label">${day.label}</span>
                ${day.items.length ? day.items.map((item) => `<span class="home-week-item">${item.icon} ${escapeHtml(item.title)}</span>`).join("") : `<span class="home-week-item-empty">—</span>`}
              </div>
            `).join("")}
          </div>
        </section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">Action needed</span><h3>Past due and due today</h3></div></div>
          ${items.length ? items.map((item) => `
            <div class="compact-row ${item.overdue ? "overdue" : ""}">
              <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.kind)} · ${item.overdue ? "Past due" : "Due today"} · ${escapeHtml(item.detail)}</small></div>
              <div class="chore-complete-group">${item.completion}</div>
              <button class="icon-button" data-home-edit-item="${item.reference}:${item.month}" type="button" aria-label="Edit ${escapeHtml(item.title)} in Calendar">✎</button>
            </div>`).join("") : `<div class="empty-inline">Nothing past due or due today — you're all caught up.</div>`}
        </section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">Private to you</span><h3>Today's plan</h3></div><button id="homeOpenPlanButton" class="ghost" type="button">Open Plan</button></div>
          ${planTasks.length ? planTasks.map((task) => `
            <div class="compact-row ${task.done ? "" : ""}">
              <div><input type="checkbox" data-home-plan-task-check="${task.id}" ${task.done ? "checked" : ""} aria-label="Complete ${escapeHtml(task.title)}"> <strong>${escapeHtml(task.title)}</strong><small>${task.startTime || "No set time"}</small></div>
            </div>`).join("") : `<div class="empty-inline">No plan tasks for today.</div>`}
        </section>
      </div>
      <aside class="side-stack">
        <section class="card">
          <div class="card-label">Bills &amp; goals</div><h3>Needs funding or payment</h3>
          ${billsAndGoals.length ? billsAndGoals.map((reminder) => `<div class="compact-row"><div><strong>${escapeHtml(reminder.title)}</strong><small>${escapeHtml(reminder.detail)}</small></div><button class="pill-button" data-dismiss-reminder="${escapeHtml(reminder.id)}" type="button">Done</button></div>`).join("") : `<div class="empty-inline">No open bills or goals right now.</div>`}
        </section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">Notes</span><h3>Reminders due</h3></div><button id="homeOpenNoteRemindersButton" class="ghost" type="button">Open Notes</button></div>
          ${noteReminders.length ? noteReminders.map((note) => `<div class="compact-row ${note.overdue ? "overdue" : ""}"><div><strong>${escapeHtml(note.title)}</strong><small>${note.overdue ? "Past due" : "Due today"} · ${escapeHtml(note.detail)}</small></div></div>`).join("") : `<div class="empty-inline">No note reminders due.</div>`}
        </section>
        <section class="card">
          <div class="card-label">Household</div><h3>Recent activity</h3>
          ${recentActivity.length ? recentActivity.map((entry) => `<div class="compact-row"><div><strong>${entry.icon} ${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.detail)} · ${formatShortDate(String(entry.at).slice(0, 10))}</small></div></div>`).join("") : `<div class="empty-inline">Nothing recent to show.</div>`}
        </section>
      </aside>
    </section>`;
}

// A bill's "account" and household-chat-staleness fields from the design
// handoff have no real data behind them in FamilyLoop (bills aren't linked
// to a wealth account, and there's no chat feature) - omitted rather than
// faked. Everything else maps onto real budget-line fields.
function billRow(bill) {
  const today = new Date().getDate();
  let dueLabel = `Due day ${bill.dueDay}`;
  let dueClass = "neutral";
  if (bill.paid) { dueLabel = "Paid"; dueClass = "good"; }
  else if (bill.dueDay < today) { dueLabel = "Past due"; dueClass = "danger"; }
  else if (bill.dueDay - today <= 3) dueClass = "danger";
  else if (bill.dueDay - today <= 7) dueClass = "warning";
  const frequencyLabel = bill.frequency === "monthly" ? "Monthly" : bill.frequency === "quarterly" ? "Quarterly" : "Yearly";
  return `
    <div class="bills-row ${bill.paid ? "paid" : ""}">
      <i class="bills-row-dot" style="background:${bill.color}"></i>
      <div class="bills-row-main">
        <div class="bills-row-name">${escapeHtml(bill.name)}<span class="pill">${frequencyLabel}</span></div>
        <div class="muted">${escapeHtml(bill.category)}</div>
      </div>
      <div class="bills-row-amount">
        <strong>${money.format(bill.planned)}</strong>
        <small class="bills-due-${dueClass}">${dueLabel}</small>
      </div>
      ${bill.paid
        ? `<span class="bills-paid-check">✓ Paid</span>`
        : `<button class="ghost" type="button" data-bills-mark-paid="${bill.id}">Mark paid</button>`}
    </div>`;
}

function renderBills() {
  const today = new Date().getDate();
  const allBills = billsRows();
  const filtered = allBills.filter((bill) => {
    if (billsFilter === "due") return !bill.paid && bill.dueDay >= today && bill.dueDay - today <= 7;
    if (billsFilter === "overdue") return !bill.paid && bill.dueDay < today;
    return true;
  });
  const byCategory = new Map();
  allBills.forEach((bill) => {
    if (!byCategory.has(bill.category)) byCategory.set(bill.category, { name: bill.category, color: bill.color, total: 0 });
    byCategory.get(bill.category).total += bill.planned;
  });
  const categoryBreakdown = [...byCategory.values()].sort((a, b) => b.total - a.total);
  const maxCategory = Math.max(1, ...categoryBreakdown.map((category) => category.total));
  const filterPills = [["all", "All"], ["due", "Due soon"], ["overdue", "Overdue"]];
  return `
    <section class="work-grid">
      <div class="main-stack">
        <section class="card">
          <div class="section-head">
            <div><span class="card-label">Bills</span><h3>Upcoming</h3></div>
            <div class="reports-scope-pills" role="group" aria-label="Filter bills">
              ${filterPills.map(([value, label]) => `<button type="button" class="${billsFilter === value ? "active" : ""}" data-bills-filter="${value}">${label}</button>`).join("")}
            </div>
          </div>
          <div class="bills-list">
            ${filtered.length ? filtered.map(billRow).join("") : `<div class="empty-inline">No bills match this filter.</div>`}
          </div>
        </section>
      </div>
      <aside class="side-stack">
        <section class="card">
          <div class="card-label">By category</div>
          <h3>Monthly recurring</h3>
          <div class="bills-category-breakdown">
            ${categoryBreakdown.length ? categoryBreakdown.map((category) => `
              <div class="bills-category-row">
                <div class="bills-category-row-label"><span>${escapeHtml(category.name)}</span><span class="muted">${money.format(category.total)}</span></div>
                <div class="bills-category-bar-track"><div class="bills-category-bar-fill" style="width:${Math.round((category.total / maxCategory) * 100)}%; background:${category.color}"></div></div>
              </div>`).join("") : `<div class="empty-inline">No recurring bills yet.</div>`}
          </div>
        </section>
        <section class="card">
          <div class="card-label">Manage</div>
          <h3>Add or edit a bill</h3>
          <p class="muted">Bills are the lines in your Budget with a due date set - open Budget to add a new one or change an amount.</p>
          <button class="ghost" type="button" data-goto-view="budget">Open Budget →</button>
        </section>
      </aside>
    </section>`;
}

// A visual companion to the flat category bars below it - same planned
// totals, just framed as "where did this month's income get allocated"
// instead of a spreadsheet-style list. Categories with nothing planned yet
// are left out entirely rather than shown as empty envelopes.
function budgetEnvelopeFlowHtml() {
  const unallocated = state.budget.income - plannedTotal();
  const categories = state.budget.categories
    .map((category) => ({ name: category.name, color: category.color, planned: category.lines.reduce((sum, line) => sum + Number(line.planned || 0), 0) }))
    .filter((category) => category.planned > 0)
    .sort((a, b) => b.planned - a.planned);
  if (!categories.length) return "";
  return `
    <section class="card budget-envelope-flow">
      <div class="section-head"><div><span class="card-label">Flow</span><h3>Where this month's income is allocated</h3></div></div>
      <div class="envelope-flow-row">
        <div class="envelope envelope-unallocated ${unallocated < 0 ? "danger" : ""}">
          <span class="envelope-label">Unallocated</span>
          <strong>${money.format(unallocated)}</strong>
        </div>
        <div class="envelope-flow-arrows" aria-hidden="true">
          ${categories.map(() => `<span class="envelope-flow-arrow"></span>`).join("")}
        </div>
        <div class="envelope-flow-targets">
          ${categories.map((category) => `
            <div class="envelope" style="border-color:${category.color}">
              <i style="background:${category.color}"></i>
              <span class="envelope-label">${escapeHtml(category.name)}</span>
              <strong>${money.format(category.planned)}</strong>
            </div>
          `).join("")}
        </div>
      </div>
    </section>`;
}

function renderBudget() {
  ensurePaycheckRecurrenceData();
  ensureAccountsData();
  ensureCategoryColors();
  const budgetMembers = calendarAssigneeOptions();
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
  const budgetMonthStart = `${state.budget.month}-01`;
  const budgetMonthEnd = monthEndDateKey(state.budget.month);
  return `
    <section class="work-grid transactions-grid">
      <div class="main-stack">
        ${budgetEnvelopeFlowHtml()}
        <section class="budget-ledger-card card">
          <div class="net-worth-strip budget-left-strip">
            <strong data-income-left>${money.format(state.budget.income - plannedTotal())}</strong>
            <span>Left to budget</span>
          </div>
          <div class="budget-ledger-head ${state.accounts.length ? "has-accounts" : ""}">
            <div><h3>Income</h3></div>
            <span>Planned</span>
            <span>Remaining</span>
            <span>Repeats</span>
            ${state.accounts.length ? `<span>Deposit to</span>` : ""}
          </div>
          ${state.paychecks
            .map((paycheck, index) => ({ paycheck, index }))
            .filter(({ paycheck }) => paycheckActiveInMonth(paycheck, budgetMonthStart, budgetMonthEnd))
            .map(({ paycheck, index }) => `
            <div class="budget-money-row ${state.accounts.length ? "has-accounts" : ""}">
              <input class="line-name-input" data-income-name="${index}" value="${paycheck.name}">
              <input class="money-input" data-income-amount="${index}" type="number" step="0.01" value="${paycheck.amount}">
              <strong data-income-remaining="${index}">${exactMoney.format(Number(paycheck.amount || 0) - paycheckAssignedAmount(paycheck))}</strong>
              <select class="income-recurrence-select" data-income-recurrence="${index}" aria-label="How often ${escapeHtml(paycheck.name)} repeats">${Object.entries(paycheckRecurrenceLabels).map(([value, label]) => `<option value="${value}" ${paycheck.recurrence === value ? "selected" : ""}>${label}</option>`).join("")}</select>
              ${state.accounts.length ? `<select class="income-recurrence-select" data-paycheck-deposit-account="${index}" aria-label="Deposit account for ${escapeHtml(paycheck.name)}"><option value="">Not linked</option>${accountOptions(paycheck.depositAccountId || "", { excludeType: "credit_card" })}</select>` : ""}
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
                ${[...state.budget.categories].sort((a, b) => a.name.localeCompare(b.name)).map((category) => `<button type="button" data-category-option="${category.name}">${category.name}</button>`).join("")}
              </div>
            </label>
            <button id="addCategoryButton" class="ghost" type="button">Add category</button>
            <button id="deleteCategoryByNameButton" class="danger-button" type="button">Delete selected</button>
          </div>
          <p class="muted">Bills like HOA, insurance, property tax, subscriptions, or memberships can be made recurring to automatically set aside savings each month.</p>
          ${budgetMembers.length ? `<div class="reports-scope-pills budget-member-pills" role="group" aria-label="Filter by member">
            <button type="button" class="${budgetMemberFilter === "all" ? "active" : ""}" data-budget-member-filter="all">Everyone</button>
            ${budgetMembers.map((member) => `<button type="button" class="${budgetMemberFilter === assigneeKey(member) ? "active" : ""}" data-budget-member-filter="${escapeHtml(assigneeKey(member))}">${escapeHtml(member.name)}</button>`).join("")}
          </div>` : ""}
          <div class="budget-table">
            ${state.budget.categories.map((category, categoryIndex) => {
              const visibleEntries = category.lines
                .map((line, lineIndex) => ({ line, lineIndex }))
                .filter(({ line }) => budgetMemberFilter === "all" || (line.ownerId || "") === budgetMemberFilter);
              if (budgetMemberFilter !== "all" && !visibleEntries.length) return "";
              return `
              <div class="category-row">
                <div class="category-title">
                  <i style="background:${category.color}"></i>
                  <div class="category-name"><input class="category-name-input" data-budget-category-name="${categoryIndex}" value="${escapeHtml(category.name)}" aria-label="Category name"><small data-category-left="${categoryIndex}">${money.format(visibleEntries.reduce((sum, { line }) => sum + Number(line.planned) - spentByLine(line.id), 0))} left</small></div>
                  <b class="category-planned" data-category-planned="${categoryIndex}">${money.format(visibleEntries.reduce((sum, { line }) => sum + Number(line.planned), 0))} planned</b>
                  <span class="category-spent" data-category-spent="${categoryIndex}">${money.format(visibleEntries.reduce((sum, { line }) => sum + spentByLine(line.id), 0))} spent</span>
                  <button class="category-add-line" data-add-line-category="${categoryIndex}" type="button">+ Add subcategory</button>
                  <button class="icon-button danger-button" data-delete-category="${categoryIndex}" type="button" aria-label="Remove ${category.name}">×</button>
                </div>
              </div>
              ${visibleEntries.length ? `<div class="budget-line-head">
                <span>Subcategory</span>
                <span>Due date</span>
                <span>Planned</span>
                <span>Spent</span>
                <span>Remaining</span>
                <span>Owner</span>
                <span></span>
              </div>` : ""}
              ${visibleEntries.map(({ line, lineIndex }) => {
                const recurring = line.recurringBill?.enabled ? recurringBudgetSetAside(line.recurringBill) : null;
                const spent = spentByLine(line.id);
                const remaining = Number(line.planned) - spent;
                return `<div class="budget-line">
                  <input class="line-name-input" data-budget-line-name="${categoryIndex}:${lineIndex}" value="${line.name}" aria-label="Subcategory name">
                  ${recurring
                    ? `<input data-budget-recurring-due-date="${categoryIndex}:${lineIndex}" type="date" value="${recurring.nextDueDate}" aria-label="Next due date for ${line.name}">`
                    : `<input data-budget-due-date="${categoryIndex}:${lineIndex}" type="date" min="${monthDateMin()}" max="${monthDateMax()}" value="${dueDateValue(line.dueDay)}" aria-label="Due date for ${line.name}">`}
                  <input class="money-input" data-budget-line="${categoryIndex}:${lineIndex}" type="number" step="0.01" value="${line.planned}" min="0" ${recurring ? "readonly" : ""} aria-label="Planned amount for ${line.name}">
                  <span>${exactMoney.format(spent)}</span>
                  <b data-line-remaining="${categoryIndex}:${lineIndex}" class="${remaining < 0 ? "danger" : ""}">${exactMoney.format(remaining)}${line.rolloverAmount > 0 ? `<small class="budget-rollover-badge" title="Unspent from last month, carried into this month's planned amount">+${exactMoney.format(line.rolloverAmount)} rolled over</small>` : ""}</b>
                  <select class="budget-line-owner-select" data-budget-line-owner="${categoryIndex}:${lineIndex}" aria-label="Owner for ${line.name}">
                    <option value="">Household</option>
                    ${budgetMembers.map((member) => `<option value="${escapeHtml(assigneeKey(member))}" ${(line.ownerId || "") === assigneeKey(member) ? "selected" : ""}>${escapeHtml(member.name)}</option>`).join("")}
                  </select>
                  <div class="budget-line-actions">
                    <button class="icon-button rollover-toggle ${line.rolloverEnabled ? "active" : ""}" data-toggle-rollover="${categoryIndex}:${lineIndex}" type="button" title="${line.rolloverEnabled ? "Rollover on: next month's leftover carries forward" : "Carry next month's unspent balance into this line automatically"}" aria-pressed="${Boolean(line.rolloverEnabled)}" aria-label="${line.rolloverEnabled ? "Turn off rollover" : "Turn on rollover"} for ${line.name}">⤴</button>
                    ${recurring ? "" : `<button class="icon-button recurring-budget-toggle" data-enable-recurring-budget="${categoryIndex}:${lineIndex}" type="button" title="Automatically set aside savings each month for bills like HOA, insurance, property tax, subscriptions, or memberships." aria-label="Make ${line.name} recurring">↻</button>`}
                    <button class="icon-button danger-button" data-delete-line="${categoryIndex}:${lineIndex}" type="button" aria-label="Remove ${line.name}">×</button>
                  </div>
                  ${Number(line.planned) > 0 ? `<div class="budget-line-bar"><span style="width:${Math.min(100, Math.max(0, Math.round((spent / Number(line.planned)) * 100)))}%; background:${remaining < 0 ? "var(--coral)" : "var(--green)"}"></span></div>` : ""}
                  ${recurring ? `<div class="recurring-budget-panel">
                    <label class="row-field"><small>Amount due</small><input class="money-input" data-budget-recurring-amount="${categoryIndex}:${lineIndex}" type="number" step="0.01" min="0" value="${recurring.amountDue}"></label>
                    <label class="row-field"><small>Frequency</small><select data-budget-recurring-frequency="${categoryIndex}:${lineIndex}">${Object.entries(recurringBudgetFrequencyLabels).map(([value, label]) => `<option value="${value}" ${recurring.frequency === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
                    <div class="recurring-budget-summary"><strong>${exactMoney.format(recurring.monthlyAmount)}/mo</strong><small>${recurringBudgetFrequencyLabels[recurring.frequency]} bill due ${formatShortDate(recurring.nextDueDate)} · ${recurring.monthsRemaining} month${recurring.monthsRemaining === 1 ? "" : "s"} to save</small></div>
                    <button class="ghost" data-disable-recurring-budget="${categoryIndex}:${lineIndex}" type="button">Remove recurring</button>
                  </div>` : ""}
                </div>`;
              }).join("")}
            `;
            }).join("")}
          </div>
        </section>
      </div>
      <aside class="side-stack">
        <section class="card">
          <div class="card-label">Next up</div>
          <h3>Due soon</h3>
          ${(() => {
            const dueSoon = dueDateRows().due.slice(0, 5);
            return dueSoon.length ? dueSoon.map((item) => compactRow(item.name, item.date, "Due")).join("") : `<div class="empty-inline">Nothing due right now</div>`;
          })()}
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

// Draft rows for whichever ledger transaction's split editor is currently
// open (index into state.transactions, or null when closed) - a scratch
// copy so typing amounts/lines doesn't touch the real transaction until
// "Save split", and "Cancel" just discards it.
let splitEditorLedgerIndex = null;
let splitEditorRows = [];

function ledgerEntryRow(transaction, index, transferMatch) {
  // Same placeholder as Bank Stream's own lineOptions - without it, a
  // genuinely-unassigned transaction (lineId: "") has no matching "selected"
  // option and the browser silently displays whichever line sorts first
  // alphabetically, indistinguishable from a real choice.
  const isSplit = transaction.splits?.length > 0;
  const lineOptions = (transaction.lineId ? "" : `<option value="" disabled selected>Choose a subcategory…</option>`) + allLines().map((line) => `<option value="${line.id}" ${line.id === transaction.lineId ? "selected" : ""}>${line.category} - ${line.name}</option>`).join("");
  return `
    <div class="ledger-entry-row ${state.accounts.length ? "has-accounts" : ""}">
      <input type="checkbox" aria-label="Select ${escapeHtml(transaction.payee)} for bulk categorize" data-ledger-entry-select="${index}" ${ledgerSelectedIndices.has(index) ? "checked" : ""}>
      <input class="line-name-input" aria-label="Payee" data-ledger-entry-payee="${index}" value="${escapeHtml(transaction.payee)}">
      <input class="money-input" aria-label="Amount" type="number" step="0.01" data-ledger-entry-amount="${index}" value="${transaction.amount}">
      <input aria-label="Date" type="date" data-ledger-entry-date="${index}" value="${transaction.date}">
      ${isSplit
        ? `<button type="button" class="split-transaction-badge" data-split-transaction-edit="${index}">✂ Split (${transaction.splits.length})</button>`
        : `<select class="income-recurrence-select" aria-label="Subcategory" data-ledger-entry-line="${index}">${lineOptions}</select>`}
      ${state.accounts.length ? `<select class="income-recurrence-select" aria-label="Account" data-ledger-entry-account="${index}"><option value="">Not linked</option>${accountOptions(transaction.accountId || "")}</select>` : ""}
      <button class="icon-button ${isSplit ? "has-transfer-match" : ""}" data-split-transaction-edit="${index}" type="button" aria-label="Split ${escapeHtml(transaction.payee)} across categories" title="Split across categories">✂</button>
      <button class="icon-button" data-assign-iou-ledger="${index}" type="button" aria-label="Split with a friend ${escapeHtml(transaction.payee)}">👥</button>
      <button class="icon-button ${transferMatch ? "has-transfer-match" : ""}" data-move-to-transfer-ledger="${index}" type="button" aria-label="Move ${escapeHtml(transaction.payee)} to Transfers" title="${transferMatch ? `Matches ${escapeHtml(accountName(transferMatch.accountId))}'s ${exactMoney.format(Math.abs(transferMatch.amount))} on ${formatShortDate(transferMatch.date)}` : "Move to Transfers (account-to-account movement)"}">⇄</button>
      <button class="icon-button danger-button" data-delete-transaction="${index}" type="button" aria-label="Delete ${escapeHtml(transaction.payee)}">×</button>
      ${tagChipsHtml(transaction.tags, "data-remove-ledger-tag", "data-add-ledger-tag", index)}
      ${splitEditorHtml(transaction, index)}
    </div>`;
}

function splitEditorHtml(transaction, index) {
  if (splitEditorLedgerIndex !== index) return "";
  const allocated = splitEditorRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const remaining = Math.round((Number(transaction.amount || 0) - allocated) * 100) / 100;
  const isBalanced = Math.abs(remaining) < 0.005;
  const lineOptionsFor = (selectedId) => (selectedId ? "" : `<option value="" disabled selected>Choose a subcategory…</option>`) + allLines().map((line) => `<option value="${line.id}" ${line.id === selectedId ? "selected" : ""}>${line.category} - ${line.name}</option>`).join("");
  return `<div class="split-editor">
    <div class="split-editor-rows">
      ${splitEditorRows.map((row, rowIndex) => `
        <div class="split-editor-row">
          <select data-split-editor-line="${rowIndex}">${lineOptionsFor(row.lineId)}</select>
          <input type="number" step="0.01" data-split-editor-amount="${rowIndex}" value="${row.amount}" placeholder="Amount">
          <button type="button" class="icon-button danger-button" data-split-editor-remove="${rowIndex}" aria-label="Remove split row">×</button>
        </div>
      `).join("")}
    </div>
    <div class="split-editor-actions">
      <button type="button" class="ghost" data-split-editor-add-row>+ Add split</button>
      <span class="split-editor-remaining ${isBalanced ? "good" : "danger"}">${isBalanced ? "Fully allocated" : `${money.format(remaining)} remaining`}</span>
    </div>
    <div class="split-editor-actions">
      <button type="button" class="ghost" data-split-editor-cancel>Cancel</button>
      ${transaction.splits?.length ? `<button type="button" class="ghost danger-button" data-split-editor-undo="${index}">Remove split</button>` : ""}
      <button type="button" data-split-editor-save="${index}" ${!isBalanced || splitEditorRows.length < 2 ? "disabled" : ""}>Save split</button>
    </div>
  </div>`;
}

function recurringExpenseRow(recurring, index) {
  const lineOptions = (recurring.lineId ? "" : `<option value="" disabled selected>Choose a subcategory…</option>`) + allLines().map((line) => `<option value="${line.id}" ${line.id === recurring.lineId ? "selected" : ""}>${line.category} - ${line.name}</option>`).join("");
  return `
    <div class="recurring-expense-row">
      <label class="row-field row-payee"><small>Payee</small><input data-recurring-payee="${index}" value="${escapeHtml(recurring.payee)}"></label>
      <label class="row-field row-amount"><small>Amount</small><input class="money-input" type="number" step="0.01" data-recurring-amount="${index}" value="${recurring.amount}"></label>
      <label class="row-field row-select"><small>Repeats</small><select data-recurring-recurrence="${index}">
        <option value="weekly" ${recurring.recurrence === "weekly" ? "selected" : ""}>Weekly</option>
        <option value="biweekly" ${recurring.recurrence === "biweekly" ? "selected" : ""}>Biweekly</option>
        <option value="monthly" ${recurring.recurrence === "monthly" ? "selected" : ""}>Monthly</option>
      </select></label>
      <label class="row-field row-select"><small>Subcategory</small><select data-recurring-line="${index}">${lineOptions}</select></label>
      ${state.accounts.length ? `<label class="row-field row-select"><small>Account</small><select data-recurring-account="${index}"><option value="">Not linked</option>${accountOptions(recurring.accountId || "")}</select></label>` : ""}
      <div class="row-actions">
        <details class="end-date-toggle">
          <summary class="icon-button ${recurring.endDate ? "has-end-date" : ""}" aria-label="${recurring.endDate ? `End date set for ${escapeHtml(recurring.payee)}` : `Set an end date for ${escapeHtml(recurring.payee)}`}">↻</summary>
          <label class="row-field row-date"><small>End date</small><input type="date" data-recurring-end-date="${index}" value="${recurring.endDate || ""}" aria-label="Stop ${escapeHtml(recurring.payee)} from repeating after this date"></label>
        </details>
        <button class="icon-button danger-button" data-delete-recurring="${index}" type="button" aria-label="Stop recurring ${escapeHtml(recurring.payee)}">×</button>
      </div>
    </div>`;
}

// A household-set override that always wins over the plain "most recent
// use" history guess (suggestSubcategoryFromHistory) for one exact payee -
// same normalization rule as history matching itself, so it can't cross-
// contaminate a different payee that merely shares a generic prefix.
function categorizationRuleForPayee(payee) {
  const key = normalizeForPayeeMatch(payee);
  if (!key) return "";
  return state.transactionCategorizationRules?.[key] || "";
}

function setCategorizationRuleForPayee(payee, lineId) {
  const key = normalizeForPayeeMatch(payee);
  if (!key) return;
  state.transactionCategorizationRules ||= {};
  if (lineId) state.transactionCategorizationRules[key] = lineId;
  else delete state.transactionCategorizationRules[key];
}

function renderTransactions() {
  ensureAccountsData();
  ensureRecurringExpensesPosted();
  // possibleDuplicate is recomputed live on every render, never trusted from
  // the stored draft — otherwise an item imported before a matching-logic
  // fix shipped (or before another transaction it now matches existed)
  // would stay stuck showing its stale result forever.
  const allImported = transactionInboxItems()
    .filter((transaction) => !(state.transactionInboxDone || []).includes(transaction.id))
    .map((transaction) => ({
      ...transaction,
      possibleDuplicate: isDuplicateTransaction(transaction, [
        ...state.transactions,
        ...(state.transactionInboxDrafts || []).filter((other) => other.id !== transaction.id)
      ]),
      refundMatch: refundMatch(transaction, [
        ...state.transactions,
        ...(state.transactionInboxDrafts || []).filter((other) => other.id !== transaction.id)
      ]),
      transferMatch: findTransferCandidate(transaction, [
        ...state.transactions,
        ...(state.transactionInboxDrafts || []).filter((other) => other.id !== transaction.id)
      ]),
      categorizationConfidence: transaction.lineId ? payeeCategorizationConfidence(transaction.payee, state.transactions) : null,
      categorizationRuleLineId: categorizationRuleForPayee(transaction.payee)
    }));
  // Recent transactions is already filtered to the viewed month, so filter
  // Bank stream to match — otherwise a pending item from a different month
  // sits next to a ledger list it can never be compared against. Sorted per
  // bankStreamSort (Date/Amount/Payee, toggled via the header buttons below,
  // defaulting to date/desc) - Bank Stream drafts land in insertion order
  // (whatever order the imported file's rows happened to be in), which
  // rarely matches any useful order on its own.
  const imported = sortTransactionsByField(
    allImported.filter((transaction) => transaction.date?.slice(0, 7) === state.budget.month),
    bankStreamSort.field,
    bankStreamSort.direction
  );
  const otherMonthCounts = {};
  allImported.forEach((transaction) => {
    const month = transaction.date?.slice(0, 7);
    if (month && month !== state.budget.month) otherMonthCounts[month] = (otherMonthCounts[month] || 0) + 1;
  });
  const otherMonthEntries = Object.entries(otherMonthCounts).sort(([a], [b]) => a.localeCompare(b));
  const unlinkedDraftCount = allImported.filter((transaction) => !transaction.accountId).length;
  // A payee-history bug (fixed) briefly let a shared generic prefix - e.g.
  // "Zelle payment to X" and "Zelle payment from Y" - cross-contaminate
  // subcategory suggestions across a whole statement import. historyMatch
  // marks exactly the drafts that came from that auto-suggestion (never a
  // manual pick or a refund match), so this offers to reset just those back
  // to unassigned in one action instead of reviewing every row by hand.
  const historyMatchedDraftCount = allImported.filter((transaction) => transaction.historyMatch).length;
  const unassignedLedger = [];
  // Without an explicit placeholder, a still-unassigned draft (lineId: "")
  // has no <option> that matches "selected" at all - the browser then just
  // displays whichever line sorts first alphabetically, indistinguishable
  // from a real choice. That silent default is exactly what looked like a
  // persistent wrong-subcategory bug even after the underlying history-match
  // bug was fixed and drafts were re-imported clean: nothing had actually
  // been assigned, the dropdown was just showing its own fallback.
  const lineOptions = (selectedLineId) => (selectedLineId ? "" : `<option value="" disabled selected>Choose a subcategory…</option>`) + allLines().map((line) => `<option value="${line.id}" ${line.id === selectedLineId ? "selected" : ""}>${line.category} - ${line.name}</option>`).join("");
  const firstCategory = state.budget.categories[0];
  return `
    <section class="work-grid">
      <div class="main-stack">
        <section class="card">
          <div class="section-head"><div><span class="card-label">Budget setup</span><h3>Manage subcategories from Transactions</h3></div></div>
          <div class="transaction-subcategory-adder">
            <label>Category<select id="transactionParentCategory">${state.budget.categories.map((category, index) => ({ category, index })).sort((a, b) => a.category.name.localeCompare(b.category.name)).map(({ category, index }) => `<option value="${index}">${category.name}</option>`).join("")}</select></label>
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
          <div class="card-label">Entries</div><h3>Ledger</h3>
          ${transactionValidationFeedback ? `<p class="muted" role="status">${escapeHtml(transactionValidationFeedback)}</p>` : ""}
          <form id="transactionForm" class="mini-form transaction-entry-form">
            <label>Payee<input name="payee" placeholder="Coffee House" required></label>
            <label>Amount<input name="amount" type="number" step="0.01" placeholder="18.72" required></label>
            <label>Date<input name="date" type="date" value="${dateKey(new Date())}" required></label>
            <label>Repeat<select name="recurrence">
              <option value="none">One-time</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
            </select></label>
            <label data-transaction-end-date-field hidden>End date (optional)<input name="endDate" type="date"></label>
            <label class="form-row-full">Subcategory<select name="lineId"><option value="" disabled selected>Choose a subcategory…</option>${allLines().map((line) => `<option value="${line.id}">${line.category} - ${line.name}</option>`).join("")}</select></label>
            <button class="ghost form-row-full" id="transactionAiSuggestButton" type="button">✨ Suggest with AI</button>
            <p class="muted form-row-full" data-transaction-refund-hint hidden></p>
            ${state.accounts.length ? `<label class="form-row-full">Account<select name="accountId"><option value="">Not linked</option>${accountOptions("")}</select></label><button class="ghost form-row-full" id="transactionAiSuggestAccountButton" type="button">✨ Suggest account with AI</button><p class="muted form-row-full" data-transaction-account-hint hidden></p>` : ""}
            <label class="form-row-full">Tags (optional)<input name="tags" list="transactionTagOptions" placeholder="Florida trip"></label>
            <datalist id="transactionTagOptions">${allTransactionTagLabels().map((tag) => `<option value="${escapeHtml(tag)}">`).join("")}</datalist>
            <button type="submit" class="form-row-full">Add transaction</button>
          </form>
          ${(() => {
            const monthStart = `${state.budget.month}-01`;
            const monthEnd = monthEndDateKey(state.budget.month);
            const activeRecurring = state.recurringExpenses
              .map((recurring, index) => ({ recurring, index }))
              .filter(({ recurring }) => recurringExpenseActiveInMonth(recurring, monthStart, monthEnd));
            if (!activeRecurring.length) return "";
            return `<div class="recurring-expenses-block">
              <div class="card-label">Recurring bills</div>
              ${activeRecurring.map(({ recurring, index }) => recurringExpenseRow(recurring, index)).join("")}
            </div>`;
          })()}
          ${unassignedLedger.map((transaction) => `
            <div class="ledger-assign-row">
              <div><strong>${transaction.payee}</strong><small>${formatShortDate(transaction.date)}</small></div>
              <b>-${exactMoney.format(transaction.amount).replace("$", "$")}</b>
              <label>Assign to<select data-ledger-line="${transaction.id}">${lineOptions("")}</select></label>
              <button data-assign-ledger="${transaction.id}:${transaction.payee}:${transaction.amount}:${transaction.date}" type="button">Assign</button>
            </div>
          `).join("")}
          <div class="card-label">Recent transactions</div>
          ${ledgerAcceptFeedback ? `<p class="muted" role="status">${escapeHtml(ledgerAcceptFeedback)}</p>` : ""}
          ${(() => {
            const monthTransactions = state.transactions
              .map((transaction, index) => ({ transaction, index }))
              .filter(({ transaction }) => transaction.date?.slice(0, 7) === state.budget.month);
            if (!monthTransactions.length) return `<div class="empty-inline">No transactions yet</div>`;
            const sorted = sortByTransactionField(monthTransactions, transactionSort.field, transactionSort.direction);
            const visibleIndices = sorted.map(({ index }) => index);
            const allVisibleSelected = visibleIndices.length > 0 && visibleIndices.every((index) => ledgerSelectedIndices.has(index));
            return `${ledgerSelectedIndices.size ? `<div class="ledger-bulk-bar">
                <strong>${ledgerSelectedIndices.size} selected</strong>
                <select id="ledgerBulkLineSelect" aria-label="Subcategory to apply to selected transactions">
                  <option value="" disabled selected>Choose a subcategory…</option>
                  ${allLines().map((line) => `<option value="${line.id}">${line.category} - ${line.name}</option>`).join("")}
                </select>
                <button id="ledgerBulkApplyButton" type="button">Apply to selected</button>
                <button id="ledgerBulkClearButton" class="ghost" type="button">Clear selection</button>
              </div>` : ""}
              <div class="ledger-entry-scroll">
              <div class="ledger-entry-head ${state.accounts.length ? "has-accounts" : ""}">
                <input type="checkbox" aria-label="Select all transactions" id="ledgerSelectAllCheckbox" ${allVisibleSelected ? "checked" : ""}>
                <button type="button" data-sort-transactions="payee">Payee${transactionSortIndicator("payee")}</button>
                <button type="button" data-sort-transactions="amount">Amount${transactionSortIndicator("amount")}</button>
                <button type="button" data-sort-transactions="date">Date${transactionSortIndicator("date")}</button>
                <button type="button" data-sort-transactions="subcategory">Subcategory${transactionSortIndicator("subcategory")}</button>
                ${state.accounts.length ? `<button type="button" data-sort-transactions="account">Account${transactionSortIndicator("account")}</button>` : ""}
                <span></span><span></span><span></span>
              </div>
              <div class="ledger-entry-list">${sorted.map(({ transaction, index }) => ledgerEntryRow(transaction, index, findTransferCandidate(transaction, [
                ...state.transactions.filter((other, otherIndex) => otherIndex !== index),
                ...(state.transactionInboxDrafts || [])
              ]))).join("")}</div>
            </div>`;
          })()}
        </section>
      </div>
      <aside class="side-stack">
        <section class="card soft-card"><div class="card-label">Transactions</div><h3>Connected accounts</h3><div class="sync-empty">Connect a bank to import transactions</div></section>
        ${(() => {
          const tagGroups = groupTransactionsByTag(state.transactions);
          const selectedGroup = tagGroups.find((group) => group.key === selectedTransactionTag) || null;
          return `<section class="card">
            <div class="card-label">Transactions</div><h3>Tags</h3>
            ${tagGroups.length ? `<label>Group by tag<select id="transactionTagFilter">
              <option value="">All tags</option>
              ${tagGroups.map((group) => `<option value="${escapeHtml(group.key)}" ${group.key === selectedTransactionTag ? "selected" : ""}>${escapeHtml(group.label)} (${money.format(group.total)})</option>`).join("")}
            </select></label>` : `<div class="empty-inline">No tagged transactions yet — add a tag like "Florida trip" to a transaction to group it here.</div>`}
            ${selectedGroup ? `
              <div class="tag-summary-total"><span>${escapeHtml(selectedGroup.label)} total</span><b>${money.format(selectedGroup.total)}</b></div>
              <div class="tag-transaction-list">${[...selectedGroup.transactions].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((transaction) => `
                <div class="tag-transaction-row">
                  <span>${escapeHtml(transaction.payee)}</span>
                  <small>${formatShortDate(transaction.date)}</small>
                  <b>${money.format(transaction.amount)}</b>
                </div>
              `).join("")}</div>
            ` : ""}
          </section>`;
        })()}
        <section class="card">
          <div class="section-head">
            <div><span class="card-label">Bank expense</span><h3>Bank stream</h3></div>
            <div class="button-row">
              <label class="documents-upload-button">+ Import CSV/PDF<input type="file" id="bankStreamCsvInput" accept=".csv,text/csv,.pdf,application/pdf"></label>
              <button id="addTransactionButton" type="button">+ Add transaction</button>
            </div>
          </div>
          ${bankImportFeedback ? `<p class="muted" role="status">${escapeHtml(bankImportFeedback)}</p>` : ""}
          ${otherMonthEntries.length ? `<div class="bank-stream-other-months">
            <small>Also pending in:</small>
            ${otherMonthEntries.map(([month, count]) => `<button type="button" class="pill-button" data-switch-budget-month="${month}">${formatMonth(month)} (${count})</button>`).join("")}
          </div>` : ""}
          ${unlinkedDraftCount && state.accounts.length ? `<div class="bank-stream-bulk-account">
            <label><small>Set account for all ${unlinkedDraftCount} unlinked row${unlinkedDraftCount === 1 ? "" : "s"} (every month)</small>
              <select id="bankStreamBulkAccount"><option value="">Choose an account…</option>${accountOptions("")}</select>
            </label>
          </div>` : ""}
          ${historyMatchedDraftCount ? `<div class="bank-stream-bulk-account bank-stream-bulk-warning">
            <span><small>A since-fixed bug could have mis-suggested the Subcategory on ${historyMatchedDraftCount} row${historyMatchedDraftCount === 1 ? "" : "s"} (every month) marked <strong>From history</strong> — safe to clear and redo if any look wrong.</small></span>
            <button type="button" id="bankStreamClearHistoryMatches" class="ghost">Clear ${historyMatchedDraftCount} suggested subcategor${historyMatchedDraftCount === 1 ? "y" : "ies"}</button>
          </div>` : ""}
          ${imported.length ? `<div class="bank-stream-sort-row">
            <span>Sort:</span>
            <button type="button" data-sort-bank-stream="date">Date${bankStreamSortIndicator("date")}</button>
            <button type="button" data-sort-bank-stream="amount">Amount${bankStreamSortIndicator("amount")}</button>
            <button type="button" data-sort-bank-stream="payee">Payee${bankStreamSortIndicator("payee")}</button>
          </div>` : ""}
          ${imported.map((transaction) => `
            <div class="bank-stream-row" data-bank-stream-row="${transaction.id}">
              ${transaction.recurringId ? `<span class="pill">Recurring</span>` : ""}
              ${transaction.isDeposit ? `<span class="pill" title="Detected as money coming in from this file's Debit/Credit or signed-Amount column">Deposit</span>` : ""}
              ${transaction.isPayment ? `<span class="pill pill-info" title="Looks like a card payoff/autopay - probably belongs in Move to Transfers, not as a regular expense">Card payment</span>` : ""}
              ${transaction.isPending ? `<span class="pill pill-warning" title="Hadn't posted yet in the statement - dated today by default, correct it once your bank assigns a real posting date">Pending</span>` : ""}
              ${transaction.historyMatch ? `<span class="pill pill-info" title="Subcategory pre-filled from how you've categorized this payee (or a similar one) most recently - double-check before accepting">From history</span>` : ""}
              ${transaction.categorizationRuleLineId ? `<span class="pill pill-info" title="Subcategory pre-filled from your 'always categorize this way' rule for this payee">🔒 Rule</span>` : ""}
              ${transaction.categorizationConfidence ? `<span class="pill bank-stream-confidence-${transaction.categorizationConfidence.confidence >= 80 ? "good" : transaction.categorizationConfidence.confidence >= 50 ? "warning" : "danger"}" title="${transaction.categorizationConfidence.sampleSize} past transaction${transaction.categorizationConfidence.sampleSize === 1 ? "" : "s"} from this payee - ${transaction.categorizationConfidence.confidence}% used this same subcategory">${transaction.categorizationConfidence.confidence}% match</span>` : ""}
              ${transaction.accountHistoryMatch ? `<span class="pill pill-info" title="Account pre-filled from which account this payee's transactions have been linked to most recently - double-check before accepting">Account from history</span>` : ""}
              ${transaction.possibleDuplicate ? `<span class="pill pill-warning" title="Matches an existing transaction with the same amount within 2 days">Possible duplicate</span>` : ""}
              ${transaction.refundMatch ? `<span class="pill pill-info" title="Refund for the ${money.format(transaction.refundMatch.amount)} purchase on ${formatShortDate(transaction.refundMatch.date)}${transaction.orderNumber ? ` (order ${escapeHtml(transaction.orderNumber)})` : ""}">Refund match</span>` : ""}
              ${transaction.transferMatch ? `<span class="pill pill-info" title="Matches ${escapeHtml(accountName(transaction.transferMatch.accountId))}'s ${exactMoney.format(Math.abs(transaction.transferMatch.amount))} on ${formatShortDate(transaction.transferMatch.date)}">Possible transfer</span>` : ""}
              <label class="row-field row-payee"><small>Payee</small><input data-bank-stream-payee="${transaction.id}" value="${escapeHtml(transaction.payee)}"></label>
              <label class="row-field row-date"><small>Date</small><input type="date" data-bank-stream-date="${transaction.id}" value="${transaction.date}"></label>
              <label class="row-field row-amount"><small>Amount</small><input class="money-input" type="number" step="0.01" data-bank-stream-amount="${transaction.id}" value="${transaction.amount}"></label>
              <label class="row-field row-select"><small>Subcategory</small><select data-bank-stream-line="${transaction.id}">${lineOptions(transaction.lineId)}</select></label>
              ${!transaction.lineId ? `<button class="icon-button" data-ai-suggest-line="${transaction.id}" type="button" aria-label="Suggest a subcategory with AI for ${escapeHtml(transaction.payee)}" title="No history match for this payee - ask AI to suggest a subcategory">✨</button>` : ""}
              ${transaction.lineId ? `<button class="icon-button ${transaction.categorizationRuleLineId === transaction.lineId ? "active" : ""}" data-toggle-categorization-rule="${transaction.id}" type="button" aria-label="${transaction.categorizationRuleLineId === transaction.lineId ? "Remove" : "Set"} always-categorize rule for ${escapeHtml(transaction.payee)}" title="${transaction.categorizationRuleLineId === transaction.lineId ? "Always categorizing this payee this way - click to remove the rule" : "Always categorize this payee this way"}">🔒</button>` : ""}
              <div class="row-account-actions">
                ${state.accounts.length ? `<label class="row-field row-select"><small>Account</small><select data-bank-stream-account="${transaction.id}"><option value="">Not linked</option>${accountOptions(transaction.accountId || "")}</select></label>` : ""}
                ${state.accounts.length && !transaction.accountId ? `<button class="icon-button" data-ai-suggest-account="${transaction.id}" type="button" aria-label="Suggest an account with AI for ${escapeHtml(transaction.payee)}" title="No history match for this payee - ask AI to suggest an account">✨</button>` : ""}
                <div class="row-actions">
                  <button class="icon-button" data-accept-import="${transaction.id}" type="button" aria-label="Accept ${escapeHtml(transaction.payee)}">✓</button>
                  <button class="icon-button" data-assign-iou="${transaction.id}" type="button" aria-label="Split with a friend ${escapeHtml(transaction.payee)}">👥</button>
                  <button class="icon-button ${transaction.transferMatch ? "has-transfer-match" : ""}" data-move-to-transfer="${transaction.id}" type="button" aria-label="Move ${escapeHtml(transaction.payee)} to Transfers">⇄</button>
                  <button class="icon-button danger-button" data-dismiss-import="${transaction.id}" type="button" aria-label="Dismiss ${escapeHtml(transaction.payee)}">×</button>
                </div>
              </div>
              ${tagChipsHtml(transaction.tags, "data-remove-bank-stream-tag", "data-add-bank-stream-tag", transaction.id)}
            </div>
          `).join("") || `<div class="empty-inline">No bank stream items waiting</div>`}
        </section>
      </aside>
    </section>`;
}

function renderPaychecks() {
  ensurePaycheckRecurrenceData();
  ensureAccountsData();
  const paycheckOptions = state.paychecks
    .filter((paycheck) => paycheckActiveInMonth(paycheck, `${state.budget.month}-01`, monthEndDateKey(state.budget.month)))
    .map((paycheck) => `<option value="${paycheck.date}">${paycheck.name} - ${money.format(paycheck.amount)}</option>`).join("");
  const lineOptions = allLines().map((line) => `<option value="${line.id}">${line.category} - ${line.name}</option>`).join("");
  return `
    <section class="work-grid">
      <div class="main-stack">
        <section class="card">
          <div class="section-head"><div><span class="card-label">Cash flow</span><h3>Paycheck/Income plan</h3></div><button id="addPaycheckButton" type="button">+ Add paycheck/income</button></div>
          <div class="paycheck-builder">
            <label>Paycheck/Income<select id="paycheckSelect">${paycheckOptions}</select></label>
            <label>Subcategory<select id="paycheckLineSelect">${lineOptions}</select></label>
            <label>Amount<input id="paycheckAmountSelect" type="number" min="0" step="0.01" placeholder="150.48"></label>
            <button id="assignBillButton" type="button">Assign bill</button>
          </div>
          <div class="paycheck-grid">
            ${state.paychecks
              .map((paycheck, index) => ({ paycheck, index }))
              .filter(({ paycheck }) => paycheckActiveInMonth(paycheck, `${state.budget.month}-01`, monthEndDateKey(state.budget.month)))
              .map(({ paycheck, index }) => {
              const assigned = paycheckAssignedAmount(paycheck);
              const monthStart = `${state.budget.month}-01`;
              const monthEnd = monthEndDateKey(state.budget.month);
              const isRecurring = !["once", "bonus"].includes(paycheck.recurrence || "once");
              const occurrencesThisMonth = isRecurring
                ? (state.paycheckOccurrences || [])
                  .filter((occurrence) => occurrence.seriesId === paycheck.id && occurrence.date >= monthStart && occurrence.date <= monthEnd)
                  .sort((a, b) => a.date.localeCompare(b.date))
                : [];
              const monthlyIncome = paycheckMonthlyIncome(paycheck);
              return `<article class="paycheck-card">
                <div class="paycheck-card-header">
                  <input class="paycheck-name-input" data-income-name="${index}" value="${escapeHtml(paycheck.name)}" aria-label="Name for this paycheck/income entry">
                  <div class="paycheck-card-actions">
                    <input class="money-input paycheck-amount-input" data-paycheck-amount="${index}" type="number" step="0.01" value="${paycheck.amount}" aria-label="Amount for ${escapeHtml(paycheck.name)}">
                    <button class="icon-button danger-button" data-delete-paycheck="${index}" type="button" aria-label="Delete ${escapeHtml(paycheck.name)}">×</button>
                  </div>
                </div>
                <label class="paycheck-recurrence-field">Date<input type="date" data-paycheck-date="${index}" value="${paycheck.date}" aria-label="Date for ${escapeHtml(paycheck.name)}"></label>
                <label class="paycheck-recurrence-field">Repeat<select data-paycheck-recurrence="${index}" aria-label="How often ${escapeHtml(paycheck.name)} repeats">${Object.entries(paycheckRecurrenceLabels).map(([value, label]) => `<option value="${value}" ${paycheck.recurrence === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
                ${isRecurring ? `<label class="paycheck-recurrence-field">End date (optional)<input type="date" data-paycheck-end-date="${index}" value="${paycheck.endDate || ""}" aria-label="Stop ${escapeHtml(paycheck.name)} from repeating after this date"></label>` : ""}
                ${state.accounts.length ? `<label class="paycheck-recurrence-field">Deposit to<select data-paycheck-deposit-account="${index}" aria-label="Deposit account for ${escapeHtml(paycheck.name)}"><option value="">Not linked</option>${accountOptions(paycheck.depositAccountId || "", { excludeType: "credit_card" })}</select></label>` : ""}
                <div class="mini-tags">${paycheck.assignedLineIds.map((id) => `<span>${escapeHtml(lineName(id))}<button type="button" class="mini-tag-remove" data-remove-paycheck-line="${index}:${id}" aria-label="Remove ${escapeHtml(lineName(id))} from ${escapeHtml(paycheck.name)}">×</button></span>`).join("")}</div>
                ${occurrencesThisMonth.length ? `<div class="pay-dates-this-month">
                  <small>Pay dates in ${formatMonth(state.budget.month)} (edit or delete individually)</small>
                  ${occurrencesThisMonth.map((occurrence) => `
                    <div class="paycheck-occurrence-row">
                      <input type="date" data-occurrence-date="${occurrence.id}" value="${occurrence.date}" aria-label="Date for this ${escapeHtml(paycheck.name)} payment">
                      <input class="money-input" type="number" step="0.01" data-occurrence-amount="${occurrence.id}" value="${occurrence.amount}" aria-label="Amount for this ${escapeHtml(paycheck.name)} payment">
                      <button class="icon-button danger-button" data-delete-occurrence="${occurrence.id}" type="button" aria-label="Delete the ${formatShortDate(occurrence.date)} payment for ${escapeHtml(paycheck.name)}">×</button>
                    </div>
                  `).join("")}
                </div>` : ""}
                <div class="split-stat" data-paycheck-split="${index}"><span>Income ${money.format(monthlyIncome)}</span><b>Assigned ${money.format(assigned)}</b></div>
              </article>`;
            }).join("")}
          </div>
        </section>
      </div>
      <aside class="side-stack">
        <section class="card"><div class="card-label">Calendar</div><h3>Due-date flow</h3>${(() => {
          const { due, paid } = dueDateRows();
          return `${due.length ? due.map((item) => compactRow(item.name, item.date, "Due")).join("") : `<div class="empty-inline">Nothing due right now</div>`}${paid.length ? `<details class="due-date-paid-toggle"><summary>Paid this month (${paid.length})</summary>${paid.map((item) => compactRow(item.name, item.date, "Paid")).join("")}</details>` : ""}`;
        })()}</section>
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

// A plain Google Maps deep link — no API key, no billing, works for any
// free-text address or place name. Opens in a new tab so the household
// calendar stays put behind it.
function directionsLinkHtml(location) {
  if (!location) return "";
  const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(location)}`;
  return `<a class="pill-button directions-link" href="${url}" target="_blank" rel="noopener noreferrer" title="Get directions to ${escapeHtml(location)}">📍 Directions</a>`;
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

const DEFAULT_CATEGORY_COLOR = "#13936d";
const categoryColorPalette = ["#13936d", "#3569d4", "#d99a24", "#e05252", "#8a5cf6", "#0891b2", "#c2410c", "#be185d"];
function categoryColor(index) {
  return categoryColorPalette[index % categoryColorPalette.length];
}

// Every category has always been created with the exact same hardcoded
// color (no color picker has ever existed), so any category still carrying
// that literal default has never been intentionally customized - safe to
// backfill it with a real, distinct color from the palette by its position.
// A category already carrying something else (a future picker, or a
// household's own edited data) is left untouched.
function ensureCategoryColors() {
  state.budget.categories.forEach((category, index) => {
    if (!category.color || category.color === DEFAULT_CATEGORY_COLOR) {
      category.color = categoryColor(index);
    }
  });
}

function renderCalendar() {
  ensureAssigneesData();
  const calendarMembers = calendarAssigneeOptions();
  const today = dateKey(new Date());
  // Personalizes the two "what's due" panels to the signed-in user: once
  // they've marked their own part done, it drops off their view even if
  // other assignees on the same chore/birthday haven't finished theirs yet.
  const viewerKey = sessionUser?.email || "";
  // Overdue items stay visible no matter how old (they still need doing),
  // but anything not yet due is capped to the next 7 days - a chore due in
  // three weeks shouldn't crowd out this week's actual to-dos just because
  // fewer than UPCOMING_LIST_LIMIT items happen to be due soon.
  const sevenDaysAhead = dateKey(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const choreRows = state.calendar.chores
    .map((chore, index) => ({ chore, index, occurrence: nextPendingChoreOccurrence(chore, viewerKey) }))
    .filter((row) => row.occurrence && row.occurrence.date <= sevenDaysAhead)
    .sort((a, b) => a.occurrence.date.localeCompare(b.occurrence.date))
    .slice(0, UPCOMING_LIST_LIMIT);
  const annualRows = state.calendar.events
    .filter((event) => ANNUAL_EVENT_TYPES.includes(event.type))
    // Unlike the calendar grid (which shows every birthday/anniversary to
    // every member, so a household can see all of them at a glance), this
    // side panel is a personal to-do list - a birthday assigned only to
    // someone else shouldn't nag a viewer who has no part in wishing it.
    .filter((event) => isRelevantToViewer(event.assignees, viewerKey))
    .map((event) => ({ event, occurrence: nextPendingAnnualEventOccurrence(event, new Date(), viewerKey) }))
    .filter((row) => row.occurrence && row.occurrence.date <= sevenDaysAhead)
    .sort((a, b) => a.occurrence.date.localeCompare(b.occurrence.date))
    .slice(0, UPCOMING_LIST_LIMIT);
  return `
    <section class="work-grid calendar-layout">
      <div class="main-stack">
        <section class="card calendar-main-card">
          <div class="section-head">
            <div><span class="card-label">Household calendar</span><h3>Chores, birthdays, anniversaries and reminders</h3></div>
            <div class="button-row"><button id="addChoreButton" class="ghost" type="button">+ Add chore</button><button id="addBirthdayButton" class="ghost" type="button">+ Add birthday</button><button id="addAnniversaryButton" class="ghost" type="button">+ Add anniversary</button><button id="addReminderButton" class="ghost" type="button">+ Add reminder</button></div>
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
            <label>Date<input name="date" type="date" value="${state.budget.month}-01" required></label>
            <label data-date-time-field>Time<input name="time" type="text" inputmode="numeric" class="time24-input" placeholder="HH:MM" maxlength="5" value="09:00"></label>
            <label data-annual-time-field hidden>Remind me at<input name="annualTime" type="text" inputmode="numeric" class="time24-input" placeholder="HH:MM" maxlength="5" value="09:00"></label>
            <label data-plain-reminder-field hidden>Remind me on<input name="reminderAtDate" type="date"></label>
            <label data-plain-reminder-field hidden>at<input name="reminderAtTime" type="text" inputmode="numeric" class="time24-input" placeholder="HH:MM" maxlength="5"></label>
            <label data-plain-reminder-field hidden>Repeat<select name="reminderRecurrence"><option value="once">Once</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
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
            <label data-location-field>Location (optional)<input name="location" placeholder="123 Main St or a place name"><span data-location-directions-preview></span></label>
            <label data-chore-recurrence-field>Repeat<select name="recurrence"><option value="once">Once</option><option value="weekly" selected>Weekly</option><option value="biweekly">Every 2 weeks</option><option value="triweekly">Every 3 weeks</option><option value="monthly">Monthly</option><option value="every3months">Every 3 months</option><option value="every4months">Every 4 months</option><option value="every6months">Every 6 months</option><option value="yearly">Yearly</option></select></label>
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
              ${cell.items.map((item) => {
                // Escalation only makes sense for chores/reminders, which
                // track an ongoing "still not done" state - an annual
                // birthday/anniversary chip has its own separate "wished"
                // tracking and isn't meant to look alarming once its date
                // has simply passed within the visible month grid.
                const escalates = item.sourceKind === "chore" || item.type === "reminder";
                const itemDateKey = `${state.budget.month}-${item.date.slice(3)}`;
                const daysOverdue = escalates && itemDateKey < today ? Math.round((new Date(`${today}T00:00:00`) - new Date(`${itemDateKey}T00:00:00`)) / 86400000) : 0;
                const overdueClass = daysOverdue > 7 ? "overdue-severe" : daysOverdue > 2 ? "overdue-moderate" : daysOverdue > 0 ? "overdue-mild" : "";
                return `<button class="event ${item.eventType || item.type} ${overdueClass}" style="border-left:3px solid ${memberColor(item.assignees?.[0]?.key)}" data-edit-calendar-item="${item.sourceKind}:${item.sourceId}" type="button" title="Edit ${escapeHtml(item.title)}${assigneeNames(item.assignees) ? ` · ${escapeHtml(assigneeNames(item.assignees))}` : ""}${daysOverdue ? ` · ${daysOverdue}d overdue` : ""}">${item.recurring ? `<span class="event-recurring-badge" aria-hidden="true">🔁</span> ` : ""}${daysOverdue ? `<span class="event-overdue-badge" aria-hidden="true">⚠${daysOverdue}d</span> ` : ""}${escapeHtml(item.title)}</button>`;
              }).join("")}
            </div>
          `).join("")}</div>
        </section>
      </div>
      <aside class="side-stack">
        <section class="card"><div class="card-label">Daily planner</div><h3>Upcoming schedule</h3>${upcomingScheduleItems().length ? upcomingScheduleItems().map((item) => calendarManageRow(item)).join("") : `<div class="empty-inline">Nothing scheduled in the next 7 days</div>`}</section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">What to do</span><h3>Chore rotation</h3></div><div class="button-row"><button id="sideAddChoreButton" class="ghost" type="button">Add chore</button><button id="sideAddReminderButton" class="ghost" type="button">Add reminder</button></div></div>
          ${choreRows.length ? choreRows.map(({ chore, index, occurrence }) => {
            const overdue = occurrence.date < today;
            return `<div class="compact-row ${overdue ? "overdue" : ""}">
              <div>${assigneeDots(chore.assignees)}<strong>${escapeHtml(chore.title)}</strong><small>${occurrence.date}${overdue ? " · Past due" : ""} · ${escapeHtml(assigneeNames(chore.assignees) || "Unassigned")} · ${choreCadenceLabel(chore)}</small>${directionsLinkHtml(chore.location)}</div>
              <div class="chore-complete-group">${choreCompletionButtons(chore, index, occurrence.date)}</div>
              <button class="icon-button" data-edit-calendar-item="chore:${chore.id}" type="button" aria-label="Edit ${escapeHtml(chore.title)}">✎</button>
              <button class="icon-button danger-button" data-delete-calendar-item="chore:${chore.id}" type="button" aria-label="Remove ${escapeHtml(chore.title)}">×</button>
            </div>`;
          }).join("") : `<div class="empty-inline">No recurring chores</div>`}
        </section>
        <section class="card">
          <div class="section-head"><div><span class="card-label">Remember</span><h3>Birthdays &amp; anniversaries</h3></div><div class="button-row"><button id="sideAddBirthdayButton" class="ghost" type="button">Add birthday</button><button id="sideAddAnniversaryButton" class="ghost" type="button">Add anniversary</button></div></div>
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
            ${state.notes.activeView === "reminders" ? `<label>Reminder date<input name="reminderDate" type="date" required></label><label>at<input name="reminderTime" type="text" inputmode="numeric" class="time24-input" placeholder="HH:MM" maxlength="5" value="09:00" required></label>` : ""}
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

// Same details/radio-picker convention as Documents' note-link picker
// (renderDocumentNoteLinkPicker), just pointed the other way: here the
// bill link lives on the note, keyed to a real budget-line id from
// billsRows() so it survives a bill being renamed.
function renderNoteBillLinkPicker(note) {
  const bills = billsRows();
  return `<details class="note-label-picker note-bill-link-picker">
    <summary title="Link to a bill" aria-label="${note.billLineId ? "Linked to a bill" : "Link to a bill"}">🧾</summary>
    <div class="note-label-picker-options">
      <label>
        <input type="radio" name="note-bill-${note.id}" data-note-bill-link="${note.id}" value="" ${!note.billLineId ? "checked" : ""}>
        <span>No linked bill</span>
      </label>
      ${bills.length ? bills.map((bill) => `<label>
        <input type="radio" name="note-bill-${note.id}" data-note-bill-link="${note.id}" value="${bill.id}" ${note.billLineId === bill.id ? "checked" : ""}>
        <span>${escapeHtml(bill.name)}</span>
      </label>`).join("") : `<small>No bills yet</small>`}
    </div>
  </details>`;
}

function linkedBillName(note) {
  if (!note.billLineId) return null;
  const bill = billsRows().find((item) => item.id === note.billLineId);
  return bill ? bill.name : null;
}

function renderNoteCard(note) {
  const { open, completed } = bucketChecklistItems(note.checklist);
  const checklistRow = (item) => `<div class="note-check-row ${item.done ? "done" : ""} ${item.parentId ? "child-item" : ""}" draggable="true" data-drag-checklist-item="${note.id}:${item.id}">
    <span class="note-check-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
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
    ${linkedBillName(note) ? `<div class="note-reminder note-linked-bill">🧾 Linked to ${escapeHtml(linkedBillName(note))}</div>` : ""}
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
      <details class="note-toolbar-popover"><summary title="Set reminder" aria-label="Set reminder">◷</summary><div class="note-toolbar-popover-panel"><label>Reminder date<input type="date" data-note-reminder-date="${note.id}" value="${escapeHtml((note.reminder || "").slice(0, 10))}"></label><label>Time<input type="text" inputmode="numeric" class="time24-input" placeholder="HH:MM" maxlength="5" data-note-reminder-time="${note.id}" value="${escapeHtml((note.reminder || "").slice(11, 16))}"></label></div></details>
      <div class="note-toolbar-labels">${renderNoteLabelPicker(note, true)}</div>
      ${renderNoteBillLinkPicker(note)}
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
const journalMoodEmoji = { Happy: "😊", Calm: "😌", Neutral: "😐", Stressed: "😖", Sad: "😢", Grateful: "🙏", Excited: "🤩" };
const journalMoodColor = { Happy: "#f59e0b", Calm: "#38bdf8", Neutral: "#94a3b8", Stressed: "#ef4444", Sad: "#6366f1", Grateful: "#10b981", Excited: "#ec4899" };

function ensureJournalData() {
  privateData.journal ||= { entries: [] };
  privateData.journal.entries ||= [];
}

function sortedJournalEntries() {
  return [...privateData.journal.entries].sort((a, b) =>
    (b.entryDate || "").localeCompare(a.entryDate || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function journalEntryDateLabel(entryDate) {
  if (!entryDate) return "";
  const today = dateKey(new Date());
  const yesterday = dateKey(new Date(Date.now() - 86400000));
  if (entryDate === today) return "Today";
  if (entryDate === yesterday) return "Yesterday";
  return formatShortDate(entryDate);
}

function moodPickerChips({ selected, namePrefix, compact }) {
  return journalMoods.map((mood) => `
    <button type="button" class="mood-chip ${compact ? "mood-chip-compact" : ""} ${selected === mood ? "active" : ""}" data-mood-choice="${namePrefix}:${mood}" style="--mood-color:${journalMoodColor[mood]}" aria-pressed="${selected === mood}" title="${mood}">
      <span class="mood-emoji">${journalMoodEmoji[mood]}</span>${compact ? "" : `<small>${mood}</small>`}
    </button>`).join("");
}

// Builds the plain-text summary sent to the server for the Journal's
// on-demand "gentle reflection" feature. Deliberately scoped to the current
// viewer's own day only (their own completed chores/reminders, not other
// household members'), matching Journal's own privacy boundary even though
// this data technically comes from shared household state - titles only,
// never note bodies or journal content itself. Returns "" when there's
// nothing to reflect on, so the caller can skip the request entirely.
function todaysJournalContext() {
  const today = dateKey(new Date());
  const viewerKey = sessionUser?.email || "";
  const lines = [];

  const completedChores = state.calendar.chores
    .filter((chore) => (chore.completedBy?.[today] || []).includes(viewerKey))
    .map((chore) => chore.title);
  if (completedChores.length) lines.push(`Completed chores today: ${completedChores.join(", ")}.`);

  const completedReminders = state.calendar.events
    .filter((event) => event.type === "reminder" && event.date === today && (event.completedBy || []).includes(viewerKey))
    .map((event) => event.title);
  if (completedReminders.length) lines.push(`Completed reminders today: ${completedReminders.join(", ")}.`);

  const wishedToday = state.calendar.events
    .filter((event) => ANNUAL_EVENT_TYPES.includes(event.type) && ((event.wishedBy || {})[String(new Date().getFullYear())] || []).includes(viewerKey) && dateKey(annualEventDate(event, new Date().getFullYear())) === today)
    .map((event) => annualEventDisplayTitle(event));
  if (wishedToday.length) lines.push(`Wished today: ${wishedToday.join(", ")}.`);

  const notesToday = (state.notes?.entries || [])
    .filter((note) => !note.trashed && (note.updatedAt || "").slice(0, 10) === today)
    .map((note) => note.title || "an untitled note");
  if (notesToday.length) lines.push(`Notes worked on today: ${notesToday.join(", ")}.`);

  return lines.join(" ");
}

function renderJournal() {
  if (!privateData) return "";
  ensureJournalData();
  const entries = sortedJournalEntries();
  const draft = journalComposerDraft || {};
  return `
    <section class="journal-layout">
      <div class="section-head"><div><span class="card-label">Journal</span><h3>Your private journal</h3><p class="private-note">Private to you — never shared with other household members.</p></div></div>
      <form id="journalComposer" class="journal-composer card">
        <div class="journal-composer-head">
          <span class="journal-composer-icon">📔</span>
          <div><span class="card-label">New entry</span><h3>Capture today</h3></div>
        </div>
        <div class="journal-composer-row">
          <label>Date<input name="entryDate" type="date" value="${draft.entryDate || dateKey(new Date())}" required></label>
          <label class="journal-title-field">Title<input name="title" placeholder="Give today a title" value="${escapeHtml(draft.title || "")}"></label>
        </div>
        <div class="journal-field-group">
          <span class="journal-field-label">Mood</span>
          <div class="mood-picker">${moodPickerChips({ selected: draft.mood || "", namePrefix: "composer" })}</div>
          <input type="hidden" name="mood" id="journalComposerMoodValue" value="${escapeHtml(draft.mood || "")}">
        </div>
        <label>🙏 Grateful for<input name="gratitude" placeholder="One thing you're grateful for today" value="${escapeHtml(draft.gratitude || "")}"></label>
        <label>Tags<input name="tags" placeholder="travel, family, work" value="${escapeHtml(draft.tags || "")}"></label>
        <textarea name="body" rows="4" placeholder="What happened today? How are you feeling?">${escapeHtml(draft.body || "")}</textarea>
        <div class="journal-composer-actions">
          <label class="journal-photo-picker">📷 Add photos<input name="photos" type="file" accept="image/*" multiple></label>
          <button type="button" id="journalReflectionButton" class="ghost" ${journalReflection?.loading ? "disabled" : ""}>${journalReflection?.loading ? "Thinking…" : "✨ Get a gentle reflection"}</button>
          <button type="submit">Save entry</button>
        </div>
        ${journalReflection && !journalReflection.loading ? `
          <div class="journal-reflection-preview ${journalReflection.isError ? "is-error" : ""}">
            <p>${escapeHtml(journalReflection.text)}</p>
            ${!journalReflection.isError ? `<button type="button" id="journalReflectionInsertButton" class="ghost">Use this</button>` : ""}
            <button type="button" id="journalReflectionDismissButton" class="icon-button" aria-label="Dismiss">×</button>
          </div>
        ` : ""}
      </form>
      <div class="journal-entries">
        ${entries.length ? entries.map(renderJournalEntry).join("") : `<div class="empty-inline journal-empty">📔 No journal entries yet — write your first one above.</div>`}
      </div>
    </section>`;
}

function renderJournalEntry(entry) {
  const moodColor = journalMoodColor[entry.mood] || "var(--line)";
  return `<article class="journal-entry card" data-journal-id="${entry.id}" style="--mood-color:${moodColor}">
    <div class="journal-entry-head">
      <i class="journal-mood-bar"></i>
      <div class="journal-entry-heading">
        <input class="journal-title-input" data-journal-title="${entry.id}" value="${escapeHtml(entry.title || "")}" placeholder="Untitled entry" aria-label="Entry title">
        <div class="journal-entry-date-row">
          <span class="journal-entry-date-label">${journalEntryDateLabel(entry.entryDate)}</span>
          <input class="journal-date-input" data-journal-date="${entry.id}" type="date" value="${entry.entryDate || ""}" aria-label="Entry date">
        </div>
      </div>
      <button class="icon-button danger-button" data-delete-journal-entry="${entry.id}" type="button" aria-label="Delete entry">×</button>
    </div>
    <div class="mood-picker mood-picker-compact" data-journal-mood-entry="${entry.id}">${moodPickerChips({ selected: entry.mood || "", namePrefix: entry.id, compact: true })}</div>
    <input class="journal-gratitude-input" data-journal-gratitude="${entry.id}" value="${escapeHtml(entry.gratitude || "")}" placeholder="🙏 Grateful for..." aria-label="Grateful for">
    <textarea class="journal-body-input" data-journal-body="${entry.id}" rows="3" placeholder="Write here..." aria-label="Entry body">${escapeHtml(entry.body || "")}</textarea>
    <input class="journal-tags-input" data-journal-tags="${entry.id}" value="${escapeHtml((entry.tags || []).join(", "))}" placeholder="Tags (comma separated)" aria-label="Tags">
    ${entry.tags?.length ? `<div class="journal-tags">${entry.tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    ${entry.photos?.length ? `<div class="journal-photos">${entry.photos.map((photo) => `<div class="journal-photo"><img src="${photo.dataUrl}" alt="Journal photo"><button class="icon-button danger-button" data-delete-journal-photo="${entry.id}:${photo.id}" type="button" aria-label="Remove photo">×</button></div>`).join("")}</div>` : ""}
    <label class="journal-photo-picker ghost">📷 Add photo<input data-journal-photo-input="${entry.id}" type="file" accept="image/*" multiple></label>
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
      <small>${escapeHtml(formatPlanAnchorDate(task))}${task.goalName ? ` · 🎯 ${escapeHtml(task.goalName)}` : ""}</small>
    </div>
    <select class="plan-task-goal-select" data-plan-task-goal="${task.id}" aria-label="Link ${escapeHtml(task.title)} to a goal">
      <option value="">No goal</option>
      ${state.goals.sinkingFunds.map((fund) => `<option value="${escapeHtml(fund.name)}" ${task.goalName === fund.name ? "selected" : ""}>${escapeHtml(fund.name)}</option>`).join("")}
    </select>
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
          <label>Start time (optional)<input name="startTime" type="text" inputmode="numeric" class="time24-input" placeholder="HH:MM" maxlength="5" value="${escapeHtml(editingTask?.startTime || "")}"></label>
          <label>Duration (min)<input name="durationMinutes" type="number" min="5" step="5" value="${formDuration}"></label>
          <label>End time<input name="endTimeDisplay" type="text" class="time24-input" value="${escapeHtml(formEndTime)}" readonly tabindex="-1"></label>
          <label>Repeat<select name="recurrence">${Object.entries(planRecurrenceLabels).map(([value, label]) => `<option value="${value}" ${editingTask && editingTask.recurrence === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
          <button type="submit">${editingTask ? "Save changes" : "Add"}</button>
          ${editingTask ? `<button class="ghost" id="cancelPlanTaskEditButton" type="button">Cancel</button>` : ""}
        </form>
        <form id="actualLogForm" class="plan-task-form plan-task-form-daily card plan-actual-log-form">
          <span class="plan-form-col-label">${editingLog ? "Edit what actually happened" : "Log what actually happened"} (${dayLabel})</span>
          <label>Start time<input name="logStartTime" type="text" inputmode="numeric" class="time24-input" placeholder="HH:MM" maxlength="5" value="${escapeHtml(editingLog?.startTime || "")}" required></label>
          <label>End time<input name="logEndTime" type="text" inputmode="numeric" class="time24-input" placeholder="HH:MM" maxlength="5" value="${escapeHtml(editingLog?.endTime || "")}" required></label>
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
  return `<div class="plan-task-row plan-task-row-daily ${done ? "done" : ""}" data-plan-task-id="${task.id}">
    <input type="checkbox" data-plan-task-check="${task.id}" ${done ? "checked" : ""} aria-label="Complete ${escapeHtml(task.title)}">
    <div class="plan-task-copy">
      <input class="plan-task-title" data-plan-task-title="${task.id}" value="${escapeHtml(task.title)}" aria-label="Task title">
      ${task.recurrence && task.recurrence !== "none" ? `<small>${planRecurrenceLabels[task.recurrence]}</small>` : ""}
      ${actualLabel ? `<small>${escapeHtml(actualLabel)}</small>` : ""}
    </div>
    <button class="icon-button" data-schedule-plan-task="${task.id}" type="button" aria-label="Schedule ${escapeHtml(task.title)}" title="Give this a start time">🕐</button>
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

async function uploadDocumentFile(file, folderId) {
  const { documentId, uploadUrl } = await api("/api/documents/upload-url", {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      folderId: folderId || null
    })
  });
  // In MEMORY_DB (test/preview) mode the server returns a placeholder URL
  // rather than a real signed GCS URL, since there is no bucket to upload
  // to - only real deployments with GCS_BUCKET configured issue an
  // http(s) signed URL that this PUT actually reaches.
  if (/^https?:\/\//.test(uploadUrl)) {
    const uploadResponse = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
    if (!uploadResponse.ok) throw new Error("Upload to storage failed");
  }
  await api(`/api/documents/${documentId}/confirm`, { method: "POST" });
  return documentId;
}

function readAllDirectoryEntries(directoryReader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    function readBatch() {
      // Chrome's directory reader only returns a batch at a time, even
      // for small folders - it must be called repeatedly until it
      // returns an empty array to get the full listing.
      directoryReader.readEntries((batch) => {
        if (!batch.length) { resolve(entries); return; }
        entries.push(...batch);
        readBatch();
      }, reject);
    }
    readBatch();
  });
}

async function readEntryTree(entry, path, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, relativePath: `${path}${entry.name}` });
  } else if (entry.isDirectory) {
    const entries = await readAllDirectoryEntries(entry.createReader());
    for (const child of entries) {
      await readEntryTree(child, `${path}${entry.name}/`, out);
    }
  }
}

async function collectFilesFromDataTransferItems(items) {
  const out = [];
  const entries = Array.from(items).map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  for (const entry of entries) {
    await readEntryTree(entry, "", out);
  }
  return out;
}

function buildTreeFromRelativePaths(fileList) {
  return Array.from(fileList).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

async function runBulkDocumentUpload(fileEntries) {
  if (!fileEntries.length) return;
  documentsUploading = true;
  // Cache of already-created-or-existing folders for this run, keyed by
  // "parentId::name" - avoids creating duplicate subfolders when several
  // files in the same drop share a folder, without needing a server
  // round-trip reload between every file.
  const folderCache = new Map();
  documentsData.folders.forEach((folder) => {
    folderCache.set(`${folder.parentId || ""}::${folder.name}`, folder.id);
  });
  let failures = 0;
  // Keyed by message so uploading a whole folder that hits the same failure
  // repeatedly (e.g. several files of an unsupported type) surfaces one
  // clear reason instead of a wall of duplicate toasts - or worse, none at
  // all, since a bare "N of M failed" count gives no way to tell why without
  // opening devtools.
  const failureMessages = new Map();
  for (let index = 0; index < fileEntries.length; index += 1) {
    const { file, relativePath } = fileEntries[index];
    documentsUploadProgress = { done: index, total: fileEntries.length, currentName: file.name };
    render();
    try {
      const segments = relativePath.split("/").slice(0, -1).filter(Boolean);
      let folderId = documentsCurrentFolderId || null;
      for (const segment of segments) {
        const key = `${folderId || ""}::${segment}`;
        if (folderCache.has(key)) {
          folderId = folderCache.get(key);
        } else {
          const created = await api("/api/documents/folders", { method: "POST", body: JSON.stringify({ name: segment, parentId: folderId || null }) });
          folderCache.set(key, created.id);
          folderId = created.id;
        }
      }
      await uploadDocumentFile(file, folderId);
    } catch (error) {
      failures += 1;
      const message = error?.message || "Upload failed";
      failureMessages.set(message, (failureMessages.get(message) || 0) + 1);
    }
  }
  documentsUploading = false;
  documentsUploadProgress = null;
  await loadDocumentsData(false);
  render();
  if (failures) {
    const reasons = [...failureMessages.entries()].map(([message, count]) => `${message}${count > 1 ? ` (${count})` : ""}`).join("; ");
    showToast(`${failures} of ${fileEntries.length} file${fileEntries.length === 1 ? "" : "s"} failed to upload: ${reasons}`);
  }
}

const DOCUMENT_TYPE_BADGES = {
  "application/pdf": { label: "PDF", color: "#d64545" },
  "application/msword": { label: "DOC", color: "#2f6fdb" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { label: "DOC", color: "#2f6fdb" },
  "application/vnd.ms-excel": { label: "XLS", color: "#1f9d55" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { label: "XLS", color: "#1f9d55" },
  "text/csv": { label: "CSV", color: "#1f9d55" },
  "application/zip": { label: "ZIP", color: "#6b7280" },
  "text/plain": { label: "TXT", color: "#6b7280" }
};

function documentTypeBadge(item) {
  const known = DOCUMENT_TYPE_BADGES[item.contentType];
  if (known) return known;
  const ext = (item.name.split(".").pop() || "").toUpperCase().slice(0, 4);
  return { label: ext || "FILE", color: "#6b7280" };
}

// Draws onto a fixed-width canvas so every thumbnail is a similarly small,
// cheap-to-hold data URL regardless of the source image's real resolution.
async function rasterizeImageThumbnail(url) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = url;
  });
  const canvas = window.document.createElement("canvas");
  const scale = 200 / img.naturalWidth;
  canvas.width = 200;
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

// Renders just the PDF's first page via pdf.js (loaded from a CDN in
// index.html, like the existing Google Sign-In script tag) rather than
// parsing/rendering the whole document - this mirrors why bank-statement PDF
// parsing was kept server-side elsewhere (see the pdf-parse endpoint comment):
// a full client-side PDF library is only worth it for this one narrow,
// bounded job (one page, small canvas), not for arbitrary PDF processing.
async function rasterizePdfThumbnail(url) {
  const pdf = await pdfjsLib.getDocument(url).promise;
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 200 / baseViewport.width });
  const canvas = window.document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.85);
}

// Fire-and-forget: called from the render path, resolves later and triggers
// its own render() once the thumbnail is ready. The pending-state guard means
// re-entering this mid-flight (render() runs again before it resolves) is a
// harmless no-op rather than a duplicate fetch.
async function queueDocumentThumbnail(item) {
  if (documentsThumbnailCache.has(item.id)) return;
  documentsThumbnailCache.set(item.id, { kind: "pending" });
  try {
    let src = null;
    if (item.contentType?.startsWith("image/")) {
      const { url } = await api(`/api/documents/${item.id}/download-url`);
      if (/^https?:\/\//.test(url)) src = await rasterizeImageThumbnail(url);
    } else if (item.contentType === "application/pdf" && window.pdfjsLib) {
      const { url } = await api(`/api/documents/${item.id}/download-url`);
      if (/^https?:\/\//.test(url)) src = await rasterizePdfThumbnail(url);
    }
    documentsThumbnailCache.set(item.id, src ? { kind: "image", src } : { kind: "badge", ...documentTypeBadge(item) });
  } catch (error) {
    documentsThumbnailCache.set(item.id, { kind: "badge", ...documentTypeBadge(item) });
  }
  render();
}

// Shared by the thumbnail click, the menu's "Open" action, and the existing
// "Download" action - in a plain web app with no in-app viewer, opening and
// downloading a file are the same browser action, so they should also share
// the same "you opened this" tracking rather than only counting one of them.
async function openDocumentFile(documentId) {
  const { url } = await api(`/api/documents/${documentId}/download-url`);
  window.open(url, "_blank", "noopener");
  try {
    await api(`/api/documents/${documentId}/open`, { method: "POST" });
  } catch (error) {
    console.warn("Could not record document open", error);
  }
  await loadDocumentsData(false);
  render();
}

function formatDocumentOpenedDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Color-coded the same way a bill's due-date label is (see billRow): the
// closer the expiration, the more urgent the color, so a household scanning
// the Documents grid can spot an about-to-lapse insurance policy or lease
// without opening each file.
function documentExpiryBadge(item) {
  if (!item.expiryDate) return null;
  const days = Math.ceil((new Date(`${item.expiryDate}T00:00:00`) - new Date(dateKey(new Date()) + "T00:00:00")) / 86400000);
  if (days < 0) return { label: `Expired ${Math.abs(days)}d ago`, className: "danger" };
  if (days <= 30) return { label: `Expires in ${days}d`, className: "danger" };
  if (days <= 90) return { label: `Expires in ${days}d`, className: "warning" };
  return { label: `Expires ${formatShortDate(item.expiryDate)}`, className: "neutral" };
}

function documentOpenedLine(item) {
  if (!item.lastOpenedAt) return `<small class="documents-opened-meta muted">Not opened yet</small>`;
  const isYou = item.lastOpenedByName && item.lastOpenedByName === sessionUser?.name;
  const who = isYou ? "You" : escapeHtml(item.lastOpenedByName || "Someone");
  return `<small class="documents-opened-meta">${who} opened · ${formatDocumentOpenedDate(item.lastOpenedAt)}</small>`;
}

function documentThumbnailHtml(item) {
  if (item.status === "pending") {
    return `<span class="documents-thumb-badge" style="background:#9aa5b1">…</span>`;
  }
  const cached = documentsThumbnailCache.get(item.id);
  if (!cached || cached.kind === "pending") {
    queueDocumentThumbnail(item);
    const badge = documentTypeBadge(item);
    return `<span class="documents-thumb-badge" style="background:${badge.color}">${escapeHtml(badge.label)}</span>`;
  }
  if (cached.kind === "image") return `<img class="documents-thumb-img" src="${cached.src}" alt="">`;
  return `<span class="documents-thumb-badge" style="background:${cached.color}">${escapeHtml(cached.label)}</span>`;
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

function documentInfoPanelHtml(item) {
  if (documentsInfoExpandedId !== item.id) return "";
  const rows = [
    ["Type", item.contentType || "Unknown"],
    ["Size", formatFileSize(item.sizeBytes) || "Unknown"],
    ["Uploaded by", item.uploadedByName || "Unknown"],
    ["Uploaded", item.createdAt ? new Date(item.createdAt).toLocaleString() : "Unknown"],
    ["Last opened", item.lastOpenedAt ? `${item.lastOpenedByName || "Someone"} · ${new Date(item.lastOpenedAt).toLocaleString()}` : "Not opened yet"]
  ];
  return `<div class="documents-file-info-panel">
    ${rows.map(([label, value]) => `<div class="documents-file-info-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("")}
    <div class="documents-file-info-row">
      <span>Expires</span>
      <input type="date" class="documents-expiry-input" data-documents-expiry="${item.id}" value="${item.expiryDate || ""}" aria-label="Expiration date for ${escapeHtml(item.name)}">
    </div>
  </div>`;
}

function renderDocumentCard(item) {
  const linkedNote = item.noteId ? state.notes.entries.find((note) => note.id === item.noteId) : null;
  const wealthLabel = documentsWealthItemLabel(item);
  const expiryBadge = documentExpiryBadge(item);
  return `<div class="documents-file-card" data-document-id="${item.id}" draggable="true" data-drag-type="document" data-drag-id="${item.id}">
    <div class="documents-file-card-header">
      <strong class="documents-file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
      ${expiryBadge ? `<span class="documents-expiry-badge documents-expiry-${expiryBadge.className}">${escapeHtml(expiryBadge.label)}</span>` : ""}
      <details class="documents-item-menu">
        <summary class="documents-icon-btn" aria-label="More actions for ${escapeHtml(item.name)}">⋮</summary>
        <div class="documents-item-menu-options">
          <button type="button" data-documents-open-file="${item.id}">Open</button>
          <button type="button" data-documents-download="${item.id}">Download</button>
          <button type="button" data-documents-rename="${item.id}">Rename</button>
          <button type="button" data-documents-copy="${item.id}">Make a copy</button>
          <button type="button" data-documents-info="${item.id}">File information</button>
          <label class="documents-item-menu-move">Move to
            <select class="documents-move-select" data-documents-move="${item.id}" aria-label="Move to folder">
              <option value="">All documents (root)</option>
              ${documentsData.folders.map((folder) => `<option value="${folder.id}" ${item.folderId === folder.id ? "selected" : ""}>${escapeHtml(documentsFolderFullPath(folder.id))}</option>`).join("")}
            </select>
          </label>
          ${renderDocumentNoteLinkPicker(item)}
          ${renderDocumentWealthLinkPicker(item)}
          <button type="button" class="danger-button" data-documents-delete="${item.id}">Delete</button>
        </div>
      </details>
    </div>
    <button type="button" class="documents-file-thumb" data-documents-open-file="${item.id}" aria-label="Open ${escapeHtml(item.name)}">
      ${documentThumbnailHtml(item)}
    </button>
    <div class="documents-file-meta">
      <small>${[formatFileSize(item.sizeBytes), item.status === "pending" ? "Uploading…" : item.contentType].filter(Boolean).join(" · ")}</small>
      ${documentOpenedLine(item)}
      ${linkedNote ? `<small class="documents-linked-note">Linked to “${escapeHtml(linkedNote.title || "Untitled note")}”</small>` : ""}
      ${wealthLabel ? `<small class="documents-linked-note">Tagged to ${escapeHtml(wealthLabel)}</small>` : ""}
    </div>
    ${documentInfoPanelHtml(item)}
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
  return `<section class="documents-layout" data-documents-os-drop-zone>
    <p class="muted">Shared with your whole household — deeds, patta, tax receipts and other property documents. Drag and drop files or whole folders in to upload.</p>
    <div class="documents-toolbar">
      <div class="documents-breadcrumb">
        <button type="button" data-documents-open-folder="" data-documents-drop-target="" class="${!currentFolderId ? "active" : ""}">All documents</button>
        ${breadcrumb.map((folder) => `<span aria-hidden="true">/</span><button type="button" data-documents-open-folder="${folder.id}" data-documents-drop-target="${folder.id}" class="${currentFolderId === folder.id ? "active" : ""}">${escapeHtml(folder.name)}</button>`).join("")}
      </div>
      <div class="documents-actions">
        <button type="button" data-documents-new-folder>+ New folder</button>
        <label class="documents-upload-button ${documentsUploading ? "disabled" : ""}">
          ${documentsUploading ? "Uploading…" : "+ Upload"}
          <input type="file" multiple data-documents-file-input ${documentsUploading ? "disabled" : ""}>
        </label>
        <label class="documents-upload-button ${documentsUploading ? "disabled" : ""}">
          + Upload folder
          <input type="file" webkitdirectory multiple data-documents-folder-input ${documentsUploading ? "disabled" : ""}>
        </label>
      </div>
    </div>
    ${documentsUploadProgress ? `<p class="documents-upload-progress">Uploading ${documentsUploadProgress.done + 1} of ${documentsUploadProgress.total}: ${escapeHtml(documentsUploadProgress.currentName)}</p>` : ""}
    ${subfolders.length ? `<div class="documents-folder-grid">
      ${subfolders.map((folder) => `<div class="documents-folder-card" draggable="true" data-drag-type="folder" data-drag-id="${folder.id}" data-documents-drop-target="${folder.id}">
        <button type="button" class="documents-folder-open" data-documents-open-folder="${folder.id}" title="${escapeHtml(folder.name)}">📁 ${escapeHtml(folder.name)}</button>
        <div class="documents-folder-card-actions">
          <button type="button" class="documents-icon-btn" data-documents-rename-folder="${folder.id}" title="Rename folder" aria-label="Rename ${escapeHtml(folder.name)} folder">✎</button>
          ${renderFolderWealthLinkPicker(folder)}
          <button type="button" class="documents-icon-btn danger-button" data-documents-delete-folder="${folder.id}" title="Delete folder" aria-label="Delete ${escapeHtml(folder.name)} folder">×</button>
        </div>
        ${folder.wealthItemId ? `<small class="documents-linked-note">Tagged to ${escapeHtml(wealthItemLabel(folder.wealthItemType, folder.wealthItemId) || "")}</small>` : ""}
      </div>`).join("")}
    </div>` : ""}
    ${currentDocuments.length ? `<div class="documents-file-grid">${currentDocuments.map(renderDocumentCard).join("")}</div>` : `<p class="muted">No documents in this folder yet. Drag and drop files or folders here to upload.</p>`}
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
      showToast(`${file.name} is larger than 5MB and was skipped.`);
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
  const isExpanded = expandedDecisionId === decision.id;
  return `<div class="card decision-card ${isDecided ? "is-decided" : ""}">
    <div class="decision-card-header">
      <button type="button" class="decision-expand-toggle" data-toggle-decision="${decision.id}" aria-expanded="${isExpanded}" aria-label="${isExpanded ? "Collapse" : "Expand"} ${escapeHtml(decision.title)}">${isExpanded ? "▲" : "▼"}</button>
      <input class="decision-title-input" data-decision-title="${decision.id}" value="${escapeHtml(decision.title)}" aria-label="Decision title">
      <span class="pill ${isDecided ? "" : "pill-open"}">${isDecided ? "Decided" : "Open"}</span>
      <button class="icon-button danger-button" data-delete-decision="${decision.id}" type="button" aria-label="Delete ${escapeHtml(decision.title)}">×</button>
    </div>
    ${isDecided ? `<div class="decision-outcome">
      <strong>Outcome:</strong> ${escapeHtml(decision.outcome) || "<em>No outcome noted</em>"}
      <small>${decision.decidedAt ? ` · ${decision.decidedAt.slice(0, 10)}` : ""}</small>
      <button class="ghost" data-reopen-decision="${decision.id}" type="button">Reopen</button>
    </div>` : ""}
    ${isExpanded ? `
    <textarea class="decision-notes-input" data-decision-notes="${decision.id}" placeholder="Any context worth remembering (optional)">${escapeHtml(decision.notes)}</textarea>
    <div class="decision-attachments">
      ${decision.attachments.map((attachment) => decisionAttachmentRow(decision.id, attachment)).join("")}
      ${decision.attachments.length < DECISION_ATTACHMENT_MAX_COUNT ? `<label class="decision-attachment-picker ghost">+ Attach a file<input data-decision-attachment-input="${decision.id}" type="file" multiple></label>` : ""}
    </div>
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
    ` : `<div class="decision-collapsed-summary muted">${decision.pros.length} pro${decision.pros.length === 1 ? "" : "s"} · ${decision.cons.length} con${decision.cons.length === 1 ? "" : "s"}${decision.notes ? " · has notes" : ""}</div>`}
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

function ensureIOUsData() {
  state.ious ||= [];
  state.ious.forEach((iou) => {
    iou.id ||= uniqueId("iou");
    iou.reason ||= "";
    iou.settled = Boolean(iou.settled);
    iou.settledDate ||= "";
    iou.accountId ||= "";
  });
}

// Friends are shared household-wide (not per-member) so any household
// member's typeahead autocompletes the same person with the same email,
// rather than each member re-inviting the same friend under slightly
// different spellings.
function ensureFriendsData() {
  state.friends ||= [];
  state.friends.forEach((friend) => {
    friend.id ||= uniqueId("friend");
    friend.invitedAt ||= "";
  });
}

// A friend-picker combobox, generalized (not copy-pasted) from the existing
// meal-recipe combobox pattern (see refreshMealRecipeMenu) so it can appear
// an arbitrary number of times per form (Split-a-bill and the Assign IOU
// dialog can each have several friend rows on screen at once, unlike the
// single fixed recipe field). `rows` is whatever array holds this row's
// data (a real dynamic-row array for split forms, or a one-element array
// wrapping the single Add IOU form's fields) - `rows[index]` is mutated
// in place as {person, email, friendId}.
function friendRowFieldsHtml(index, row) {
  return `
    <div class="custom-combobox friend-name-combobox">
      <input type="text" placeholder="Friend's name" value="${escapeHtml(row.person || "")}" data-friend-name="${index}" autocomplete="off" required>
      <div class="combo-menu" data-friend-menu="${index}" hidden></div>
    </div>
    <input type="email" placeholder="Email (optional, invites new friends)" value="${escapeHtml(row.email || "")}" data-friend-email="${index}" ${row.friendId ? "readonly" : ""}>
  `;
}

function wireFriendRow(container, index, rows) {
  const nameInput = container.querySelector(`[data-friend-name="${index}"]`);
  const emailInput = container.querySelector(`[data-friend-email="${index}"]`);
  const menu = container.querySelector(`[data-friend-menu="${index}"]`);
  if (!nameInput || !emailInput || !menu) return;

  function refreshMenu() {
    const query = nameInput.value.trim().toLowerCase();
    const matches = query ? state.friends.filter((friend) => friend.name.toLowerCase().includes(query)) : state.friends;
    menu.innerHTML = matches.length
      ? matches.map((friend) => `<button type="button" data-friend-option="${friend.id}">${escapeHtml(friend.name)} · ${escapeHtml(friend.email)}</button>`).join("")
      : `<div class="combo-empty">No matching friend yet - add an email below to invite someone new.</div>`;
  }

  nameInput.addEventListener("focus", () => { refreshMenu(); menu.hidden = false; });
  nameInput.addEventListener("input", () => {
    rows[index].person = nameInput.value;
    if (rows[index].friendId) {
      const stillMatches = state.friends.find((friend) => friend.id === rows[index].friendId && friend.name === nameInput.value);
      if (!stillMatches) {
        rows[index].friendId = "";
        emailInput.readOnly = false;
      }
    }
    refreshMenu();
    menu.hidden = false;
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-friend-option]");
    if (!option) return;
    const friend = state.friends.find((item) => item.id === option.dataset.friendOption);
    if (!friend) return;
    nameInput.value = friend.name;
    emailInput.value = friend.email;
    emailInput.readOnly = true;
    rows[index].person = friend.name;
    rows[index].email = friend.email;
    rows[index].friendId = friend.id;
    menu.hidden = true;
  });
  emailInput.addEventListener("input", () => { rows[index].email = emailInput.value; });
}

// Invites a friend the first time they're added by email - skipped
// entirely (no request, no error) when no email was given, since email is
// optional on every friend field (existing free-text-only friend tracking
// still works). Best-effort: if the invite request fails, the friend is
// still kept on file and the caller's split/IOU still saves - only the
// invite itself is skipped.
async function sendFriendInviteAndMark(friend) {
  try {
    await api("/api/friends/invite", { method: "POST", body: JSON.stringify({ name: friend.name, email: friend.email, inviterName: sessionUser?.name || "" }) });
    friend.invitedAt = new Date().toISOString();
  } catch (_error) {
    // Invite email failed to send - the friend stays on file so whatever
    // saved it still saves; just no invite was recorded this time.
  }
}

async function inviteFriendIfNew(name, email) {
  const trimmedEmail = String(email || "").trim();
  if (!trimmedEmail) return null;
  ensureFriendsData();
  const normalizedEmail = trimmedEmail.toLowerCase();
  const existing = state.friends.find((friend) => friend.email.toLowerCase() === normalizedEmail);
  if (existing) return existing;
  const friend = { id: uniqueId("friend"), name: String(name || "").trim() || trimmedEmail, email: trimmedEmail, invitedAt: "" };
  state.friends.push(friend);
  await sendFriendInviteAndMark(friend);
  return friend;
}

// Adds or updates a friend by name (rather than by email, like
// inviteFriendIfNew) - this is how the Friends card on the Shared Expenses
// page lets you add someone with no email yet (just a name used on a debt
// record) and come back later to fill in their email, which is what
// actually triggers the invite: only when the email is genuinely new does
// this send one, so re-saving an unchanged email is a no-op.
async function upsertFriend(name, email) {
  ensureFriendsData();
  const trimmedName = String(name || "").trim();
  const trimmedEmail = String(email || "").trim();
  if (!trimmedName) return null;
  const key = trimmedName.toLowerCase();
  let friend = state.friends.find((item) => item.name.trim().toLowerCase() === key);
  if (!friend) {
    friend = { id: uniqueId("friend"), name: trimmedName, email: "", invitedAt: "" };
    state.friends.push(friend);
  }
  const isNewEmail = Boolean(trimmedEmail) && trimmedEmail.toLowerCase() !== friend.email.toLowerCase();
  friend.name = trimmedName;
  friend.email = trimmedEmail || friend.email;
  if (isNewEmail) await sendFriendInviteAndMark(friend);
  return friend;
}

// Every distinct person named on a debt/shared-expense record that isn't
// already a real state.friends entry - a name-only debt (e.g. from Record a
// debt) never creates a friend record on its own since there's no email to
// invite, so these show up here as a way to add one after the fact.
function friendsWithoutEmailFromIous() {
  const known = new Set(state.friends.map((friend) => friend.name.trim().toLowerCase()));
  const seen = new Set();
  const names = [];
  (state.ious || []).forEach((iou) => {
    const key = String(iou.person || "").trim().toLowerCase();
    if (!key || known.has(key) || seen.has(key)) return;
    seen.add(key);
    names.push(String(iou.person).trim());
  });
  return names;
}

function friendsListForDisplay() {
  ensureFriendsData();
  const real = state.friends.map((friend) => ({ ...friend, isVirtual: false }));
  const virtual = friendsWithoutEmailFromIous().map((name) => ({ id: "", name, email: "", invitedAt: "", isVirtual: true }));
  return [...real, ...virtual].sort((a, b) => a.name.localeCompare(b.name));
}

function friendListRow(friend, index) {
  const statusNote = friend.invitedAt
    ? `<small>Invited ${formatShortDate(friend.invitedAt.slice(0, 10))}</small>`
    : friend.email
      ? "" : `<small>No email yet</small>`;
  return `<div class="compact-row">
    <div><strong>${escapeHtml(friend.name)}</strong>${statusNote}</div>
    <div class="compact-row-line">
      <input type="email" placeholder="Add email to invite" value="${escapeHtml(friend.email)}" data-friend-list-email="${index}">
      ${friend.isVirtual ? "" : `<button class="icon-button danger-button" data-delete-friend="${friend.id}" type="button" aria-label="Remove ${escapeHtml(friend.name)}">×</button>`}
    </div>
  </div>`;
}

function iouRow(iou) {
  return `<div class="compact-row">
    <div><strong>${escapeHtml(iou.person)}</strong><small>${iou.reason ? `${escapeHtml(iou.reason)} · ` : ""}${formatShortDate(iou.date)}</small></div>
    <b>${exactMoney.format(iou.amount)}</b>
    <div class="compact-row-line">
      ${state.accounts.length ? `<select class="income-recurrence-select" data-iou-account="${iou.id}" aria-label="Account for ${escapeHtml(iou.person)}"><option value="">Not linked</option>${accountOptions(iou.accountId || "", { excludeType: "credit_card" })}</select>` : ""}
      <div class="compact-row-actions">
        ${iou.receiptDocumentId
          ? `<button class="icon-button" data-documents-open-file="${iou.receiptDocumentId}" type="button" aria-label="View receipt for ${escapeHtml(iou.person)}" title="View receipt">📎</button>`
          : `<label class="icon-button iou-receipt-upload" title="Attach a receipt photo" aria-label="Attach a receipt photo for ${escapeHtml(iou.person)}">📷<input type="file" accept="image/*,application/pdf" data-iou-receipt-upload="${iou.id}" hidden></label>`}
        ${iou.settled ? "" : `<button class="icon-button" data-settle-iou="${iou.id}" type="button" aria-label="Mark settled with ${escapeHtml(iou.person)}">✓</button>`}
        <button class="icon-button danger-button" data-delete-iou="${iou.id}" type="button" aria-label="Delete IOU with ${escapeHtml(iou.person)}">×</button>
      </div>
    </div>
  </div>`;
}

function personBalanceCard(group) {
  const isSettled = group.direction === "settled";
  const headline = isSettled
    ? "All settled up"
    : group.direction === "owed_to_me"
      ? `${escapeHtml(group.label)} owes you ${money.format(Math.abs(group.net))}`
      : `You owe ${escapeHtml(group.label)} ${money.format(Math.abs(group.net))}`;
  return `<div class="card iou-person-card">
    <div class="iou-person-head">
      <div><span class="card-label">${escapeHtml(group.label)}</span><h3 class="${isSettled ? "" : group.direction === "owed_to_me" ? "positive" : "danger"}">${headline}</h3></div>
      ${isSettled ? "" : `<button class="ghost" type="button" data-settle-up-person="${escapeHtml(group.key)}">Settle up</button>`}
    </div>
    <details class="iou-person-records">
      <summary>${group.records.length} record${group.records.length === 1 ? "" : "s"}</summary>
      ${group.records.map((iou) => iouRow(iou)).join("")}
    </details>
  </div>`;
}

// The value to pass as computeBillSplitAmounts' explicit yourShare - only
// exact/percentage/shares have a real editable "You" field (equal is always
// automatic, so there's nothing to pass and the implicit +1-participant path
// still applies).
function splitBillYourShareValue() {
  if (splitBillType === "percentage") return splitBillYou.percent;
  if (splitBillType === "shares") return splitBillYou.shares;
  if (splitBillType === "exact") return splitBillYou.amount;
  return undefined;
}

// The Split-a-bill form's dynamic friend rows, mirroring the Bank Stream
// Assign IOU dialog's iouSplitRows/renderIouSplitRows pattern. The payer also
// gets their own row (splitBillYou, rendered separately from splitBillRows
// since it has no name/email fields and can't be removed) so their share is
// something they can see and set directly - including to 0, to fully
// exclude themselves - rather than only ever being whatever's left over.
function recomputeSplitBillRows() {
  const totalAmount = Number($("#splitExpenseForm")?.amount?.value || 0);
  const result = computeBillSplitAmounts(splitBillType, totalAmount, splitBillRows, splitBillYourShareValue());
  const messageEl = $("#splitBillMessage");
  const remainderEl = $("#splitBillRemainder");
  if (!result.ok) {
    if (messageEl) messageEl.textContent = result.error;
    if (remainderEl) remainderEl.textContent = exactMoney.format(0);
    return;
  }
  if (messageEl) messageEl.textContent = "";
  if (splitBillType !== "exact") {
    splitBillRows.forEach((row, index) => {
      row.amount = result.friendAmounts[index];
      const input = document.querySelector(`#splitBillRows [data-split-bill-amount="${index}"]`);
      if (input) input.value = row.amount;
    });
  }
  if (splitBillType === "equal") {
    splitBillYou.amount = result.payerAmount;
    const youInput = document.querySelector(`#splitBillRows [data-split-bill-you-amount]`);
    if (youInput) youInput.value = result.payerAmount;
  }
  if (remainderEl) {
    remainderEl.textContent = exactMoney.format(result.payerAmount);
    remainderEl.classList.toggle("danger", result.payerAmount < 0);
  }
}

function renderSplitBillRows() {
  const container = $("#splitBillRows");
  if (!container) return;
  const youField = splitBillType === "percentage"
    ? `<input type="number" step="0.01" min="0" max="100" placeholder="%" value="${splitBillYou.percent || ""}" data-split-bill-you-percent>`
    : splitBillType === "shares"
      ? `<input type="number" step="1" min="0" placeholder="Parts" value="${splitBillYou.shares || ""}" data-split-bill-you-shares>`
      : `<input type="number" step="0.01" min="0" placeholder="Amount" value="${splitBillYou.amount || ""}" data-split-bill-you-amount ${splitBillType === "equal" ? "readonly" : ""}>`;
  container.innerHTML = `
    <div class="iou-split-row iou-split-you-row">
      <div class="iou-split-you-label">You</div>
      ${youField}
    </div>
  ` + splitBillRows.map((row, index) => `
    <div class="iou-split-row">
      ${friendRowFieldsHtml(index, row)}
      <div class="compact-row-line">
        ${splitBillType === "percentage"
          ? `<input type="number" step="0.01" min="0" max="100" placeholder="%" value="${row.percent || ""}" data-split-bill-percent="${index}">`
          : splitBillType === "shares"
            ? `<input type="number" step="1" min="0" placeholder="Parts" value="${row.shares || ""}" data-split-bill-shares="${index}">`
            : `<input type="number" step="0.01" min="0.01" placeholder="Amount" value="${row.amount || ""}" data-split-bill-amount="${index}" ${splitBillType === "equal" ? "readonly" : ""}>`}
        <button type="button" class="icon-button ghost" data-remove-split-bill-row="${index}" aria-label="Remove person">×</button>
      </div>
    </div>
  `).join("");
  splitBillRows.forEach((row, index) => wireFriendRow(container, index, splitBillRows));
  container.querySelectorAll("[data-split-bill-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      splitBillRows[Number(input.dataset.splitBillAmount)].amount = Number(input.value);
      recomputeSplitBillRows();
    });
  });
  container.querySelectorAll("[data-split-bill-percent]").forEach((input) => {
    input.addEventListener("input", () => {
      splitBillRows[Number(input.dataset.splitBillPercent)].percent = Number(input.value);
      recomputeSplitBillRows();
    });
  });
  container.querySelectorAll("[data-split-bill-shares]").forEach((input) => {
    input.addEventListener("input", () => {
      splitBillRows[Number(input.dataset.splitBillShares)].shares = Number(input.value);
      recomputeSplitBillRows();
    });
  });
  container.querySelector("[data-split-bill-you-amount]")?.addEventListener("input", (event) => {
    splitBillYou.amount = Number(event.currentTarget.value);
    recomputeSplitBillRows();
  });
  container.querySelector("[data-split-bill-you-percent]")?.addEventListener("input", (event) => {
    splitBillYou.percent = Number(event.currentTarget.value);
    recomputeSplitBillRows();
  });
  container.querySelector("[data-split-bill-you-shares]")?.addEventListener("input", (event) => {
    splitBillYou.shares = Number(event.currentTarget.value);
    recomputeSplitBillRows();
  });
  container.querySelectorAll("[data-remove-split-bill-row]").forEach((button) => {
    button.addEventListener("click", () => {
      splitBillRows.splice(Number(button.dataset.removeSplitBillRow), 1);
      renderSplitBillRows();
    });
  });
  recomputeSplitBillRows();
}

function renderIOUs() {
  ensureIOUsData();
  const today = dateKey(new Date());
  const balances = netBalancesByPerson(state.ious);
  const settled = state.ious.filter((iou) => iou.settled);
  const friendsList = friendsListForDisplay();
  return `
    <section class="ious-layout">
      <p class="muted">Track money you've borrowed from people, and split a shared expense you already paid so friends can pay you back.</p>
      <div class="card">
        <div class="card-label">Shared Expenses</div><h3>Friends</h3>
        <p class="muted">Everyone you've split a debt or expense with - add an email any time to send them an invite.</p>
        <form id="addFriendForm" class="mini-form">
          <label>Name<input name="name" placeholder="Jordan" required></label>
          <label>Email (optional)<input name="email" type="email" placeholder="jordan@example.com"></label>
          <button type="submit" class="form-row-full">Add friend</button>
        </form>
        ${friendsList.length ? `<div id="friendListRows">${friendsList.map((friend, index) => friendListRow(friend, index)).join("")}</div>` : `<div class="empty-inline">No friends yet</div>`}
      </div>
      <div class="card">
        <div class="card-label">Add</div><h3>Record a debt</h3>
        <form id="iouForm" class="mini-form iou-form">
          <label>Person
            <div class="custom-combobox friend-name-combobox">
              <input type="text" name="person" placeholder="Sam" data-friend-name="0" autocomplete="off" required>
              <div class="combo-menu" data-friend-menu="0" hidden></div>
            </div>
          </label>
          <label>Email (optional, invites new friends)<input type="email" name="email" data-friend-email="0" placeholder="sam@example.com"></label>
          <label>Amount<input name="amount" type="number" step="0.01" min="0.01" placeholder="20" required></label>
          <label>Direction<select name="direction">
            <option value="i_owe">I owe them</option>
            <option value="owed_to_me">They owe me</option>
          </select></label>
          <label class="form-row-full">Reason (optional)<input name="reason" placeholder="Gas money"></label>
          <label>Date<input name="date" type="date" value="${today}"></label>
          ${state.accounts.length ? `<label>Account (optional)<select name="accountId"><option value="">Not linked</option>${accountOptions("", { excludeType: "credit_card" })}</select></label>` : ""}
          <button type="submit" class="form-row-full">Add debt</button>
        </form>
      </div>
      <div class="card">
        <div class="card-label">Shared expense</div><h3>Split a bill with friends</h3>
        <p class="muted">Enter the total bill including your own share — only your friends' shares are tracked as amounts they owe you.</p>
        <form id="splitExpenseForm" class="mini-form split-expense-form">
          <label>What for<input name="reason" placeholder="Dinner" required></label>
          <label>Total bill (including your share)<input name="amount" type="number" step="0.01" min="0.01" placeholder="90" required></label>
          <label>Date<input name="date" type="date" value="${today}"></label>
          <label>Split type<select id="splitBillType">
            <option value="equal" ${splitBillType === "equal" ? "selected" : ""}>Equal</option>
            <option value="exact" ${splitBillType === "exact" ? "selected" : ""}>Exact amounts</option>
            <option value="percentage" ${splitBillType === "percentage" ? "selected" : ""}>Percentage</option>
            <option value="shares" ${splitBillType === "shares" ? "selected" : ""}>Shares (parts)</option>
          </select></label>
          <div id="splitBillRows" class="iou-split-rows form-row-full"></div>
          <button id="addSplitBillRowButton" class="ghost form-row-full" type="button">+ Add another person</button>
          <div class="iou-split-total form-row-full"><span>Your share</span><b id="splitBillRemainder">$0.00</b></div>
          ${state.accounts.length ? `<label>Account their repayment lands in (optional)<select name="accountId"><option value="">Not linked</option>${accountOptions("", { excludeType: "credit_card" })}</select></label>` : ""}
          <p id="splitBillMessage" class="form-message form-row-full"></p>
          <button type="submit" class="form-row-full">Split and add</button>
        </form>
      </div>
      ${balances.length ? balances.map(personBalanceCard).join("") : `<div class="card"><div class="empty-inline">No shared expenses yet</div></div>`}
      ${settled.length ? `<details class="card ious-settled-details">
        <summary>Settled (${settled.length})</summary>
        ${settled.map((iou) => iouRow(iou)).join("")}
      </details>` : ""}
    </section>
  `;
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
        ${state.goals.sinkingFunds.length ? state.goals.sinkingFunds.map((fund, index) => {
          const pct = Math.min(100, Math.round((Number(fund.saved || 0) / Math.max(Number(fund.target || 0), 1)) * 100));
          return `
          <article class="goal-card">
            <div class="goal-edit-grid">
              <label class="goal-name-field">Goal name<input data-goal-name="${index}" value="${escapeHtml(fund.name || "")}" placeholder="Emergency fund"></label>
              <label>Target amount<input data-goal-target="${index}" type="number" min="0" step="0.01" value="${Number(fund.target || 0)}"></label>
              <label>Saved so far<input data-goal-saved="${index}" type="number" min="0" step="0.01" value="${Number(fund.saved || 0)}"></label>
              <label>Target date<input data-goal-date="${index}" type="date" value="${fund.targetDate || ""}"></label>
              <button class="icon-button danger-button" data-delete-goal="${index}" type="button" aria-label="Remove ${escapeHtml(fund.name || "goal")}">×</button>
            </div>
            <div class="goal-ring-row">
              <div class="goal-ring" style="background:conic-gradient(var(--green) ${pct}%, var(--soft-blue) ${pct}% 100%)"><div class="goal-ring-inner"><span aria-hidden="true">🎯</span></div></div>
              <div class="goal-ring-stats">
                <div class="split-stat"><span>Saved</span><b>${money.format(fund.saved)}</b></div>
                <div class="split-stat"><span>Target</span><b>${money.format(fund.target)}</b></div>
                <div class="split-stat"><span>${pct}%</span><b>${money.format(Math.max(0, fund.target - fund.saved))} remaining</b></div>
              </div>
            </div>
            <div class="goal-contribution-row">
              <input type="number" min="0" step="0.01" placeholder="Add a contribution" data-goal-contribution-input="${index}" aria-label="Contribution amount for ${escapeHtml(fund.name || "this goal")}">
              <button type="button" class="ghost" data-goal-contribution-add="${index}">+ Add</button>
            </div>
            <div class="goal-auto-contribute-row">
              <label class="row-field row-select"><small>Auto-contribute</small>
                <select data-goal-auto-mode="${index}">
                  <option value="off" ${!fund.autoContribute?.enabled ? "selected" : ""}>Off</option>
                  <option value="roundup" ${fund.autoContribute?.enabled && fund.autoContribute.mode === "roundup" ? "selected" : ""}>Round-up purchases</option>
                  <option value="percent" ${fund.autoContribute?.enabled && fund.autoContribute.mode === "percent" ? "selected" : ""}>% of each paycheck</option>
                </select>
              </label>
              ${fund.autoContribute?.enabled && fund.autoContribute.mode === "percent" ? `<label class="row-field row-select"><small>Percent</small><input type="number" min="0" max="100" step="1" value="${Number(fund.autoContribute.percent || 0)}" data-goal-auto-percent="${index}" aria-label="Percent of each paycheck for ${escapeHtml(fund.name || "this goal")}"></label>` : ""}
              ${fund.autoContribute?.enabled ? `<small class="muted">${fund.autoContribute.mode === "roundup" ? "Rounds every purchase up to the next dollar" : `Sets aside ${Number(fund.autoContribute.percent || 0)}% of every paycheck`} automatically.</small>` : ""}
            </div>
          </article>
        `;
        }).join("") : `<div class="onboarding-empty compact-onboarding"><div class="empty-symbol" aria-hidden="true">◎</div><h3>Create your first goal</h3><p>Give it a target amount and date, then update the saved balance as you make progress.</p><button id="emptyAddGoalButton" type="button">Add a goal</button></div>`}
      </section>
    </section>`;
}

// Buckets every net-worth asset (not liabilities) into the four classes
// the design calls out - retirement accounts are folded into "Stocks &
// funds" rather than getting a fifth bucket, since they're already
// stock/fund holdings under the hood (see isHoldingAssetClass).
function assetAllocationBreakdown() {
  const groups = { cash: 0, stock: 0, property: 0, other: 0 };
  const labels = { cash: "Cash", stock: "Stocks & funds", property: "Property", other: "Other" };
  const colors = { cash: "var(--blue)", stock: "var(--green)", property: "var(--gold)", other: "var(--muted)" };
  state.goals.netWorth.assets.forEach((asset) => {
    const bucket = asset.assetClass === "retirement" ? "stock" : (groups[asset.assetClass] !== undefined ? asset.assetClass : "other");
    groups[bucket] += Math.max(0, assetValue(asset));
  });
  const total = Object.values(groups).reduce((sum, value) => sum + value, 0);
  return Object.entries(groups)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({ key, label: labels[key], value, percent: total ? Math.round((value / total) * 100) : 0, color: colors[key] }))
    .sort((a, b) => b.value - a.value);
}

function assetAllocationRingHtml(segments) {
  let cursor = 0;
  const stops = segments.map((segment) => {
    const start = cursor;
    cursor += segment.percent;
    return `${segment.color} ${start}% ${cursor}%`;
  }).join(", ");
  return `<div class="wealth-allocation-ring" style="background:conic-gradient(${stops || "var(--soft) 0 100%"})"></div>`;
}

function renderWealth() {
  if (ensureDebtNetWorthSync()) autosaveState();
  ensureAccountsData();
  const wealthTrend = netWorthTrend(trailingMonthKeys(6));
  const wealthNetWorthChange = wealthTrend.length ? netWorth().total - (wealthTrend[0]?.value || 0) : 0;
  const allocation = assetAllocationBreakdown();
  return `
    <section class="work-grid wealth-layout">
      <div class="main-stack">
        <section class="card">
          <div class="section-head"><div><span class="card-label">Trend</span><h3>Net worth history</h3></div><b class="${wealthNetWorthChange < 0 ? "danger" : ""}">${wealthNetWorthChange >= 0 ? "+" : ""}${money.format(wealthNetWorthChange)} over ${wealthTrend.length} months</b></div>
          ${netWorthTrendSvg(wealthTrend)}
          <div class="networth-chart-labels">${wealthTrend.map((point) => `<span>${formatMonth(point.month).split(" ")[0].slice(0, 3)}</span>`).join("")}</div>
        </section>
        ${allocation.length ? `<section class="card">
          <div class="section-head"><div><span class="card-label">Breakdown</span><h3>Asset allocation</h3></div></div>
          <div class="wealth-allocation-row">
            ${assetAllocationRingHtml(allocation)}
            <div class="wealth-allocation-legend">
              ${allocation.map((segment) => `<div class="wealth-allocation-legend-row"><i style="background:${segment.color}"></i><span>${segment.label}</span><b>${money.format(segment.value)}</b><small>${segment.percent}%</small></div>`).join("")}
            </div>
          </div>
        </section>` : ""}
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
              <label class="debt-asset-field">Subcategory<select data-debt-line="${index}" aria-label="Subcategory for ${escapeHtml(debt.name)} payments">${debtLineOptions(debt)}</select></label>
            </div>
            <div class="debt-payoff-summary"><span><b>Estimated payoff</b>${termLabel(payoffMonths(debt))}</span><span><b>Suggested EMI</b>${debt.termMonths ? money.format(suggestedEmi(debt)) : "Set a loan term"}</span>${debt.termMonths ? `<button class="ghost" data-use-suggested-emi="${index}" type="button">Use suggested EMI</button>` : ""}</div>
            <div class="debt-progress-bar"><span style="width:${debtPayoffProgressPercent(debt)}%"></span></div>
            <p class="debt-progress-caption">${debtPayoffProgressPercent(debt)}% paid off · ${money.format(debt.balance)} remaining</p>
            <div class="payment-row"><label>Additional payment<input data-debt-payment="${index}" value="0" type="number" min="0" step="0.01"></label><button class="ghost" data-apply-debt-payment="${index}" type="button" ${Number(debt.minimum || 0) <= 0 ? "disabled" : ""}>Record EMI payment</button><button class="icon-button danger-button" data-delete-debt="${index}" type="button" aria-label="Delete ${escapeHtml(debt.name)}">×</button></div>
            ${debt.payments?.length ? `<details class="payment-history"><summary>Payment history (${debt.payments.length})</summary>${debt.payments.slice(0, 8).map((payment, paymentIndex) => `<div><input type="date" data-debt-payment-date="${index}:${paymentIndex}" value="${payment.date}" aria-label="Date for this ${escapeHtml(debt.name)} payment"><span>${money.format(payment.amount)} paid</span><span>${money.format(payment.principal)} principal</span><span>${money.format(payment.interest)} interest</span><button class="icon-button danger-button" data-delete-debt-payment="${index}:${paymentIndex}" type="button" aria-label="Remove this ${escapeHtml(debt.name)} payment and restore its balance">×</button></div>`).join("")}</details>` : ""}
          </article>`).join("") : `<div class="onboarding-empty compact-onboarding"><div class="empty-symbol" aria-hidden="true">↓</div><h3>Add a debt when you are ready</h3><p>Track its balance, rate, payment, and the asset it secures.</p></div>`}
        </section>
      </div>
      <section class="card wealth-holdings"><div class="section-head"><div><span class="card-label">Net worth</span><h3>Assets, investments and liabilities</h3></div><div class="wealth-currency-row"><select id="wealthCurrencySelect" aria-label="Display currency"><option value="USD" ${wealthCurrency === "USD" ? "selected" : ""}>USD</option><option value="EUR" ${wealthCurrency === "EUR" ? "selected" : ""}>EUR</option><option value="GBP" ${wealthCurrency === "GBP" ? "selected" : ""}>GBP</option></select><button id="addNetWorthItemButton" type="button">+ Add holding</button></div></div><div class="net-worth-strip"><strong data-net-worth-total>${wealthMoney(netWorth().total)}</strong><span>Assets <b data-net-worth-assets>${wealthMoney(netWorth().assets)}</b> Liabilities <b data-net-worth-liabilities>${wealthMoney(netWorth().liabilities)}</b></span></div>${wealthCurrency !== "USD" ? `<p class="muted wealth-currency-note">Converted from USD using real exchange rates${wealthFxRates ? "" : " — loading…"}. Individual accounts and holdings below still show USD.</p>` : ""}<div class="net-worth-items">${groupStockHoldings(state.goals.netWorth.assets).map((group) => netWorthStockGroupCard(group)).join("")}${state.goals.netWorth.assets.map((asset, index) => ({ asset, index })).filter(({ asset }) => !isHoldingAssetClass(asset.assetClass)).map(({ asset, index }) => netWorthItemRow(asset, "asset", index)).join("")}${state.goals.netWorth.liabilities.map((item, index) => netWorthItemRow(item, "liability", index)).join("")}</div>${state.goals.netWorth.assets.length || state.goals.netWorth.liabilities.length ? "" : `<div class="empty-inline">No assets, investments or liabilities yet</div>`}</section>
    </section>`;
}

// Only ever called on state.goals.netWorth.assets - a stock group is always
// an asset card. The per-item Type selector still lets someone move a
// single holding to the liabilities array (same as before grouping
// existed); doing so just drops that one holding out of its group's card,
// the same way it always dropped out of the stock-specific fields once
// moved (assetClass survives the move, but netWorthItemRow only renders
// the stock fields for non-liability items).
//
// Renaming the account and editing/adding/removing individual holdings both
// live in the Manage holdings modal now (one entry point per action, same
// principle as the chips below being read-only) - the card itself is a
// read-only summary.
function netWorthStockGroupCard(group) {
  const totalValue = group.items.reduce((sum, item) => sum + assetValue(item), 0);
  const holdingsLabel = `${group.items.length} holding${group.items.length === 1 ? "" : "s"}`;
  const gainLoss = groupGainLoss(group.items);
  const lastUpdated = formatRelativeTime(state.goals.netWorth.priceLastUpdated?.[group.groupId]);
  const liveCaption = lastUpdated ? `Live pricing • updated ${lastUpdated}` : `Live pricing across ${holdingsLabel}`;
  return `<article class="account-item stock-group-card" draggable="true" data-drag-networth-asset="${group.groupId}">
    <span class="net-worth-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
    <div class="stock-group-main">
      <div class="stock-group-grid">
        <div class="name-field"><span>Name</span><strong>${escapeHtml(group.groupName)}</strong></div>
        <div class="stock-group-stat"><span>Asset class</span><strong>${assetClassLabelForHoldings(group.items)}</strong></div>
        <div class="stock-group-stat"><span>Holdings</span><strong>${holdingsLabel}</strong><button type="button" class="ghost" data-manage-stock-group="${group.groupId}">Manage list →</button></div>
      </div>
      <div class="stock-group-chips">${group.items.map((item) => `<span class="stock-chip">${escapeHtml(item.symbol || item.name)}</span>`).join("")}</div>
    </div>
    <div class="stock-market-value stock-group-value-panel">
      <span>Market value</span>
      <strong>${money.format(totalValue)}</strong>
      ${gainLoss.hasCostBasis ? `<small class="gain-loss ${gainLoss.amount < 0 ? "loss" : "gain"}">${gainLoss.amount >= 0 ? "+" : ""}${money.format(gainLoss.amount)} (${gainLoss.percent >= 0 ? "+" : ""}${gainLoss.percent.toFixed(1)}%)</small>` : ""}
      <button type="button" class="live-price-pill" data-refresh-stock-group="${group.groupId}">↻ Live price</button>
      <small class="muted">${liveCaption}</small>
    </div>
    <button class="icon-button danger-button" data-delete-stock-group="${group.groupId}" type="button" aria-label="Remove ${escapeHtml(group.groupName)}">×</button>
  </article>`;
}

const accountTypeColors = { checking: "var(--blue)", savings: "var(--green)", cash: "var(--gold)", credit_card: "var(--coral)", other: "var(--muted)" };

function accountItemRow(account, index) {
  const balance = currentAccountBalance(account.id);
  const isLiability = account.type === "credit_card";
  const typeLabels = { checking: "Checking", savings: "Savings", cash: "Cash", credit_card: "Credit card", other: "Other" };
  return `<article class="account-item ${isLiability ? "liability" : ""}" draggable="true" data-drag-account="${account.id}">
    <div class="debt-edit-grid">
      <label class="debt-name-field">Account name<input data-account-name="${index}" value="${escapeHtml(account.name)}" aria-label="Account name"></label>
      <label>Type<select data-account-type="${index}" aria-label="Type for ${escapeHtml(account.name)}">${Object.entries(typeLabels).map(([value, label]) => `<option value="${value}" ${account.type === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label>Opening balance<input data-account-opening-balance="${index}" type="number" step="0.01" inputmode="decimal" value="${account.openingBalance}" aria-label="Opening balance for ${escapeHtml(account.name)}"></label>
      <label>Close date<input type="date" data-account-close-date="${index}" value="${account.closedAt}" aria-label="Close date for ${escapeHtml(account.name)}"></label>
    </div>
    <div class="account-balance-row">
      <span class="account-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
      <i class="account-type-dot" style="background:${accountTypeColors[account.type] || accountTypeColors.other}" title="${typeLabels[account.type] || account.type}"></i>
      <div class="split-stat"><span>${isLiability ? "Owed" : "Balance"}</span><b class="${isLiability && balance > 0 ? "danger" : ""}">${money.format(balance)}</b></div>
      ${account.closedAt ? `<span class="pill pill-warning" title="No new transactions can be added after ${formatShortDate(account.closedAt)}">Closed ${formatShortDate(account.closedAt)}</span>` : ""}
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
  return `<div class="net-worth-item ${isLiability ? "liability" : ""} ${isStock ? "stock" : ""}" draggable="true" ${isLiability ? `data-drag-networth-liability="${item.id}"` : `data-drag-networth-asset="${item.id}"`}>
    <span class="net-worth-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
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
          <div class="invite-box"><span>Invite code</span><strong>${state.household.inviteCode || "No invite yet"}</strong>${state.household.inviteCode ? `<button class="ghost invite-copy-button" data-copy-invite-code="${escapeHtml(state.household.inviteCode)}" type="button">Copy</button>` : ""}</div>
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
              ${sharingAccess?.canManage && !member.isOwner && member.status === "active"
                ? `<select class="sharing-access-level-select" data-member-access-level="${escapeHtml(member.email)}" aria-label="Permission level for ${escapeHtml(member.name)}">
                    <option value="edit" ${(member.accessLevel || "edit") === "edit" ? "selected" : ""}>Can edit</option>
                    <option value="view" ${member.accessLevel === "view" ? "selected" : ""}>View only</option>
                  </select>`
                : member.isOwner ? `<span class="pill">Can edit</span>` : ""}
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

function currentReportsScope() {
  if (!reportsScope) reportsScope = { type: "month", month: state.budget.month };
  return reportsScope;
}

// A same-length window shifted back exactly one year from each of this
// scope's month keys - used only to compute the "vs last year" delta, never
// shown as its own chart, so it doesn't need to handle gaps/duplicates the
// way a real trend series would.
function priorYearMonthKeys(monthKeys) {
  return monthKeys.map((key) => {
    const [year, month] = key.split("-");
    return `${Number(year) - 1}-${month}`;
  });
}

// null when there's nothing to compare against (division by zero or no
// prior-year data at all) rather than a misleading 0%/∞% badge.
function yoyDelta(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

function yoyBadgeHtml(delta) {
  if (delta === null) return "";
  const up = delta >= 0;
  return `<span class="reports-yoy-badge ${up ? "good" : "danger"}">${up ? "▲" : "▼"} ${Math.abs(delta)}% vs last year</span>`;
}

function renderReports() {
  const scope = currentReportsScope();
  const monthKeys = monthKeysForScope(scope);
  const categories = reportCategoriesForScope(monthKeys);
  const trend = netWorthTrend(monthKeys.length ? monthKeys : trailingMonthKeys(6));
  const currentNetWorth = trend[trend.length - 1]?.value || 0;
  const netWorthChange = currentNetWorth - (trend[0]?.value || 0);
  const months = cashFlowByMonth(monthKeys.length ? monthKeys : trailingMonthKeys(6));
  const totalIncome = months.reduce((sum, month) => sum + month.income, 0);
  const totalExpenses = months.reduce((sum, month) => sum + month.expenses, 0);
  const priorMonths = reportsCompareLastYear ? cashFlowByMonth(priorYearMonthKeys(monthKeys.length ? monthKeys : trailingMonthKeys(6))) : [];
  const priorIncome = priorMonths.reduce((sum, month) => sum + month.income, 0);
  const priorExpenses = priorMonths.reduce((sum, month) => sum + month.expenses, 0);
  const priorTrend = reportsCompareLastYear ? netWorthTrend(priorYearMonthKeys(monthKeys.length ? monthKeys : trailingMonthKeys(6))) : [];
  const priorNetWorth = priorTrend[priorTrend.length - 1]?.value || 0;
  const reportsTheme = REPORTS_THEMES[reportsColorTheme] || REPORTS_THEMES.fresh;
  const sankeySegments = sankeyFlowSegments(categories, totalIncome, totalExpenses).map((segment, index) => ({ ...segment, color: reportsTheme.palette[index % reportsTheme.palette.length] }));
  const budgetVsActual = budgetVsActualByCategory(monthKeys).filter((row) => row.planned !== 0 || row.actual !== 0);
  const rangeTransactions = state.transactions.filter((transaction) => (monthKeys.length ? monthKeys : trailingMonthKeys(6)).includes(transaction.date?.slice(0, 7)));
  const reportsTagGroups = groupTransactionsByTag(rangeTransactions).sort((a, b) => b.total - a.total);
  const selectedReportsTagGroup = reportsTagGroups.find((group) => group.key === reportsSelectedTag) || null;
  const expandedSankeySegment = reportsExpandedSankeyLineKey ? sankeySegments.find((segment) => segment.lineIds.length && segment.lineIds.join(",") === reportsExpandedSankeyLineKey) || null : null;
  const expandedSankeyTransactions = expandedSankeySegment ? rangeTransactions.filter((transaction) => transactionHasLine(transaction, expandedSankeySegment.lineIds)) : [];
  // reportsSelectedCategoryLine is "cat:<lineId>,<lineId>,..." (every
  // subcategory under that category, joined - categories have no id of their
  // own) or "line:<lineId>" (one specific subcategory).
  let categoryLineLabel = "";
  let categoryLineTotal = 0;
  let categoryLineTransactions = [];
  if (reportsSelectedCategoryLine) {
    const [kind, targetId] = reportsSelectedCategoryLine.split(":");
    if (kind === "cat") {
      const category = categories.find((item) => item.lines.map((line) => line.id).join(",") === targetId);
      if (category) {
        const lineIds = category.lines.map((line) => line.id);
        categoryLineLabel = category.name;
        categoryLineTotal = category.value;
        categoryLineTransactions = rangeTransactions.filter((transaction) => transactionHasLine(transaction, lineIds));
      }
    } else if (kind === "line") {
      const category = categories.find((item) => item.lines.some((line) => line.id === targetId));
      const line = category?.lines.find((item) => item.id === targetId);
      if (category && line) {
        categoryLineLabel = `${category.name} · ${line.name}`;
        categoryLineTotal = line.value;
        categoryLineTransactions = rangeTransactions.filter((transaction) => transactionHasLine(transaction, [targetId]));
      }
    }
  }
  const showCard = (key) => reportsCardFilter === "all" || reportsCardFilter === key;
  const scopePills = [["month", "Month"], ["range", "Date range"], ["year", "Whole year"]];
  const themeSwatches = [["fresh", "Fresh"], ["sunset", "Sunset"], ["ocean", "Ocean"]];
  return `
    <section class="card reports-toolbar">
      <div class="section-head"><div><span class="card-label">Reports</span><h3>Scope</h3></div></div>
      <div class="reports-toolbar-fields">
        <div class="reports-scope-pills" role="group" aria-label="Time range">
          ${scopePills.map(([value, label]) => `<button type="button" class="${scope.type === value ? "active" : ""}" data-reports-scope-type="${value}">${label}</button>`).join("")}
        </div>
        ${scope.type === "month" ? `<label>Month<input type="month" id="reportsScopeMonth" value="${scope.month}"></label>` : ""}
        ${scope.type === "range" ? `<label>Start<input type="date" id="reportsScopeStart" value="${scope.start || ""}"></label><label>End<input type="date" id="reportsScopeEnd" value="${scope.end || ""}"></label>` : ""}
        ${scope.type === "year" ? `<label>Year<input type="number" id="reportsScopeYear" min="2000" max="2100" value="${scope.year}"></label>` : ""}
        <label>Show<select id="reportsCardFilter">
          <option value="all" ${reportsCardFilter === "all" ? "selected" : ""}>All</option>
          <option value="networth" ${reportsCardFilter === "networth" ? "selected" : ""}>Net worth</option>
          <option value="cashflow" ${reportsCardFilter === "cashflow" ? "selected" : ""}>Cash flow</option>
          <option value="cashflowbreakdown" ${reportsCardFilter === "cashflowbreakdown" ? "selected" : ""}>Cash flow breakdown</option>
          <option value="category" ${reportsCardFilter === "category" ? "selected" : ""}>Category spend</option>
          <option value="budgetvsactual" ${reportsCardFilter === "budgetvsactual" ? "selected" : ""}>Budget vs Expense</option>
          <option value="transactions" ${reportsCardFilter === "transactions" ? "selected" : ""}>Transactions</option>
          <option value="categorysubcategory" ${reportsCardFilter === "categorysubcategory" ? "selected" : ""}>Category / Subcategory</option>
          <option value="tags" ${reportsCardFilter === "tags" ? "selected" : ""}>Tags</option>
        </select></label>
      </div>
      <div class="reports-appearance-row">
        <div class="reports-appearance-group">
          <span class="reports-appearance-label">Compare</span>
          <div class="reports-scope-pills">
            <button type="button" class="${reportsCompareLastYear ? "active" : ""}" data-reports-compare-last-year>Compare to last year</button>
          </div>
        </div>
        <div class="reports-appearance-group">
          <span class="reports-appearance-label">Density</span>
          <div class="reports-scope-pills">
            <button type="button" class="${reportsDensity === "comfortable" ? "active" : ""}" data-reports-density="comfortable">Comfortable</button>
            <button type="button" class="${reportsDensity === "compact" ? "active" : ""}" data-reports-density="compact">Compact</button>
          </div>
        </div>
        <div class="reports-appearance-group">
          <span class="reports-appearance-label">Color theme</span>
          <div class="reports-theme-swatches">
            ${themeSwatches.map(([value, label]) => `<button type="button" class="reports-theme-swatch ${reportsColorTheme === value ? "active" : ""}" data-reports-theme="${value}" aria-label="${label} theme" title="${label}">${REPORTS_THEMES[value].palette.slice(0, 3).map((color) => `<i style="background:${color}"></i>`).join("")}</button>`).join("")}
          </div>
        </div>
        <div class="reports-appearance-group">
          <span class="reports-appearance-label">Category style</span>
          <div class="reports-scope-pills">
            <button type="button" class="${reportsCategoryStyle === "bars" ? "active" : ""}" data-reports-category-style="bars">Bars</button>
            <button type="button" class="${reportsCategoryStyle === "rings" ? "active" : ""}" data-reports-category-style="rings">Rings</button>
          </div>
        </div>
      </div>
    </section>
    <section class="work-grid reports-density-${reportsDensity}">
      <div class="main-stack">
        ${showCard("networth") ? `<section class="card">
          <div class="section-head"><div><span class="card-label">Trend</span><h3>Net worth</h3></div><b class="${netWorthChange < 0 ? "danger" : ""}">${netWorthChange >= 0 ? "+" : ""}${money.format(netWorthChange)} over ${trend.length} months</b></div>
          ${reportsCompareLastYear ? yoyBadgeHtml(yoyDelta(currentNetWorth, priorNetWorth)) : ""}
          ${netWorthTrendSvg(trend)}
          <div class="networth-chart-labels">${trend.map((point) => `<span>${formatMonth(point.month).split(" ")[0].slice(0, 3)}</span>`).join("")}</div>
        </section>` : ""}
        ${showCard("cashflow") ? `<section class="card">
          <div class="section-head"><div><span class="card-label">Trend</span><h3>Cash flow</h3></div><span>${money.format(totalIncome - totalExpenses)} net over ${months.length} months</span></div>
          ${reportsCompareLastYear ? `<div class="reports-yoy-row">${yoyBadgeHtml(yoyDelta(totalIncome, priorIncome))}<small>income</small>${yoyBadgeHtml(yoyDelta(totalExpenses, priorExpenses))}<small>expenses</small></div>` : ""}
          ${cashFlowChart(months)}
        </section>` : ""}
        ${showCard("cashflowbreakdown") ? `<section class="card">
          <div class="section-head"><div><span class="card-label">Breakdown</span><h3>Cash flow breakdown</h3></div><span>${money.format(totalIncome)} income this period</span></div>
          ${sankeySegments.length ? cashFlowBreakdownBar(sankeySegments, totalIncome) : `<div class="empty-inline">No income or spend in this period</div>`}
          ${sankeySegments.some((segment) => segment.lineIds.length) ? `<small class="muted">Click a category band for its transactions.</small>` : ""}
          ${expandedSankeySegment ? `
            <div class="tag-summary-total"><span>${escapeHtml(expandedSankeySegment.label)} total</span><b>${money.format(expandedSankeySegment.value)}</b></div>
            <div class="tag-transaction-list">${expandedSankeyTransactions.length ? [...expandedSankeyTransactions].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((transaction) => `
              <div class="tag-transaction-row">
                <span>${escapeHtml(transaction.payee)}</span>
                <small>${formatShortDate(transaction.date)}</small>
                <b>${money.format(transaction.amount)}</b>
              </div>
            `).join("") : `<div class="empty-inline">No transactions found for this category.</div>`}</div>
          ` : ""}
        </section>` : ""}
        ${showCard("category") ? (() => {
          const sortedCategories = [...categories].sort((a, b) => b.value - a.value).map((category, index) => ({ ...category, themeColor: reportsTheme.palette[index % reportsTheme.palette.length] }));
          const barsMarkup = sortedCategories.map((category) => `
            <div class="report-row-group">
              <div class="category-spend-row">
                <span class="category-spend-icon" aria-hidden="true">${categoryIcon(category.name)}</span>
                <strong class="category-spend-name">${escapeHtml(category.name)}</strong>
                <div class="category-spend-bar-track"><span class="category-spend-bar-fill" style="width:${category.percent}%; background:${category.themeColor}"></span></div>
                <b class="category-spend-amount">${money.format(category.value)}</b>
              </div>
              ${category.lines.length ? `<details class="report-subcategory-details">
                <summary>${category.lines.length} subcategor${category.lines.length === 1 ? "y" : "ies"}</summary>
                ${category.lines.map((line) => `<div class="report-subcategory-row"><span>${escapeHtml(line.name)}</span><b>${money.format(line.value)}</b></div>`).join("")}
              </details>` : ""}
            </div>
          `).join("");
          const ringsMarkup = `<div class="report-category-rings">${sortedCategories.map((category) => {
            const key = category.lines.map((line) => line.id).join(",");
            const expanded = reportsExpandedRingCategory === key;
            return `<button type="button" class="report-category-ring" data-toggle-category-ring="${escapeHtml(key)}">
              <div class="report-category-ring-dial" style="background:conic-gradient(${category.themeColor} ${category.percent}%, var(--soft-blue) ${category.percent}% 100%)"><span class="report-category-ring-icon">${categoryIcon(category.name)}</span></div>
              <strong>${escapeHtml(category.name)}</strong>
              <small class="muted">${money.format(category.value)}</small>
              ${expanded && category.lines.length ? `<div class="report-category-ring-lines">${category.lines.map((line) => `<span>${escapeHtml(line.name)}: ${money.format(line.value)}</span>`).join("")}</div>` : ""}
            </button>`;
          }).join("")}</div>`;
          return `<section class="card"><div class="card-label">Spending</div><h3>Category report</h3>${reportsCategoryStyle === "rings" ? ringsMarkup : barsMarkup}</section>`;
        })() : ""}
        ${showCard("budgetvsactual") ? `<section class="card">
          <div class="card-label">Insight</div><h3>Budget vs Expense</h3>
          <div class="budget-vs-actual-list">${budgetVsActual.map((row) => `
            <div class="budget-vs-actual-row">
              <span>${formatMonth(row.month)} · ${escapeHtml(row.category)}</span>
              <span>Planned ${money.format(row.planned)}</span>
              <span>Actual ${money.format(row.actual)}</span>
              <b class="${row.variance < 0 ? "danger" : ""}">${row.variance >= 0 ? "+" : ""}${money.format(row.variance)}${row.variancePercent === null ? "" : ` (${row.variancePercent}%)`}</b>
            </div>
          `).join("") || `<div class="empty-inline">No categories to compare yet.</div>`}</div>
        </section>` : ""}
        ${showCard("transactions") ? `<section class="card">
          <div class="section-head"><div><span class="card-label">Detail</span><h3>Transactions</h3></div><span>${rangeTransactions.length} in this period</span></div>
          <div class="tag-transaction-list">${[...rangeTransactions].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((transaction) => `
            <div class="tag-transaction-row">
              <small>${formatShortDate(transaction.date)}</small>
              <span>${escapeHtml(transaction.payee)}</span>
              <small>${escapeHtml(transactionAssignmentLabel(transaction))}</small>
              <b>${money.format(transaction.amount)}</b>
            </div>
          `).join("") || `<div class="empty-inline">No transactions in this period.</div>`}</div>
        </section>` : ""}
        ${showCard("categorysubcategory") ? `<section class="card">
          <div class="card-label">Insight</div><h3>Category / Subcategory</h3>
          ${categories.some((category) => category.lines.length) ? `<label>Filter by category or subcategory<select id="reportsCategoryLineFilter">
            <option value="">All categories</option>
            ${categories.filter((category) => category.lines.length).map((category) => {
              const categoryKey = `cat:${category.lines.map((line) => line.id).join(",")}`;
              return `<optgroup label="${escapeHtml(category.name)}">
                <option value="${categoryKey}" ${reportsSelectedCategoryLine === categoryKey ? "selected" : ""}>All of ${escapeHtml(category.name)} (${money.format(category.value)})</option>
                ${category.lines.map((line) => `<option value="line:${line.id}" ${reportsSelectedCategoryLine === `line:${line.id}` ? "selected" : ""}>${escapeHtml(line.name)} (${money.format(line.value)})</option>`).join("")}
              </optgroup>`;
            }).join("")}
          </select></label>` : `<div class="empty-inline">No category spend in this range yet.</div>`}
          ${reportsSelectedCategoryLine && categoryLineLabel ? `
            <div class="tag-summary-total"><span>${escapeHtml(categoryLineLabel)} total</span><b>${money.format(categoryLineTotal)}</b></div>
            <div class="tag-transaction-list">${categoryLineTransactions.length ? [...categoryLineTransactions].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((transaction) => `
              <div class="tag-transaction-row">
                <span>${escapeHtml(transaction.payee)}</span>
                <small>${formatShortDate(transaction.date)}</small>
                <b>${money.format(transaction.amount)}</b>
              </div>
            `).join("") : `<div class="empty-inline">No transactions found.</div>`}</div>
          ` : ""}
        </section>` : ""}
        ${showCard("tags") ? `<section class="card">
          <div class="card-label">Insight</div><h3>Tags</h3>
          ${reportsTagGroups.length ? `<label>Group by tag<select id="reportsTagFilter">
            <option value="">All tags</option>
            ${reportsTagGroups.map((group) => `<option value="${escapeHtml(group.key)}" ${group.key === reportsSelectedTag ? "selected" : ""}>${escapeHtml(group.label)} (${money.format(group.total)})</option>`).join("")}
          </select></label>` : `<div class="empty-inline">No tagged transactions in this range yet.</div>`}
          ${selectedReportsTagGroup ? `
            <div class="tag-summary-total"><span>${escapeHtml(selectedReportsTagGroup.label)} total</span><b>${money.format(selectedReportsTagGroup.total)}</b></div>
            <div class="tag-transaction-list">${[...selectedReportsTagGroup.transactions].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((transaction) => `
              <div class="tag-transaction-row">
                <span>${escapeHtml(transaction.payee)}</span>
                <small>${formatShortDate(transaction.date)}</small>
                <b>${money.format(transaction.amount)}</b>
              </div>
            `).join("")}</div>
          ` : ""}
        </section>` : ""}
      </div>
      <aside class="side-stack">
        <section class="card"><div class="card-label">Budget health</div><h3>Snapshot</h3><div class="snapshot-grid"><span>Planned <b>${money.format(plannedTotal())}</b></span><span>Spent <b>${money.format(spentTotal())}</b></span><span>Cash left <b>${money.format(remainingTotal())}</b></span><span>Net worth <b>${money.format(currentNetWorth)}</b></span></div>${categories.slice(0, 3).map((category) => compactRow(`${category.name} - ${money.format(category.value)}`, "", "")).join("")}</section>
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
    { icon: "◈", title: "Households", id: "households",
      steps: [
        "Open <strong>Current household</strong> in the sidebar to switch between homes — each one keeps entirely separate budgets, calendars, notes, and records.",
        "Select <strong>+ Add</strong> to create another household (one per currency — you'll be blocked if you already have one in that currency).",
        "Select <strong>Set as default</strong> to choose which household loads automatically the next time you sign in.",
        "Select <strong>Remove</strong> to delete a household outright — blocked if it's your only one."
      ],
      tips: [
        "Set as default is personal to you — it doesn't change what other members see when they sign in.",
        "Running two currencies (e.g. a home country and an overseas one)? That's exactly what a second household is for."
      ] },
    { icon: "▦", title: "Budget", id: "budget",
      image: { src: "assets/mockup-budget.svg", alt: "A Housing category with planned/spent totals and two subcategory rows with progress bars" },
      steps: [
        "First time in a month? Select <strong>Start planning</strong>, then add each paycheck under <strong>Add income</strong>.",
        "Select <strong>Add category</strong> and type a name (e.g. Housing, Food, Debt).",
        "Inside a category, select <strong>+ Add subcategory</strong> for each budget line (e.g. Rent, Groceries) and give it a planned amount.",
        "Optionally set a due day on a bill-like line to get it reminders on the Calendar and its own sinking-fund set-aside math.",
        "As you assign transactions to a line (see Transactions below), <strong>Spent</strong> and <strong>Remaining</strong> update automatically — nothing to recalculate by hand.",
        "Starting a new month? Use <strong>Use previous budget</strong> at the top of Categories and subcategories to copy last month's categories and amounts instead of rebuilding from scratch."
      ],
      tips: [
        "Build out every category before you start assigning transactions — an unassigned transaction can't tell you if you're over or under budget in that area.",
        "\"Left to budget\" at the top should reach $0 once every dollar of income has a job — that's zero-based budgeting.",
        "Recurring bills (HOA, insurance, property tax, subscriptions) are worth marking as recurring so FamilyLoop sets aside savings for them every month instead of one big hit when the bill lands."
      ] },
    { icon: "☰", title: "Transactions", id: "transactions",
      image: { src: "assets/mockup-bank-stream.svg", alt: "A Bank Stream refund row with a Refund match pill and Subcategory pre-filled to the matched purchase's budget line" },
      steps: [
        "Use <strong>+ Add transaction</strong> for something you're entering by hand, or <strong>+ Import CSV/PDF</strong> to bring in a bank or credit-card statement.",
        "Imported rows land in the <strong>Bank Stream</strong> review queue first — nothing counts until you accept or dismiss each one.",
        "Pick the <strong>Subcategory</strong> (budget line) for each transaction so it counts toward that line's Spent total in Budget.",
        "If you've linked a bank account under Wealth, also link the transaction to that account so its running balance stays accurate.",
        "Select the ✓ to accept a Bank Stream row into the ledger, or × to dismiss it."
      ],
      tips: [
        "A refund or return is auto-matched to its original purchase by payee, amount, and date, and pre-filled with that purchase's budget line — always double-check the suggested line before accepting, especially if it wasn't a confident match.",
        "\"Possible duplicate\" and \"Possible transfer\" pills flag likely re-imports and account-to-account movements (like a credit card payment from checking) before you accept them — use the ⇄ icon to move a transfer instead of counting it as an expense.",
        "Tag transactions (e.g. \"Florida trip\") to see them grouped together later in Reports.",
        "A new transaction's Subcategory <strong>and</strong> Wealth account are both pre-filled from how you (or a similar payee) were categorized/linked most recently, in both Bank Stream (a <strong>From history</strong> pill for Subcategory, an <strong>Account from history</strong> pill for the account) and the manual Add transaction form - always worth a glance before accepting, since it's a suggestion, not a guarantee.",
        "No history for a payee yet? Select <strong>✨ Suggest with AI</strong> for Subcategory, or <strong>✨ Suggest account with AI</strong> for the account (both on the Add transaction form, or their matching ✨ buttons next to an unlinked Bank Stream row) to have it pick from your real budget lines or Wealth accounts - only runs when you ask, one payee at a time, never automatically across a whole import.",
        "CSV import recognizes exports from Chase, Capital One, Wells Fargo, Discover, Amex, and Citi, among others — both plain checking-style files and credit-card-style files (positive = purchase) are detected automatically. PDF import recognizes both a monthly credit-card statement and a checking/deposit account's \"Account Activity\" print export (e.g. Bank of America's Online Banking print-to-PDF); a still-\"Processing\" row that hasn't posted yet imports dated today with a <strong>Pending</strong> pill, so it isn't lost — just correct the date once your bank posts it for real.",
        "An import auto-links to a Wealth account by matching its name against the file's own name (and, for a checking-account PDF, the account label printed on the statement itself, e.g. \"Adv Plus Banking - 6769\") — if that whole-file match comes up empty, each row still falls back to the per-payee account history/AI suggestion above; if nothing matches at all, use <strong>Set account for all unlinked rows</strong> above the list to assign one account to everything in a single action instead of picking it row by row."
      ] },
    { icon: "☑", title: "Paycheck/Income", id: "paycheck",
      steps: [
        "In Budget, select <strong>Add income</strong> and name the paycheck (e.g. \"Jordan's salary\").",
        "Set the amount and how often it repeats — one-time, bonus, weekly, biweekly, or monthly.",
        "Use the assign form to route pieces of that paycheck to specific budget lines until it's fully assigned.",
        "Optionally set <strong>Deposit to account</strong> (under Wealth) so that account's balance reflects the deposit automatically."
      ],
      tips: [
        "Setting a deposit account means you don't need a matching manual transaction just to keep that account's balance right.",
        "The Paycheck page filters to unpaid paychecks sorted by how soon they're due, so you always see what needs assigning next first."
      ] },
    { icon: "⌂", title: "Calendar", id: "calendar",
      image: { src: "assets/mockup-calendar.svg", alt: "A week grid with a past-due chore card and a chore rotation panel showing who's up next" },
      steps: [
        "Add a chore with a repeat schedule (weekly, every 2/3/4/6 months, or yearly) — it rotates through the <strong>Chore rotation</strong> panel automatically.",
        "Select <strong>Complete</strong> on a chore to reveal its next occurrence; anything overdue turns red as \"Past due.\"",
        "Add birthdays and anniversaries once — they recur every year automatically.",
        "Set <strong>Remind before</strong> (or <strong>Don't remind</strong>) and <strong>Remind me at</strong> to control exactly when the reminder email fires, then select <strong>Mark wished</strong> once you've reached out.",
        "Add a plain Reminder with its own independent remind time, fully separate from the event's own date — so a noon event can remind you an hour earlier.",
        "Use the member chips above the grid to filter the whole calendar down to one person."
      ],
      tips: [
        "Completed chores stay visible on the calendar grid instead of disappearing, so you can see what actually got done.",
        "Assign chores to different household members and rotate fairly — everyone sees only their own past-due items highlighted on Home."
      ] },
    { icon: "✎", title: "Notes", id: "notes",
      steps: [
        "Create a note, give it a label and color, and add a checklist if it needs one.",
        "Nest checklist items under a parent item for sub-steps — typing will suggest matches from items you've used before.",
        "Select <strong>Pin</strong> on notes you check often so they stay at the top.",
        "Select <strong>Archive</strong> once a note is done but might be useful again later.",
        "Deleted notes move to Trash and are permanently removed after 7 days — recover one before then if needed."
      ],
      tips: ["Drag checklist items to reorder them — handy for turning a note into a step-by-step list."] },
    { icon: "✒", title: "Journal", id: "journal",
      steps: [
        "Open Journal and add an entry for the day — mood, gratitude, tags, photos, and free text are all optional.",
        "Use the AI reflection option for a short prompt back on what you wrote, if you'd find that helpful.",
        "Browse past entries by date to see patterns over time."
      ],
      tips: ["This is private to you — never shared with other household members, even ones with full access to everything else."] },
    { icon: "◫", title: "Plan", id: "plan",
      steps: [
        "Add a task with a start time and duration on the daily timeline.",
        "Drag or resize a task block to adjust when it happens.",
        "Log what actually happened afterward so Plan can compare planned versus actual.",
        "Break a task into subtasks for anything with multiple steps."
      ],
      tips: ["Like Journal, Plan is private to you alone — a personal planner, not a shared household calendar."] },
    { icon: "📁", title: "Documents", id: "documents",
      image: { src: "assets/mockup-documents.svg", alt: "A folder card and two file cards in a grid, with a file information panel below" },
      steps: [
        "Select <strong>+ New folder</strong> to organize files, or drag files/whole folders straight onto the page to upload.",
        "Use the ⋮ menu on any file to open, download, rename, make a copy, view file information, move it, or delete it.",
        "Link a folder or an individual document to a Note, or to a specific asset/liability in Wealth (for example, a mortgage folder linked to your home) so the paperwork behind a number is easy to find later."
      ],
      tips: ["Documents are shared across every household you own, not just the one currently selected — so they don't disappear when you switch households."] },
    { icon: "⚖", title: "Decisions", id: "decisions",
      steps: [
        "Select <strong>Add decision</strong> and type the question you're weighing (e.g. \"Should we move to a bigger apartment?\").",
        "Add notes for context, and attach any relevant files.",
        "List out Pros and Cons together as they come up.",
        "Once you've chosen, fill in what you decided and select <strong>Mark decided</strong> — you can always <strong>Reopen</strong> it later if things change."
      ],
      tips: ["Decisions are shared across all your households too, just like Documents — a running family log, not tied to one specific household."] },
    { icon: "💸", title: "Shared Expenses", id: "shared-expenses",
      image: { src: "assets/mockup-shared-expenses.svg", alt: "A split-a-bill total with two per-person balance cards, one owed to you and one you owe" },
      steps: [
        "Add people you split money with under <strong>Friends</strong> — add their email any time to send an invite.",
        "Use <strong>Record a debt</strong> for a simple one-off — pick a person, an amount, and whether you owe them or they owe you.",
        "Use <strong>Split a bill with friends</strong> when you paid the whole thing yourself — enter the total bill (including your own share), pick a split type (equal, exact amounts, percentage, or shares), and only your friends' portions get tracked as amounts owed to you.",
        "Select <strong>Settle up</strong> against a person's running balance once they've paid you back (or you've paid them), for the full amount or a partial one."
      ],
      tips: ["Assign a Ledger transaction directly to an IOU split (via the 👥 icon) when you're entering the original purchase, instead of creating the split separately afterward."] },
    { icon: "♨", title: "Meals and recipes", id: "meals",
      steps: [
        "Save a reusable recipe under <strong>Recipes</strong> with its ingredients and nutrition info.",
        "In <strong>Meals</strong>, drop a saved recipe into a day and slot on the weekly planner.",
        "Use the grocery list built automatically from that week's planned ingredients.",
        "Post the grocery list straight to a budget line when you're ready to shop."
      ],
      tips: ["Build a small library of go-to recipes once — planning a week becomes picking from a list instead of starting from zero."] },
    { icon: "◎", title: "Goals", id: "goals",
      steps: [
        "Add a sinking fund with a name, a target amount, and optionally a target date.",
        "Update <strong>Saved so far</strong> as you contribute — the progress bar and remaining balance recalculate automatically."
      ],
      tips: ["Use Goals for anything you're saving toward outside a monthly bill — vacations, a big purchase, an emergency fund."] },
    { icon: "▥", title: "Wealth", id: "wealth",
      image: { src: "assets/mockup-wealth.svg", alt: "A net worth summary strip and two account cards with colored type dots and a debt payoff tracker" },
      steps: [
        "Add a real bank or credit-card <strong>Account</strong> with its opening balance.",
        "Let the balance update itself from there on — it's computed live from linked transactions, paychecks, and transfers, never entered by hand.",
        "Link an account to a <strong>Net worth</strong> asset or liability so that entry updates automatically as the account does.",
        "For debt, check the <strong>Debt payoff tracker</strong> — it estimates a payoff date and suggested payment from the balance, rate, and term you enter."
      ],
      tips: [
        "Move an account-to-account payment (like paying a credit card from checking) to a Transfer instead of leaving it as a regular expense/income pair — the ⇄ icon on a matched transaction does this in one step.",
        "Drag an account or net worth item by its ⠿ handle to reorder its list - useful for putting the ones you check most often at the top.",
        "Under Net worth, a brokerage or retirement account with several stocks or mutual funds shows as one card - add a holding, then set its Asset class to Stock or Retirement to turn it into one. <strong>Manage list</strong> on the card is where you add, edit, or remove individual holdings.",
        "Enter each holding's <strong>Avg. cost</strong> in Manage list to see gain/loss in dollars and percent, per holding and totaled on the card - holdings with no cost basis entered are left out of the total rather than counted as break-even.",
        "No real ticker for a holding (like a proprietary 401(k) fund)? Type its dollar value straight into <strong>Market value</strong> in Manage list instead of shares × price - shares default to 1 and price adjusts to match."
      ] },
    { icon: "♙", title: "Sharing", id: "sharing",
      steps: [
        "Select <strong>Invite</strong>, choose a preset role (co-owner, adult, viewer, or meals/chores-only) or pick exact areas to share instead.",
        "Send the one-time invite code to the person you're inviting.",
        "Resend a new code any time theirs lapsed or was already used — a code is single-use.",
        "Select <strong>Revoke</strong> next to any member in the list to remove their access."
      ],
      tips: ["Pick \"exact areas to share\" instead of a preset role for anyone who should only see, say, Calendar and Chores and nothing about the household's money."] },
    { icon: "◷", title: "Reports and export", id: "reports",
      image: { src: "assets/mockup-reports-category.svg", alt: "The Category report card: a horizontal bar with an icon and dollar amount per category, sorted largest first" },
      steps: [
        "Choose a scope — month, date range, or whole year — from the toolbar at the top.",
        "Review the cards: Budget vs Expense, Cash flow trend, Cash flow breakdown (the Sankey chart), Category/Subcategory, and Tags.",
        "Select any Sankey segment, category, subcategory, or tag to drill down into the exact transactions behind that number.",
        "Use the header's download control to export whatever you're currently viewing as a file."
      ],
      tips: ["If a refund never got matched to its purchase, that category's total will look higher than it really is until you assign the refund to the same budget line — see the Transactions tips above."] }
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
      <nav class="help-toc" aria-label="Jump to a topic">
        ${guides.map((guide) => `<button type="button" class="help-toc-link" data-help-jump="${guide.id}">${guide.icon} ${guide.title}</button>`).join("")}
      </nav>
      <section class="help-grid">
        ${guides.map((guide) => `
          <article class="help-topic ${guide.image ? "has-image" : ""}" id="help-${guide.id}">
            <span class="help-topic-icon">${guide.icon}</span>
            <div>
              <h3>${guide.title}</h3>
              ${guide.image ? `<img class="help-topic-image" src="${guide.image.src}" alt="${escapeHtml(guide.image.alt)}" loading="lazy">` : ""}
              <ol class="help-steps">${guide.steps.map((step) => `<li>${step}</li>`).join("")}</ol>
              ${guide.tips?.length ? `<div class="help-tips"><strong>Get the most out of it</strong><ul>${guide.tips.map((tip) => `<li>${tip}</li>`).join("")}</ul></div>` : ""}
            </div>
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
      <section class="help-faq">
        <span class="card-label">FAQ</span>
        <h3>Common questions</h3>
        ${[
          ["Will I lose data if I remove a household?", "Yes — removing a household deletes all of its budget, transaction, calendar, meal, goal, debt, and asset data, and it's blocked if it's your only household. Documents and Decisions are unaffected either way, since those belong to you personally, not to any one household."],
          ["Why do I see the same Documents and Decisions in every household I own?", "Those two features are deliberately shared across every household you own, not tied to one household - so your paperwork and family decisions don't disappear or split apart when you switch households. Everything else (budget, calendar, transactions, meals, and so on) stays separate per household."],
          ["Can other household members read my Journal or Plan?", "No. Both are private to you specifically, even for household members who otherwise have full access to everything else."],
          ["Why didn't my refund automatically match its purchase?", "Automatic matching needs an exact opposite amount, a similar payee name, and a purchase dated within 180 days before the refund. If any of those don't line up - a different amount, very different payee wording, or more than 180 days apart - it won't auto-match. Pick the correct Subcategory yourself on that Bank Stream row before accepting it."],
          ["My budget category still shows money spent that I got refunded - why?", "A refund only offsets a category's spending once it's assigned to the same budget line as the original purchase. An unmatched refund sitting unassigned doesn't cancel anything out in that category's total, even though your overall Cash flow total nets out correctly either way. Check the Subcategory on that transaction."],
          ["Why is my linked account's balance different from what I expected?", "A linked account's balance is always computed live from its real linked transactions, paychecks, and transfers - never typed in by hand after the opening balance. If it looks off, something real (a transaction, paycheck, or transfer) probably isn't linked to that account yet."],
          ["I lost my invitation email or code - what do I do?", "Ask the household owner to resend it from Sharing. A code is single-use, and resending automatically replaces the old one."],
          ["How long do I have to recover a deleted note?", "7 days in Trash - after that it's permanently removed."],
          ["Can I run households in different currencies?", "Yes - FamilyLoop allows one household per currency. Switch between them any time from Current household in the sidebar."],
          ["Does a successful email mean the recipient definitely got it?", "Not quite - a successful send just means the email provider accepted the message for delivery, not that it landed in the inbox. Check Spam and All Mail if an expected email doesn't show up."],
          ["What does Try demo actually give me access to?", "A temporary account with no reusable credentials and no administrator access - safe to explore the whole app without setting anything up first."]
        ].map(([question, answer]) => `
          <details class="help-faq-item">
            <summary>${question}</summary>
            <p>${answer}</p>
          </details>
        `).join("")}
      </section>
      <section class="help-footer">
        <div><span class="card-label">Need assistance?</span><h3>Contact the household owner first</h3></div>
        <p>Household owners manage invitations and shared access. Application administrators manage login availability.</p>
      </section>
    </section>`;
}

function scrollToHelpTopic(topicId) {
  document.getElementById(`help-${topicId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Help is content-only (renderHelp() never touches state), so it doesn't
// need a signed-in session - shown as its own panel alongside #authPanel
// rather than requiring #workspace, which stays hidden until real login.
// This is also what makes a bookmarked/shared #help link work even when the
// visitor's session has expired, instead of silently landing back on the
// sign-in form with no way to reach it.
function showPublicHelp() {
  $("#authPanel").hidden = true;
  const panel = $("#publicHelpPanel");
  panel.hidden = false;
  panel.innerHTML = `
    <div class="public-help-nav">
      <button id="closePublicHelpButton" class="ghost" type="button">← Back to sign in</button>
      <button class="ghost" type="button" data-public-help-goto="/welcome.html">Home</button>
      <button class="ghost" type="button" data-public-help-goto="/calculators.html">Calculators</button>
      <button class="ghost" type="button" data-public-help-goto="/welcome.html#privacy">Privacy</button>
    </div>
    ${renderHelp()}`;
  $("#closePublicHelpButton").addEventListener("click", hidePublicHelp);
  panel.querySelectorAll("[data-public-help-goto]").forEach((button) => {
    button.addEventListener("click", () => { window.location.href = button.dataset.publicHelpGoto; });
  });
  history.replaceState({}, "", "#help");
}

function hidePublicHelp() {
  $("#publicHelpPanel").hidden = true;
  $("#publicHelpPanel").innerHTML = "";
  $("#authPanel").hidden = false;
  history.replaceState({}, "", location.pathname);
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
  return `<div class="compact-row calendar-manage-row">
    <div class="calendar-manage-row-head">
      <div class="calendar-manage-row-meta">${assigneeDots(assignees)}${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>
      <div class="compact-row-actions">
        <button class="icon-button" data-edit-calendar-item="${kind}:${id}" type="button" aria-label="Edit ${escapeHtml(title)}">✎</button>
        <button class="icon-button danger-button" data-delete-calendar-item="${kind}:${id}" type="button" aria-label="Remove ${escapeHtml(title)}">×</button>
      </div>
    </div>
    <strong>${escapeHtml(title)}</strong>
    ${badge ? `<span class="pill">${escapeHtml(badge)}</span>` : ""}
    ${directionsLinkHtml(reminderEvent?.location)}
    ${reminderEvent ? `<div class="chore-complete-group">${reminderCompletionControl(reminderEvent)}</div>` : ""}
  </div>`;
}

function progressNumberBlock(label, value, target, unit) {
  const pct = Math.min(100, Math.round((Number(value || 0) / Math.max(Number(target || 0), 1)) * 100));
  return `<div class="progress-block"><div><span>${label}</span><b>${Number(value || 0).toLocaleString()}${unit ? ` ${unit}` : ""} / ${Number(target || 0).toLocaleString()}${unit ? ` ${unit}` : ""}</b></div><div class="bar"><span style="width:${pct}%"></span></div></div>`;
}

// Split into still-due and already-paid so the Paycheck page's Due-date flow
// reads as "what needs my attention" rather than a flat wall of every
// subcategory that has ever had a due day set. When viewing the current
// real month, the due list is further ordered overdue-first (most urgent -
// the due day already passed but it's still unpaid) then by soonest
// upcoming due day, rather than raw ascending day-of-month (which buried a
// bill due today under earlier-in-the-month ones that already got paid).
// Viewing a past/future budget month has no meaningful "today" to measure
// against, so it falls back to plain ascending day-of-month.
function dueDateRows() {
  const todayDay = new Date().getDate();
  const isCurrentMonth = state.budget.month === dateKey(new Date()).slice(0, 7);
  const rows = allLines()
    .filter((line) => line.dueDay)
    .map((line) => ({
      name: line.name,
      dueDay: line.dueDay,
      date: `${String(line.dueDay).padStart(2, "0")} · Bill ${money.format(line.planned)}`,
      paid: spentByLine(line.id) >= Number(line.planned || 0)
    }));
  const paid = rows.filter((row) => row.paid).sort((a, b) => a.dueDay - b.dueDay);
  const unpaid = rows.filter((row) => !row.paid);
  const due = isCurrentMonth
    ? [
        ...unpaid.filter((row) => row.dueDay < todayDay).sort((a, b) => a.dueDay - b.dueDay),
        ...unpaid.filter((row) => row.dueDay >= todayDay).sort((a, b) => a.dueDay - b.dueDay)
      ]
    : unpaid.sort((a, b) => a.dueDay - b.dueDay);
  return { due, paid };
}

function scheduleItems() {
  ensureAnnualEventRecurrenceData();
  ensureChoreRecurrenceData();
  ensureAssigneesData();
  const selectedMonth = state.budget.month;
  const oneTimeEvents = state.calendar.events
    .filter((event) => !ANNUAL_EVENT_TYPES.includes(event.type) && event.date?.startsWith(selectedMonth) && !isReminderComplete(event))
    .map((event) => ({ title: event.title, date: event.date.slice(5), displayDate: `${event.date.slice(5)}${event.dateTime ? ` · ${formatReminderTime(event.dateTime)}` : ""}`, type: event.type, sourceKind: "event", sourceId: event.id, assignees: event.assignees || [], recurring: Boolean(event.recurrence && event.recurrence !== "once") }));
  const chores = state.calendar.chores.flatMap((chore) =>
    choreOccurrencesForMonth(chore).map((occurrence) => ({
      title: chore.title,
      date: occurrence.date.slice(5),
      type: "Chore",
      label: `${choreCadenceLabel(chore)} chore`,
      eventType: "chore",
      sourceKind: "chore",
      sourceId: chore.id,
      assignees: chore.assignees || [],
      recurring: Boolean(chore.recurrence && chore.recurrence !== "once")
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

// Recurring paychecks deposit through real, individually editable/deletable
// rows (state.paycheckOccurrences) rather than being computed on the fly, so
// a specific missed payday (or any other single occurrence) can be deleted
// without touching any other month, past or future. Rows are only
// materialized up to 12 months out - not forever - and this window keeps
// advancing each time the app is used, since it is recomputed from todays
// date on every render rather than once at creation time. generatedThroughDate
// is a watermark: it only ever moves forward, so a deleted occurrence is
// never silently regenerated.
function ensurePaycheckOccurrencesGenerated() {
  state.paycheckOccurrences ||= [];
  // Enforced on every render (not just reactively when the end date field
  // itself changes) so an occurrence materialized before an end date existed
  // — or from before this pruning existed at all — doesn't linger forever;
  // the invariant "no occurrence past a paycheck's end date" always holds.
  const paychecksById = new Map(state.paychecks.map((paycheck) => [paycheck.id, paycheck]));
  state.paycheckOccurrences = state.paycheckOccurrences.filter((occurrence) => {
    const paycheck = paychecksById.get(occurrence.seriesId);
    return !paycheck?.endDate || occurrence.date <= paycheck.endDate;
  });
  const capDate = new Date();
  capDate.setMonth(capDate.getMonth() + 12);
  const capKey = dateKey(capDate);
  state.paychecks.forEach((paycheck) => {
    paycheck.id ||= uniqueId("paycheck");
    const recurrence = paycheck.recurrence || "once";
    // Occurrences already on file were materialized under whatever
    // recurrence was active when they were generated (generatedRecurrence) -
    // if the paycheck's recurrence has since changed (e.g. monthly ->
    // biweekly), those rows no longer match the real schedule and need to be
    // thrown out and regenerated from the anchor date, not left stale
    // alongside a mismatched watermark. Checking this on every render
    // (rather than only reactively in the Repeat dropdown's own change
    // handler) also self-heals any paycheck already left in this broken
    // state by an edit made before this check existed.
    if (paycheck.generatedRecurrence !== recurrence) {
      state.paycheckOccurrences = state.paycheckOccurrences.filter((occurrence) => occurrence.seriesId !== paycheck.id);
      paycheck.generatedThroughDate = "";
      paycheck.generatedRecurrence = recurrence;
    }
    if (recurrence === "once" || recurrence === "bonus") return;
    if (paycheck.generatedThroughDate && paycheck.generatedThroughDate >= capKey) return;
    const generateFromKey = paycheck.generatedThroughDate
      ? dateKey(new Date(new Date(`${paycheck.generatedThroughDate}T00:00:00`).getTime() + 24 * 60 * 60 * 1000))
      : paycheck.date;
    if (generateFromKey <= capKey) {
      paycheckAllOccurrenceDatesInRange(paycheck, generateFromKey, capKey).forEach((date) => {
        state.paycheckOccurrences.push({
          id: uniqueId("paycheck-occurrence"),
          seriesId: paycheck.id,
          date,
          amount: paycheck.amount,
          depositAccountId: paycheck.depositAccountId || ""
        });
      });
    }
    paycheck.generatedThroughDate = capKey;
  });
}

// Runs on every render (same convention as ensurePaycheckOccurrencesGenerated
// just above) so a goal with auto-contribute enabled keeps accumulating even
// when nobody's actually looking at the Goals page.
//
// Round-up tracks a watermark - how many transactions have already been
// accounted for - rather than a set of processed transaction ids, because
// transactions have no stable id of their own anywhere else in this app
// (they're addressed by array index). Percent-of-paycheck tracks processed
// paycheck-OCCURRENCE ids instead, since those do have a real id
// (ensurePaycheckOccurrencesGenerated already mints one per occurrence).
//
// Both are safe to call every render: once a transaction/occurrence has been
// counted, the watermark/id list rules it out next time, so nothing is ever
// double-credited just because render() ran again.
function ensureGoalAutoContributions() {
  let changed = false;
  state.goals.sinkingFunds.forEach((fund) => {
    const auto = fund.autoContribute;
    if (!auto?.enabled) return;
    if (auto.mode === "roundup") {
      fund.roundupProcessedCount ||= 0;
      const alreadySeen = fund.roundupProcessedCount;
      if (state.transactions.length <= alreadySeen) return;
      const newTransactions = state.transactions.slice(alreadySeen);
      const roundup = newTransactions.reduce((sum, transaction) => {
        const amount = Number(transaction.amount || 0);
        // Only positive (expense) amounts round up - a refund/income row
        // has nothing to "round" toward a purchase.
        return amount > 0 ? sum + (Math.ceil(amount) - amount) : sum;
      }, 0);
      fund.roundupProcessedCount = state.transactions.length;
      if (roundup > 0.004) {
        fund.saved = Math.round((Number(fund.saved || 0) + roundup) * 100) / 100;
        changed = true;
      }
    } else if (auto.mode === "percent") {
      const percent = Number(auto.percent || 0);
      if (percent <= 0) return;
      fund.percentProcessedOccurrenceIds ||= [];
      const today = dateKey(new Date());
      const newlyReceived = (state.paycheckOccurrences || []).filter((occurrence) => occurrence.date <= today && !fund.percentProcessedOccurrenceIds.includes(occurrence.id));
      if (!newlyReceived.length) return;
      const contribution = newlyReceived.reduce((sum, occurrence) => sum + Number(occurrence.amount || 0) * (percent / 100), 0);
      fund.percentProcessedOccurrenceIds.push(...newlyReceived.map((occurrence) => occurrence.id));
      if (contribution > 0.004) {
        fund.saved = Math.round((Number(fund.saved || 0) + contribution) * 100) / 100;
        changed = true;
      }
    }
  });
  if (changed) autosaveState();
}

// A recurring bill surfaces each elapsed period as a Bank stream draft for
// review (amount can vary month to month, e.g. a utility bill) rather than
// posting straight to the Ledger; it only becomes a real transaction once
// accepted there. postedDates tracks periods already surfaced (accepted or
// dismissed) so revisiting this page never re-surfaces the same period.
function ensureRecurringExpensesPosted() {
  state.recurringExpenses ||= [];
  state.transactionInboxDrafts ||= [];
  const today = dateKey(new Date());
  state.recurringExpenses.forEach((recurring) => {
    recurring.postedDates ||= [];
    recurringExpenseOccurrenceDates(recurring, today).forEach((date) => {
      if (recurring.postedDates.includes(date)) return;
      state.transactionInboxDrafts.unshift({
        id: uniqueId("recurring-bank-stream"),
        payee: recurring.payee,
        amount: Number(recurring.amount || 0),
        lineId: recurring.lineId,
        accountId: recurring.accountId || "",
        date,
        recurringId: recurring.id
      });
      recurring.postedDates.push(date);
    });
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

// Whether a reminder still belongs on viewerKey's own past-due/due-today
// list - same personalization as isChoreOccurrencePendingFor: once a
// specific assignee has marked their own part done, it drops off THEIR view
// even if other assignees haven't finished theirs yet, instead of staying
// stuck showing "Past due" until every last person clicks done.
function isReminderPendingFor(event, viewerKey) {
  const assigneeKeys = (event.assignees || []).map((assignee) => assignee.key);
  if (viewerKey && assigneeKeys.includes(viewerKey)) {
    const completedKeys = event.completedBy || [];
    return !completedKeys.includes(viewerKey);
  }
  return !isReminderComplete(event);
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

function choreCadenceLabel(chore) {
  const recurrence = chore.recurrence || "once";
  const base = {
    once: "Once",
    weekly: "Weekly",
    biweekly: "Every 2 weeks",
    triweekly: "Every 3 weeks",
    monthly: "Monthly",
    every3months: "Every 3 months",
    every4months: "Every 4 months",
    every6months: "Every 6 months",
    yearly: "Yearly"
  }[recurrence] || "Once";
  return chore.endDate ? `${base} until ${chore.endDate}` : base;
}

// Every occurrence of a chore that falls within the viewed month, regardless
// of completion - this feeds the literal calendar grid (and the "Upcoming
// schedule" side panel), which both need to keep showing a date's chore
// once it's happened, the same way a birthday or a past calendar event
// doesn't vanish from the grid once its day has passed. This is
// deliberately different from the "Chore rotation" panel (which uses
// nextPendingChoreOccurrence instead, precisely so completing one occurrence
// there reveals the next) - marking a chore done should drop it from that
// to-do list without also erasing it from the calendar's own record.
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
    return key.startsWith(state.budget.month) ? [{ date: key }] : [];
  }

  const monthStep = CHORE_MONTH_STEP_BY_RECURRENCE[chore.recurrence];
  if (monthStep) {
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= monthEnd) {
      const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const occurrence = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(start.getDate(), lastDay));
      if (occurrence >= start && occurrence >= monthStart && occurrence <= monthEnd) {
        dates.push({ date: dateKey(occurrence) });
      }
      cursor.setMonth(cursor.getMonth() + monthStep);
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
    dates.push({ date: dateKey(cursor) });
    cursor.setDate(cursor.getDate() + intervalDays);
  }
  return dates;
}

function nextChoreOccurrenceInMonth(chore) {
  return choreOccurrencesForMonth(chore)[0] || null;
}

const UPCOMING_LIST_LIMIT = 5;

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

// Whether a given year still belongs on viewerKey's own pending list —
// mirrors isChoreOccurrencePendingFor, but keyed purely on the viewer's own
// confirmation rather than assignee-list membership: an assignee on a
// birthday/anniversary means "whose family member this is," not "who's
// allowed to wish them," so anyone's own mark counts for their own view
// regardless of whether they're formally listed.
function isAnnualEventYearPendingFor(event, year, viewerKey) {
  if (viewerKey) {
    const completedKeys = (event.wishedBy || {})[String(year)] || [];
    return !completedKeys.includes(viewerKey);
  }
  return !isAnnualEventYearComplete(event, year);
}

// A single button tied to whoever is actually signed in — never a menu of
// every assignee's own checkbox, which would let one person mark it wished
// on someone else's behalf. Unlike a chore (where the assignee is literally
// "whose job it is"), a birthday/anniversary's assignee list just marks
// whose family member it is - wishing them happy birthday isn't limited to
// that one person, so every signed-in household member gets their own
// button here regardless of whether they're formally listed. A jointly-
// assigned birthday/anniversary only counts as fully wished for a given year
// once every assignee has marked their own button (see
// isAnnualEventYearComplete), but each person can only ever toggle their own.
function annualEventCompletionButtons(event, year) {
  const completedKeys = (event.wishedBy || {})[String(year)] || [];
  const assignees = event.assignees || [];
  // A handful of legacy birthdays/anniversaries predate the assignee system
  // and have nobody assigned at all, and a signed-out edge case has no
  // viewer either - "household" is the shared fallback button for both.
  const effectiveKey = sessionUser?.email || "household";
  const done = completedKeys.includes(effectiveKey);
  const total = Math.max(assignees.length, completedKeys.length);
  const suffix = total > 1 ? ` (${completedKeys.length}/${total})` : "";
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

// Whether an item belongs on THIS viewer's own Home dashboard at all - not
// just whether it's still pending. isChoreOccurrencePendingFor/
// isAnnualEventYearPendingFor fall back to a household-wide "has everyone
// finished" check whenever the viewer isn't an assignee (so the Calendar
// tab's shared rotation/side-panels can show every outstanding item to every
// member); Home is a personal "what do I need to do" list, so an item
// assigned only to OTHER people shouldn't appear there just because those
// other people haven't finished it yet. Unassigned (household-wide) items,
// and items the viewer IS assigned to, still show as usual.
function isRelevantToViewer(assignees, viewerKey) {
  if (!assignees || !assignees.length) return true;
  if (!viewerKey) return true;
  return assignees.some((assignee) => assignee.key === viewerKey);
}

// Everything on the Home dashboard that has an actual calendar date and is
// either already overdue or due today — chores, birthdays/anniversaries, and
// plain reminders. Personalized to the signed-in viewer the same way the
// Calendar tab's own side panels are (see nextPendingChoreOccurrence),
// so a jointly-assigned item drops off once the viewer has done their part,
// and an item assigned only to someone else never shows up here at all
// (see isRelevantToViewer).
function homeActionItems() {
  ensureChoreRecurrenceData();
  ensureAnnualEventRecurrenceData();
  const today = dateKey(new Date());
  const viewerKey = sessionUser?.email || "";

  const choreItems = state.calendar.chores
    .map((chore, index) => ({ chore, index, occurrence: nextPendingChoreOccurrence(chore, viewerKey) }))
    .filter((row) => row.occurrence && row.occurrence.date <= today && isRelevantToViewer(row.chore.assignees, viewerKey))
    .map((row) => ({
      date: row.occurrence.date,
      overdue: row.occurrence.date < today,
      title: row.chore.title,
      kind: "Chore",
      detail: `${assigneeNames(row.chore.assignees) || "Unassigned"} · ${choreCadenceLabel(row.chore)}`,
      reference: `chore:${row.chore.id}`,
      month: row.occurrence.date.slice(0, 7),
      completion: choreCompletionButtons(row.chore, row.index, row.occurrence.date)
    }));

  const annualItems = state.calendar.events
    .filter((event) => ANNUAL_EVENT_TYPES.includes(event.type))
    .map((event) => ({ event, occurrence: nextPendingAnnualEventOccurrence(event, new Date(), viewerKey) }))
    .filter((row) => row.occurrence && row.occurrence.date <= today && isRelevantToViewer(row.event.assignees, viewerKey))
    .map((row) => ({
      date: row.occurrence.date,
      overdue: row.occurrence.date < today,
      title: annualEventDisplayTitle(row.event),
      kind: annualEventLabels[row.event.type] || "Annual",
      detail: assigneeNames(row.event.assignees) || "Household",
      reference: `event:${row.event.id}`,
      month: row.occurrence.date.slice(0, 7),
      completion: annualEventCompletionButtons(row.event, row.occurrence.year)
    }));

  const reminderItems = state.calendar.events
    .filter((event) => event.type === "reminder" && event.date && event.date <= today && isReminderPendingFor(event, viewerKey) && isRelevantToViewer(event.assignees, viewerKey))
    .map((event) => ({
      date: event.date,
      overdue: event.date < today,
      title: event.title,
      kind: "Reminder",
      detail: event.dateTime ? formatReminderTime(event.dateTime) : (assigneeNames(event.assignees) || "Household"),
      reference: `event:${event.id}`,
      month: event.date.slice(0, 7),
      completion: reminderCompletionControl(event)
    }));

  return [...choreItems, ...annualItems, ...reminderItems].sort((a, b) => a.date.localeCompare(b.date));
}

// Notes reminders that are due today or already past — mirrors the
// household calendar items above, just for the separate Notes reminder
// concept (a note with its own reminder date/time, not a calendar item).
function homeNoteReminders() {
  ensureNotesData();
  const today = dateKey(new Date());
  return state.notes.entries
    .filter((note) => !note.archived && !note.trashed && note.reminder && note.reminder.slice(0, 10) <= today)
    .map((note) => ({
      id: note.id,
      title: note.title || "Untitled note",
      overdue: note.reminder.slice(0, 10) < today,
      reminder: note.reminder,
      detail: formatDateTime(note.reminder)
    }))
    .sort((a, b) => a.reminder.localeCompare(b.reminder));
}

// Today's Plan tasks (private to the signed-in user, same as the Plan tab
// itself) — always computed against the real current date rather than
// planSelectedDate, which only tracks whatever day the user last browsed to
// on the Plan tab and would otherwise drift from "today" here.
function homeTodayPlanTasks() {
  if (!privateData) return [];
  ensurePlanData();
  const today = dateKey(new Date());
  return privateData.plans.tasks
    .filter((task) => task.bucket === "daily" && dailyTaskOccursOnDate(task, today))
    .map((task) => ({
      id: task.id,
      title: task.title,
      done: isDailyTaskDoneOnDate(task, today),
      startTime: task.startTime || ""
    }))
    .sort((a, b) => (a.startTime ? timeToMinutes(a.startTime) : Infinity) - (b.startTime ? timeToMinutes(b.startTime) : Infinity));
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
  const sevenDaysAhead = dateKey(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  return visibleScheduleItems().filter((item) => {
    const fullDate = `${state.budget.month}-${item.date.slice(3)}`;
    return fullDate >= today && fullDate <= sevenDaysAhead;
  });
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

// Best-effort icon for a household's own free-typed category name (there's
// no icon field in the data model) - matched by keyword rather than exact
// name so household-specific variations ("Auto Insurance" vs "Car
// Insurance") still land on something sensible. Falls back to a generic
// wallet for anything that matches nothing, rather than leaving a blank.
const CATEGORY_ICON_KEYWORDS = [
  [/mortgage|rent|housing/i, "🏠"],
  [/insurance/i, "🛡️"],
  [/auto|car\b|vehicle|transport/i, "🚗"],
  [/fuel|\bgas\b/i, "⛽"],
  [/grocer|\bfood\b/i, "🛒"],
  [/electric/i, "⚡"],
  [/water/i, "💧"],
  [/util/i, "💡"],
  [/internet|cable|wifi/i, "🌐"],
  [/phone|mobile/i, "📱"],
  [/medical|health|pharmac|doctor/i, "💊"],
  [/restaurant|dining|bar\b/i, "🍽️"],
  [/coffee/i, "☕"],
  [/entertainment|streaming|movie/i, "🎬"],
  [/travel|flight|hotel/i, "✈️"],
  [/taxi|ride|uber|lyft|transit/i, "🚕"],
  [/cloth|shopping/i, "🛍️"],
  [/pet/i, "🐾"],
  [/gift|charity|giving|church/i, "🎁"],
  [/debt|credit card|loan|payoff/i, "💳"],
  [/saving|goal|fund|emergency/i, "🎯"],
  [/education|school|tuition|student/i, "🎓"],
  [/childcare|daycare|kid/i, "🧸"],
  [/subscription/i, "🔁"]
];

function categoryIcon(name) {
  const match = CATEGORY_ICON_KEYWORDS.find(([pattern]) => pattern.test(name || ""));
  return match ? match[1] : "💰";
}

function reportCategories() {
  const max = Math.max(...state.budget.categories.map((category) => category.lines.reduce((sum, line) => sum + spentByLine(line.id), 0)), 1);
  return state.budget.categories.map((category) => {
    const value = category.lines.reduce((sum, line) => sum + spentByLine(line.id), 0);
    return { name: category.name, value, color: category.color, percent: Math.max(2, Math.round((value / max) * 100)) };
  });
}

// Thin wrappers around lib/shared-logic.js's compute* counterparts - kept
// under their original names/signatures so every existing call site here in
// app.js is untouched, while the real (now unit-tested) implementation lives
// in shared-logic.js. Named "computeX" there specifically to avoid colliding
// with these same-named functions: app.js and shared-logic.js are separate
// <script> tags sharing one global scope, so two top-level functions with the
// identical name would silently shadow each other depending on script load
// order instead of throwing.
function reportCategoriesForScope(monthKeys) {
  return computeReportCategoriesForScope(state, monthKeys);
}

function trailingMonthKeys(count) {
  return computeTrailingMonthKeys(state.budget.month, count);
}

function netWorthAtDate(referenceDateKey) {
  return computeNetWorthAtDate(state, referenceDateKey);
}

function netWorthTrend(monthKeys) {
  return computeNetWorthTrend(state, monthKeys);
}

function cashFlowByMonth(monthKeys) {
  return computeCashFlowByMonth(state, monthKeys);
}

function netWorthTrendSvg(trend) {
  const width = 560;
  const height = 160;
  const padding = 20;
  const values = trend.map((point) => point.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = trend.length > 1 ? (width - padding * 2) / (trend.length - 1) : 0;
  const toXY = (point, index) => {
    const x = padding + stepX * index;
    const y = height - padding - ((point.value - min) / range) * (height - padding * 2);
    return [x, y];
  };
  const coords = trend.map(toXY);
  const zeroY = height - padding - ((0 - min) / range) * (height - padding * 2);
  // The filled area closes the line down to the zero baseline (not the
  // chart's bottom edge), so a net worth trend that dips negative still
  // fills correctly relative to zero rather than the arbitrary min value.
  const areaPoints = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const firstX = coords[0]?.[0].toFixed(1) ?? padding;
  const lastX = coords[coords.length - 1]?.[0].toFixed(1) ?? width - padding;
  const areaPath = coords.length ? `M${firstX},${zeroY.toFixed(1)} L${areaPoints} L${lastX},${zeroY.toFixed(1)} Z` : "";
  return `
    <svg viewBox="0 0 ${width} ${height}" class="networth-chart-svg" preserveAspectRatio="none" role="img" aria-label="Net worth trend">
      <defs>
        <linearGradient id="networthAreaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3569d4" stop-opacity="0.32"></stop>
          <stop offset="100%" stop-color="#3569d4" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${areaPath ? `<path d="${areaPath}" fill="url(#networthAreaGradient)"></path>` : ""}
      <line x1="${padding}" y1="${zeroY.toFixed(1)}" x2="${width - padding}" y2="${zeroY.toFixed(1)}" class="networth-chart-zero"></line>
      <polyline points="${areaPoints}" class="networth-chart-line"></polyline>
      ${coords.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="networth-chart-dot"></circle>`).join("")}
    </svg>`;
}

function cashFlowChart(months) {
  const max = Math.max(...months.flatMap((month) => [month.income, month.expenses]), 1);
  return `
    <div class="cashflow-chart">
      ${months.map((month) => `
        <div class="cashflow-month">
          <div class="cashflow-bars">
            <span class="cashflow-bar cashflow-income" style="height:${Math.max(2, Math.round((month.income / max) * 100))}%" title="Income ${money.format(month.income)}"></span>
            <span class="cashflow-bar cashflow-expense" style="height:${Math.max(2, Math.round((month.expenses / max) * 100))}%" title="Expenses ${money.format(month.expenses)}"></span>
          </div>
          <small>${formatMonth(month.month).split(" ")[0].slice(0, 3)}</small>
        </div>
      `).join("")}
    </div>
    <div class="cashflow-legend"><span class="cashflow-legend-income">Income</span><span class="cashflow-legend-expense">Expenses</span></div>`;
}

// Single stacked bar (each category as a proportional-width segment) + a
// wrapped legend below - replaces the earlier two-column Sankey ribbon
// diagram with a simpler read: hover any segment for its exact amount,
// click one with real transactions behind it to drill down (same
// data-sankey-lines click handler the Sankey version used, reused as-is).
// Colors come from the caller's chosen Reports color theme, cycling
// through its 5-color palette by index - not each category's own stored
// .color, so switching Reports themes never touches Budget's colors.
function cashFlowBreakdownBar(segments, totalIncome) {
  return `
    <div class="cashflow-breakdown-bar">
      ${segments.map((segment) => {
        const pct = totalIncome > 0 ? (segment.value / totalIncome) * 100 : 0;
        const key = segment.lineIds.length ? segment.lineIds.join(",") : "";
        const clickable = key ? ` data-sankey-lines="${escapeHtml(key)}" tabindex="0" role="button" aria-label="${escapeHtml(segment.label)} transactions"` : "";
        return `<div class="cashflow-breakdown-segment${key ? " cashflow-breakdown-clickable" : ""}" style="width:${pct.toFixed(2)}%; background:${segment.color}" title="${escapeHtml(segment.label)}: ${money.format(segment.value)}"${clickable}></div>`;
      }).join("")}
    </div>
    <div class="cashflow-breakdown-legend">
      ${segments.map((segment) => {
        const pct = totalIncome > 0 ? Math.round((segment.value / totalIncome) * 100) : 0;
        return `<span class="cashflow-breakdown-legend-item"><i style="background:${segment.color}"></i>${escapeHtml(segment.label)} <b>${money.format(segment.value)}</b> <small class="muted">${pct}%</small></span>`;
      }).join("")}
    </div>`;
}

// ---- Export-only chart renderers ----
//
// A rasterized image is drawn from a detached data-URI with no access to
// styles.css, so the live netWorthTrendSvg()/cashFlowChart() (which rely on
// external classes like .networth-chart-line, or plain CSS height divs for
// cash flow) would render invisible or not at all once rasterized. These
// two mirror their layout with every color inlined directly in the markup,
// used only for the exported report's embedded chart images.
function netWorthTrendSvgForExport(trend) {
  const width = 560;
  const height = 160;
  const padding = 20;
  const values = trend.map((point) => point.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = trend.length > 1 ? (width - padding * 2) / (trend.length - 1) : 0;
  const toXY = (point, index) => {
    const x = padding + stepX * index;
    const y = height - padding - ((point.value - min) / range) * (height - padding * 2);
    return [x, y];
  };
  const coords = trend.map(toXY);
  const zeroY = height - padding - ((0 - min) / range) * (height - padding * 2);
  const areaPoints = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const firstX = coords[0]?.[0].toFixed(1) ?? padding;
  const lastX = coords[coords.length - 1]?.[0].toFixed(1) ?? width - padding;
  const areaPath = coords.length ? `M${firstX},${zeroY.toFixed(1)} L${areaPoints} L${lastX},${zeroY.toFixed(1)} Z` : "";
  return `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"></rect>
      <defs>
        <linearGradient id="networthAreaGradientExport" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3569d4" stop-opacity="0.32"></stop>
          <stop offset="100%" stop-color="#3569d4" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${areaPath ? `<path d="${areaPath}" fill="url(#networthAreaGradientExport)"></path>` : ""}
      <line x1="${padding}" y1="${zeroY.toFixed(1)}" x2="${width - padding}" y2="${zeroY.toFixed(1)}" stroke="#dfe7ef" stroke-width="1" stroke-dasharray="4 4"></line>
      <polyline points="${areaPoints}" fill="none" stroke="#3569d4" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>
      ${coords.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#3569d4"></circle>`).join("")}
    </svg>`;
}

function cashFlowChartSvgForExport(months) {
  const width = 560;
  const height = 160;
  const padding = 20;
  const max = Math.max(...months.flatMap((month) => [month.income, month.expenses]), 1);
  const slotWidth = months.length ? (width - padding * 2) / months.length : 0;
  const barWidth = Math.max(4, slotWidth * 0.3);
  const chartHeight = height - padding * 2;
  const bars = months.map((month, index) => {
    const slotX = padding + slotWidth * index;
    const incomeHeight = Math.max(1, (month.income / max) * chartHeight);
    const expenseHeight = Math.max(1, (month.expenses / max) * chartHeight);
    const incomeX = slotX + slotWidth / 2 - barWidth - 2;
    const expenseX = slotX + slotWidth / 2 + 2;
    return `
      <rect x="${incomeX.toFixed(1)}" y="${(height - padding - incomeHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${incomeHeight.toFixed(1)}" fill="#13936d"></rect>
      <rect x="${expenseX.toFixed(1)}" y="${(height - padding - expenseHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${expenseHeight.toFixed(1)}" fill="#e05252"></rect>`;
  }).join("");
  return `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"></rect>
      <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#dfe7ef" stroke-width="1"></line>
      ${bars}
    </svg>`;
}

// Rasterizes an SVG string to a PNG (base64, no data-URI prefix) via an
// off-screen canvas - the standard no-library technique (Image loaded from
// a data-URI, drawn to canvas, read back with toDataURL). Resolves null
// instead of throwing on any failure, so one bad chart never sinks the rest
// of the export - the caller just omits that image and keeps the data rows.
function svgStringToPngBase64(svgString, { width, height }) {
  return new Promise((resolve) => {
    try {
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(image, 0, 0, width, height);
          resolve(canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""));
        } catch (_drawError) {
          resolve(null);
        }
      };
      image.onerror = () => resolve(null);
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
    } catch (_error) {
      resolve(null);
    }
  });
}

// Fills in the "Overview" sheet's chart images once buildWorkbookSpec has
// returned - kept as a separate async step so buildWorkbookSpec itself can
// stay synchronous and easy to reason about.
async function attachReportChartImages(sheets, chartData) {
  if (!chartData) return sheets;
  const overviewSheet = sheets.find((sheet) => sheet.name === "Overview");
  if (!overviewSheet) return sheets;
  const [netWorthPng, cashFlowPng] = await Promise.all([
    svgStringToPngBase64(netWorthTrendSvgForExport(chartData.trend), { width: 560, height: 160 }),
    svgStringToPngBase64(cashFlowChartSvgForExport(chartData.cashFlow), { width: 560, height: 160 })
  ]);
  const images = [];
  if (netWorthPng) images.push({ base64: netWorthPng, cell: "H2", widthPx: 400, heightPx: 114 });
  if (cashFlowPng) images.push({ base64: cashFlowPng, cell: "H12", widthPx: 400, heightPx: 114 });
  overviewSheet.images = images;
  return sheets;
}

function transactionInboxItems() {
  return [...(state.transactionInboxDrafts || [])];
}

// orderRefundMatch/refundMatch (order-number match, falling back to a fuzzy
// same-payee/opposite-amount/date-window match when there's no order number)
// come from lib/shared-logic.js, loaded as a global script alongside this
// file - so the client and any future server-side use agree on the exact
// same matching rules.

function bindViewEvents() {
  if (googleMapsApiKey) attachLocationAutocomplete();
  updateLocationDirectionsPreview();
  $("#calendarQuickAdd [name='location']")?.addEventListener("input", updateLocationDirectionsPreview);

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

  // The edit icon on a Home action item needs the Calendar view (and its
  // #calendarQuickAdd form) to actually exist in the DOM before it can be
  // populated, so switch views and re-render first, then open the editor —
  // unlike editCalendarItem's other callers, which are already on Calendar.
  document.querySelectorAll("[data-home-edit-item]").forEach((button) => {
    button.addEventListener("click", () => {
      const raw = button.dataset.homeEditItem;
      const monthSeparator = raw.lastIndexOf(":");
      const reference = raw.slice(0, monthSeparator);
      const month = raw.slice(monthSeparator + 1);
      if (month) state.budget.month = month;
      goToViewAndRun("calendar", () => editCalendarItem(reference));
    });
  });

  $("#homeAddChoreButton")?.addEventListener("click", () => goToViewAndRun("calendar", () => focusCalendarType("chore")));
  $("#homeAddReminderButton")?.addEventListener("click", () => goToViewAndRun("calendar", () => focusCalendarType("reminder")));
  $("#homeAddBirthdayButton")?.addEventListener("click", () => goToViewAndRun("calendar", () => focusCalendarType("birthday")));
  $("#homeAddAnniversaryButton")?.addEventListener("click", () => goToViewAndRun("calendar", () => focusCalendarType("anniversary")));
  $("#homeAddTransactionButton")?.addEventListener("click", () => goToViewAndRun("transactions", () => {
    $("#transactionForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
    $("#transactionForm [name='payee']")?.focus();
  }));
  $("#homeAddIncomeButton")?.addEventListener("click", () => goToViewAndRun("budget", () => {
    $("#addIncomeButton")?.click();
    $("#addIncomeButton")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }));

  $("#homeOpenPlanButton")?.addEventListener("click", () => {
    planActiveBucket = "daily";
    planSelectedDate = dateKey(new Date());
    goToViewAndRun("plan");
  });

  $("#homeOpenNoteRemindersButton")?.addEventListener("click", () => {
    state.notes.activeView = "reminders";
    autosaveState();
    goToViewAndRun("notes");
  });

  // Toggles against the real current date directly, rather than reusing
  // Plan's own data-plan-task-check handler, which keys off planSelectedDate
  // — a value that only tracks whatever day the user last browsed to on the
  // Plan tab and could otherwise silently drift from "today" here on Home.
  document.querySelectorAll("[data-home-plan-task-check]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const task = privateData.plans.tasks.find((item) => item.id === checkbox.dataset.homePlanTaskCheck);
      if (!task) return;
      const updated = toggleDailyTaskDoneOnDate(task, dateKey(new Date()));
      Object.assign(task, updated);
      autosavePlans();
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
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-notes-label]").forEach((button) => {
    button.addEventListener("click", () => {
      state.notes.activeView = "label";
      state.notes.activeLabel = button.dataset.notesLabel;
      autosaveState();
      render();
    });
  });

  $("#openNoteComposerButton")?.addEventListener("click", () => {
    state.notes.composerOpen = true;
    autosaveState();
    render();
  });

  $("#closeNoteComposerButton")?.addEventListener("click", () => {
    state.notes.composerOpen = false;
    autosaveState();
    render();
  });

  $("#emptyNotesTrashButton")?.addEventListener("click", () => {
    state.notes.entries = state.notes.entries.filter((note) => !note.trashed);
    autosaveState();
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
      reminder: data.reminderDate && data.reminderTime ? `${data.reminderDate}T${data.reminderTime}` : "",
      reminderAt: data.reminderDate && data.reminderTime ? new Date(`${data.reminderDate}T${data.reminderTime}`).toISOString() : "",
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
    autosaveState();
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
      autosaveState();
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
          autosaveState();
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
      autosaveState();
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
          autosaveState();
          render();
        });
      });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const note = state.notes.entries.find((item) => item.id === input.dataset.noteItemInput);
        if (addOrRestoreChecklistItem(note, input.value)) { autosaveState(); render(); }
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
      autosaveState();
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
      autosaveState();
      render();
    });
  });

  // Drag-to-reorder for note checklist items. draggedChecklistItem is local
  // to this one bindViewEvents pass (rebound fresh on every render, like
  // every other delegated listener here) - dragstart on one row and drop on
  // another both close over the same variable, so it only needs to survive
  // for the duration of a single drag gesture.
  let draggedChecklistItem = null;
  const clearChecklistDragOverClasses = () => {
    document.querySelectorAll(".note-check-row-drag-over-top, .note-check-row-drag-over-bottom").forEach((row) => {
      row.classList.remove("note-check-row-drag-over-top", "note-check-row-drag-over-bottom");
    });
  };
  document.querySelectorAll("[data-drag-checklist-item]").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      const [noteId, itemId] = row.dataset.dragChecklistItem.split(":");
      draggedChecklistItem = { noteId, itemId };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", itemId);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      clearChecklistDragOverClasses();
      draggedChecklistItem = null;
    });
    row.addEventListener("dragover", (event) => {
      if (!draggedChecklistItem || row.dataset.dragChecklistItem.split(":")[0] !== draggedChecklistItem.noteId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const isAfter = event.clientY - row.getBoundingClientRect().top > row.getBoundingClientRect().height / 2;
      row.classList.toggle("note-check-row-drag-over-bottom", isAfter);
      row.classList.toggle("note-check-row-drag-over-top", !isAfter);
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("note-check-row-drag-over-top", "note-check-row-drag-over-bottom");
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      clearChecklistDragOverClasses();
      if (!draggedChecklistItem) return;
      const [noteId, targetItemId] = row.dataset.dragChecklistItem.split(":");
      if (noteId !== draggedChecklistItem.noteId || targetItemId === draggedChecklistItem.itemId) return;
      const note = state.notes.entries.find((item) => item.id === noteId);
      if (!note) return;
      const insertAfter = event.clientY - row.getBoundingClientRect().top > row.getBoundingClientRect().height / 2;
      note.checklist = moveChecklistItem(note.checklist, draggedChecklistItem.itemId, targetItemId, insertAfter);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-pin-note]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = state.notes.entries.find((item) => item.id === button.dataset.pinNote);
      if (!note) return;
      note.pinned = !note.pinned;
      autosaveState();
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
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-note-reminder-date]").forEach((input) => {
    input.addEventListener("change", () => {
      const note = state.notes.entries.find((item) => item.id === input.dataset.noteReminderDate);
      if (!note) return;
      const timeInput = document.querySelector(`[data-note-reminder-time="${note.id}"]`);
      const combined = input.value && timeInput?.value ? `${input.value}T${timeInput.value}` : "";
      note.reminder = combined;
      note.reminderAt = combined ? new Date(combined).toISOString() : "";
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-note-reminder-time]").forEach((input) => {
    input.addEventListener("change", () => {
      const note = state.notes.entries.find((item) => item.id === input.dataset.noteReminderTime);
      if (!note) return;
      const dateInput = document.querySelector(`[data-note-reminder-date="${note.id}"]`);
      const combined = dateInput?.value && input.value ? `${dateInput.value}T${input.value}` : "";
      note.reminder = combined;
      note.reminderAt = combined ? new Date(combined).toISOString() : "";
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-note-color]").forEach((select) => {
    select.addEventListener("change", () => {
      const note = state.notes.entries.find((item) => item.id === select.dataset.noteColor);
      if (!note) return;
      note.color = select.value;
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-note-bill-link]").forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const note = state.notes.entries.find((item) => item.id === input.dataset.noteBillLink);
      if (!note) return;
      note.billLineId = input.value || null;
      autosaveState();
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
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-toggle-note-checklist]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = state.notes.entries.find((item) => item.id === button.dataset.toggleNoteChecklist);
      if (!note) return;
      note.showChecklist = !note.showChecklist;
      autosaveState();
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
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-restore-note]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = state.notes.entries.find((item) => item.id === button.dataset.restoreNote);
      if (!note) return;
      note.trashed = false;
      note.trashedAt = "";
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-note-forever]").forEach((button) => {
    button.addEventListener("click", () => {
      state.notes.entries = state.notes.entries.filter((note) => note.id !== button.dataset.deleteNoteForever);
      autosaveState();
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
      gratitude: data.gratitude || "",
      tags: String(data.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
      photos,
      createdAt: now,
      updatedAt: now
    });
    journalComposerDraft = null;
    autosaveJournal();
    render();
  });

  function captureJournalComposerDraft() {
    const composerForm = document.getElementById("journalComposer");
    if (composerForm) journalComposerDraft = Object.fromEntries(new FormData(composerForm));
  }

  $("#journalReflectionButton")?.addEventListener("click", async () => {
    captureJournalComposerDraft();
    const context = todaysJournalContext();
    if (!context) {
      journalReflection = { text: "Nothing logged yet today to reflect on - complete a chore, wish someone happy birthday, or jot a note first.", isError: true, loading: false };
      render();
      return;
    }
    journalReflection = { loading: true };
    render();
    try {
      const result = await api("/api/journal/reflection", { method: "POST", body: JSON.stringify({ context }) });
      captureJournalComposerDraft();
      journalReflection = { text: result.message, isError: false, loading: false };
    } catch (error) {
      captureJournalComposerDraft();
      journalReflection = { text: error.message, isError: true, loading: false };
    }
    render();
  });

  $("#journalReflectionInsertButton")?.addEventListener("click", () => {
    captureJournalComposerDraft();
    const existingBody = journalComposerDraft.body || "";
    journalComposerDraft.body = existingBody ? `${existingBody}\n\n${journalReflection.text}` : journalReflection.text;
    journalReflection = null;
    render();
  });

  $("#journalReflectionDismissButton")?.addEventListener("click", () => {
    captureJournalComposerDraft();
    journalReflection = null;
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

  document.querySelectorAll("[data-journal-gratitude]").forEach((input) => {
    input.addEventListener("input", () => {
      const entry = privateData.journal.entries.find((item) => item.id === input.dataset.journalGratitude);
      if (!entry) return;
      entry.gratitude = input.value;
      autosaveJournal();
    });
  });

  document.querySelectorAll("[data-mood-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const [groupId, mood] = button.dataset.moodChoice.split(":");
      const picker = button.closest(".mood-picker");
      const wasActive = button.classList.contains("active");
      picker.querySelectorAll(".mood-chip").forEach((chip) => {
        chip.classList.remove("active");
        chip.setAttribute("aria-pressed", "false");
      });
      const nextMood = wasActive ? "" : mood;
      if (!wasActive) {
        button.classList.add("active");
        button.setAttribute("aria-pressed", "true");
      }
      if (groupId === "composer") {
        $("#journalComposerMoodValue").value = nextMood;
        return;
      }
      const entry = privateData.journal.entries.find((item) => item.id === groupId);
      if (!entry) return;
      entry.mood = nextMood;
      const entryEl = button.closest(".journal-entry");
      if (entryEl) entryEl.style.setProperty("--mood-color", journalMoodColor[nextMood] || "var(--line)");
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

  document.querySelectorAll("[data-plan-task-goal]").forEach((select) => {
    select.addEventListener("change", () => {
      const task = privateData.plans.tasks.find((item) => item.id === select.dataset.planTaskGoal);
      if (!task) return;
      task.goalName = select.value || null;
      autosavePlans();
      render();
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

  // Opens the same edit form a scheduled timeline block uses (title,
  // start time, duration, repeat) pre-filled for this task, so an
  // unscheduled item can be given a start time without recreating it.
  document.querySelectorAll("[data-schedule-plan-task]").forEach((button) => {
    button.addEventListener("click", () => {
      planEditingDailyTaskId = button.dataset.schedulePlanTask;
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
      if (input.readOnly) return;
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

  document.querySelectorAll("[data-toggle-rollover]").forEach((button) => {
    button.addEventListener("click", () => {
      const [categoryIndex, lineIndex] = button.dataset.toggleRollover.split(":").map(Number);
      const line = state.budget.categories[categoryIndex].lines[lineIndex];
      line.rolloverEnabled = !line.rolloverEnabled;
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-enable-recurring-budget]").forEach((button) => {
    button.addEventListener("click", () => {
      const [categoryIndex, lineIndex] = button.dataset.enableRecurringBudget.split(":").map(Number);
      const line = state.budget.categories[categoryIndex]?.lines[lineIndex];
      if (!line) return;
      line.recurringBill = {
        enabled: true,
        amount: Number(line.planned || 0),
        frequency: "yearly",
        dueDate: dueDateValue(line.dueDay) || `${state.budget.month}-01`
      };
      applyRecurringBudgetToLine(line);
      refreshBudgetTotals(categoryIndex, lineIndex);
      refreshIncomeTotals();
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-disable-recurring-budget]").forEach((button) => {
    button.addEventListener("click", () => {
      const [categoryIndex, lineIndex] = button.dataset.disableRecurringBudget.split(":").map(Number);
      const line = state.budget.categories[categoryIndex]?.lines[lineIndex];
      if (!line) return;
      delete line.recurringBill;
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-budget-recurring-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      const [categoryIndex, lineIndex] = input.dataset.budgetRecurringAmount.split(":").map(Number);
      const line = state.budget.categories[categoryIndex]?.lines[lineIndex];
      if (!line?.recurringBill) return;
      line.recurringBill.amount = Number(input.value || 0);
      applyRecurringBudgetToLine(line);
      refreshBudgetTotals(categoryIndex, lineIndex);
      refreshIncomeTotals();
      autosaveState();
    });
    input.addEventListener("change", () => render());
  });

  document.querySelectorAll("[data-budget-recurring-frequency]").forEach((select) => {
    select.addEventListener("change", () => {
      const [categoryIndex, lineIndex] = select.dataset.budgetRecurringFrequency.split(":").map(Number);
      const line = state.budget.categories[categoryIndex]?.lines[lineIndex];
      if (!line?.recurringBill) return;
      line.recurringBill.frequency = select.value;
      applyRecurringBudgetToLine(line);
      refreshBudgetTotals(categoryIndex, lineIndex);
      refreshIncomeTotals();
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-budget-recurring-due-date]").forEach((input) => {
    input.addEventListener("input", () => {
      const [categoryIndex, lineIndex] = input.dataset.budgetRecurringDueDate.split(":").map(Number);
      const line = state.budget.categories[categoryIndex]?.lines[lineIndex];
      if (!line?.recurringBill) return;
      line.recurringBill.dueDate = input.value || `${state.budget.month}-01`;
      applyRecurringBudgetToLine(line);
      refreshBudgetTotals(categoryIndex, lineIndex);
      refreshIncomeTotals();
      autosaveState();
    });
    input.addEventListener("change", () => render());
  });

  document.querySelectorAll("[data-budget-line-name]").forEach((input) => {
    input.addEventListener("input", () => {
      const [categoryIndex, lineIndex] = input.dataset.budgetLineName.split(":").map(Number);
      state.budget.categories[categoryIndex].lines[lineIndex].name = input.value || "Subcategory";
      autosaveState();
    });
    input.addEventListener("change", () => {
      const [categoryIndex, lineIndex] = input.dataset.budgetLineName.split(":").map(Number);
      state.budget.categories[categoryIndex].lines[lineIndex].name = input.value || "Subcategory";
      render();
    });
  });

  document.querySelectorAll("[data-budget-category-name]").forEach((input) => {
    input.addEventListener("input", () => {
      const categoryIndex = Number(input.dataset.budgetCategoryName);
      state.budget.categories[categoryIndex].name = input.value || "Category";
      autosaveState();
    });
    input.addEventListener("change", () => {
      const categoryIndex = Number(input.dataset.budgetCategoryName);
      state.budget.categories[categoryIndex].name = input.value.trim() || "Category";
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

  document.querySelectorAll("[data-budget-line-owner]").forEach((select) => {
    select.addEventListener("change", () => {
      const [categoryIndex, lineIndex] = select.dataset.budgetLineOwner.split(":").map(Number);
      state.budget.categories[categoryIndex].lines[lineIndex].ownerId = select.value || null;
      autosaveState();
    });
  });

  document.querySelectorAll("[data-budget-member-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      budgetMemberFilter = button.dataset.budgetMemberFilter;
      render();
    });
  });

  document.querySelectorAll("[data-income-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.dataset.incomeAmount);
      state.paychecks[index].amount = Number(input.value || 0);
      state.budget.income = budgetIncomeFromPaychecks();
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
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-income-recurrence]").forEach((select) => {
    select.addEventListener("change", () => {
      const paycheck = state.paychecks[Number(select.dataset.incomeRecurrence)];
      if (paycheck) paycheck.recurrence = select.value;
      state.budget.income = budgetIncomeFromPaychecks();
      autosaveState();
      render();
    });
  });

  $("#copyBudgetSelect")?.addEventListener("change", async (event) => {
    const month = event.currentTarget.value;
    if (!month) return;
    const confirmed = await showConfirm(`Replace ${monthLabel()}'s categories and amounts with ${formatMonth(month)}'s budget? This cannot be undone.`, { confirmLabel: "Replace" });
    if (!confirmed) {
      event.currentTarget.value = "";
      return;
    }
    copyBudgetFromMonth(month);
    ensureRecurringBudgetBills();
    autosaveState();
    render();
  });

  $("#transactionForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const date = data.date || dateKey(new Date());
    const recurrence = data.recurrence || "none";
    if (!accountAllowsDate(data.accountId, date)) {
      transactionValidationFeedback = `${accountName(data.accountId)} is closed - pick a date on or before its close date, or choose a different account.`;
      render();
      return;
    }
    transactionValidationFeedback = "";
    if (recurrence === "none") {
      state.transactions.unshift(makeTransaction({ date, payee: data.payee, lineId: data.lineId, amount: Number(data.amount), memo: "Manual entry", accountId: data.accountId || "", tags: parseTagsInput(data.tags) }));
    } else {
      state.recurringExpenses ||= [];
      state.recurringExpenses.unshift({
        id: uniqueId("recurring-expense"),
        payee: data.payee,
        amount: Number(data.amount),
        lineId: data.lineId,
        accountId: data.accountId || "",
        recurrence,
        anchorDate: date,
        endDate: data.endDate || "",
        postedDates: []
      });
      ensureRecurringExpensesPosted();
    }
    autosaveState();
    render();
  });

  const updateTransactionFormFields = () => {
    const form = $("#transactionForm");
    if (!form) return;
    const endDateField = form.querySelector("[data-transaction-end-date-field]");
    if (endDateField) endDateField.hidden = form.recurrence.value === "none";
  };
  $("#transactionForm select[name='recurrence']")?.addEventListener("change", updateTransactionFormFields);
  updateTransactionFormFields();

  // Manually-added transactions skip the Bank Stream inbox entirely, so
  // without this they never got the same refund auto-match Bank Stream rows
  // do. Recomputed on every payee/amount/date edit against the real ledger
  // (not the inbox pool - a hand-typed refund has no pending draft sibling to
  // match against); only auto-fills the Subcategory once per form session so
  // it doesn't fight a choice the user already made by hand.
  let transactionFormLineTouched = false;
  $("#transactionForm select[name='lineId']")?.addEventListener("change", () => {
    transactionFormLineTouched = true;
  });
  let transactionFormAccountTouched = false;
  $("#transactionForm select[name='accountId']")?.addEventListener("change", () => {
    transactionFormAccountTouched = true;
  });
  const updateTransactionRefundHint = () => {
    const form = $("#transactionForm");
    const hint = form?.querySelector("[data-transaction-refund-hint]");
    if (!form || !hint) return;
    const amount = Number(form.amount.value);
    const payee = form.payee.value;
    const date = form.date.value;
    const match = amount < 0 && payee ? refundMatch({ payee, amount, date }, state.transactions) : null;
    if (match) {
      hint.hidden = false;
      hint.textContent = `Matches the ${money.format(match.amount)} purchase at ${match.payee} on ${formatShortDate(match.date)} - Subcategory set to that line.`;
      if (!transactionFormLineTouched) form.lineId.value = match.lineId;
      return;
    }
    // No refund to pin the line to - fall back to how this payee (or a
    // similar one) was categorized most recently, same as a Bank Stream
    // import does when it has no refund match either.
    const historyLineId = payee ? suggestSubcategoryFromHistory(payee, state.transactions) : null;
    if (historyLineId) {
      const line = allLines().find((candidate) => candidate.id === historyLineId);
      hint.hidden = false;
      hint.textContent = `You've categorized ${payee} (or a similar payee) as ${line ? `${line.category} - ${line.name}` : "this line"} most recently - Subcategory set to that line.`;
      if (!transactionFormLineTouched) form.lineId.value = historyLineId;
    } else {
      hint.hidden = true;
    }
  };
  const updateTransactionAccountHint = () => {
    const form = $("#transactionForm");
    const hint = form?.querySelector("[data-transaction-account-hint]");
    if (!form || !form.accountId || !hint) return;
    const payee = form.payee.value;
    const date = form.date.value;
    const historyAccountId = payee ? suggestAccountFromHistory(payee, state.transactions) : null;
    if (historyAccountId && accountAllowsDate(historyAccountId, date)) {
      hint.hidden = false;
      hint.textContent = `You've linked ${payee} to ${accountName(historyAccountId)} most recently - Account set to that.`;
      if (!transactionFormAccountTouched) form.accountId.value = historyAccountId;
    } else {
      hint.hidden = true;
    }
  };
  ["payee", "amount", "date"].forEach((field) => {
    $(`#transactionForm [name='${field}']`)?.addEventListener("input", updateTransactionRefundHint);
    $(`#transactionForm [name='${field}']`)?.addEventListener("input", updateTransactionAccountHint);
  });

  $("#transactionAiSuggestButton")?.addEventListener("click", async () => {
    const form = $("#transactionForm");
    const button = $("#transactionAiSuggestButton");
    const payee = form?.payee.value.trim();
    if (!payee) {
      showToast("Enter a payee first.");
      return;
    }
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "Asking AI…";
    try {
      const { lineId } = await suggestSubcategoryWithAI(payee);
      if (lineId) {
        form.lineId.value = lineId;
        transactionFormLineTouched = true;
      } else {
        showToast("AI couldn't find a confident match for this payee - pick one manually.");
      }
    } catch (error) {
      showToast(error.message || "AI suggestion failed - try again or pick manually.");
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });

  $("#transactionAiSuggestAccountButton")?.addEventListener("click", async () => {
    const form = $("#transactionForm");
    const button = $("#transactionAiSuggestAccountButton");
    const payee = form?.payee.value.trim();
    if (!payee) {
      showToast("Enter a payee first.");
      return;
    }
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "Asking AI…";
    try {
      const { accountId } = await suggestAccountWithAI(payee);
      if (!accountId) {
        showToast("AI couldn't find a confident match for this payee - pick one manually.");
      } else if (!accountAllowsDate(accountId, form.date.value)) {
        showToast(`${accountName(accountId)} is closed - this item is dated after its close date.`);
      } else {
        form.accountId.value = accountId;
        transactionFormAccountTouched = true;
      }
    } catch (error) {
      showToast(error.message || "AI suggestion failed - try again or pick manually.");
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });

  $("#addIncomeButton")?.addEventListener("click", () => {
    // Dated to the first of the currently-viewed budget month, not today's
    // real-world date - a one-time paycheck's date is what paycheckActiveInMonth
    // checks against, so defaulting to "today" made a new income row invisible
    // whenever it was added while viewing any month other than the current one.
    // recurrence is explicit "once", not left blank - ensurePaycheckRecurrenceData
    // defaults a blank recurrence to "monthly" (for pre-recurrence-field legacy
    // data), which would otherwise turn a single backfilled/historical income
    // entry into an ongoing recurring paycheck that keeps generating occurrences
    // in every month afterward, including whatever month is actually current.
    state.paychecks.push({ date: `${state.budget.month}-01`, name: `Income ${state.paychecks.length + 1}`, amount: 0, assignedLineIds: [], recurrence: "once" });
    state.budget.income = budgetIncomeFromPaychecks();
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-add-line-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const category = state.budget.categories[Number(button.dataset.addLineCategory)];
      category.lines.push({ id: uniqueId(category.name), name: "New subcategory", planned: 0, dueDay: 28 });
      autosaveState();
      render();
    });
  });

  $("#addCategoryButton")?.addEventListener("click", () => {
    const name = ($("#newCategoryName")?.value || "New category").trim();
    if (!name) return;
    if (state.budget.categories.some((category) => category.name.toLowerCase() === name.toLowerCase())) return;
    state.budget.categories.push({ name, color: categoryColor(state.budget.categories.length), lines: [{ id: uniqueId(name), name: "New subcategory", planned: 0, dueDay: 28 }] });
    autosaveState();
    render();
  });

  $("#deleteCategoryByNameButton")?.addEventListener("click", () => {
    const name = ($("#newCategoryName")?.value || "").trim().toLowerCase();
    const categoryIndex = state.budget.categories.findIndex((category) => category.name.toLowerCase() === name);
    if (categoryIndex < 0) return;
    const category = state.budget.categories[categoryIndex];
    openDeleteBudgetLineDialog({
      title: `Remove ${category.name}?`,
      lineIds: category.lines.map((line) => line.id),
      perform: () => { state.budget.categories.splice(categoryIndex, 1); }
    });
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
    autosaveState();
    render();
  });

  $("#deleteTransactionSubcategoryButton")?.addEventListener("click", () => {
    const categoryIndex = Number($("#transactionParentCategory")?.value || 0);
    const category = state.budget.categories[categoryIndex];
    const name = ($("#transactionSubcategoryName")?.value || "").trim().toLowerCase();
    const lineIndex = category?.lines?.findIndex((line) => line.name.toLowerCase() === name) ?? -1;
    const line = lineIndex >= 0 ? category.lines[lineIndex] : null;
    if (!category || !line) return;
    openDeleteBudgetLineDialog({
      title: `Remove ${line.name}?`,
      lineIds: [line.id],
      perform: () => {
        category.lines.splice(lineIndex, 1);
        state.household.activity.unshift(`Deleted ${line.name} subcategory from ${category.name}`);
      }
    });
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
      const line = state.budget.categories[categoryIndex].lines[lineIndex];
      openDeleteBudgetLineDialog({
        title: `Remove ${line.name}?`,
        lineIds: [line.id],
        perform: () => {
          state.budget.categories[categoryIndex].lines.splice(lineIndex, 1);
          if (state.budget.categories[categoryIndex].lines.length === 0) state.budget.categories.splice(categoryIndex, 1);
        }
      });
    });
  });

  document.querySelectorAll("[data-delete-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const categoryIndex = Number(button.dataset.deleteCategory);
      const category = state.budget.categories[categoryIndex];
      openDeleteBudgetLineDialog({
        title: `Remove ${category.name}?`,
        lineIds: category.lines.map((line) => line.id),
        perform: () => { state.budget.categories.splice(categoryIndex, 1); }
      });
    });
  });

  $("#addTransactionButton")?.addEventListener("click", () => {
    state.transactionInboxDrafts ||= [];
    state.transactionInboxDrafts.unshift({
      id: uniqueId("manual-bank-stream"),
      payee: "New bank stream item",
      amount: 0,
      lineId: allLines()[0]?.id || "",
      accountId: "",
      date: new Date().toISOString().slice(0, 10)
    });
    autosaveState();
    render();
  });

  // Shared by both CSV and PDF imports: builds bank stream drafts from
  // parsed rows, matching the target account by filename and flagging
  // likely duplicates - a PDF row additionally carries an orderNumber, and
  // when a row is a refund (negative amount), refundMatch (lib/shared-logic.js)
  // pre-assigns the draft to the matched original purchase's subcategory so
  // the refund nets against the same line, instead of landing unassigned -
  // preferring an exact orderNumber match, falling back to a fuzzy
  // same-payee/opposite-amount/date-window match when there's no order
  // number to go on (most in-store or non-itemized returns). The matching
  // purchase isn't always already in the ledger - it can be a still-pending
  // Bank Stream draft from an earlier import, or (a return within the same
  // billing cycle) another row in this very batch - so the search pool
  // covers all three instead of only the accepted ledger.
  function addBankStreamRows(rows, file, idPrefix, extraAccountHint) {
    // A checking-account "Account Activity" PDF's own title line names the
    // real account ("Adv Plus Banking - 6769") - the upload's filename is
    // BofA's own generic "...Print Transaction Details.pdf" regardless of
    // which account it's for, so that alone can never match; the content
    // hint is tried first since it's the more specific/reliable signal.
    const matchedAccount = matchAccountByHints([extraAccountHint, file.name], state.accounts);
    state.transactionInboxDrafts ||= [];
    const alreadyKnown = [...state.transactions, ...state.transactionInboxDrafts];
    const duplicateCount = rows.filter((row) => isDuplicateTransaction(row, alreadyKnown)).length;
    const rowRefundMatchPool = [...alreadyKnown, ...rows];
    rows.forEach((row) => {
      const rowRefundMatch = refundMatch(row, rowRefundMatchPool);
      // A refund match (this exact row is the return for a specific
      // purchase) is a much stronger, more literal signal than history -
      // only fall back to "you've categorized payees like this before" when
      // there's no refund to pin the line to.
      const historyLineId = rowRefundMatch ? "" : suggestSubcategoryFromHistory(row.payee, state.transactions);
      // A household's own "always categorize this way" rule beats the plain
      // most-recent-use guess (but never a literal refund match, which is
      // tied to a specific purchase and could legitimately differ).
      const ruleLineId = rowRefundMatch ? "" : categorizationRuleForPayee(row.payee);
      // The file-level filename/content-hint match (matchedAccount) applies
      // to every row in this import - only fall back to a per-payee history
      // guess when that whole-file match came up empty.
      const historyAccountId = matchedAccount ? "" : suggestAccountFromHistory(row.payee, state.transactions);
      state.transactionInboxDrafts.unshift({
        id: uniqueId(idPrefix),
        payee: row.payee,
        amount: row.amount,
        lineId: rowRefundMatch?.lineId || ruleLineId || historyLineId || "",
        accountId: matchedAccount?.id || historyAccountId || "",
        date: row.date,
        orderNumber: row.orderNumber || "",
        isDeposit: !!row.isDeposit,
        isPayment: !!row.isPayment,
        isPending: !!row.isPending,
        historyMatch: !!(!rowRefundMatch && !ruleLineId && historyLineId),
        accountHistoryMatch: !!(!matchedAccount && historyAccountId)
      });
    });
    const duplicateNote = duplicateCount ? ` ${duplicateCount} look${duplicateCount === 1 ? "s" : ""} like a duplicate of a transaction you already have — check before accepting.` : "";
    bankImportFeedback = `Imported ${rows.length} transaction${rows.length === 1 ? "" : "s"} from ${file.name}${matchedAccount ? ` — linked to ${matchedAccount.name}` : " — no matching account found, pick one per row below"}.${duplicateNote}`;
    autosaveState();
    render();
  }

  $("#bankStreamCsvInput")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (isPdf) {
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = String(reader.result || "");
        const fileBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        bankImportFeedback = `Reading ${file.name}…`;
        render();
        try {
          const { rows, accountHint } = await api("/api/bank-statement/parse-pdf", { method: "POST", body: JSON.stringify({ fileBase64 }) });
          if (!rows.length) {
            bankImportFeedback = `No transactions found in ${file.name} — this may be a scanned/image PDF that can't be read as text.`;
            render();
            return;
          }
          addBankStreamRows(rows, file, "pdf-import", accountHint);
        } catch (error) {
          bankImportFeedback = error.message || `Could not read ${file.name}.`;
          render();
        }
      };
      reader.readAsDataURL(file);
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseBankCsvTransactions(String(reader.result || ""));
      if (!rows.length) {
        bankImportFeedback = `No transactions found in ${file.name} — check that it has Date, Description, and Amount (or Debit) columns.`;
        render();
        return;
      }
      addBankStreamRows(rows, file, "csv-import");
    };
    reader.readAsText(file);
    event.target.value = "";
  });

  document.querySelectorAll("[data-sort-transactions]").forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.dataset.sortTransactions;
      if (transactionSort.field === field) {
        transactionSort = { field, direction: transactionSort.direction === "asc" ? "desc" : "asc" };
      } else {
        transactionSort = { field, direction: field === "date" ? "desc" : "asc" };
      }
      render();
    });
  });

  document.querySelectorAll("[data-sort-bank-stream]").forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.dataset.sortBankStream;
      if (bankStreamSort.field === field) {
        bankStreamSort = { field, direction: bankStreamSort.direction === "asc" ? "desc" : "asc" };
      } else {
        bankStreamSort = { field, direction: field === "date" ? "desc" : "asc" };
      }
      render();
    });
  });

  document.querySelectorAll("[data-switch-budget-month]").forEach((button) => {
    button.addEventListener("click", () => {
      switchBudgetMonth(button.dataset.switchBudgetMonth);
      autosaveState();
      render();
    });
  });

  $("#transactionTagFilter")?.addEventListener("change", (event) => {
    selectedTransactionTag = event.currentTarget.value;
    render();
  });

  $("#reportsTagFilter")?.addEventListener("change", (event) => {
    reportsSelectedTag = event.currentTarget.value;
    render();
  });

  $("#reportsCategoryLineFilter")?.addEventListener("change", (event) => {
    reportsSelectedCategoryLine = event.currentTarget.value;
    render();
  });

  // Ribbon, node rect, and label text each carry the same data-sankey-lines
  // (that segment's comma-joined line ids) so any part of a segment is
  // clickable, not just the thin node bar.
  document.querySelectorAll("[data-sankey-lines]").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.sankeyLines;
      reportsExpandedSankeyLineKey = reportsExpandedSankeyLineKey === key ? null : key;
      render();
    });
  });

  document.querySelectorAll("[data-bills-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      billsFilter = button.dataset.billsFilter;
      render();
    });
  });
  document.querySelectorAll("[data-bills-mark-paid]").forEach((button) => {
    button.addEventListener("click", () => {
      dismissBudgetReminder(`bill:${button.dataset.billsMarkPaid}`);
    });
  });

  document.querySelectorAll("[data-reports-scope-type]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.reportsScopeType;
      if (type === "month") reportsScope = { type: "month", month: state.budget.month };
      else if (type === "range") reportsScope = { type: "range", start: `${state.budget.month}-01`, end: monthEndDateKey(state.budget.month) };
      else reportsScope = { type: "year", year: state.budget.month.slice(0, 4) };
      render();
    });
  });
  const compareLastYearButton = document.querySelector("[data-reports-compare-last-year]");
  if (compareLastYearButton) {
    compareLastYearButton.addEventListener("click", () => {
      reportsCompareLastYear = !reportsCompareLastYear;
      render();
    });
  }
  document.querySelectorAll("[data-reports-density]").forEach((button) => {
    button.addEventListener("click", () => {
      reportsDensity = button.dataset.reportsDensity;
      render();
    });
  });
  document.querySelectorAll("[data-reports-theme]").forEach((button) => {
    button.addEventListener("click", () => {
      reportsColorTheme = button.dataset.reportsTheme;
      render();
    });
  });
  document.querySelectorAll("[data-reports-category-style]").forEach((button) => {
    button.addEventListener("click", () => {
      reportsCategoryStyle = button.dataset.reportsCategoryStyle;
      render();
    });
  });
  document.querySelectorAll("[data-toggle-category-ring]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.toggleCategoryRing;
      reportsExpandedRingCategory = reportsExpandedRingCategory === key ? null : key;
      render();
    });
  });
  $("#reportsScopeMonth")?.addEventListener("change", (event) => {
    reportsScope = { type: "month", month: event.currentTarget.value || state.budget.month };
    render();
  });
  $("#reportsScopeStart")?.addEventListener("change", (event) => {
    reportsScope = { ...currentReportsScope(), type: "range", start: event.currentTarget.value };
    render();
  });
  $("#reportsScopeEnd")?.addEventListener("change", (event) => {
    reportsScope = { ...currentReportsScope(), type: "range", end: event.currentTarget.value };
    render();
  });
  $("#reportsScopeYear")?.addEventListener("change", (event) => {
    reportsScope = { type: "year", year: event.currentTarget.value || state.budget.month.slice(0, 4) };
    render();
  });
  $("#reportsCardFilter")?.addEventListener("change", (event) => {
    reportsCardFilter = event.currentTarget.value;
    render();
  });

  document.querySelectorAll("[data-bank-stream-payee]").forEach((input) => {
    input.addEventListener("input", () => {
      const draft = (state.transactionInboxDrafts || []).find((item) => item.id === input.dataset.bankStreamPayee);
      if (draft) draft.payee = input.value;
      autosaveState();
    });
  });

  document.querySelectorAll("[data-bank-stream-date]").forEach((input) => {
    input.addEventListener("change", () => {
      const draft = (state.transactionInboxDrafts || []).find((item) => item.id === input.dataset.bankStreamDate);
      if (!draft || !input.value) return;
      if (!accountAllowsDate(draft.accountId, input.value)) {
        transactionValidationFeedback = `${accountName(draft.accountId)} is closed - pick a date on or before its close date.`;
        render();
        return;
      }
      draft.date = input.value;
      transactionValidationFeedback = "";
      render();
    });
  });

  document.querySelectorAll("[data-bank-stream-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      const draft = (state.transactionInboxDrafts || []).find((item) => item.id === input.dataset.bankStreamAmount);
      if (draft) draft.amount = Number(input.value || 0);
      autosaveState();
    });
  });

  document.querySelectorAll("[data-bank-stream-line]").forEach((select) => {
    select.addEventListener("change", () => {
      const draft = (state.transactionInboxDrafts || []).find((item) => item.id === select.dataset.bankStreamLine);
      if (draft) {
        draft.lineId = select.value;
        // The "From history" pill describes where the *current* line came
        // from - once someone hand-picks a different one, keeping the pill
        // up would misattribute their own choice to the suggestion.
        draft.historyMatch = false;
      }
      autosaveState();
    });
  });

  document.querySelectorAll("[data-toggle-categorization-rule]").forEach((button) => {
    button.addEventListener("click", () => {
      const draft = (state.transactionInboxDrafts || []).find((item) => item.id === button.dataset.toggleCategorizationRule);
      if (!draft || !draft.lineId) return;
      const alreadySet = categorizationRuleForPayee(draft.payee) === draft.lineId;
      setCategorizationRuleForPayee(draft.payee, alreadySet ? "" : draft.lineId);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-ai-suggest-line]").forEach((button) => {
    button.addEventListener("click", async () => {
      const draft = (state.transactionInboxDrafts || []).find((item) => item.id === button.dataset.aiSuggestLine);
      if (!draft) return;
      button.disabled = true;
      button.textContent = "…";
      try {
        const { lineId } = await suggestSubcategoryWithAI(draft.payee);
        if (lineId) {
          draft.lineId = lineId;
          draft.historyMatch = false;
          autosaveState();
          render();
        } else {
          showToast("AI couldn't find a confident match for this payee - pick one manually.");
        }
      } catch (error) {
        showToast(error.message || "AI suggestion failed - try again or pick manually.");
        button.disabled = false;
        button.textContent = "✨";
      }
    });
  });

  document.querySelectorAll("[data-ai-suggest-account]").forEach((button) => {
    button.addEventListener("click", async () => {
      const draft = (state.transactionInboxDrafts || []).find((item) => item.id === button.dataset.aiSuggestAccount);
      if (!draft) return;
      button.disabled = true;
      button.textContent = "…";
      try {
        const { accountId } = await suggestAccountWithAI(draft.payee);
        if (!accountId) {
          showToast("AI couldn't find a confident match for this payee - pick one manually.");
        } else if (!accountAllowsDate(accountId, draft.date)) {
          showToast(`${accountName(accountId)} is closed - this item is dated after its close date.`);
        } else {
          draft.accountId = accountId;
          draft.accountHistoryMatch = false;
          autosaveState();
          render();
        }
      } catch (error) {
        showToast(error.message || "AI suggestion failed - try again or pick manually.");
      } finally {
        button.disabled = false;
        button.textContent = "✨";
      }
    });
  });

  document.querySelectorAll("[data-remove-bank-stream-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const draft = (state.transactionInboxDrafts || []).find((item) => item.id === button.dataset.removeBankStreamTag);
      const tag = button.closest(".tag-chip")?.dataset.tag;
      if (!draft || !tag) return;
      draft.tags = (draft.tags || []).filter((existing) => existing !== tag);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-add-bank-stream-tag]").forEach((input) => {
    const commit = () => {
      const draft = (state.transactionInboxDrafts || []).find((item) => item.id === input.dataset.addBankStreamTag);
      if (!draft || !input.value.trim()) return;
      draft.tags = addTagsDeduped(draft.tags, input.value);
      input.value = "";
      autosaveState();
      render();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); commit(); }
    });
    input.addEventListener("blur", commit);
  });

  document.querySelectorAll("[data-bank-stream-account]").forEach((select) => {
    select.addEventListener("change", () => {
      const draft = (state.transactionInboxDrafts || []).find((item) => item.id === select.dataset.bankStreamAccount);
      if (!draft) return;
      if (!accountAllowsDate(select.value, draft.date)) {
        transactionValidationFeedback = `${accountName(select.value)} is closed - this item is dated after its close date.`;
        render();
        return;
      }
      draft.accountId = select.value;
      draft.accountHistoryMatch = false;
      transactionValidationFeedback = "";
      autosaveState();
    });
  });

  $("#bankStreamBulkAccount")?.addEventListener("change", (event) => {
    const accountId = event.target.value;
    if (!accountId) return;
    // Only touches drafts with no account yet - never overwrites a row the
    // filename match already linked correctly, or one someone hand-picked.
    const unlinked = (state.transactionInboxDrafts || []).filter((draft) => !draft.accountId);
    let skippedClosed = 0;
    unlinked.forEach((draft) => {
      if (accountAllowsDate(accountId, draft.date)) {
        draft.accountId = accountId;
      } else {
        skippedClosed += 1;
      }
    });
    transactionValidationFeedback = skippedClosed
      ? `${accountName(accountId)} was applied to ${unlinked.length - skippedClosed} row${unlinked.length - skippedClosed === 1 ? "" : "s"} - ${skippedClosed} skipped because they're dated after that account's close date.`
      : "";
    autosaveState();
    render();
  });

  $("#bankStreamClearHistoryMatches")?.addEventListener("click", () => {
    const matched = (state.transactionInboxDrafts || []).filter((draft) => draft.historyMatch);
    matched.forEach((draft) => {
      draft.lineId = "";
      draft.historyMatch = false;
    });
    transactionValidationFeedback = `Cleared the suggested Subcategory on ${matched.length} row${matched.length === 1 ? "" : "s"} - pick each one by hand, or re-suggest with the ✨ AI button.`;
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-ledger-entry-payee]").forEach((input) => {
    input.addEventListener("input", () => {
      const transaction = state.transactions[Number(input.dataset.ledgerEntryPayee)];
      if (transaction) transaction.payee = input.value;
      autosaveState();
    });
  });

  document.querySelectorAll("[data-ledger-entry-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      const transaction = state.transactions[Number(input.dataset.ledgerEntryAmount)];
      if (transaction) transaction.amount = Number(input.value || 0);
      autosaveState();
    });
  });

  document.querySelectorAll("[data-ledger-entry-date]").forEach((input) => {
    input.addEventListener("change", () => {
      const transaction = state.transactions[Number(input.dataset.ledgerEntryDate)];
      if (!transaction || !input.value) return;
      if (!accountAllowsDate(transaction.accountId, input.value)) {
        transactionValidationFeedback = `${accountName(transaction.accountId)} is closed - pick a date on or before its close date.`;
        render();
        return;
      }
      transaction.date = input.value;
      transactionValidationFeedback = "";
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-ledger-entry-line]").forEach((select) => {
    select.addEventListener("change", () => {
      const transaction = state.transactions[Number(select.dataset.ledgerEntryLine)];
      if (transaction) Object.assign(transaction, { lineId: select.value }, lineSnapshot(select.value));
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-ledger-entry-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const index = Number(checkbox.dataset.ledgerEntrySelect);
      if (checkbox.checked) ledgerSelectedIndices.add(index);
      else ledgerSelectedIndices.delete(index);
      render();
    });
  });

  $("#ledgerSelectAllCheckbox")?.addEventListener("change", (event) => {
    document.querySelectorAll("[data-ledger-entry-select]").forEach((checkbox) => {
      const index = Number(checkbox.dataset.ledgerEntrySelect);
      if (event.currentTarget.checked) ledgerSelectedIndices.add(index);
      else ledgerSelectedIndices.delete(index);
    });
    render();
  });

  $("#ledgerBulkClearButton")?.addEventListener("click", () => {
    ledgerSelectedIndices.clear();
    render();
  });

  $("#ledgerBulkApplyButton")?.addEventListener("click", () => {
    const lineId = $("#ledgerBulkLineSelect")?.value;
    if (!lineId) return;
    const snapshot = lineSnapshot(lineId);
    ledgerSelectedIndices.forEach((index) => {
      const transaction = state.transactions[index];
      if (transaction) Object.assign(transaction, { lineId }, snapshot);
    });
    ledgerSelectedIndices.clear();
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-split-transaction-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.splitTransactionEdit);
      const transaction = state.transactions[index];
      if (!transaction) return;
      splitEditorLedgerIndex = index;
      splitEditorRows = transaction.splits?.length
        ? transaction.splits.map((split) => ({ lineId: split.lineId, amount: split.amount }))
        : [{ lineId: transaction.lineId || "", amount: Number(transaction.amount || 0) }, { lineId: "", amount: 0 }];
      render();
    });
  });

  document.querySelectorAll("[data-split-editor-line]").forEach((select) => {
    select.addEventListener("change", () => {
      const row = splitEditorRows[Number(select.dataset.splitEditorLine)];
      if (row) row.lineId = select.value;
      render();
    });
  });

  document.querySelectorAll("[data-split-editor-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      const row = splitEditorRows[Number(input.dataset.splitEditorAmount)];
      if (row) row.amount = Number(input.value || 0);
      render();
    });
  });

  document.querySelectorAll("[data-split-editor-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      splitEditorRows.splice(Number(button.dataset.splitEditorRemove), 1);
      render();
    });
  });

  document.querySelector("[data-split-editor-add-row]")?.addEventListener("click", () => {
    splitEditorRows.push({ lineId: "", amount: 0 });
    render();
  });

  document.querySelector("[data-split-editor-cancel]")?.addEventListener("click", () => {
    splitEditorLedgerIndex = null;
    splitEditorRows = [];
    render();
  });

  document.querySelectorAll("[data-split-editor-undo]").forEach((button) => {
    button.addEventListener("click", () => {
      const transaction = state.transactions[Number(button.dataset.splitEditorUndo)];
      if (!transaction) return;
      const firstSplit = transaction.splits?.[0];
      transaction.splits = undefined;
      Object.assign(transaction, { lineId: firstSplit?.lineId || "" }, lineSnapshot(firstSplit?.lineId || ""));
      splitEditorLedgerIndex = null;
      splitEditorRows = [];
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-split-editor-save]").forEach((button) => {
    button.addEventListener("click", () => {
      const transaction = state.transactions[Number(button.dataset.splitEditorSave)];
      if (!transaction) return;
      const rows = splitEditorRows.filter((row) => row.lineId).map((row) => ({ lineId: row.lineId, amount: Number(row.amount || 0) }));
      if (rows.length < 2) return;
      transaction.splits = rows;
      transaction.lineId = "";
      transaction.categoryName = "";
      transaction.subcategoryName = "";
      splitEditorLedgerIndex = null;
      splitEditorRows = [];
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-ledger-entry-account]").forEach((select) => {
    select.addEventListener("change", () => {
      const transaction = state.transactions[Number(select.dataset.ledgerEntryAccount)];
      if (!transaction) return;
      if (!accountAllowsDate(select.value, transaction.date)) {
        transactionValidationFeedback = `${accountName(select.value)} is closed - this transaction is dated after its close date.`;
        render();
        return;
      }
      transaction.accountId = select.value;
      transactionValidationFeedback = "";
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-remove-ledger-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const transaction = state.transactions[Number(button.dataset.removeLedgerTag)];
      const tag = button.closest(".tag-chip")?.dataset.tag;
      if (!transaction || !tag) return;
      transaction.tags = (transaction.tags || []).filter((existing) => existing !== tag);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-add-ledger-tag]").forEach((input) => {
    const commit = () => {
      const transaction = state.transactions[Number(input.dataset.addLedgerTag)];
      if (!transaction || !input.value.trim()) return;
      transaction.tags = addTagsDeduped(transaction.tags, input.value);
      input.value = "";
      autosaveState();
      render();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); commit(); }
    });
    input.addEventListener("blur", commit);
  });

  document.querySelectorAll("[data-recurring-payee]").forEach((input) => {
    input.addEventListener("input", () => {
      const recurring = state.recurringExpenses[Number(input.dataset.recurringPayee)];
      if (recurring) recurring.payee = input.value;
      autosaveState();
    });
  });

  document.querySelectorAll("[data-recurring-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      const recurring = state.recurringExpenses[Number(input.dataset.recurringAmount)];
      if (recurring) recurring.amount = Number(input.value || 0);
      autosaveState();
    });
  });

  document.querySelectorAll("[data-recurring-line]").forEach((select) => {
    select.addEventListener("change", () => {
      const recurring = state.recurringExpenses[Number(select.dataset.recurringLine)];
      if (recurring) recurring.lineId = select.value;
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-recurring-account]").forEach((select) => {
    select.addEventListener("change", () => {
      const recurring = state.recurringExpenses[Number(select.dataset.recurringAccount)];
      if (recurring) recurring.accountId = select.value;
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-recurring-recurrence]").forEach((select) => {
    select.addEventListener("change", () => {
      const recurring = state.recurringExpenses[Number(select.dataset.recurringRecurrence)];
      if (recurring) recurring.recurrence = select.value;
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-recurring-end-date]").forEach((input) => {
    input.addEventListener("change", () => {
      const recurring = state.recurringExpenses[Number(input.dataset.recurringEndDate)];
      if (recurring) {
        recurring.endDate = input.value || "";
        // A bank stream draft already surfaced past a newly-set (or
        // newly-lowered) end date would otherwise sit there unreviewed
        // forever — pending drafts get the same cleanup paycheck
        // occurrences get when their end date changes.
        if (recurring.endDate) {
          state.transactionInboxDrafts = (state.transactionInboxDrafts || []).filter((draft) => draft.recurringId !== recurring.id || draft.date <= recurring.endDate);
        }
      }
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-recurring]").forEach((button) => {
    button.addEventListener("click", () => {
      state.recurringExpenses.splice(Number(button.dataset.deleteRecurring), 1);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-assign-ledger]").forEach((button) => {
    button.addEventListener("click", () => {
      const [id, payee, amount, date] = button.dataset.assignLedger.split(":");
      const lineId = document.querySelector(`[data-ledger-line="${id}"]`)?.value || allLines()[0]?.id;
      state.transactions.unshift(makeTransaction({ date, payee, amount: Number(amount), lineId, memo: "Assigned from ledger" }));
      state.household.activity.unshift(`Assigned ${payee} to ${transactionAssignmentLabel({ lineId })}`);
      autosaveState();
      render();
    });
  });

  $("#addPaycheckButton")?.addEventListener("click", () => {
    // Same reasoning as #addIncomeButton: date to the viewed budget month
    // (not today's real date) and default to a one-time recurrence, not
    // "monthly" - otherwise a single backfilled/historical entry keeps
    // generating occurrences into every month afterward, including whichever
    // month is actually current.
    state.paychecks.push({ date: `${state.budget.month}-01`, name: `Paycheck/Income ${state.paychecks.length + 1}`, amount: 0, assignedLineIds: [], recurrence: "once" });
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-delete-paycheck]").forEach((button) => {
    button.addEventListener("click", () => {
      const [paycheck] = state.paychecks.splice(Number(button.dataset.deletePaycheck), 1);
      if (paycheck?.id) {
        state.paycheckOccurrences = (state.paycheckOccurrences || []).filter((occurrence) => occurrence.seriesId !== paycheck.id);
      }
      state.budget.income = budgetIncomeFromPaychecks();
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-paycheck-date]").forEach((input) => {
    input.addEventListener("change", () => {
      const paycheck = state.paychecks[Number(input.dataset.paycheckDate)];
      if (paycheck && input.value) paycheck.date = input.value;
      state.budget.income = budgetIncomeFromPaychecks();
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-paycheck-recurrence]").forEach((select) => {
    select.addEventListener("change", () => {
      const paycheck = state.paychecks[Number(select.dataset.paycheckRecurrence)];
      // Regenerating stale occurrences after a recurrence change is handled
      // centrally in ensurePaycheckOccurrencesGenerated (keyed off
      // generatedRecurrence), which runs on every render - so no manual
      // clearing is needed here, and a paycheck that was already left in a
      // stale state before that existed self-heals the same way.
      if (paycheck) paycheck.recurrence = select.value;
      state.budget.income = budgetIncomeFromPaychecks();
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-paycheck-end-date]").forEach((input) => {
    input.addEventListener("change", () => {
      const paycheck = state.paychecks[Number(input.dataset.paycheckEndDate)];
      if (paycheck) {
        paycheck.endDate = input.value || "";
        // Rows already materialized past a newly-set (or newly-lowered) end
        // date would otherwise keep counting as income forever — generation
        // only prevents new rows going forward, so already-existing ones
        // need to be pruned here too.
        if (paycheck.endDate) {
          state.paycheckOccurrences = (state.paycheckOccurrences || []).filter((occurrence) => occurrence.seriesId !== paycheck.id || occurrence.date <= paycheck.endDate);
        }
      }
      state.budget.income = budgetIncomeFromPaychecks();
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-occurrence-date]").forEach((input) => {
    input.addEventListener("change", () => {
      const occurrence = (state.paycheckOccurrences || []).find((item) => item.id === input.dataset.occurrenceDate);
      if (occurrence && input.value) occurrence.date = input.value;
      state.budget.income = budgetIncomeFromPaychecks();
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-occurrence-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      const occurrence = (state.paycheckOccurrences || []).find((item) => item.id === input.dataset.occurrenceAmount);
      if (occurrence) occurrence.amount = Number(input.value || 0);
      state.budget.income = budgetIncomeFromPaychecks();
      autosaveState();
    });
    input.addEventListener("change", () => render());
  });

  document.querySelectorAll("[data-delete-occurrence]").forEach((button) => {
    button.addEventListener("click", () => {
      const occurrenceIndex = (state.paycheckOccurrences || []).findIndex((item) => item.id === button.dataset.deleteOccurrence);
      if (occurrenceIndex < 0) return;
      state.paycheckOccurrences.splice(occurrenceIndex, 1);
      state.budget.income = budgetIncomeFromPaychecks();
      autosaveState();
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
      state.budget.income = budgetIncomeFromPaychecks();
      const splitEl = document.querySelector(`[data-paycheck-split="${index}"]`);
      if (splitEl) {
        const assigned = paycheckAssignedAmount(paycheck);
        splitEl.innerHTML = `<span>Income ${money.format(paycheckMonthlyIncome(paycheck))}</span><b>Assigned ${money.format(assigned)}</b>`;
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
    const amountInput = $("#paycheckAmountSelect");
    const amount = Number(amountInput?.value);
    if (amountInput?.value && amount >= 0) {
      const line = findLineById(lineId);
      if (line) line.planned = amount;
    }
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-remove-paycheck-line]").forEach((button) => {
    button.addEventListener("click", () => {
      const [index, lineId] = button.dataset.removePaycheckLine.split(":");
      const paycheck = state.paychecks[Number(index)];
      if (!paycheck) return;
      paycheck.assignedLineIds = paycheck.assignedLineIds.filter((id) => id !== lineId);
      autosaveState();
      render();
    });
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
    autosaveState();
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
      autosaveState();
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
    autosaveState();
    render();
  });

  $("#cancelRecipeEditButton")?.addEventListener("click", () => {
    state.meals.editingRecipeId = "";
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-edit-recipe]").forEach((button) => {
    button.addEventListener("click", () => {
      state.meals.editingRecipeId = button.dataset.editRecipe;
      autosaveState();
      render();
      $("#recipeForm input[name='name']")?.focus();
    });
  });

  document.querySelectorAll("[data-select-recipe]").forEach((button) => {
    button.addEventListener("click", () => {
      const form = $("#mealPlanForm");
      state.meals.selectedRecipeId = button.dataset.selectRecipe;
      currentView = "meals";
      autosaveState();
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
      autosaveState();
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
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-goal-auto-mode]").forEach((select) => {
    select.addEventListener("change", () => {
      const fund = state.goals.sinkingFunds[Number(select.dataset.goalAutoMode)];
      if (!fund) return;
      if (select.value === "off") {
        fund.autoContribute = { enabled: false };
      } else {
        fund.autoContribute = { enabled: true, mode: select.value, percent: fund.autoContribute?.percent || 5 };
      }
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-goal-auto-percent]").forEach((input) => {
    input.addEventListener("change", () => {
      const fund = state.goals.sinkingFunds[Number(input.dataset.goalAutoPercent)];
      if (!fund?.autoContribute) return;
      fund.autoContribute.percent = Math.min(100, Math.max(0, Number(input.value || 0)));
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-goal-contribution-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.goalContributionAdd);
      const fund = state.goals.sinkingFunds[index];
      const input = document.querySelector(`[data-goal-contribution-input="${index}"]`);
      const amount = Number(input?.value || 0);
      if (!fund || amount <= 0) return;
      fund.saved = Math.max(0, Number(fund.saved || 0) + amount);
      autosaveState();
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

  document.querySelectorAll("[data-debt-line]").forEach((select) => {
    select.addEventListener("change", () => {
      const debt = state.goals.debts[Number(select.dataset.debtLine)];
      debt.lineId = select.value;
      autosaveState();
    });
  });

  document.querySelectorAll("[data-debt-payment-date]").forEach((input) => {
    input.addEventListener("change", () => {
      const [debtIndex, paymentIndex] = input.dataset.debtPaymentDate.split(":").map(Number);
      const payment = state.goals.debts[debtIndex]?.payments?.[paymentIndex];
      if (payment && input.value) payment.date = input.value;
      autosaveState();
    });
  });

  document.querySelectorAll("[data-delete-debt-payment]").forEach((button) => {
    button.addEventListener("click", () => {
      const [debtIndex, paymentIndex] = button.dataset.deleteDebtPayment.split(":").map(Number);
      const debt = state.goals.debts[debtIndex];
      const payment = debt?.payments?.[paymentIndex];
      if (!debt || !payment) return;
      // Restores the balance this payment reduced, without touching
      // appliedPaymentSignatures — the underlying Ledger transaction (if any)
      // stays marked as already accounted for, so removing a wrongly
      // recorded payment here never causes it to silently reapply later.
      debt.balance = Math.max(0, Number(debt.balance || 0) + Number(payment.principal || 0));
      debt.payments.splice(paymentIndex, 1);
      const liability = liabilityForDebt(debt);
      if (liability) liability.value = debt.balance;
      autosaveState();
      render();
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
      const paymentDate = new Date().toISOString().slice(0, 10);
      debt.payments ||= [];
      debt.payments.unshift({ id: uniqueId("payment"), date: paymentDate, amount, principal, interest, extra, balance: debt.balance });
      if (debt.lineId) {
        const paymentTransaction = makeTransaction({ date: paymentDate, payee: debt.name, lineId: debt.lineId, amount, memo: "EMI payment" });
        state.transactions.unshift(paymentTransaction);
        // Prevents ensureDebtPaymentsAppliedFromLedger from treating the
        // transaction this button just created as a brand new payment and
        // reducing the balance a second time.
        debt.appliedPaymentSignatures ||= [];
        debt.appliedPaymentSignatures.push(transactionSignature(paymentTransaction));
      }
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

  $("#wealthCurrencySelect")?.addEventListener("change", (event) => {
    setWealthCurrency(event.target.value);
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

  // A stock group's items are matched by groupId, falling back to the
  // group's own id for a legacy solo holding with no groupId of its own -
  // same fallback groupStockHoldings() uses to build the group in the
  // first place, so a rename/delete here always hits every item it showed.
  const stockGroupAssets = (groupId) => state.goals.netWorth.assets.filter((asset) => isHoldingAssetClass(asset.assetClass) && (asset.groupId || asset.id) === groupId);

  document.querySelectorAll("[data-manage-stock-group]").forEach((button) => {
    button.addEventListener("click", () => openHoldingsModal(button.dataset.manageStockGroup));
  });

  document.querySelectorAll("[data-refresh-stock-group]").forEach((button) => {
    button.addEventListener("click", async () => {
      const groupId = button.dataset.refreshStockGroup;
      button.disabled = true;
      await refreshHoldingQuotes(stockGroupAssets(groupId));
      markStockGroupRefreshed(groupId);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-stock-group]").forEach((button) => {
    button.addEventListener("click", async () => {
      const items = stockGroupAssets(button.dataset.deleteStockGroup);
      if (!items.length) return;
      const confirmed = await showConfirm(`This deletes ${items.length} holding${items.length === 1 ? "" : "s"} under this account.`, {
        title: `Remove ${items[0].groupName || items[0].name}?`,
        confirmLabel: "Delete"
      });
      if (!confirmed) return;
      const ids = new Set(items.map((item) => item.id));
      state.goals.netWorth.assets = state.goals.netWorth.assets.filter((asset) => !ids.has(asset.id));
      state.goals.debts = state.goals.debts.filter((debt) => !ids.has(debt.id));
      autosaveState();
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
    button.addEventListener("click", async () => {
      const index = Number(button.dataset.deleteAsset);
      const target = state.goals.netWorth.assets[index];
      if (!target) return;
      if (!(await showConfirm(`Delete "${target.name}"? This cannot be undone.`, { confirmLabel: "Delete" }))) return;
      const [asset] = state.goals.netWorth.assets.splice(index, 1);
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
    button.addEventListener("click", async () => {
      const index = Number(button.dataset.deleteLiability);
      const target = state.goals.netWorth.liabilities[index];
      if (!target) return;
      if (!(await showConfirm(`Delete "${target.name}"? This cannot be undone.`, { confirmLabel: "Delete" }))) return;
      const [liability] = state.goals.netWorth.liabilities.splice(index, 1);
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
    input.addEventListener("change", () => {
      const account = state.accounts[Number(input.dataset.accountName)];
      const newName = input.value.trim() || "Untitled account";
      if (newName === account.name) {
        input.value = account.name;
        return;
      }
      const applyRename = () => {
        account.name = newName;
        const asset = state.goals.netWorth.assets.find((item) => item.id === account.netWorthAssetId);
        if (asset) asset.name = newName;
        const liability = state.goals.netWorth.liabilities.find((item) => item.id === account.netWorthLiabilityId);
        if (liability) liability.name = newName;
        input.value = newName;
        autosaveState();
      };
      openAccountActionConfirm({
        title: `Rename ${account.name} to "${newName}"?`,
        summarySuffix: "Renaming will not change what they are linked to - this is just so you know before continuing.",
        account,
        reassignable: false,
        confirmLabel: "Rename",
        onConfirm: applyRename,
        onCancel: () => { input.value = account.name; }
      });
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

  document.querySelectorAll("[data-account-close-date]").forEach((input) => {
    input.addEventListener("change", () => {
      const account = state.accounts[Number(input.dataset.accountCloseDate)];
      account.closedAt = input.value || "";
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-account]").forEach((button) => {
    button.addEventListener("click", () => {
      const accountIndex = Number(button.dataset.deleteAccount);
      const account = state.accounts[accountIndex];
      if (!account) return;
      openAccountActionConfirm({
        title: `Remove ${account.name}?`,
        summarySuffix: "Reassign them to a different account below, or leave them unassigned.",
        account,
        reassignable: true,
        confirmLabel: "Delete",
        onConfirm: (targetAccountId) => {
          const usage = accountUsage(account.id);
          usage.transactions.forEach((transaction) => { transaction.accountId = targetAccountId; });
          usage.recurringExpenses.forEach((recurring) => { recurring.accountId = targetAccountId; });
          usage.paychecks.forEach((paycheck) => { paycheck.depositAccountId = targetAccountId; });
          (state.paycheckOccurrences || []).forEach((occurrence) => {
            if (occurrence.depositAccountId === account.id) occurrence.depositAccountId = targetAccountId;
          });
          // The paired net-worth entry is computed entirely from this account
          // (ensureAccountsData overwrites its value every render) - once the
          // account is gone that value is frozen and meaningless, so remove
          // the entry too instead of leaving a stale number in net worth.
          if (account.netWorthAssetId) {
            const assetIndex = state.goals.netWorth.assets.findIndex((item) => item.id === account.netWorthAssetId);
            if (assetIndex >= 0) state.goals.netWorth.assets.splice(assetIndex, 1);
          }
          if (account.netWorthLiabilityId) {
            const liabilityIndex = state.goals.netWorth.liabilities.findIndex((item) => item.id === account.netWorthLiabilityId);
            if (liabilityIndex >= 0) state.goals.netWorth.liabilities.splice(liabilityIndex, 1);
          }
          state.accounts.splice(accountIndex, 1);
          // Deliberately leave state.transfers untouched: a transfer that already
          // moved money out of/into a surviving account is a historical fact that
          // must keep affecting that account's balance, even after the other side
          // of the transfer is deleted (or reassigned). accountBalance() only
          // looks up the account currently being computed, so a transfer
          // referencing a stale account id on the *other* side is simply inert
          // going forward, never an error.
          autosaveState();
          render();
        }
      });
    });
  });

  // Drag-to-reorder accounts on the Wealth page, same pattern as the note
  // checklist reorder above: draggedAccountId is local to this one
  // bindViewEvents pass, only needs to survive one drag gesture.
  let draggedAccountId = null;
  const clearAccountDragOverClasses = () => {
    document.querySelectorAll(".account-item-drag-over-top, .account-item-drag-over-bottom").forEach((row) => {
      row.classList.remove("account-item-drag-over-top", "account-item-drag-over-bottom");
    });
  };
  document.querySelectorAll("[data-drag-account]").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      draggedAccountId = row.dataset.dragAccount;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedAccountId);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      clearAccountDragOverClasses();
      draggedAccountId = null;
    });
    row.addEventListener("dragover", (event) => {
      if (!draggedAccountId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const isAfter = event.clientY - row.getBoundingClientRect().top > row.getBoundingClientRect().height / 2;
      row.classList.toggle("account-item-drag-over-bottom", isAfter);
      row.classList.toggle("account-item-drag-over-top", !isAfter);
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("account-item-drag-over-top", "account-item-drag-over-bottom");
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      clearAccountDragOverClasses();
      if (!draggedAccountId) return;
      const targetAccountId = row.dataset.dragAccount;
      if (targetAccountId === draggedAccountId) return;
      const insertAfter = event.clientY - row.getBoundingClientRect().top > row.getBoundingClientRect().height / 2;
      state.accounts = moveArrayItemById(state.accounts, draggedAccountId, targetAccountId, insertAfter);
      autosaveState();
      render();
    });
  });

  // Net worth's drag-to-reorder covers two separate lists sharing the same
  // wiring shape as the accounts block above: assets (grouped holdings
  // cards and plain asset rows together, moved as a block via
  // moveNetWorthAssetBlock so a group's several holdings travel as one
  // unit) and liabilities (plain rows only, so the existing single-item
  // moveArrayItemById applies unchanged). Both class-name pairs are toggled
  // on every row regardless of which element type it is - a stock-group
  // card only matches the .account-item-* selectors and a plain
  // .net-worth-item only matches the .net-worth-item-* ones, so the unused
  // pair is simply inert rather than needing a per-row type check.
  const wireNetWorthDragReorder = (attribute, getList, setList, reorder) => {
    let draggedKey = null;
    const clearOverClasses = () => {
      document.querySelectorAll(".account-item-drag-over-top, .account-item-drag-over-bottom, .net-worth-item-drag-over-top, .net-worth-item-drag-over-bottom").forEach((row) => {
        row.classList.remove("account-item-drag-over-top", "account-item-drag-over-bottom", "net-worth-item-drag-over-top", "net-worth-item-drag-over-bottom");
      });
    };
    document.querySelectorAll(`[${attribute}]`).forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        draggedKey = row.getAttribute(attribute);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedKey);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        clearOverClasses();
        draggedKey = null;
      });
      row.addEventListener("dragover", (event) => {
        if (!draggedKey) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const isAfter = event.clientY - row.getBoundingClientRect().top > row.getBoundingClientRect().height / 2;
        row.classList.toggle("account-item-drag-over-bottom", isAfter);
        row.classList.toggle("account-item-drag-over-top", !isAfter);
        row.classList.toggle("net-worth-item-drag-over-bottom", isAfter);
        row.classList.toggle("net-worth-item-drag-over-top", !isAfter);
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("account-item-drag-over-top", "account-item-drag-over-bottom", "net-worth-item-drag-over-top", "net-worth-item-drag-over-bottom");
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        clearOverClasses();
        if (!draggedKey) return;
        const targetKey = row.getAttribute(attribute);
        if (targetKey === draggedKey) return;
        const insertAfter = event.clientY - row.getBoundingClientRect().top > row.getBoundingClientRect().height / 2;
        setList(reorder(getList(), draggedKey, targetKey, insertAfter));
        autosaveState();
        render();
      });
    });
  };
  wireNetWorthDragReorder("data-drag-networth-asset", () => state.goals.netWorth.assets, (list) => { state.goals.netWorth.assets = list; }, moveNetWorthAssetBlock);
  wireNetWorthDragReorder("data-drag-networth-liability", () => state.goals.netWorth.liabilities, (list) => { state.goals.netWorth.liabilities = list; }, moveArrayItemById);

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
    const selectedDate = String(data.date || "");
    const selectedTime = String(data.time || "09:00");
    const selectedDateTime = selectedDate ? `${selectedDate}T${selectedTime}` : "";
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
        time: selectedTime,
        notifyAt: selectedDateTime ? new Date(selectedDateTime).toISOString() : "",
        location: String(data.location || "").trim(),
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
      // 11AM) -- falls back to the event's own date/time if left blank.
      const reminderAtDate = String(data.reminderAtDate || "");
      const reminderAtTime = String(data.reminderAtTime || "09:00");
      const reminderAtCombined = reminderAtDate ? `${reminderAtDate}T${reminderAtTime}` : "";
      const reminderAt = !isAnnual ? String(reminderAtCombined || selectedDateTime) : "";
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
        location: isAnnual ? "" : String(data.location || "").trim(),
        reminderDays,
        recurrence: isAnnual ? undefined : (data.reminderRecurrence || "once"),
        assignees
      };
      if (existing) {
        delete existing.owner;
        delete existing.ownerName;
        Object.assign(existing, calendarEvent);
      } else state.calendar.events.push(calendarEvent);
    }
    calendarFeedback = `${data.type === "chore" ? "Chore" : annualEventLabels[data.type] || "Reminder"} ${wasEditing ? "updated" : "added"}.`;
    autosaveState();
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
      autosaveState();
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
      // Only a genuinely completing action (not un-checking) advances a
      // recurring reminder - otherwise clicking "Mark done" then "Undo"
      // would leave it silently jumped ahead to the wrong next date.
      if (!already && event.type === "reminder" && event.recurrence && event.recurrence !== "once" && isReminderComplete(event)) {
        const nextDate = advanceReminderDate(event.date, event.recurrence);
        event.date = nextDate;
        event.dateTime = `${nextDate}T${(event.dateTime || "09:00").slice(11, 16) || "09:00"}`;
        if (event.reminderAt) {
          const reminderTime = event.reminderAt.slice(11, 16) || "09:00";
          const nextReminderDate = advanceReminderDate(event.reminderAt.slice(0, 10), event.recurrence);
          event.reminderAt = `${nextReminderDate}T${reminderTime}`;
          event.notifyAt = new Date(event.reminderAt).toISOString();
        }
        event.completedBy = [];
      }
      autosaveState();
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
      autosaveState();
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
      autosaveState();
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
      // The date and time are always separate fields now, so clicking a
      // different day just updates the date - whatever time was already
      // typed (or the "annual" case, where there's no time field at all)
      // is untouched.
      dateInput.value = cell.dataset.calendarDay;
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
    autosaveState();
    render();
  });

  $("#addChoreButton")?.addEventListener("click", () => focusCalendarType("chore"));
  $("#sideAddChoreButton")?.addEventListener("click", () => focusCalendarType("chore"));
  $("#addBirthdayButton")?.addEventListener("click", () => focusCalendarType("birthday"));
  $("#sideAddBirthdayButton")?.addEventListener("click", () => focusCalendarType("birthday"));
  $("#addAnniversaryButton")?.addEventListener("click", () => focusCalendarType("anniversary"));
  $("#sideAddAnniversaryButton")?.addEventListener("click", () => focusCalendarType("anniversary"));
  $("#addReminderButton")?.addEventListener("click", () => focusCalendarType("reminder"));
  $("#sideAddReminderButton")?.addEventListener("click", () => focusCalendarType("reminder"));

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
      autosaveState();
      render();
    });
  });

  $("#shareEverythingToggle")?.addEventListener("change", (event) => {
    const allScopes = [...document.querySelectorAll("[data-share-scope]")].map((input) => input.dataset.shareScope);
    state.household.sharedScopes = event.currentTarget.checked ? allScopes : [];
    autosaveState();
    render();
  });

  $("#inviteButton")?.addEventListener("click", () => {
    state.household.inviteCode = `HUB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    state.household.activity.unshift(`Generated invite code ${state.household.inviteCode}`);
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-copy-invite-code]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copyInviteCode);
        showToast("Copied!", { type: "success" });
      } catch {
        showToast("Couldn't copy - select and copy the code manually.");
      }
    });
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

  document.querySelectorAll("[data-member-access-level]").forEach((select) => {
    select.addEventListener("change", async () => {
      const email = select.dataset.memberAccessLevel;
      select.disabled = true;
      try {
        await api("/api/households/access", { method: "PATCH", body: JSON.stringify({ email, accessLevel: select.value }) });
        state.household.activity.unshift(`${select.value === "view" ? "View-only" : "Edit"} access set for ${email}`);
        await saveStateNow();
        sharingAccess = null;
        await loadSharingAccess(false);
        render();
      } catch (error) {
        showToast(error.message);
        select.disabled = false;
      }
    });
  });

  document.querySelectorAll("[data-revoke-household-access]").forEach((button) => {
    button.addEventListener("click", async () => {
      const email = button.dataset.revokeHouseholdAccess;
      if (!(await showConfirm(`Revoke household access for ${email}?`, { confirmLabel: "Revoke" }))) return;
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
      showToast(error.message);
    }
  });

  document.querySelectorAll("[data-documents-delete-folder]").forEach((button) => {
    button.addEventListener("click", async () => {
      const folderId = button.dataset.documentsDeleteFolder;
      const hasContents = documentsData.folders.some((item) => item.parentId === folderId) || documentsData.documents.some((item) => item.folderId === folderId);
      const message = hasContents
        ? "Delete this folder and everything inside it - subfolders and documents included? This can't be undone."
        : "Delete this folder? This can't be undone.";
      if (!(await showConfirm(message, { confirmLabel: "Delete" }))) return;
      try {
        await api(`/api/documents/folders/${button.dataset.documentsDeleteFolder}`, { method: "DELETE" });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        showToast(error.message);
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
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-documents-file-input]").forEach((input) => {
    input.addEventListener("change", async () => {
      const files = buildTreeFromRelativePaths(input.files || []);
      input.value = "";
      await runBulkDocumentUpload(files);
    });
  });

  document.querySelectorAll("[data-documents-folder-input]").forEach((input) => {
    input.addEventListener("change", async () => {
      const files = buildTreeFromRelativePaths(input.files || []);
      input.value = "";
      await runBulkDocumentUpload(files);
    });
  });

  document.querySelectorAll("[data-documents-os-drop-zone]").forEach((zone) => {
    zone.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    zone.addEventListener("dragenter", (event) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      zone.classList.add("documents-os-drop-active");
    });
    zone.addEventListener("dragleave", (event) => {
      if (event.target !== zone) return;
      zone.classList.remove("documents-os-drop-active");
    });
    zone.addEventListener("drop", async (event) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      zone.classList.remove("documents-os-drop-active");
      const files = await collectFilesFromDataTransferItems(event.dataTransfer.items);
      await runBulkDocumentUpload(files);
    });
  });

  document.querySelectorAll("[data-documents-move]").forEach((select) => {
    select.addEventListener("change", async () => {
      try {
        await api(`/api/documents/${select.dataset.documentsMove}`, { method: "PATCH", body: JSON.stringify({ folderId: select.value || null }) });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        showToast(error.message);
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
        showToast(error.message);
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
        showToast(error.message);
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
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-documents-download], [data-documents-open-file]").forEach((button) => {
    button.addEventListener("click", async () => {
      const documentId = button.dataset.documentsDownload || button.dataset.documentsOpenFile;
      try {
        await openDocumentFile(documentId);
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-documents-rename]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = documentsData.documents.find((doc) => doc.id === button.dataset.documentsRename);
      const name = window.prompt("Rename document", item?.name || "");
      if (!name || !name.trim()) return;
      try {
        await api(`/api/documents/${button.dataset.documentsRename}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-documents-expiry]").forEach((input) => {
    input.addEventListener("change", async () => {
      const documentId = input.dataset.documentsExpiry;
      try {
        await api(`/api/documents/${documentId}`, { method: "PATCH", body: JSON.stringify({ expiryDate: input.value || null }) });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-documents-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/documents/${button.dataset.documentsCopy}/copy`, { method: "POST" });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-documents-info]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.documentsInfo;
      documentsInfoExpandedId = documentsInfoExpandedId === id ? null : id;
      render();
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
      if (!(await showConfirm("Delete this document? This cannot be undone.", { confirmLabel: "Delete" }))) return;
      try {
        await api(`/api/documents/${button.dataset.documentsDelete}`, { method: "DELETE" });
        await loadDocumentsData(false);
        render();
      } catch (error) {
        showToast(error.message);
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
            showToast("Can't move a folder into itself or one of its own subfolders.");
            return;
          }
          await api(`/api/documents/folders/${payload.id}`, { method: "PATCH", body: JSON.stringify({ parentId: targetFolderId }) });
        } else if (payload.type === "document") {
          await api(`/api/documents/${payload.id}`, { method: "PATCH", body: JSON.stringify({ folderId: targetFolderId }) });
        }
        await loadDocumentsData(false);
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  $("#decisionForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const title = String(formData.get("title") || "").trim();
    if (!title) return;
    const newDecision = {
      id: uniqueId("decision"),
      title,
      notes: String(formData.get("notes") || "").trim(),
      status: "open",
      outcome: "",
      decidedAt: "",
      pros: [],
      cons: [],
      createdAt: new Date().toISOString()
    };
    state.decisions.push(newDecision);
    expandedDecisionId = newDecision.id;
    event.currentTarget.reset();
    autosaveState();
    render();
  });

  $("#addFriendForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const name = String(data.name || "").trim();
    if (!name) return;
    await upsertFriend(name, data.email);
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-friend-list-email]").forEach((input) => {
    input.addEventListener("change", async () => {
      const friend = friendsListForDisplay()[Number(input.dataset.friendListEmail)];
      if (!friend) return;
      const newEmail = input.value.trim();
      if (!newEmail || newEmail.toLowerCase() === friend.email.toLowerCase()) return;
      await upsertFriend(friend.name, newEmail);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-friend]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = state.friends.findIndex((friend) => friend.id === button.dataset.deleteFriend);
      if (index === -1) return;
      state.friends.splice(index, 1);
      autosaveState();
      render();
    });
  });

  $("#iouForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const person = String(data.person || "").trim();
    const amount = Number(data.amount);
    if (!person || !(amount > 0)) return;
    await inviteFriendIfNew(person, data.email);
    state.ious ||= [];
    state.ious.push({
      id: uniqueId("iou"),
      person,
      amount,
      direction: data.direction === "owed_to_me" ? "owed_to_me" : "i_owe",
      reason: String(data.reason || "").trim(),
      date: data.date || dateKey(new Date()),
      accountId: data.accountId || "",
      settled: false,
      settledDate: ""
    });
    autosaveState();
    render();
  });

  if ($("#iouForm")) {
    wireFriendRow($("#iouForm"), 0, [{ person: "", email: "", friendId: "" }]);
  }

  if ($("#splitBillRows")) {
    if (!splitBillRows.length) splitBillRows = [{ person: "", amount: 0, percent: 0, shares: 1, email: "", friendId: "" }];
    renderSplitBillRows();
  }

  $("#splitExpenseForm")?.amount?.addEventListener("input", recomputeSplitBillRows);

  $("#splitBillType")?.addEventListener("change", (event) => {
    splitBillType = event.currentTarget.value;
    renderSplitBillRows();
  });

  $("#addSplitBillRowButton")?.addEventListener("click", () => {
    splitBillRows.push({ person: "", amount: 0, percent: 0, shares: 1, email: "", friendId: "" });
    renderSplitBillRows();
  });

  $("#splitExpenseForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const reason = String(data.reason || "").trim();
    const totalAmount = Number(data.amount);
    const friends = splitBillRows
      .map((row) => ({ person: String(row.person || "").trim(), amount: Number(row.amount), percent: Number(row.percent), shares: Number(row.shares), email: String(row.email || "").trim() }))
      .filter((row) => row.person);
    if (!reason || !(totalAmount > 0) || !friends.length) {
      $("#splitBillMessage").textContent = "Enter what it was for, the total bill, and at least one friend.";
      return;
    }
    const result = computeBillSplitAmounts(splitBillType, totalAmount, friends, splitBillYourShareValue());
    if (!result.ok) {
      $("#splitBillMessage").textContent = result.error;
      return;
    }
    const date = data.date || dateKey(new Date());
    for (const friend of friends) {
      await inviteFriendIfNew(friend.person, friend.email);
    }
    state.ious ||= [];
    friends.forEach((friend, index) => {
      state.ious.push({
        id: uniqueId("iou"),
        person: friend.person,
        amount: result.friendAmounts[index],
        direction: "owed_to_me",
        reason,
        date,
        accountId: data.accountId || "",
        settled: false,
        settledDate: ""
      });
    });
    splitBillRows = [];
    splitBillType = "equal";
    splitBillYou = { amount: 0, percent: 0, shares: 1 };
    autosaveState();
    render();
  });

  document.querySelectorAll("[data-iou-account]").forEach((select) => {
    select.addEventListener("change", () => {
      const iou = state.ious.find((item) => item.id === select.dataset.iouAccount);
      if (iou) iou.accountId = select.value;
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-iou-receipt-upload]").forEach((input) => {
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      const iou = state.ious.find((item) => item.id === input.dataset.iouReceiptUpload);
      if (!iou) return;
      try {
        // Receipts go through the same Documents upload pipeline as any
        // other file (upload-url -> PUT -> confirm) - just parked at the
        // household's document root rather than a chosen folder, since an
        // IOU has no folder of its own to file it under.
        const documentId = await uploadDocumentFile(file, null);
        iou.receiptDocumentId = documentId;
        autosaveState();
        render();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-settle-iou]").forEach((button) => {
    button.addEventListener("click", () => {
      const iou = state.ious.find((item) => item.id === button.dataset.settleIou);
      if (!iou) return;
      iou.settled = true;
      iou.settledDate = dateKey(new Date());
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-iou]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = state.ious.findIndex((item) => item.id === button.dataset.deleteIou);
      if (index === -1) return;
      state.ious.splice(index, 1);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-settle-up-person]").forEach((button) => {
    button.addEventListener("click", () => {
      openSettleUpDialog(button.dataset.settleUpPerson);
    });
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
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-decision-attachment]").forEach((button) => {
    button.addEventListener("click", () => {
      const [decisionId, attachmentId] = button.dataset.deleteDecisionAttachment.split(":");
      const decision = state.decisions.find((item) => item.id === decisionId);
      if (!decision) return;
      decision.attachments = decision.attachments.filter((attachment) => attachment.id !== attachmentId);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-decision]").forEach((button) => {
    button.addEventListener("click", () => {
      state.decisions = state.decisions.filter((item) => item.id !== button.dataset.deleteDecision);
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-toggle-decision]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.toggleDecision;
      expandedDecisionId = expandedDecisionId === id ? null : id;
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
      autosaveState();
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
      autosaveState();
      render();
    });
  });

  document.querySelectorAll("[data-delete-decision-item]").forEach((button) => {
    button.addEventListener("click", () => {
      const [decisionId, listKey, itemId] = button.dataset.deleteDecisionItem.split(":");
      const decision = state.decisions.find((item) => item.id === decisionId);
      if (!decision) return;
      decision[listKey] = decision[listKey].filter((item) => item.id !== itemId);
      autosaveState();
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
      autosaveState();
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
      autosaveState();
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

// Home's Quick add shortcuts jump to another tab and then act on that tab's
// own form, which only exists once that view has actually been rendered.
// Calendar specifically also needs its member/sharing-access loads awaited
// first (see the data-home-edit-item handler above) since each one
// re-renders again on resolve and would otherwise wipe out anything the
// action callback just set up.
async function goToViewAndRun(targetView, action) {
  currentView = targetView;
  if (targetView === "calendar") {
    await Promise.all([
      sharingAccess ? null : loadSharingAccess(false),
      sharedCalendarMembers.length === 0 ? loadCalendarMembers(false) : null
    ]);
  }
  render();
  action?.();
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
  // Show/hide the right fields for this type before assigning values below,
  // so e.g. the reminder date/time fields already exist and are visible by
  // the time we populate them.
  updateCalendarQuickAddFields();
  form.title.value = item.title || "";
  const isAnnualItem = kind === "event" && ANNUAL_EVENT_TYPES.includes(item.type);
  form.date.value = kind === "chore"
    ? (item.startDate || item.nextDue || `${state.budget.month}-01`)
    : isAnnualItem
      ? item.date || `${state.budget.month}-01`
      : (item.dateTime ? item.dateTime.slice(0, 10) : (item.date || `${state.budget.month}-01`));
  form.time.value = kind === "chore"
    ? (item.time || "09:00")
    : (!isAnnualItem && item.dateTime ? item.dateTime.slice(11, 16) : "09:00");
  const selectedAssigneeKeys = new Set((item.assignees || []).map((assignee) => assignee.key));
  form.querySelectorAll('input[name="assignees"]').forEach((checkbox) => {
    checkbox.checked = selectedAssigneeKeys.has(checkbox.value);
  });
  updateAssigneeSummary();
  form.recurrence.value = kind === "chore" ? item.recurrence || "once" : "once";
  form.choreEndDate.value = kind === "chore" ? item.endDate || "" : "";
  form.reminderDays.value = kind === "event" && ANNUAL_EVENT_TYPES.includes(item.type) ? String(item.reminderDays ?? 1) : "1";
  form.annualTime.value = isAnnualItem ? (item.dateTime?.slice(11, 16) || "09:00") : "09:00";
  const reminderAtValue = kind === "event" && item.type === "reminder"
    ? (item.reminderAt || item.dateTime || `${form.date.value}T${form.time.value}`)
    : "";
  form.reminderAtDate.value = reminderAtValue ? reminderAtValue.slice(0, 10) : "";
  form.reminderAtTime.value = reminderAtValue ? reminderAtValue.slice(11, 16) : "";
  form.reminderRecurrence.value = kind === "event" && item.type === "reminder" ? item.recurrence || "once" : "once";
  form.location.value = item.location || "";
  updateLocationDirectionsPreview();
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
  form.date.value = `${state.budget.month}-01`;
  form.time.value = "09:00";
  updateLocationDirectionsPreview();
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
  const plainReminderFields = form.querySelectorAll("[data-plain-reminder-field]");
  const locationField = form.querySelector("[data-location-field]");
  if (locationField) locationField.hidden = isAnnual;
  if (recurrenceField) recurrenceField.hidden = type !== "chore";
  // An end date only means something for a chore that actually repeats —
  // a one-time chore already stops after its single occurrence.
  if (endDateField) endDateField.hidden = type !== "chore" || form.recurrence.value === "once";
  if (reminderField) reminderField.hidden = !isAnnual;
  if (timeField) timeField.hidden = !isAnnual;
  plainReminderFields.forEach((field) => { field.hidden = type !== "reminder"; });
  // Default the reminder date/time to match the event's own date/time the
  // first time this field appears, so it's not empty — the user can then
  // move it earlier (or later) independent of when the event itself happens.
  if (type === "reminder" && !form.reminderAtDate.value) {
    form.reminderAtDate.value = form.date.value;
    form.reminderAtTime.value = form.time.value;
  }
  // Birthdays/anniversaries only need a plain calendar date, never a time of
  // day — asking for a year and time invites entering an actual birth year,
  // which used to make the reminder look permanently overdue (see
  // annualEventNotifyAt). The date field itself is always a plain
  // type="date" now (chores/reminders get their time from the separate
  // "time" field below it), so there's no more input-type switching here.
  const dateTimeField = form.querySelector("[data-date-time-field]");
  if (dateTimeField) dateTimeField.hidden = isAnnual;
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
  if (leftEl) leftEl.textContent = money.format(left);

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
  const matches = state.budget.categories
    .filter((category) => category.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));
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
      showToast(error.message);
      return;
    } finally {
      button.disabled = false;
    }
  }
  currentView = button.dataset.view;
  document.body.classList.remove("mobile-sidebar-open");
  render();
});

$("#mobileTabBar").addEventListener("click", (event) => {
  if (event.target.closest("#mobileMoreButton")) {
    document.body.classList.toggle("mobile-sidebar-open");
    return;
  }
  const button = event.target.closest("[data-view]");
  if (!button) return;
  currentView = button.dataset.view;
  document.body.classList.remove("mobile-sidebar-open");
  render();
});

$("#mobileSidebarBackdrop").addEventListener("click", () => {
  document.body.classList.remove("mobile-sidebar-open");
});

view.addEventListener("click", (event) => {
  const helpJumpButton = event.target.closest("[data-help-jump]");
  if (helpJumpButton) {
    scrollToHelpTopic(helpJumpButton.dataset.helpJump);
    return;
  }

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

  const assignIouButton = event.target.closest("[data-assign-iou]");
  if (assignIouButton) {
    openAssignIouDialog({ type: "draft", id: assignIouButton.dataset.assignIou });
    return;
  }

  const assignIouLedgerButton = event.target.closest("[data-assign-iou-ledger]");
  if (assignIouLedgerButton) {
    openAssignIouDialog({ type: "ledger", id: assignIouLedgerButton.dataset.assignIouLedger });
    return;
  }

  const moveToTransferButton = event.target.closest("[data-move-to-transfer]");
  if (moveToTransferButton) {
    openMoveToTransferDialog({ type: "draft", id: moveToTransferButton.dataset.moveToTransfer });
    return;
  }

  const moveToTransferLedgerButton = event.target.closest("[data-move-to-transfer-ledger]");
  if (moveToTransferLedgerButton) {
    openMoveToTransferDialog({ type: "ledger", id: moveToTransferLedgerButton.dataset.moveToTransferLedger });
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
    // Generalized rather than listing each menu by id, since an arbitrary
    // number of friend-picker combo-menus can exist at once (one per
    // dynamic split row) - hiding every open .combo-menu covers those plus
    // every existing fixed-id menu (subcategory, category, recipe, assignee).
    document.querySelectorAll(".combo-menu").forEach((menu) => { menu.hidden = true; });
  }
});

function acceptImportTransaction(button) {
  let inboxItem = transactionInboxItems().find((item) => item.id === button.dataset.acceptImport);

  if (!inboxItem && button.dataset.acceptImport?.includes(":")) {
    const [payee, amount] = button.dataset.acceptImport.split(":");
    inboxItem = { id: uniqueId(payee), payee, amount: Number(amount), date: new Date().toISOString().slice(0, 10) };
  }

  if (!inboxItem) return;
  if (!accountAllowsDate(inboxItem.accountId, inboxItem.date)) {
    transactionValidationFeedback = `${accountName(inboxItem.accountId)} is closed - "${inboxItem.payee}" is dated after its close date. Change the date, pick a different account, or dismiss it.`;
    render();
    return;
  }
  transactionValidationFeedback = "";
  // Never silently fall back to "whichever line sorts first alphabetically"
  // - that's indistinguishable from a real choice and was the exact
  // mechanism (paired with the Subcategory dropdown's own missing
  // placeholder) that made a since-fixed bug look worse than it was. A
  // truly-unassigned accept becomes a truly-unassigned ledger entry, which
  // the Insights "N unassigned transactions" nudge already surfaces.
  const lineId = inboxItem.lineId || "";
  const memo = inboxItem.recurringId ? "Recurring bill" : "Accepted bank stream item";
  state.transactions.unshift(makeTransaction({ date: inboxItem.date, payee: inboxItem.payee, amount: Number(inboxItem.amount), lineId, memo, accountId: inboxItem.accountId || "", orderNumber: inboxItem.orderNumber || "", tags: inboxItem.tags || [] }));
  state.transactionInboxDone ||= [];
  if (!state.transactionInboxDone.includes(inboxItem.id)) state.transactionInboxDone.push(inboxItem.id);
  state.transactionInboxDrafts = (state.transactionInboxDrafts || []).filter((item) => item.id !== inboxItem.id);
  state.household.activity.unshift(`Assigned ${inboxItem.payee} to ${transactionAssignmentLabel({ lineId })}`);
  // Recent transactions only ever shows the month currently being viewed
  // (see budget.month filtering), so an accepted item dated in a different
  // month would otherwise seem to vanish — jump to that month too, the same
  // way switching the month picker would, so it's visibly there right away.
  const acceptedMonth = inboxItem.date?.slice(0, 7);
  if (acceptedMonth && acceptedMonth !== state.budget.month) {
    switchBudgetMonth(acceptedMonth);
    ledgerAcceptFeedback = `Added "${inboxItem.payee}" and switched to ${formatMonth(acceptedMonth)} so you can see it in the ledger.`;
  } else {
    ledgerAcceptFeedback = "";
  }
  autosaveState();
  render();
}

function dismissImportTransaction(button) {
  const inboxItem = transactionInboxItems().find((item) => item.id === button.dataset.dismissImport);
  state.transactionInboxDone ||= [];
  if (!state.transactionInboxDone.includes(button.dataset.dismissImport)) state.transactionInboxDone.push(button.dataset.dismissImport);
  state.transactionInboxDrafts = (state.transactionInboxDrafts || []).filter((item) => item.id !== button.dataset.dismissImport);
  state.household.activity.unshift(`Dismissed bank stream item: ${inboxItem?.payee || button.dataset.dismissImport}`);
  autosaveState();
  render();
}

$("#signinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/auth/signin", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    await loadApp();
  } catch (error) {
    setAuthMessage(error.message);
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
    setAuthMessage("Password updated. Sign in with your new password.", true);
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
  setAuthMessage("");
  try {
    await api("/api/auth/demo", { method: "POST", body: "{}" });
    await loadApp();
  } catch (error) {
    setAuthMessage(error.message);
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
    setAuthMessage(error.message);
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
  $("#mobileTabBar").hidden = true;
  document.body.classList.remove("mobile-sidebar-open");
  showSigninForm();
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

$("#notificationBellButton").addEventListener("click", (event) => {
  event.stopPropagation();
  const dropdown = $("#notificationBellDropdown");
  dropdown.hidden = !dropdown.hidden;
});

$("#notificationBellDropdown").addEventListener("click", (event) => {
  const item = event.target.closest("[data-notification-bell-goto]");
  if (!item) return;
  currentView = item.dataset.notificationBellGoto;
  $("#notificationBellDropdown").hidden = true;
  render();
});

document.addEventListener("click", (event) => {
  if ($("#notificationBellDropdown").hidden) return;
  if (event.target.closest(".notification-bell-wrap")) return;
  $("#notificationBellDropdown").hidden = true;
});

function applyThemeButtonIcon() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const button = $("#themeToggleButton");
  if (button) button.textContent = isDark ? "☀️" : "🌙";
}
applyThemeButtonIcon();

$("#themeToggleButton").addEventListener("click", () => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const next = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("familyloop-theme", next);
  applyThemeButtonIcon();
});

function renderGlobalSearchResults() {
  const results = globalSearchResults($("#globalSearchInput").value);
  const query = $("#globalSearchInput").value.trim();
  $("#globalSearchResults").innerHTML = query.length < 2
    ? `<div class="empty-inline">Type at least 2 characters to search.</div>`
    : results.length
      ? results.map((result) => `
        <button type="button" class="global-search-result" data-global-search-goto="${result.view}">
          <span class="global-search-result-icon">${result.icon}</span>
          <span class="global-search-result-text"><strong>${escapeHtml(result.title)}</strong><small>${result.type} · ${escapeHtml(result.detail)}</small></span>
        </button>
      `).join("")
      : `<div class="empty-inline">No matches for "${escapeHtml(query)}".</div>`;
}

$("#onboardingWizardDialog").addEventListener("click", (event) => {
  if (event.target.closest("#closeOnboardingWizardButton") || event.target.closest("#onboardingSkipButton")) {
    dismissOnboarding();
    return;
  }
  if (event.target.closest("#onboardingBackButton")) {
    onboardingStep = Math.max(1, onboardingStep - 1);
    renderOnboardingWizard();
    return;
  }
  const gotoButton = event.target.closest("[data-onboarding-goto]");
  if (gotoButton) {
    if (onboardingStep < ONBOARDING_STEPS.length) {
      currentView = gotoButton.dataset.onboardingGoto;
      onboardingStep += 1;
      $("#onboardingWizardDialog").close();
      render();
    } else {
      dismissOnboarding();
      currentView = "home";
      render();
    }
  }
});

$("#globalSearchButton").addEventListener("click", () => {
  if (!documentsData) loadDocumentsData(false);
  $("#globalSearchInput").value = "";
  renderGlobalSearchResults();
  $("#globalSearchDialog").showModal();
  $("#globalSearchInput").focus();
});

$("#closeGlobalSearchDialogButton").addEventListener("click", () => $("#globalSearchDialog").close());

$("#globalSearchInput").addEventListener("input", renderGlobalSearchResults);

$("#globalSearchResults").addEventListener("click", (event) => {
  const button = event.target.closest("[data-global-search-goto]");
  if (!button) return;
  currentView = button.dataset.globalSearchGoto;
  $("#globalSearchDialog").close();
  render();
});

$("#monthPicker").addEventListener("change", (event) => {
  switchBudgetMonth(event.target.value);
  autosaveState();
  render();
});

$("#mealWeekHeaderSelect").addEventListener("change", (event) => {
  state.meals.selectedWeekByMonth ||= {};
  state.meals.selectedWeekByMonth[state.budget.month] = Number(event.target.value);
  autosaveState();
  render();
});

$("#householdPicker").addEventListener("change", async (event) => {
  const picker = event.currentTarget;
  const message = $("#householdWorkspaceMessage");
  const previousValue = households.find((household) => household.selected)?.id || "";
  if (message) message.textContent = "";
  picker.disabled = true;
  householdSwitchInProgress = true;
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
    householdSwitchInProgress = false;
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

$("#brandHomeButton").addEventListener("click", () => {
  currentView = "home";
  render();
});

$("#showPublicHelpButton").addEventListener("click", showPublicHelp);

$("#publicHelpPanel").addEventListener("click", (event) => {
  const helpJumpButton = event.target.closest("[data-help-jump]");
  if (helpJumpButton) scrollToHelpTopic(helpJumpButton.dataset.helpJump);
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

$("#confirmDialogOkButton").addEventListener("click", () => {
  const dialog = $("#confirmDialog");
  dialog.returnValue = "confirmed";
  dialog.close();
});
$("#confirmDialogCancelButton").addEventListener("click", () => {
  const dialog = $("#confirmDialog");
  dialog.returnValue = "cancelled";
  dialog.close();
});

function closeDeleteBudgetLineDialog() {
  pendingBudgetLineDeletion = null;
  $("#deleteBudgetLineDialog").close();
}
$("#closeDeleteBudgetLineDialogButton").addEventListener("click", closeDeleteBudgetLineDialog);
$("#cancelDeleteBudgetLineButton").addEventListener("click", closeDeleteBudgetLineDialog);
$("#confirmDeleteBudgetLineButton").addEventListener("click", () => {
  if (!pendingBudgetLineDeletion) return;
  const { lineIds, perform } = pendingBudgetLineDeletion;
  const targetLineId = $("#deleteBudgetLineReassignSelect")?.value || "";
  const impact = budgetDeletionImpact(lineIds);
  if (targetLineId) {
    const targetLine = allLines().find((line) => line.id === targetLineId);
    impact.transactions.forEach((transaction) => {
      transaction.lineId = targetLineId;
      transaction.categoryName = targetLine?.category || transaction.categoryName;
      transaction.subcategoryName = targetLine?.name || transaction.subcategoryName;
    });
    impact.recurringExpenses.forEach((recurring) => { recurring.lineId = targetLineId; });
    impact.debts.forEach((debt) => { debt.lineId = targetLineId; });
    impact.drafts.forEach((draft) => { draft.lineId = targetLineId; });
    const lineIdSet = new Set(lineIds);
    impact.paychecks.forEach((paycheck) => {
      paycheck.assignedLineIds = paycheck.assignedLineIds.filter((id) => !lineIdSet.has(id));
      if (!paycheck.assignedLineIds.includes(targetLineId)) paycheck.assignedLineIds.push(targetLineId);
    });
    if (impact.plannedAmount > 0) {
      // allLines() is a flattened copy (safe to read category/name from, but
      // not to mutate) - the real, persistable line lives in
      // state.budget.categories, found via findLineById instead.
      const realTargetLine = findLineById(targetLineId);
      if (realTargetLine) realTargetLine.planned = Number(realTargetLine.planned || 0) + impact.plannedAmount;
    }
  } else {
    lineIds.forEach((lineId) => {
      const line = allLines().find((item) => item.id === lineId);
      if (line) snapshotTransactionsForLine(line);
    });
  }
  perform();
  pendingBudgetLineDeletion = null;
  $("#deleteBudgetLineDialog").close();
  autosaveState();
  render();
});

function closeAccountActionConfirmDialog() {
  const pending = pendingAccountAction;
  pendingAccountAction = null;
  $("#accountActionConfirmDialog").close();
  pending?.onCancel?.();
}
$("#closeAccountActionConfirmDialogButton").addEventListener("click", closeAccountActionConfirmDialog);
$("#cancelAccountActionConfirmButton").addEventListener("click", closeAccountActionConfirmDialog);
$("#confirmAccountActionConfirmButton").addEventListener("click", () => {
  if (!pendingAccountAction) return;
  const { onConfirm } = pendingAccountAction;
  const targetAccountId = $("#accountActionReassignSelect")?.value || "";
  pendingAccountAction = null;
  $("#accountActionConfirmDialog").close();
  onConfirm(targetAccountId);
});

function updateExportReportScopeFields() {
  const form = $("#exportReportForm");
  if (!form) return;
  const section = form.section.value;
  const isSnapshot = REPORT_SECTIONS[section]?.periodicity === "snapshot";
  $("#exportReportScopeField").hidden = isSnapshot;
  const scopeType = form.scopeType.value;
  form.querySelectorAll("[data-export-scope]").forEach((field) => {
    field.hidden = field.dataset.exportScope !== scopeType;
  });
}

function openExportReportDialog(defaultSection) {
  const form = $("#exportReportForm");
  const sectionSelect = $("#exportReportSection");
  sectionSelect.innerHTML = Object.entries(REPORT_SECTIONS).map(([key, meta]) => `<option value="${key}">${escapeHtml(meta.label)}</option>`).join("");
  sectionSelect.value = REPORT_SECTIONS[defaultSection] ? defaultSection : "budget";
  // Opening the dialog from Reports itself defaults to whatever scope the
  // page is already showing, so the export and the on-screen view never
  // drift apart - every other page just defaults to the current month.
  const defaultScope = defaultSection === "reports" ? currentReportsScope() : { type: "month", month: state.budget.month };
  form.scopeType.value = defaultScope.type;
  form.month.value = defaultScope.type === "month" ? defaultScope.month : state.budget.month;
  form.rangeStart.value = defaultScope.type === "range" ? defaultScope.start : `${state.budget.month}-01`;
  form.rangeEnd.value = defaultScope.type === "range" ? defaultScope.end : monthEndDateKey(state.budget.month);
  form.year.value = defaultScope.type === "year" ? defaultScope.year : state.budget.month.slice(0, 4);
  $("#exportReportMessage").textContent = "";
  updateExportReportScopeFields();
  $("#exportReportDialog").showModal();
}

$("#downloadCsvButton").addEventListener("click", () => {
  openExportReportDialog(currentView);
});

$("#closeExportReportDialogButton").addEventListener("click", () => $("#exportReportDialog").close());
$("#cancelExportReportButton").addEventListener("click", () => $("#exportReportDialog").close());
$("#exportReportSection").addEventListener("change", updateExportReportScopeFields);
$("#exportReportScopeType").addEventListener("change", updateExportReportScopeFields);

$("#exportReportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const section = data.section;
  let scope;
  if (REPORT_SECTIONS[section]?.periodicity === "snapshot") {
    scope = { type: "month", month: state.budget.month };
  } else if (data.scopeType === "range") {
    if (!data.rangeStart || !data.rangeEnd || data.rangeStart > data.rangeEnd) {
      $("#exportReportMessage").textContent = "Pick a valid start and end date.";
      return;
    }
    scope = { type: "range", start: data.rangeStart, end: data.rangeEnd };
  } else if (data.scopeType === "year") {
    scope = { type: "year", year: data.year || state.budget.month.slice(0, 4) };
  } else {
    scope = { type: "month", month: data.month || state.budget.month };
  }

  const submitButton = $("#submitExportReportButton");
  submitButton.disabled = true;
  const originalLabel = submitButton.textContent;
  submitButton.textContent = "Generating…";
  $("#exportReportMessage").textContent = "";
  try {
    const spec = buildWorkbookSpec({ section, scope });
    if (spec.chartData) await attachReportChartImages(spec.sheets, spec.chartData);
    const response = await fetch("/api/reports/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ fileName: spec.fileName, sheets: spec.sheets })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "Could not build the report");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = spec.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    $("#exportReportDialog").close();
  } catch (error) {
    $("#exportReportMessage").textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalLabel;
  }
});

// Every field in this modal writes straight to the matching asset in
// state.goals.netWorth.assets (autosaved on each change), the same live-edit
// convention the rest of Wealth already uses - there's no staged draft to
// submit, so the modal has no form/submit handler, just a "Done" button
// that closes it. A row with no id yet can't exist (every row IS an asset,
// even mid-composition with a blank symbol) - the "close" handler below
// purges any still-blank rows so an abandoned add never leaves debris.
function holdingsModalItems() {
  if (!currentHoldingsModalGroupId) return [];
  return state.goals.netWorth.assets.filter((asset) => isHoldingAssetClass(asset.assetClass) && asset.groupId === currentHoldingsModalGroupId);
}

function updateHoldingsModalTotal() {
  const totalEl = $("#holdingsModalTotal");
  if (!totalEl) return;
  const total = holdingsModalItems().reduce((sum, item) => sum + assetValue(item), 0);
  totalEl.textContent = money.format(total);
}

function holdingGainLossMarkup(item) {
  const gain = holdingGainLoss(item);
  if (!gain.hasCostBasis) return { className: "holdings-modal-gain-loss", text: "—" };
  const className = `holdings-modal-gain-loss ${gain.amount < 0 ? "loss" : "gain"}`;
  const text = `${gain.amount >= 0 ? "+" : ""}${money.format(gain.amount)} (${gain.percent >= 0 ? "+" : ""}${gain.percent.toFixed(1)}%)`;
  return { className, text };
}

function recomputeHoldingsModalRow(assetId) {
  const asset = state.goals.netWorth.assets.find((item) => item.id === assetId);
  if (!asset) return;
  asset.value = assetValue(asset);
  const marketValueEl = document.querySelector(`[data-holding-market-value="${assetId}"]`);
  if (marketValueEl && marketValueEl !== document.activeElement) marketValueEl.value = asset.value.toFixed(2);
  const gainEl = document.querySelector(`[data-holding-gain-loss="${assetId}"]`);
  if (gainEl) {
    const gain = holdingGainLossMarkup(asset);
    gainEl.className = gain.className;
    gainEl.textContent = gain.text;
  }
  autosaveState();
  updateHoldingsModalTotal();
}

function holdingsModalRowHtml(item) {
  const feedback = stockPriceFeedback[item.id];
  const gain = holdingGainLossMarkup(item);
  return `<div class="holdings-modal-row" data-holding-row="${item.id}">
    <input value="${escapeHtml(item.symbol || "")}" placeholder="e.g. AAPL" data-holding-symbol="${item.id}" aria-label="Symbol">
    <select data-holding-type="${item.id}" aria-label="Asset class">
      <option value="stock" ${item.holdingType !== "fund" ? "selected" : ""}>Stock</option>
      <option value="fund" ${item.holdingType === "fund" ? "selected" : ""}>Mutual Fund</option>
    </select>
    <input type="number" min="0" step="0.0001" inputmode="decimal" value="${item.shares || 0}" data-holding-shares="${item.id}" aria-label="Shares">
    <input type="number" min="0" step="0.01" inputmode="decimal" value="${item.costBasis || 0}" data-holding-cost-basis="${item.id}" aria-label="Average share price paid" placeholder="Avg. cost">
    <div class="holdings-modal-price-cell">
      <div class="holdings-modal-price-row">
        <input type="number" min="0" step="0.01" inputmode="decimal" value="${item.price || 0}" data-holding-price="${item.id}" aria-label="Price per share">
        <button type="button" class="holdings-modal-refresh-button" data-holding-refresh="${item.id}" title="Refresh live price" aria-label="Refresh live price for ${escapeHtml(item.symbol || "this holding")}">⟳</button>
      </div>
      <small class="${feedback?.isError ? "stock-price-error" : ""}">${feedback ? feedback.message : "Not refreshed yet"}</small>
    </div>
    <input type="number" min="0" step="0.01" inputmode="decimal" class="holdings-modal-market-value-input" value="${assetValue(item).toFixed(2)}" data-holding-market-value="${item.id}" aria-label="Market value" title="Type a dollar amount directly for holdings with no live-priceable ticker (e.g. a 401(k) fund) - shares/price adjust to match">
    <div class="${gain.className}" data-holding-gain-loss="${item.id}">${gain.text}</div>
    <button type="button" class="holdings-modal-remove" data-holding-remove="${item.id}" aria-label="Remove ${escapeHtml(item.symbol || "this holding")}">×</button>
  </div>`;
}

function wireHoldingsModalRowEvents() {
  const container = $("#holdingsModalRows");
  if (!container) return;
  const findAsset = (id) => state.goals.netWorth.assets.find((item) => item.id === id);

  container.querySelectorAll("[data-holding-symbol]").forEach((input) => {
    input.addEventListener("input", () => {
      const asset = findAsset(input.dataset.holdingSymbol);
      if (!asset) return;
      asset.symbol = input.value.toUpperCase();
      const accountName = $("#holdingsModalAccountName").value.trim();
      asset.name = accountName ? `${accountName} - ${asset.symbol}` : asset.symbol;
      autosaveState();
    });
  });
  container.querySelectorAll("[data-holding-type]").forEach((select) => {
    select.addEventListener("change", () => {
      const asset = findAsset(select.dataset.holdingType);
      if (!asset) return;
      asset.holdingType = select.value;
      autosaveState();
    });
  });
  container.querySelectorAll("[data-holding-shares]").forEach((input) => {
    input.addEventListener("input", () => {
      const asset = findAsset(input.dataset.holdingShares);
      if (!asset) return;
      asset.shares = Math.max(0, Number(input.value || 0));
      recomputeHoldingsModalRow(asset.id);
    });
  });
  container.querySelectorAll("[data-holding-cost-basis]").forEach((input) => {
    input.addEventListener("input", () => {
      const asset = findAsset(input.dataset.holdingCostBasis);
      if (!asset) return;
      asset.costBasis = Math.max(0, Number(input.value || 0));
      recomputeHoldingsModalRow(asset.id);
    });
  });
  container.querySelectorAll("[data-holding-price]").forEach((input) => {
    input.addEventListener("input", () => {
      const asset = findAsset(input.dataset.holdingPrice);
      if (!asset) return;
      asset.price = Math.max(0, Number(input.value || 0));
      recomputeHoldingsModalRow(asset.id);
    });
  });
  // Lets a holding with no real live-priceable ticker (a proprietary 401(k)
  // fund, for instance) get its dollar value entered directly, since shares
  // x price - the only other way assetValue() computes a stock-class item's
  // value - isn't always something the household actually knows. Shares
  // default to 1 if unset so price = the entered value outright; if shares
  // is already set, price is back-derived (value / shares) so a later share-
  // count correction still scales the value sensibly instead of orphaning it.
  container.querySelectorAll("[data-holding-market-value]").forEach((input) => {
    input.addEventListener("input", () => {
      const asset = findAsset(input.dataset.holdingMarketValue);
      if (!asset) return;
      const value = Math.max(0, Number(input.value || 0));
      if (!asset.shares) {
        asset.shares = 1;
        const sharesInput = document.querySelector(`[data-holding-shares="${asset.id}"]`);
        if (sharesInput) sharesInput.value = asset.shares;
      }
      asset.price = value / asset.shares;
      asset.value = value;
      const priceInput = document.querySelector(`[data-holding-price="${asset.id}"]`);
      if (priceInput) priceInput.value = asset.price.toFixed(2);
      const gainEl = document.querySelector(`[data-holding-gain-loss="${asset.id}"]`);
      if (gainEl) {
        const gain = holdingGainLossMarkup(asset);
        gainEl.className = gain.className;
        gainEl.textContent = gain.text;
      }
      autosaveState();
      updateHoldingsModalTotal();
    });
  });
  container.querySelectorAll("[data-holding-refresh]").forEach((button) => {
    button.addEventListener("click", async () => {
      const asset = findAsset(button.dataset.holdingRefresh);
      if (!asset) return;
      const symbol = (asset.symbol || "").trim().toUpperCase();
      if (!symbol) {
        stockPriceFeedback[asset.id] = { message: "Enter a symbol first.", isError: true };
        renderHoldingsModalRows();
        return;
      }
      button.disabled = true;
      try {
        const result = await api(`/api/stock-quote?symbol=${encodeURIComponent(symbol)}`);
        asset.price = result.price;
        asset.value = assetValue(asset);
        stockPriceFeedback[asset.id] = { message: `Updated to ${money.format(result.price)}`, isError: false };
      } catch (error) {
        stockPriceFeedback[asset.id] = { message: error.message, isError: true };
      }
      autosaveState();
      renderHoldingsModalRows();
      updateHoldingsModalTotal();
    });
  });
  container.querySelectorAll("[data-holding-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.holdingRemove;
      state.goals.netWorth.assets = state.goals.netWorth.assets.filter((item) => item.id !== id);
      delete stockPriceFeedback[id];
      autosaveState();
      renderHoldingsModalRows();
      updateHoldingsModalTotal();
    });
  });
}

function renderHoldingsModalRows() {
  const container = $("#holdingsModalRows");
  if (!container) return;
  container.innerHTML = holdingsModalItems().map((item) => holdingsModalRowHtml(item)).join("");
  wireHoldingsModalRowEvents();
}

function openHoldingsModal(groupId) {
  const items = state.goals.netWorth.assets.filter((asset) => isHoldingAssetClass(asset.assetClass) && (asset.groupId || asset.id) === groupId);
  if (!items.length) return;
  // A legacy solo holding (no groupId of its own) is adopted into a real
  // group as soon as it's opened here, so every subsequent lookup by
  // groupId - including this same modal's own rows - works uniformly.
  items.forEach((item) => { item.groupId = groupId; });
  currentHoldingsModalGroupId = groupId;
  $("#holdingsModalAccountName").value = items[0].groupName || items[0].name || "";
  $("#holdingsModalAssetClass").value = items[0].assetClass || "stock";
  renderHoldingsModalRows();
  updateHoldingsModalTotal();
  $("#holdingsModalMessage").textContent = "";
  $("#holdingsModalDialog").showModal();
}

$("#holdingsModalAccountName").addEventListener("input", (event) => {
  const name = event.target.value;
  holdingsModalItems().forEach((asset) => {
    asset.groupName = name;
    asset.name = asset.symbol ? `${name} - ${asset.symbol}` : name;
  });
  autosaveState();
});

// Moving an account off Stock/Retirement drops every one of its holdings
// out of isHoldingAssetClass, so this is the only place a misclassified
// account (a bank account someone picked Stock for by mistake) can ever
// become a normal Cash/Property/Other row again - there's no such control
// on the read-only group card itself. Snapshotting shares * price into
// .value before flipping the class is what keeps the dollar amount from
// reading as $0 the moment it lands on the flat row, since that row only
// ever reads .value, never shares/price.
$("#holdingsModalAssetClass").addEventListener("change", (event) => {
  if (!currentHoldingsModalGroupId) return;
  const newClass = event.target.value;
  const leavingHoldings = !isHoldingAssetClass(newClass);
  holdingsModalItems().forEach((asset) => {
    if (leavingHoldings) asset.value = assetValue(asset);
    asset.assetClass = newClass;
  });
  autosaveState();
  if (leavingHoldings) {
    $("#holdingsModalDialog").close();
  } else {
    renderHoldingsModalRows();
    updateHoldingsModalTotal();
  }
});

$("#addHoldingsModalRowButton").addEventListener("click", () => {
  if (!currentHoldingsModalGroupId) return;
  const accountName = $("#holdingsModalAccountName").value.trim();
  const existingClass = holdingsModalItems()[0]?.assetClass || "stock";
  const asset = {
    id: uniqueId(`${currentHoldingsModalGroupId}-${Date.now()}`), name: accountName, value: 0,
    assetClass: existingClass, symbol: "", holdingType: "stock", shares: 0, price: 0, costBasis: 0,
    groupId: currentHoldingsModalGroupId, groupName: accountName
  };
  state.goals.netWorth.assets.push(asset);
  autosaveState();
  renderHoldingsModalRows();
  updateHoldingsModalTotal();
});

$("#holdingsModalRefreshAllButton").addEventListener("click", async (event) => {
  if (!currentHoldingsModalGroupId) return;
  const button = event.currentTarget;
  const items = holdingsModalItems();
  button.disabled = true;
  await Promise.all(items.map(async (asset) => {
    const symbol = (asset.symbol || "").trim().toUpperCase();
    if (!symbol) return;
    try {
      const result = await api(`/api/stock-quote?symbol=${encodeURIComponent(symbol)}`);
      asset.price = result.price;
      asset.value = assetValue(asset);
      stockPriceFeedback[asset.id] = { message: `Updated to ${money.format(result.price)}`, isError: false };
    } catch (error) {
      stockPriceFeedback[asset.id] = { message: error.message, isError: true };
    }
  }));
  markStockGroupRefreshed(currentHoldingsModalGroupId);
  autosaveState();
  renderHoldingsModalRows();
  updateHoldingsModalTotal();
  button.disabled = false;
});

$("#closeHoldingsModalButton").addEventListener("click", () => $("#holdingsModalDialog").close());
$("#holdingsModalDoneButton").addEventListener("click", () => $("#holdingsModalDialog").close());

// Fires for every close path (Done, ×, Esc) - purges any row still mid-
// composition (blank symbol AND no value entered, never finished) so an
// abandoned "+ Add holding"-then-convert-to-Stock or a cleared-out row
// never leaves an empty asset behind. A blank symbol alone isn't enough to
// call a row abandoned now that Market value can be typed directly for a
// holding with no real ticker (a 401(k) fund, say) - assetValue(asset) > 0
// covers that path too, since typing a market value always leaves shares
// >= 1 and a derived price behind.
$("#holdingsModalDialog").addEventListener("close", () => {
  if (!currentHoldingsModalGroupId) return;
  const groupId = currentHoldingsModalGroupId;
  state.goals.netWorth.assets = state.goals.netWorth.assets.filter((asset) => {
    const inThisGroup = isHoldingAssetClass(asset.assetClass) && asset.groupId === groupId;
    return !inThisGroup || (asset.symbol || "").trim() || assetValue(asset) > 0;
  });
  currentHoldingsModalGroupId = null;
  autosaveState();
  render();
});

let assignIouDraftTotal = 0;
let iouSplitRows = [];
let assignIouSplitType = "exact";
// Same idea as splitBillYou (see recomputeSplitBillRows) - your own row in
// this dialog, shown alongside the friend rows instead of only ever being
// whatever's left over, so it can be set directly (including to 0, to fully
// exclude yourself from the transaction).
let assignIouYou = { amount: 0, percent: 0, shares: 1 };

function assignIouYourShareValue() {
  if (assignIouSplitType === "percentage") return assignIouYou.percent;
  if (assignIouSplitType === "shares") return assignIouYou.shares;
  if (assignIouSplitType === "exact") return assignIouYou.amount;
  return undefined;
}

// Recomputes friend row amounts (equal/percentage/shares modes derive them,
// exact just reads what's typed) and the "Your share" display from
// computeBillSplitAmounts' own payerAmount, so the two always reconcile to
// the cent regardless of mode - never independently re-summed.
function recomputeAssignIouSplits() {
  const result = computeBillSplitAmounts(assignIouSplitType, assignIouDraftTotal, iouSplitRows, assignIouYourShareValue());
  const remainderEl = $("#assignIouRemainder");
  const messageEl = $("#assignIouMessage");
  if (!result.ok) {
    if (messageEl) messageEl.textContent = result.error;
    if (remainderEl) remainderEl.textContent = exactMoney.format(0);
    return;
  }
  if (messageEl) messageEl.textContent = "";
  if (assignIouSplitType !== "exact") {
    iouSplitRows.forEach((row, index) => {
      row.amount = result.friendAmounts[index];
      const input = document.querySelector(`#assignIouSplitRows [data-iou-split-amount="${index}"]`);
      if (input) input.value = row.amount;
    });
  }
  if (assignIouSplitType === "equal") {
    assignIouYou.amount = result.payerAmount;
    const youInput = document.querySelector(`#assignIouSplitRows [data-iou-split-you-amount]`);
    if (youInput) youInput.value = result.payerAmount;
  }
  if (remainderEl) {
    remainderEl.textContent = exactMoney.format(result.payerAmount);
    remainderEl.classList.toggle("danger", result.payerAmount < 0);
  }
}

function renderIouSplitRows() {
  const container = $("#assignIouSplitRows");
  const youField = assignIouSplitType === "percentage"
    ? `<input type="number" step="0.01" min="0" max="100" placeholder="%" value="${assignIouYou.percent || ""}" data-iou-split-you-percent>`
    : assignIouSplitType === "shares"
      ? `<input type="number" step="1" min="0" placeholder="Parts" value="${assignIouYou.shares || ""}" data-iou-split-you-shares>`
      : `<input type="number" step="0.01" min="0" placeholder="Amount" value="${assignIouYou.amount || ""}" data-iou-split-you-amount ${assignIouSplitType === "equal" ? "readonly" : ""}>`;
  container.innerHTML = `
    <div class="iou-split-row iou-split-you-row">
      <div class="iou-split-you-label">You</div>
      ${youField}
    </div>
  ` + iouSplitRows.map((row, index) => `
    <div class="iou-split-row">
      ${friendRowFieldsHtml(index, row)}
      ${assignIouSplitType === "percentage"
        ? `<input type="number" step="0.01" min="0" max="100" placeholder="%" value="${row.percent || ""}" data-iou-split-percent="${index}">`
        : assignIouSplitType === "shares"
          ? `<input type="number" step="1" min="0" placeholder="Parts" value="${row.shares || ""}" data-iou-split-shares="${index}">`
          : `<input type="number" step="0.01" min="0.01" placeholder="Amount" value="${row.amount || ""}" data-iou-split-amount="${index}" ${assignIouSplitType === "equal" ? "readonly" : ""}>`}
      <button type="button" class="icon-button ghost" data-remove-iou-split-row="${index}" aria-label="Remove person">×</button>
    </div>
  `).join("");
  iouSplitRows.forEach((row, index) => wireFriendRow(container, index, iouSplitRows));
  container.querySelectorAll("[data-iou-split-amount]").forEach((input) => {
    input.addEventListener("input", () => {
      iouSplitRows[Number(input.dataset.iouSplitAmount)].amount = Number(input.value);
      recomputeAssignIouSplits();
    });
  });
  container.querySelectorAll("[data-iou-split-percent]").forEach((input) => {
    input.addEventListener("input", () => {
      iouSplitRows[Number(input.dataset.iouSplitPercent)].percent = Number(input.value);
      recomputeAssignIouSplits();
    });
  });
  container.querySelectorAll("[data-iou-split-shares]").forEach((input) => {
    input.addEventListener("input", () => {
      iouSplitRows[Number(input.dataset.iouSplitShares)].shares = Number(input.value);
      recomputeAssignIouSplits();
    });
  });
  container.querySelector("[data-iou-split-you-amount]")?.addEventListener("input", (event) => {
    assignIouYou.amount = Number(event.currentTarget.value);
    recomputeAssignIouSplits();
  });
  container.querySelector("[data-iou-split-you-percent]")?.addEventListener("input", (event) => {
    assignIouYou.percent = Number(event.currentTarget.value);
    recomputeAssignIouSplits();
  });
  container.querySelector("[data-iou-split-you-shares]")?.addEventListener("input", (event) => {
    assignIouYou.shares = Number(event.currentTarget.value);
    recomputeAssignIouSplits();
  });
  container.querySelectorAll("[data-remove-iou-split-row]").forEach((button) => {
    button.addEventListener("click", () => {
      iouSplitRows.splice(Number(button.dataset.removeIouSplitRow), 1);
      renderIouSplitRows();
    });
  });
  recomputeAssignIouSplits();
}

// Assign-to-IOU works from two different sources: an unaccepted Bank Stream
// draft, or a transaction already sitting in the Ledger - resolving by
// source type here keeps the dialog/submit logic below written once,
// against whichever record type it's actually holding.
function resolveIouSource(source) {
  if (!source) return null;
  if (source.type === "ledger") {
    // Ledger transactions have no id field (makeTransaction doesn't assign
    // one - the whole Ledger UI already addresses them by array index, e.g.
    // data-delete-transaction/data-ledger-entry-amount), so "id" here is
    // really the index into state.transactions.
    return state.transactions[Number(source.id)] || null;
  }
  return transactionInboxItems().find((item) => item.id === source.id) || null;
}

function openAssignIouDialog(source) {
  const record = resolveIouSource(source);
  if (!record) return;
  pendingIouSource = source;
  assignIouDraftTotal = Math.abs(Number(record.amount || 0));
  assignIouSplitType = "exact";
  const form = $("#assignIouForm");
  form.reset();
  form.reason.value = record.payee || "";
  form.date.value = record.date || dateKey(new Date());
  $("#assignIouSplitType").value = "exact";
  $("#assignIouTotal").textContent = exactMoney.format(assignIouDraftTotal);
  // Default to an even 2-way split (you + one friend), like Splitwise's
  // default - the user can edit the amount or add more people from here.
  // assignIouYou starts at the same 50/50 balance as the friend row below,
  // so "exact" mode (the default split type here) opens already balanced
  // instead of showing a "doesn't add up" error before anyone's typed
  // anything.
  const halfShare = Math.round((assignIouDraftTotal / 2) * 100) / 100;
  iouSplitRows = [{ person: "", amount: halfShare, percent: 50, shares: 1, email: "", friendId: "" }];
  assignIouYou = { amount: assignIouDraftTotal - halfShare, percent: 50, shares: 1 };
  renderIouSplitRows();
  $("#assignIouMessage").textContent = "";
  $("#assignIouDialog").showModal();
}

$("#closeAssignIouDialogButton").addEventListener("click", () => $("#assignIouDialog").close());
$("#cancelAssignIouButton").addEventListener("click", () => $("#assignIouDialog").close());
$("#assignIouSplitType").addEventListener("change", (event) => {
  assignIouSplitType = event.currentTarget.value;
  renderIouSplitRows();
});
$("#addIouSplitRowButton").addEventListener("click", () => {
  iouSplitRows.push({ person: "", amount: 0, percent: 0, shares: 1, email: "", friendId: "" });
  renderIouSplitRows();
});

$("#assignIouForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const source = pendingIouSource;
  const record = resolveIouSource(source);
  if (!record) {
    $("#assignIouMessage").textContent = source?.type === "ledger" ? "This transaction is no longer in the Ledger." : "This item is no longer in Bank stream.";
    return;
  }
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const splits = iouSplitRows
    .map((row) => ({ person: String(row.person || "").trim(), amount: Number(row.amount), email: String(row.email || "").trim() }))
    .filter((row) => row.person && row.amount > 0);
  if (!splits.length) {
    $("#assignIouMessage").textContent = "Enter at least one friend's name and a positive amount.";
    return;
  }
  const total = assignIouDraftTotal;
  const splitTotal = splits.reduce((sum, row) => sum + row.amount, 0);
  if (splitTotal > total + 0.005) {
    $("#assignIouMessage").textContent = `Splits add up to ${exactMoney.format(splitTotal)}, more than the ${exactMoney.format(total)} total.`;
    return;
  }

  const recordAccountId = record.accountId || "";
  const originalAmount = Number(record.amount);
  const sign = originalAmount < 0 ? -1 : 1;
  const rawYourShare = Math.round((total - splitTotal) * 100) / 100;
  // Friends' splits can fully cover the bill, leaving nothing for you to
  // keep as your own expense - a $0 ledger entry in that case would have no
  // effect on the budget and just sit there as clutter, so this drops the
  // draft/transaction entirely instead of accepting/keeping a zero-amount
  // one. The IOUs pushed below already carry a copy of what it was for
  // (reason/date), so nothing is lost by not keeping a $0 ledger row too.
  const fullySplit = rawYourShare <= 0.005;
  const yourShare = fullySplit ? 0 : rawYourShare;

  if (source.type === "draft") {
    if (fullySplit) {
      state.transactionInboxDrafts = (state.transactionInboxDrafts || []).filter((item) => item.id !== source.id);
      state.transactionInboxDone ||= [];
      if (!state.transactionInboxDone.includes(source.id)) state.transactionInboxDone.push(source.id);
      state.household.activity.unshift(`Split ${record.payee} entirely with friends - nothing left to add to the Ledger`);
    } else {
      // Only your remaining share (after everyone else's split) is accepted
      // as your own expense - mutate the draft's amount in place before
      // accepting so the real ledger transaction reflects just your portion.
      record.amount = sign * yourShare;
      acceptImportTransaction({ dataset: { acceptImport: source.id } });
      const stillPending = (state.transactionInboxDrafts || []).some((item) => item.id === source.id);
      if (stillPending) {
        // acceptImportTransaction bailed out (e.g. the linked account is
        // closed as of this date) and already surfaced its own message above
        // the Ledger - restore the original amount and don't create an
        // orphan IOU for a transaction that was never actually accepted.
        record.amount = originalAmount;
        $("#assignIouMessage").textContent = "Could not accept this item - see the message above the Ledger, then try again.";
        return;
      }
    }
  } else if (fullySplit) {
    const index = Number(source.id);
    if (index >= 0) state.transactions.splice(index, 1);
    state.household.activity.unshift(`Split ${record.payee} entirely with friends - removed from the Ledger`);
  } else {
    // Already an accepted Ledger transaction - no accept step needed, just
    // reduce it to your remaining share directly (the plain Ledger amount
    // input already lets any accepted transaction's amount be edited freely,
    // with no account/date gate, so this is consistent with that).
    record.amount = sign * yourShare;
  }

  for (const split of splits) {
    await inviteFriendIfNew(split.person, split.email);
  }

  state.ious ||= [];
  splits.forEach((split) => {
    state.ious.push({
      id: uniqueId("iou"),
      person: split.person,
      amount: split.amount,
      direction: "owed_to_me",
      reason: String(data.reason || "").trim(),
      date: data.date || record.date,
      accountId: recordAccountId,
      settled: false,
      settledDate: ""
    });
  });
  autosaveState();
  pendingIouSource = null;
  $("#assignIouDialog").close();
  render();
});

// Move-to-Transfer works from the same two sources as Assign-to-IOU (an
// unaccepted Bank Stream draft, or a transaction already sitting in the
// Ledger) - same {type, id} shape, same resolution idiom as
// resolveIouSource, kept as its own function since the two features are
// unrelated and shouldn't share a resolver that later needs to special-case
// one or the other.
function resolveTransferMoveSource(source) {
  if (!source) return null;
  if (source.type === "ledger") return state.transactions[Number(source.id)] || null;
  return transactionInboxItems().find((item) => item.id === source.id) || null;
}

function openMoveToTransferDialog(source) {
  const record = resolveTransferMoveSource(source);
  if (!record) return;
  if (!record.accountId) {
    transactionValidationFeedback = `Set an account on "${record.payee}" before moving it to Transfers - a transfer needs to know which account the money left or landed in.`;
    render();
    return;
  }
  transactionValidationFeedback = "";
  pendingTransferMoveSource = source;
  const otherRecords = [
    ...state.transactions.filter((transaction) => transaction !== record),
    ...(state.transactionInboxDrafts || []).filter((item) => item.id !== record.id)
  ];
  const match = findTransferCandidate(record, otherRecords);
  const movingOut = Number(record.amount) > 0;
  const form = $("#moveToTransferForm");
  form.reset();
  $("#moveToTransferCounterpartLabel").textContent = movingOut ? "Money went to" : "Money came from";
  $("#moveToTransferPayee").textContent = record.payee || "";
  $("#moveToTransferAmount").textContent = exactMoney.format(Math.abs(Number(record.amount || 0)));
  form.counterpartAccountId.innerHTML = `<option value="">Choose an account</option>${accountOptions(match ? match.accountId : "")}`;
  form.memo.value = record.payee || "";
  $("#moveToTransferMessage").textContent = "";
  $("#moveToTransferDialog").showModal();
}

$("#closeMoveToTransferDialogButton").addEventListener("click", () => $("#moveToTransferDialog").close());
$("#cancelMoveToTransferButton").addEventListener("click", () => $("#moveToTransferDialog").close());

$("#moveToTransferForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const source = pendingTransferMoveSource;
  const record = resolveTransferMoveSource(source);
  if (!record) {
    $("#moveToTransferMessage").textContent = source?.type === "ledger" ? "This transaction is no longer in the Ledger." : "This item is no longer in Bank stream.";
    return;
  }
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const counterpartAccountId = data.counterpartAccountId;
  if (!counterpartAccountId || counterpartAccountId === record.accountId) {
    $("#moveToTransferMessage").textContent = "Pick a different account.";
    return;
  }

  const amount = Math.abs(Number(record.amount));
  const movingOut = Number(record.amount) > 0;
  const fromAccountId = movingOut ? record.accountId : counterpartAccountId;
  const toAccountId = movingOut ? counterpartAccountId : record.accountId;
  state.transfers ||= [];
  state.transfers.unshift({
    id: uniqueId("transfer"),
    date: record.date,
    fromAccountId,
    toAccountId,
    amount,
    memo: (data.memo || record.payee || "").trim()
  });

  // Only clear a second row if it's genuinely still the matching offsetting
  // entry for the *chosen* counterpart account - the user may have picked a
  // different account than the one auto-suggested, in which case whatever
  // was auto-matched is unrelated and must be left alone.
  const otherRecords = [
    ...state.transactions.filter((transaction) => transaction !== record),
    ...(state.transactionInboxDrafts || [])
  ];
  const counterpartMatch = findTransferCandidate(record, otherRecords);
  const shouldClearCounterpart = counterpartMatch && counterpartMatch.accountId === counterpartAccountId;

  if (source.type === "draft") {
    state.transactionInboxDone ||= [];
    if (!state.transactionInboxDone.includes(record.id)) state.transactionInboxDone.push(record.id);
    state.transactionInboxDrafts = (state.transactionInboxDrafts || []).filter((item) => item.id !== record.id);
  } else {
    const index = state.transactions.indexOf(record);
    if (index >= 0) state.transactions.splice(index, 1);
  }

  if (shouldClearCounterpart) {
    const draftIndex = (state.transactionInboxDrafts || []).findIndex((item) => item.id === counterpartMatch.id);
    if (draftIndex >= 0) {
      state.transactionInboxDone ||= [];
      if (!state.transactionInboxDone.includes(counterpartMatch.id)) state.transactionInboxDone.push(counterpartMatch.id);
      state.transactionInboxDrafts.splice(draftIndex, 1);
    } else {
      const ledgerIndex = state.transactions.indexOf(counterpartMatch);
      if (ledgerIndex >= 0) state.transactions.splice(ledgerIndex, 1);
    }
  }

  state.household.activity.unshift(`Moved ${record.payee} to Transfers`);
  autosaveState();
  pendingTransferMoveSource = null;
  $("#moveToTransferDialog").close();
  render();
});

let pendingSettleUpPersonKey = "";

function openSettleUpDialog(personKey) {
  const group = netBalancesByPerson(state.ious).find((item) => item.key === personKey);
  if (!group || group.direction === "settled") return;
  pendingSettleUpPersonKey = personKey;
  const net = Math.abs(group.net);
  const form = $("#settleUpForm");
  form.reset();
  form.amount.value = net;
  form.date.value = dateKey(new Date());
  $("#settleUpPersonName").textContent = group.label;
  $("#settleUpNetAmount").textContent = money.format(net);
  $("#settleUpMessage").textContent = "";
  $("#settleUpDialog").showModal();
}

$("#closeSettleUpDialogButton").addEventListener("click", () => $("#settleUpDialog").close());
$("#cancelSettleUpButton").addEventListener("click", () => $("#settleUpDialog").close());
$("#settleInFullButton").addEventListener("click", () => {
  const group = netBalancesByPerson(state.ious).find((item) => item.key === pendingSettleUpPersonKey);
  if (group) $("#settleUpForm").amount.value = Math.abs(group.net);
});

$("#settleUpForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const result = settleUpPersonIous(state.ious, pendingSettleUpPersonKey, Number(data.amount), data.date || dateKey(new Date()), () => uniqueId("iou"));
  if (!result.ok) {
    $("#settleUpMessage").textContent = result.error;
    return;
  }
  state.ious = result.ious;
  autosaveState();
  pendingSettleUpPersonKey = "";
  $("#settleUpDialog").close();
  render();
});

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

// Loaded lazily (only once a key is actually configured, and only the first
// time a calendar location field needs it) rather than unconditionally in
// index.html, so households without Maps configured never pay for the
// script fetch at all. Cached as a promise so repeated calendar renders
// don't re-inject the script tag.
function loadGoogleMapsScript(apiKey) {
  if (googleMapsLoadPromise) return googleMapsLoadPromise;
  googleMapsLoadPromise = new Promise((resolve, reject) => {
    if (window.google?.maps?.places) { resolve(); return; }
    window.__familyLoopGoogleMapsReady = resolve;
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&loading=async&callback=__familyLoopGoogleMapsReady`;
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load Google Maps"));
    document.head.appendChild(script);
  });
  return googleMapsLoadPromise;
}

// Re-attached every render (bindViewEvents runs after every render() call,
// and the calendar form's innerHTML — including the location input — is
// fully regenerated each time, so any previous Autocomplete instance is
// already gone with its old input node). A no-op wherever the location
// field isn't currently in the DOM (every view but Calendar) or Maps hasn't
// finished loading yet.
function attachLocationAutocomplete() {
  const input = document.querySelector('#calendarQuickAdd [name="location"]');
  if (!input || !window.google?.maps?.places) return;
  const autocomplete = new google.maps.places.Autocomplete(input, { fields: ["formatted_address"] });
  autocomplete.addListener("place_changed", () => {
    const place = autocomplete.getPlace();
    if (place?.formatted_address) input.value = place.formatted_address;
    updateLocationDirectionsPreview();
  });
}

// Lets a household preview the route (and get a feel for the distance)
// right while filling in the form, instead of only after saving and
// hunting for it in Chore rotation / Upcoming schedule. Reads the input's
// live value, so it updates for a typed address too, not just one picked
// from the autocomplete dropdown.
function updateLocationDirectionsPreview() {
  const input = document.querySelector('#calendarQuickAdd [name="location"]');
  const preview = document.querySelector('#calendarQuickAdd [data-location-directions-preview]');
  if (!input || !preview) return;
  preview.innerHTML = directionsLinkHtml(input.value.trim());
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
    setAuthMessage(error.message);
  }
}

async function loadApp() {
  const session = await api("/api/session");
  initGoogleSignIn(session.googleClientId);
  googleMapsApiKey = session.googleMapsApiKey || "";
  if (googleMapsApiKey) loadGoogleMapsScript(googleMapsApiKey).then(attachLocationAutocomplete).catch(() => {});
  if (!session.authenticated) {
    sessionUser = null;
    households = [];
    document.body.classList.add("auth-mode");
    $("#workspace").hidden = true;
    if (location.hash.slice(1) === "help") {
      showPublicHelp();
    } else {
      $("#authPanel").hidden = false;
    }
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
  // A fresh login should always land on today's month - restoring whatever
  // month was last viewed (Budget history browsing, etc.) is only useful
  // within an already-open session, not as the starting point for a new
  // one. reloadSelectedHousehold() (switching households mid-session) is
  // deliberately left alone - only this true login entry point resets it.
  const loginMonth = currentMonthKey();
  const shouldForceCurrentMonth = state?.budget && state.budget.month !== loginMonth;
  const migrated = migrateInitialMonth();
  if (shouldForceCurrentMonth) {
    state.budget.month = loginMonth;
    state.budget.monthPreferenceSet = true;
  }
  if (migrated || shouldForceCurrentMonth) autosaveState();
  const hashView = location.hash.slice(1);
  if (hashView && renderers[hashView]) currentView = hashView;
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
    showToast(error.message);
  }
}

async function updateAdminUser(userId, patch) {
  await api(`/api/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(patch) });
  adminData = null;
  await loadAdminData();
}

// ---- Rich report export (replaces the old flat single-sheet CSV) ----
//
// Every section can be exported scoped to a single month, a date range, or a
// whole year - "periodic" sections get one sheet per calendar month in that
// range (reusing the same per-month row-builder in a loop), "semi-periodic"
// (wealth) gets one sheet per month showing net worth as of that month's
// end, and "snapshot" sections (no stored history to split by) always get
// exactly one current-state sheet regardless of scope.
const REPORT_SECTIONS = {
  budget: { label: "Budget", periodicity: "periodic" },
  transactions: { label: "Transactions", periodicity: "periodic" },
  paychecks: { label: "Paycheck/Income", periodicity: "periodic" },
  calendar: { label: "Calendar", periodicity: "periodic" },
  meals: { label: "Meals", periodicity: "periodic" },
  wealth: { label: "Wealth", periodicity: "semi-periodic" },
  reports: { label: "Reports", periodicity: "periodic" },
  recipes: { label: "Recipes", periodicity: "snapshot" },
  goals: { label: "Goals", periodicity: "snapshot" },
  sharing: { label: "Sharing", periodicity: "snapshot" }
};

function monthSheetName(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const label = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "short" });
  return `${label}${year}`;
}

function monthKeysForScope(scope) {
  if (scope.type === "year") return monthKeysInRange(`${scope.year}-01-01`, `${scope.year}-12-31`);
  if (scope.type === "range") return monthKeysInRange(scope.start, scope.end);
  const month = scope.month || state.budget.month;
  return monthKeysInRange(`${month}-01`, monthEndDateKey(month));
}

function scopeDescriptionText(scope) {
  if (scope.type === "month") return formatMonth(scope.month);
  if (scope.type === "year") return `Whole year ${scope.year}`;
  if (scope.type === "range") return `${scope.start} to ${scope.end}`;
  return "";
}

function reportFileName(section, scope) {
  const label = (REPORT_SECTIONS[section]?.label || section).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const scopeTag = scope.type === "year" ? scope.year : scope.type === "month" ? scope.month : `${scope.start}_to_${scope.end}`;
  return `familyloop-${label}-${scopeTag}.xlsx`;
}

function buildReportMetaRows({ section, scope }) {
  return [
    ["Generated at", new Date().toISOString()],
    ["Generated by", sessionUser?.name || sessionUser?.email || ""],
    ["Household", state.household?.name || ""],
    ["Section", REPORT_SECTIONS[section]?.label || section],
    ["Scope", scopeDescriptionText(scope)]
  ];
}

// Mirrors switchBudgetMonth's own carry-forward rule (an exact snapshot for
// this month if one was ever saved, else the nearest prior month's, else 0)
// so an exported month shows the same planned amount the app itself would
// show if you actually navigated there - not a re-derived guess.
function plannedForLineInMonth(lineId, monthKey) {
  if (monthKey === state.budget.month) return Number(findLineById(lineId)?.planned || 0);
  const history = state.budgetHistory || [];
  const exact = history.find((budget) => budget.month === monthKey);
  if (exact) return plannedByLineIdFromSnapshot(exact).get(lineId) || 0;
  const priorSnapshots = history.filter((budget) => budget.month < monthKey).sort((a, b) => b.month.localeCompare(a.month));
  return priorSnapshots.length ? (plannedByLineIdFromSnapshot(priorSnapshots[0]).get(lineId) || 0) : 0;
}

// The "deeper insight" the Reports page and the Budget export both surface:
// planned vs. actual spend per category, per month, across whatever range
// was picked - not just current-month totals.
function budgetVsActualByCategory(monthKeys) {
  const rows = [];
  monthKeys.forEach((monthKey) => {
    state.budget.categories.forEach((category) => {
      const planned = category.lines.reduce((sum, line) => sum + plannedForLineInMonth(line.id, monthKey), 0);
      const actual = category.lines.reduce((sum, line) => sum + spentByLineInMonth(state.transactions, line.id, monthKey), 0);
      const variance = planned - actual;
      rows.push({ category: category.name, month: monthKey, planned, actual, variance, variancePercent: planned ? Math.round((variance / planned) * 100) : null });
    });
  });
  return rows;
}

function budgetVsActualOverviewRows(monthKeys) {
  const comparisons = budgetVsActualByCategory(monthKeys);
  return [
    ["Month", "Category", "Planned", "Actual", "Variance", "Variance %"],
    ...comparisons.map((row) => [formatMonth(row.month), row.category, row.planned.toFixed(2), row.actual.toFixed(2), row.variance.toFixed(2), row.variancePercent === null ? "" : `${row.variancePercent}%`])
  ];
}

// Stitches several labeled {title, rows} blocks into one sheet with a blank
// line between them - simpler than giving every overview sheet its own
// bespoke multi-table layout.
function combineReportBlocks(blocks) {
  const rows = [];
  blocks.forEach((block, index) => {
    if (index > 0) rows.push([]);
    rows.push([block.title]);
    rows.push(...block.rows);
  });
  return rows;
}

function transactionsOverviewSummary(monthKeys) {
  const rangeTransactions = state.transactions.filter((transaction) => monthKeys.includes(transaction.date?.slice(0, 7)));
  const byCategory = new Map();
  rangeTransactions.forEach((transaction) => {
    const line = allLines().find((item) => item.id === transaction.lineId);
    const key = line?.category || transaction.categoryName || "Unassigned";
    byCategory.set(key, (byCategory.get(key) || 0) + Number(transaction.amount || 0));
  });
  const categoryRows = [["Category", "Total spent"], ...[...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([name, total]) => [name, total.toFixed(2)])];
  const tagGroups = groupTransactionsByTag(rangeTransactions).sort((a, b) => b.total - a.total);
  const tagRows = [["Tag", "Total", "Transaction count"], ...tagGroups.map((group) => [group.label, group.total.toFixed(2), group.transactions.length])];
  const totalSpend = rangeTransactions.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  return { totalSpend, totalCount: rangeTransactions.length, categoryRows, tagRows };
}

// Builds the same net worth trend / cash flow / budget-vs-expense insight
// the Reports page itself shows, for an arbitrary month range - the images
// array starts empty and is filled in by attachReportChartImages() once the
// charts are rasterized (see cashFlowChartSvg/svgStringToPngBase64).
function reportsOverviewRows(monthKeys) {
  const trend = netWorthTrend(monthKeys);
  const cashFlow = cashFlowByMonth(monthKeys);
  const rows = combineReportBlocks([
    { title: "Net worth trend", rows: [["Month", "Net worth"], ...trend.map((point) => [formatMonth(point.month), point.value.toFixed(2)])] },
    { title: "Cash flow", rows: [["Month", "Income", "Expenses", "Net"], ...cashFlow.map((month) => [formatMonth(month.month), month.income.toFixed(2), month.expenses.toFixed(2), (month.income - month.expenses).toFixed(2)])] },
    { title: "Budget vs Expense", rows: budgetVsActualOverviewRows(monthKeys) },
    { title: "Spend by category", rows: transactionsOverviewSummary(monthKeys).categoryRows }
  ]);
  return { rows, trend, cashFlow };
}

function budgetRowsForMonth(monthKey) {
  return [
    ["Category", "Subcategory", "Planned", "Spent", "Remaining", "Recurring bill"],
    ...allLines().map((line) => {
      const spent = spentByLineInMonth(state.transactions, line.id, monthKey);
      const planned = plannedForLineInMonth(line.id, monthKey);
      const recurringLabel = line.recurringBill?.enabled ? `${line.recurringBill.frequency} - ${money.format(line.recurringBill.amount)} due ${line.recurringBill.dueDate}` : "";
      return [line.category, line.name, planned.toFixed(2), spent.toFixed(2), (planned - spent).toFixed(2), recurringLabel];
    })
  ];
}

// Every household's transaction with the most tags decides how many "Tag N"
// columns the export gets - scanning all transactions (not just the month
// being exported) so every month's sheet in a multi-sheet export lines up
// under the same columns, rather than each sheet having its own tag-count.
function maxTransactionTagCount() {
  return state.transactions.reduce((max, transaction) => Math.max(max, (transaction.tags || []).length), 0);
}

function transactionRowsForMonth(monthKey) {
  const maxTags = maxTransactionTagCount();
  const tagHeaders = Array.from({ length: maxTags }, (_, index) => `Tag ${index + 1}`);
  return [
    ["Date", "Payee", "Amount", "Category", "Subcategory", "Account", ...tagHeaders, "Memo"],
    ...state.transactions
      .filter((transaction) => transaction.date?.slice(0, 7) === monthKey)
      .map((transaction) => {
        const line = allLines().find((item) => item.id === transaction.lineId);
        const tags = transaction.tags || [];
        const tagCells = Array.from({ length: maxTags }, (_, index) => tags[index] || "");
        return [
          transaction.date, transaction.payee, Number(transaction.amount || 0).toFixed(2),
          line?.category || transaction.categoryName || "", line?.name || "Unassigned",
          accountName(transaction.accountId) || "", ...tagCells, transaction.memo || ""
        ];
      })
  ];
}

function paycheckRowsForMonth(monthKey) {
  const monthStart = `${monthKey}-01`;
  const monthEnd = monthEndDateKey(monthKey);
  const rows = [];
  state.paychecks.forEach((paycheck) => {
    paycheckAllOccurrenceDatesInRange(paycheck, monthStart, monthEnd).forEach((date) => {
      rows.push([date, paycheck.name, Number(paycheck.amount || 0).toFixed(2), (paycheck.assignedLineIds || []).map((id) => allLines().find((line) => line.id === id)?.name || id).join("; ")]);
    });
  });
  return [["Date", "Paycheck", "Amount", "Assigned subcategories"], ...rows];
}

function calendarRowsForMonth(monthKey) {
  const monthStart = `${monthKey}-01`;
  const monthEnd = monthEndDateKey(monthKey);
  const events = state.calendar.events.filter((item) => {
    const date = item.date || item.dateTime?.slice(0, 10) || "";
    return date >= monthStart && date <= monthEnd;
  });
  const chores = state.calendar.chores.filter((item) => {
    const date = item.startDate || item.nextDue || "";
    return date >= monthStart && date <= monthEnd;
  });
  return [
    ["Kind", "Title", "Date/time", "Assigned to", "Repeat"],
    ...events.map((item) => [item.type, item.title, item.dateTime || item.date, assigneeNames(item.assignees), item.annual ? "Yearly" : "Once"]),
    ...chores.map((item) => ["chore", item.title, `${item.startDate || item.nextDue}T${item.time || "09:00"}`, assigneeNames(item.assignees), choreCadenceLabel(item)])
  ];
}

function mealRowsForMonth(monthKey) {
  return [
    ["Month", "Week", "Day", "Slot", "Meal", "Servings"],
    ...state.meals.plannedWeek.filter((item) => (item.month || state.budget.month) === monthKey).map((item) => [item.month || monthKey, item.week || 1, item.day, item.slot || "Dinner", item.meal, item.servings])
  ];
}

function wealthRowsForMonth(monthKey) {
  const asOfDate = monthEndDateKey(monthKey);
  const context = { accounts: state.accounts, transactions: state.transactions, paychecks: state.paychecks, paycheckOccurrences: state.paycheckOccurrences, transfers: state.transfers, ious: state.ious || [] };
  const assetRows = state.goals.netWorth.assets.map((asset) => {
    const linkedAccount = state.accounts.find((account) => account.netWorthAssetId === asset.id);
    return ["asset", asset.name, asset.assetClass || "other", (linkedAccount ? accountBalance(linkedAccount.id, context, asOfDate) : assetValue(asset)).toFixed(2)];
  });
  const liabilityRows = state.goals.netWorth.liabilities.map((liability) => {
    const linkedAccount = state.accounts.find((account) => account.netWorthLiabilityId === liability.id);
    return ["liability", liability.name, "", (linkedAccount ? accountBalance(linkedAccount.id, context, asOfDate) : Number(liability.value || 0)).toFixed(2)];
  });
  return [["Record type", "Name", "Class/APR", `Value as of ${asOfDate}`], ...assetRows, ...liabilityRows];
}

function reportSummaryRowsForMonth(monthKey) {
  return [
    ["Category", "Planned", "Spent", "Remaining"],
    ...state.budget.categories.map((category) => {
      const planned = category.lines.reduce((sum, line) => sum + plannedForLineInMonth(line.id, monthKey), 0);
      const actual = category.lines.reduce((sum, line) => sum + spentByLineInMonth(state.transactions, line.id, monthKey), 0);
      return [category.name, planned.toFixed(2), actual.toFixed(2), (planned - actual).toFixed(2)];
    })
  ];
}

function recipeRows() {
  return [["Recipe", "Calories", "Protein (g)", "Ingredients"], ...state.meals.recipes.map((recipe) => [recipe.name, recipe.calories, recipe.protein, (recipe.ingredients || []).join("; ")])];
}

function goalRows() {
  return [["Goal", "Target date", "Target", "Saved", "Remaining"], ...state.goals.sinkingFunds.map((goal) => [goal.name, goal.targetDate || "", goal.target, goal.saved, Math.max(0, Number(goal.target || 0) - Number(goal.saved || 0))])];
}

function sharingRows() {
  return [["Name", "Email", "Role", "Status"], ...(sharingAccess?.members || []).map((member) => [member.name, member.email, member.role, member.status])];
}

const SECTION_MONTH_ROW_BUILDERS = {
  budget: budgetRowsForMonth,
  transactions: transactionRowsForMonth,
  paychecks: paycheckRowsForMonth,
  calendar: calendarRowsForMonth,
  meals: mealRowsForMonth,
  wealth: wealthRowsForMonth,
  reports: reportSummaryRowsForMonth
};

const SNAPSHOT_SECTION_BUILDERS = { recipes: recipeRows, goals: goalRows, sharing: sharingRows };

// The one entry point every download button (and the Reports export dialog)
// calls into. Returns { fileName, sheets, chartData } - chartData is null
// unless section is "reports", in which case attachReportChartImages()
// (chart-rasterization step) fills in that sheet's images before the spec
// is POSTed to /api/reports/export.
function buildWorkbookSpec({ section, scope }) {
  const meta = REPORT_SECTIONS[section] || REPORT_SECTIONS.budget;
  const sheets = [];
  let chartData = null;

  if (meta.periodicity === "snapshot") {
    const builder = SNAPSHOT_SECTION_BUILDERS[section];
    sheets.push({ name: "Current", rows: builder ? builder() : [["No data"]] });
  } else {
    const monthKeys = monthKeysForScope(scope);
    const todayMonth = dateKey(new Date()).slice(0, 7);

    if (section === "budget") {
      sheets.push({ name: "Budget vs Expense", rows: budgetVsActualOverviewRows(monthKeys) });
    } else if (section === "transactions") {
      const summary = transactionsOverviewSummary(monthKeys);
      sheets.push({ name: "Overview", rows: combineReportBlocks([
        { title: "Totals", rows: [["Total spend", summary.totalSpend.toFixed(2)], ["Transactions", summary.totalCount]] },
        { title: "By category", rows: summary.categoryRows },
        { title: "By tag", rows: summary.tagRows }
      ]) });
    } else if (section === "reports") {
      const overview = reportsOverviewRows(monthKeys);
      sheets.push({ name: "Overview", rows: overview.rows, images: [] });
      chartData = { trend: overview.trend, cashFlow: overview.cashFlow };
    }

    const builder = SECTION_MONTH_ROW_BUILDERS[section] || SECTION_MONTH_ROW_BUILDERS.budget;
    monthKeys.forEach((monthKey) => {
      const rows = builder(monthKey);
      const isFuture = monthKey > todayMonth;
      const hasData = rows.length > 1;
      if (isFuture && !hasData) return;
      sheets.push({ name: monthSheetName(monthKey), rows });
    });
  }

  sheets.push({ name: "Report info", rows: buildReportMetaRows({ section, scope }) });
  return { fileName: reportFileName(section, scope), sheets, chartData };
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
      setAuthMessage("Email verified. Sign in to continue.", true);
    } catch (error) {
      setAuthMessage(error.message);
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
  setAuthMessage(error.message);
});

// Keeps Wealth's live-price captions from going stale on a long-open tab,
// without polling a page nobody is looking at.
setInterval(() => {
  if (currentView === "wealth") refreshAllStockGroupPrices();
}, 5 * 60 * 1000);

window.addEventListener("popstate", (event) => {
  const view = event.state?.view;
  if (!view || view === currentView || !renderers[view]) return;
  currentView = view;
  render();
});

// A 24-hour "HH:MM" text input used everywhere in place of a native
// <input type="time"> or the time portion of a <input type="datetime-local">.
// Modern Chrome derives those native controls' AM/PM-vs-24-hour display from
// the browser's own language/OS region settings, ignoring the page's own
// lang attribute entirely - there is no reliable way to force every user's
// device into 24-hour mode with the native pickers. Wired once here (not
// inside bindViewEvents, which reruns on every render) as a single delegated
// listener on document, so it keeps working regardless of how the DOM
// underneath it gets rebuilt.
document.addEventListener("input", (event) => {
  const input = event.target;
  if (!input.classList?.contains("time24-input")) return;
  // Digits accumulate as typed; once there are 3+, everything except the
  // last two becomes the hour and the last two become the minute - so
  // typing "930" (no leading zero) still lands on 9:30, not 93:0.
  const digits = input.value.replace(/\D/g, "").slice(0, 4);
  input.value = digits.length <= 2 ? digits : `${digits.slice(0, -2)}:${digits.slice(-2)}`;
});

// Normalizes/clamps to a valid zero-padded HH:MM on blur (capture phase,
// since blur doesn't bubble) - e.g. "9:3" becomes "09:03", and an
// out-of-range "25:99" clamps to "23:59" rather than being silently kept or
// rejected outright.
document.addEventListener("blur", (event) => {
  const input = event.target;
  if (!input.classList?.contains("time24-input")) return;
  if (!input.value) return;
  const match = input.value.match(/^(\d{1,2}):(\d{1,2})$/);
  const normalized = match
    ? `${String(Math.min(23, Number(match[1]))).padStart(2, "0")}:${String(Math.min(59, Number(match[2]))).padStart(2, "0")}`
    : "";
  if (normalized !== input.value) {
    input.value = normalized;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}, true);
