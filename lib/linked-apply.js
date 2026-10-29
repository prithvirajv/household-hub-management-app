// Applies a linked-account sync (SimpleFIN transactions and balances, SnapTrade holdings) to a household state object without a browser:
// the server uses it overnight so new bank transactions reach the ledger without anyone opening the app. It is the same pipeline the app
// runs when a person syncs - new rows become Bank stream drafts, balances follow the bank, a steady salary becomes a paycheck, AI fills in
// categories, and every row that is safe goes into the ledger (everything else waits in Bank stream with the reason a person would see) -
// built from the same shared-logic.js rules, on a plain state object instead of the app's globals. Mutates the state it is given.
const {
  autoAcceptDecision, matchesRecordedPaycheck, isDuplicateTransaction, findTransferCandidate, refundMatch, adoptRefundMatch, refundMemo,
  suggestSubcategoryFromHistory, suggestAccountFromHistory, normalizeForPayeeMatch, lookupCategorizationRule, openingShiftForPostedRow, selectNewLinkedTransactions,
  rememberLinkedImportedIds, reconcileOpeningBalance, applyBalanceToHoldingsGroup, matchDebtToBankBalance, accountBalance,
  applyDetectedSalariesToState, updateAccountsSyncedFrom, markAccountsSynced, mergeBrokeragePositions
} = require("./shared-logic");

const AI_CHUNK_SIZE = 25;
const AI_CALL_TIMEOUT_MS = 45000;
// The server refuses any household save above about 1 MB, so a sync that would push the state past this is not applied.
const STATE_SIZE_LIMIT = 900000;

const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const uniqueIdFactory = () => (seed) => `${String(seed || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Math.random().toString(36).slice(2, 7)}`;

function allLines(state) {
  return [...state.budget.categories]
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((category) => [...category.lines].sort((a, b) => a.name.localeCompare(b.name)).map((line) => ({ ...line, category: category.name, color: category.color })));
}

function lineSnapshot(state, lineId) {
  const line = allLines(state).find((item) => item.id === lineId);
  return { categoryName: line?.category || "Deleted category", subcategoryName: line?.name || lineId || "Deleted subcategory" };
}

function categorizationRuleForPayee(state, payee) {
  return lookupCategorizationRule(state.transactionCategorizationRules, payee);
}

function accountAllowsDate(state, accountId, date) {
  if (!accountId) return true;
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account?.closedAt) return true;
  return Boolean(date) && date <= account.closedAt;
}

function currentAccountBalance(state, accountId, todayKey) {
  return accountBalance(accountId, { accounts: state.accounts, transactions: state.transactions, paychecks: state.paychecks, paycheckOccurrences: state.paycheckOccurrences, transfers: state.transfers, ious: state.ious || [] }, todayKey);
}

// A draft going into the ledger. A row from a linked feed is already inside the balance synced from the bank, so posting it hands its
// amount back through the opening balance and the account's total stays the bank's.
function postDraftToLedger(state, draft, todayKey) {
  const lineId = draft.lineId || "";
  const memo = draft.postMemo || (draft.recurringId ? "Recurring bill" : "Accepted bank stream item");
  const posted = { date: draft.date, payee: draft.payee, amount: Number(draft.amount), lineId, memo, accountId: draft.accountId || "", orderNumber: draft.orderNumber || "", tags: draft.tags || [], ...lineSnapshot(state, lineId) };
  if (draft.externalId) {
    posted.externalId = draft.externalId;
    const account = state.accounts.find((item) => item.id === draft.accountId);
    if (account && Number.isFinite(Number(draft.amount)) && draft.date <= todayKey) account.openingBalance = Math.round((Number(account.openingBalance || 0) + openingShiftForPostedRow(account, draft)) * 100) / 100;
  }
  state.transactions.unshift(posted);
  state.transactionInboxDone ||= [];
  if (!state.transactionInboxDone.includes(draft.id)) state.transactionInboxDone.push(draft.id);
  state.transactionInboxDrafts = (state.transactionInboxDrafts || []).filter((item) => item.id !== draft.id);
  state.household.activity ||= [];
  state.household.activity.unshift(`Assigned ${draft.payee} to ${posted.categoryName === "Deleted category" && !lineId ? "no category" : `${posted.categoryName} - ${posted.subcategoryName}`}`);
}

// Rows from one linked account become Bank stream drafts pre-filled as far as is safe: a return pins to the purchase it reverses, otherwise
// the household's own rule, then its most recent history for that exact payee, fill the category.
function buildDrafts(state, rows, accountId, createId) {
  state.transactionInboxDrafts ||= [];
  const alreadyKnown = [...state.transactions, ...state.transactionInboxDrafts];
  const refundPool = [...alreadyKnown, ...rows];
  const ids = [];
  rows.forEach((row) => {
    const rowRefund = refundMatch({ ...row, accountId }, refundPool);
    const historyLineId = rowRefund ? "" : suggestSubcategoryFromHistory(row.payee, state.transactions);
    const ruleLineId = rowRefund ? "" : categorizationRuleForPayee(state, row.payee);
    const id = createId("linked-import");
    ids.push(id);
    state.transactionInboxDrafts.unshift({
      id, payee: row.payee, amount: row.amount,
      lineSource: rowRefund?.lineId ? "refund" : ruleLineId ? "rule" : historyLineId ? "history" : "",
      lineId: rowRefund?.lineId || ruleLineId || historyLineId || "",
      accountId, date: row.date, orderNumber: row.orderNumber || "", externalId: row.externalId || "",
      isDeposit: !!row.isDeposit, isPayment: !!row.isPayment, isPending: !!row.isPending,
      historyMatch: !!(!rowRefund && !ruleLineId && historyLineId), accountHistoryMatch: false
    });
  });
  return ids;
}

// SimpleFIN: new transactions to Bank stream drafts, then every mapped balance in line with the bank.
function applySimplefinPayload(state, link, payload, createId) {
  state.linkedImportedIds ||= [];
  const knownIds = new Set([...state.linkedImportedIds, ...state.transactions.map((t) => t.externalId).filter(Boolean), ...(state.transactionInboxDrafts || []).map((d) => d.externalId).filter(Boolean)]);
  const { fresh } = selectNewLinkedTransactions(payload.transactions, link.mappings, knownIds);
  const posted = fresh.filter((transaction) => !transaction.pending);
  if (JSON.stringify(state).length + posted.length * 400 > STATE_SIZE_LIMIT) throw new Error(`Importing ${posted.length} transactions would push the household data past the size that can be saved`);
  const byAccount = new Map();
  posted.forEach((transaction) => { byAccount.set(transaction.accountId, [...(byAccount.get(transaction.accountId) || []), transaction]); });
  const draftIds = [];
  byAccount.forEach((rows, accountId) => draftIds.push(...buildDrafts(state, rows, accountId, createId)));
  state.linkedImportedIds = rememberLinkedImportedIds(state.linkedImportedIds, posted.map((transaction) => transaction.externalId));

  const todayKey = dateKey(new Date());
  // The accounts' "synced from / through / last synced" marks are stamped by applyLinkedPayload once everything below has finished.
  let balancesUpdated = 0;
  (payload.accounts || []).forEach((remote) => {
    const accountId = link.mappings[remote.remoteId]?.accountId;
    const account = accountId ? state.accounts.find((item) => item.id === accountId) : null;
    if (!account || remote.balance === null || remote.balance === undefined) return;
    const opening = reconcileOpeningBalance(account, currentAccountBalance(state, account.id, todayKey), remote.balance);
    if (opening !== Number(account.openingBalance || 0)) { account.openingBalance = opening; balancesUpdated += 1; }
  });
  (payload.accounts || []).forEach((remote) => {
    const mapping = link.mappings[remote.remoteId];
    if (!mapping?.groupId || remote.balance === null || remote.balance === undefined) return;
    const result = applyBalanceToHoldingsGroup(state.goals.netWorth.assets, { linkId: link.id, remoteId: remote.remoteId, groupId: mapping.groupId, groupName: mapping.groupName || remote.name, balance: remote.balance }, createId);
    state.goals.netWorth.assets = result.assets;
  });
  (payload.accounts || []).forEach((remote) => {
    const debtId = link.mappings[remote.remoteId]?.debtId;
    if (!debtId || remote.balance === null || remote.balance === undefined) return;
    const result = matchDebtToBankBalance({ debts: state.goals.debts, liabilities: state.goals.netWorth.liabilities, transactions: state.transactions }, { debtId, balance: remote.balance }, (transaction) => `${transaction.date}|${transaction.amount}`);
    state.goals.debts = result.debts;
    state.goals.netWorth.liabilities = result.liabilities;
  });
  return { draftIds, imported: posted.length, balancesUpdated };
}

function applySnaptradePayload(state, link, payload, createId) {
  const result = mergeBrokeragePositions(state.goals.netWorth.assets, { linkId: link.id, positions: payload.positions, cash: payload.cash, accounts: payload.accounts, mappings: link.mappings }, createId);
  state.goals.netWorth.assets = result.assets;
  return { draftIds: [], imported: 0, balancesUpdated: 0 };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

// The import pass over the given drafts: salary first, then rule/history/refund categories, AI for the gaps (one call per chunk, posting as
// it goes), and a final decision for everything still waiting. `suggest(rows, lines, accounts, tags)` resolves to the AI results or throws;
// it is optional (without it, rows the household's own rules cannot categorize go in uncategorized).
async function categorizeAndPost(state, draftIds, { suggest = null, createId, todayKey = dateKey(new Date()), aiCache = new Map() } = {}) {
  const findDraft = (id) => (state.transactionInboxDrafts || []).find((draft) => draft.id === id);
  const openAccounts = () => state.accounts.filter((account) => !account.closedAt);
  const hasAccounts = openAccounts().length > 0;
  const summary = { added: 0, uncategorized: 0, aiFilled: 0, aiNote: "", reasons: new Map() };
  const settled = new Set();
  const note = (reason) => summary.reasons.set(reason, (summary.reasons.get(reason) || 0) + 1);

  const postSafeRows = (ids, { final = false } = {}) => {
    ids.forEach((id) => {
      if (settled.has(id)) return;
      const draft = findDraft(id);
      if (!draft) return;
      const others = [...state.transactions, ...state.transactionInboxDrafts.filter((other) => other.id !== draft.id)];
      const returnOf = refundMatch(draft, others);
      const returnOfPosted = !!returnOf && state.transactions.includes(returnOf);
      if (returnOf && !returnOfPosted && !final) return;
      if (returnOfPosted) adoptRefundMatch(draft, returnOf);
      settled.add(id);
      const decision = autoAcceptDecision(draft, {
        accountsExist: hasAccounts,
        possibleDuplicate: isDuplicateTransaction(draft, others),
        refundMatch: returnOf,
        refundMatchPosted: returnOfPosted,
        transferMatch: findTransferCandidate(draft, others),
        accountClosedForDate: !accountAllowsDate(state, draft.accountId, draft.date),
        bankFeed: true,
        paycheckMatch: matchesRecordedPaycheck(draft, state.paycheckOccurrences)
      });
      if (decision.accept) {
        if (returnOfPosted) draft.postMemo = refundMemo(returnOf);
        if (decision.uncategorized) { draft.lineId = ""; draft.lineSource = ""; draft.postMemo = "Needs a category"; summary.uncategorized += 1; }
        postDraftToLedger(state, draft, todayKey);
        summary.added += 1;
      } else {
        note(decision.reason);
      }
    });
  };

  applyDetectedSalariesToState(state, todayKey, createId);
  draftIds.map(findDraft).forEach((draft) => {
    if (!draft || draft.lineSource) return;
    // A row waiting without a category takes the household's own rule or history for its payee if one exists now; a row that has a category
    // but no recorded source is vouched for when its rule or history agrees.
    const rule = categorizationRuleForPayee(state, draft.payee);
    const history = rule ? "" : suggestSubcategoryFromHistory(draft.payee, state.transactions) || "";
    if (!draft.lineId) {
      if (rule) { draft.lineId = rule; draft.lineSource = "rule"; } else if (history) { draft.lineId = history; draft.lineSource = "history"; draft.historyMatch = true; }
    } else if (rule === draft.lineId) draft.lineSource = "rule";
    else if (suggestSubcategoryFromHistory(draft.payee, state.transactions) === draft.lineId) draft.lineSource = "history";
  });
  draftIds.map(findDraft).forEach((draft) => {
    if (!draft || Number(draft.amount) >= 0) return;
    const returnOf = refundMatch(draft, state.transactions);
    if (returnOf) adoptRefundMatch(draft, returnOf);
  });
  // A waiting row the AI has already been asked about is not sent again every night (it stays for a person, or for a rule/history match).
  const needAi = draftIds.map(findDraft).filter((draft) => draft && !draft.aiAskedAt && (!draft.lineId || (!draft.accountId && openAccounts().length)));
  const needAiIds = new Set(needAi.map((draft) => draft.id));
  postSafeRows(draftIds.filter((id) => !needAiIds.has(id)));

  if (needAi.length && suggest && allLines(state).length) {
    const lines = allLines(state).map((line) => ({ id: line.id, label: `${line.category} - ${line.name}` }));
    const accounts = openAccounts().map((account) => ({ id: account.id, label: account.type ? `${account.name} (${account.type})` : account.name }));
    const knownTags = [...new Set(state.transactions.flatMap((transaction) => transaction.tags || []))].slice(0, 60);
    const cacheKey = (draft) => `${draft.payee}|${draft.amount}|${draft.date}|${draft.accountId || ""}`;
    for (let start = 0; start < needAi.length; start += AI_CHUNK_SIZE) {
      const chunk = needAi.slice(start, start + AI_CHUNK_SIZE);
      // Answers already fetched in an earlier attempt (the pass can be re-run when the household changed under it) are not asked for twice.
      const toAsk = chunk.filter((draft) => !aiCache.has(cacheKey(draft)));
      if (toAsk.length) {
        try {
          const results = await withTimeout(suggest(toAsk.map((draft) => ({ id: draft.id, payee: draft.payee, amount: draft.amount, date: draft.date })), lines, accounts, knownTags), AI_CALL_TIMEOUT_MS, "the AI took too long to answer");
          const byId = new Map(results.map((result) => [result.id, result]));
          toAsk.forEach((draft) => { if (byId.has(draft.id)) aiCache.set(cacheKey(draft), byId.get(draft.id)); draft.aiAskedAt = todayKey; });
        } catch (error) {
          // The rows still go into the ledger, marked "Needs a category"; fillUncategorizedLedgerRows gives them a category later, once the AI is back.
          summary.aiNote = `AI categorization failed for some rows (${error.message || "unknown error"})`;
          if (/not configured/i.test(String(error.message))) break;
        }
      }
      chunk.forEach((draft) => {
        const result = aiCache.get(cacheKey(draft));
        if (!result) return;
        let filled = false;
        if (!draft.lineId && result.lineId) { draft.lineId = result.lineId; draft.lineSource = result.confidence === "high" ? "ai-high" : "ai-low"; filled = true; }
        if (!draft.accountId && result.accountId) { draft.accountId = result.accountId; draft.accountHistoryMatch = false; filled = true; }
        if (result.tags?.length && !(draft.tags || []).length) { draft.tags = [...new Set(result.tags)]; filled = true; }
        if (filled) summary.aiFilled += 1;
      });
      postSafeRows(chunk.map((draft) => draft.id));
    }
  }
  postSafeRows(draftIds, { final: true });
  summary.left = draftIds.filter(findDraft).length;
  return summary;
}

// Rows that went into the ledger from a bank feed with no category (the AI was busy or unsure) get one now: the AI is asked for the ones it
// can place with confidence, in batches, and anything it is still unsure about keeps its "Needs a category" mark. Run overnight after the
// apply, so a night when the AI was down is made up the next time it answers. Returns how many rows were categorized.
async function fillUncategorizedLedgerRows(state, { suggest, limit = 75 } = {}) {
  if (!suggest || !allLines(state).length) return 0;
  const rows = state.transactions.filter((transaction) => transaction.externalId && !transaction.lineId && !(transaction.splits || []).length && transaction.memo === "Needs a category").slice(0, limit);
  if (!rows.length) return 0;
  const lines = allLines(state).map((line) => ({ id: line.id, label: `${line.category} - ${line.name}` }));
  const accounts = state.accounts.filter((account) => !account.closedAt).map((account) => ({ id: account.id, label: account.type ? `${account.name} (${account.type})` : account.name }));
  const knownTags = [...new Set(state.transactions.flatMap((transaction) => transaction.tags || []))].slice(0, 60);
  let filled = 0;
  for (let start = 0; start < rows.length; start += AI_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + AI_CHUNK_SIZE);
    let results;
    try {
      results = await withTimeout(suggest(chunk.map((transaction, index) => ({ id: `fill-${start + index}`, payee: transaction.payee, amount: transaction.amount, date: transaction.date })), lines, accounts, knownTags), AI_CALL_TIMEOUT_MS, "the AI took too long to answer");
    } catch (_error) {
      break;
    }
    const byId = new Map(results.map((result) => [result.id, result]));
    chunk.forEach((transaction, index) => {
      const result = byId.get(`fill-${start + index}`);
      if (!result?.lineId || result.confidence !== "high") return;
      Object.assign(transaction, { lineId: result.lineId, memo: "Categorized by AI", ...lineSnapshot(state, result.lineId) });
      if (result.tags?.length && !(transaction.tags || []).length) transaction.tags = [...new Set(result.tags)];
      filled += 1;
    });
  }
  if (filled) state.household.activity.unshift(`AI categorized ${filled} bank transaction${filled === 1 ? "" : "s"} that were waiting for a category`);
  return filled;
}

// Every night, whatever is still waiting in Bank stream from a linked bank (not just what arrived last night) gets another chance: a rule or
// history match that now exists, an AI that is back, a duplicate that was resolved. Rows that are still held for a real reason stay as they are.
async function retryWaitingDrafts(state, { suggest = null, createId, todayKey = dateKey(new Date()) } = {}) {
  const ids = (state.transactionInboxDrafts || []).filter((draft) => draft.externalId && !draft.isPending).map((draft) => draft.id);
  if (!ids.length) return { added: 0, left: 0, uncategorized: 0 };
  const result = await categorizeAndPost(state, ids, { suggest, createId, todayKey });
  if (result.added) state.household.activity.unshift(`${result.added} waiting bank transaction${result.added === 1 ? "" : "s"} added to the ledger overnight`);
  return result;
}

// One link's staged payload end to end. Returns what happened, for the household's notification and the link's own status.
async function applyLinkedPayload(state, link, payload, { suggest = null, createId = uniqueIdFactory(), todayKey = dateKey(new Date()), aiCache } = {}) {
  state.household.activity ||= [];
  state.transactionInboxDrafts ||= [];
  state.transactionInboxDone ||= [];
  const applied = link.provider === "snaptrade" ? applySnaptradePayload(state, link, payload, createId) : applySimplefinPayload(state, link, payload, createId);
  const pass = await categorizeAndPost(state, applied.draftIds, { suggest, createId, todayKey, aiCache });
  // Only now, with the rows in the ledger or Bank stream and every balance reconciled, does each account's sync date move forward - and not at
  // all when part of the requested range could not be fetched, since then the account is not caught up.
  if (link.provider !== "snaptrade" && !(payload.failedWindows && payload.failedWindows.length)) {
    updateAccountsSyncedFrom(state.accounts, link.mappings, payload.coverage, [...state.transactions, ...state.transactionInboxDrafts], todayKey);
    markAccountsSynced(state.accounts, link.mappings, payload.accounts, todayKey, new Date().toISOString());
  }
  if (applied.imported || pass.added) state.household.activity.unshift(`${link.label}: ${applied.imported} new transaction${applied.imported === 1 ? "" : "s"} from the bank, ${pass.added} added to the ledger overnight`);
  return { imported: applied.imported, balancesUpdated: applied.balancesUpdated, added: pass.added, uncategorized: pass.uncategorized, left: pass.left, reasons: Object.fromEntries(pass.reasons), aiNote: pass.aiNote };
}

module.exports = { applyLinkedPayload, fillUncategorizedLedgerRows, retryWaitingDrafts, categorizeAndPost, buildDrafts, postDraftToLedger, allLines, uniqueIdFactory, dateKey, STATE_SIZE_LIMIT };
