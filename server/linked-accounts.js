// Linked accounts: pull balances/transactions from SimpleFIN Bridge and brokerage positions from SnapTrade so Wealth and Bank stream
// can update without manual entry. Everything here is READ-ONLY toward the outside world (SimpleFIN is read-only by design; SnapTrade
// connections are requested with connectionType "read", and no trading endpoint is ever called).
//
// A sync returns normalized data and the client (web/mobile) turns it into Bank stream drafts and balance/holding updates through its
// normal whole-state save. The nightly job also applies what it staged itself (lib/linked-apply.js), so new transactions reach the ledger
// without anyone opening the app; it writes only with the household's version it read (a save from anyone else in between makes it start
// again), and clients that name the version they loaded are refused, not merged over, when it wrote first.
//
// Credentials (a SimpleFIN access URL, a SnapTrade userSecret) are encrypted at rest with AES-256-GCM using LINK_ENCRYPTION_KEY, and
// are never returned to the client. Without the key the whole feature reports "not configured" rather than storing anything in clear.
const crypto = require("node:crypto");
const { applyLinkedPayload, fillUncategorizedLedgerRows, retryWaitingDrafts, uniqueIdFactory } = require("../lib/linked-apply");

const SIMPLEFIN_WINDOW_DAYS = 55; // the Bridge hard-caps one request at 60 days and only warns above 45 (data still comes back); every request counts against its daily limit, so use few
// A link's first sync (and the first after its accounts are changed) starts at the first day of last month, not "30 days ago": whole months
// only, so no account begins with a half-filled month (see trimPartialHistory for when the bank returns less).
function firstOfPreviousMonth(nowMs = Date.now()) {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
}
const SIMPLEFIN_OVERLAP_DAYS = 3;
const SIMPLEFIN_REQUEST_TIMEOUT_MS = 60000; // re-ask a few days we already saw; the client drops rows it already imported
const BROKERAGE_KINDS_AS_FUND = new Set(["mutualfund"]);

// ---- encryption ---------------------------------------------------------------------------------------------------

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encryptJson(secret, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
}

function decryptJson(secret, payload) {
  const [version, iv, tag, data] = String(payload || "").split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unreadable stored credentials");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8"));
}

// ---- SimpleFIN ----------------------------------------------------------------------------------------------------

// A SimpleFIN setup token is a base64-encoded claim URL, and the claimed access URL embeds basic-auth credentials. Both come from the
// user, so they must be pinned to SimpleFIN's own hosts: otherwise the server would POST/GET to any address a user types (SSRF, e.g.
// the cloud metadata service). Tests may allow a local stub host explicitly.
function assertSimplefinUrl(rawUrl, allowInsecureHosts) {
  let url;
  try { url = new URL(rawUrl); } catch (_error) { throw clientError("That doesn't look like a SimpleFIN token."); }
  const trustedHost = url.hostname === "simplefin.org" || url.hostname.endsWith(".simplefin.org");
  if (allowInsecureHosts) return url;
  if (url.protocol !== "https:" || !trustedHost) throw clientError("That token doesn't point at SimpleFIN Bridge.");
  return url;
}

function clientError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function claimSimplefinToken(setupToken, { fetchImpl = fetch, allowInsecureHosts = false } = {}) {
  let claimUrl;
  try { claimUrl = Buffer.from(String(setupToken || "").trim(), "base64").toString("utf8").trim(); } catch (_error) { claimUrl = ""; }
  const url = assertSimplefinUrl(claimUrl, allowInsecureHosts);
  const response = await fetchImpl(url.toString(), { method: "POST" });
  if (response.status === 403) throw clientError("SimpleFIN rejected that token - setup tokens work once; create a new one at bridge.simplefin.org.");
  if (!response.ok) throw clientError(`SimpleFIN could not claim that token (HTTP ${response.status}).`, 502);
  const accessUrl = String((await response.text()).trim());
  assertSimplefinUrl(accessUrl, allowInsecureHosts);
  return accessUrl;
}

// The access URL looks like https://user:pass@host/simplefin; fetch must not carry the credentials in the URL itself.
function simplefinRequest(accessUrl, path, params) {
  const url = new URL(accessUrl);
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
  url.username = "";
  url.password = "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return { url: url.toString(), headers: { Authorization: auth, Accept: "application/json" } };
}

async function fetchSimplefinAccounts(accessUrl, params, { fetchImpl = fetch, allowInsecureHosts = false } = {}) {
  assertSimplefinUrl(accessUrl, allowInsecureHosts);
  const request = simplefinRequest(accessUrl, "/accounts", params);
  // A request the Bridge does not answer is given up on after a minute (it can otherwise hang for two - Cloudflare answers "524"), so the
  // caller can try a smaller date range instead of losing the whole sync.
  let response;
  try {
    response = await fetchImpl(request.url, { headers: request.headers, signal: AbortSignal.timeout(SIMPLEFIN_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    // A request that never answered is a timeout; anything else (the Bridge resetting the connection, DNS, TLS) is a dropped connection.
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError" || /abort|timeout/i.test(String(error?.message));
    const reason = String(error?.cause?.code || error?.code || "");
    const failure = clientError(timedOut ? "SimpleFIN took too long to answer." : `SimpleFIN dropped the connection${reason ? ` (${reason})` : ""} - its servers may be having trouble.`, timedOut ? 504 : 502);
    failure.dropped = !timedOut;
    throw failure;
  }
  if (response.status === 401 || response.status === 403) throw clientError("SimpleFIN no longer accepts this connection - remove it and link again.", 409);
  if (!response.ok) throw clientError(`SimpleFIN is unavailable right now (HTTP ${response.status}).`, 502);
  const body = await response.json().catch(() => ({}));
  return { errors: Array.isArray(body.errors) ? body.errors.map(String) : [], accounts: Array.isArray(body.accounts) ? body.accounts : [] };
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 10);
}

function normalizeSimplefinAccount(account) {
  return {
    remoteId: String(account.id),
    name: String(account.name || "Account"),
    orgName: String(account.org?.name || account.org?.domain || ""),
    currency: String(account.currency || "USD"),
    balance: numberOrNull(account.balance),
    balanceDate: account["balance-date"] ? isoDate(account["balance-date"]) : ""
  };
}

// SimpleFIN amounts are signed from the account's point of view (deposit +, withdrawal -); the app's convention is the opposite:
// positive = money out. Pending rows have posted = 0, so they fall back to transacted_at or today.
function normalizeSimplefinTransactions(account, { today = new Date() } = {}) {
  return (account.transactions || []).map((transaction) => {
    const amount = numberOrNull(transaction.amount);
    if (amount === null) return null;
    const stamp = Number(transaction.posted) > 0 ? transaction.posted : (Number(transaction.transacted_at) > 0 ? transaction.transacted_at : null);
    return {
      externalId: `sf:${account.id}:${transaction.id}`,
      remoteAccountId: String(account.id),
      date: stamp ? isoDate(stamp) : today.toISOString().slice(0, 10),
      payee: String(transaction.description || transaction.memo || "Unknown").trim().slice(0, 200),
      amount: -amount,
      pending: Boolean(transaction.pending) || !(Number(transaction.posted) > 0)
    };
  }).filter(Boolean);
}

// Walks [startDate, endDate] in windows the Bridge accepts and merges the results by account (transactions de-duplicated by id).
async function syncSimplefin(accessUrl, { startUnix, endUnix, allowPartial = false }, options = {}) {
  const windowSeconds = SIMPLEFIN_WINDOW_DAYS * 86400;
  const accounts = new Map();
  const errors = [];
  // A range the Bridge fails on (timeout or a server error) is split in half and each half tried again, twice over, so one slow stretch of
  // history does not cost the whole import. What still fails is reported (failedWindows); a sync that is not allowed to be partial (the
  // nightly job, whose next run starts from where this one ended) fails instead, so nothing is silently skipped.
  const queue = [];
  for (let start = startUnix; start < endUnix; start += windowSeconds) queue.push({ start, end: Math.min(start + windowSeconds, endUnix), depth: 0 });
  const failedWindows = [];
  const retriedDrop = new Set();
  let succeeded = 0;
  let lastFailure = null;
  while (queue.length) {
    const { start, end, depth } = queue.shift();
    let result;
    try {
      result = await fetchSimplefinAccounts(accessUrl, { "start-date": start, "end-date": end, pending: 1 }, options);
    } catch (error) {
      if (error.statusCode === 409) throw error;
      lastFailure = error;
      console.warn(`SimpleFIN window ${new Date(start * 1000).toISOString().slice(0, 10)}..${new Date(end * 1000).toISOString().slice(0, 10)} failed: ${error.message}`);
      if (allowPartial && error.dropped && !retriedDrop.has(`${start}-${end}`)) {
        // A dropped connection says nothing about the size of the range: ask again once, after a short pause, before splitting it.
        retriedDrop.add(`${start}-${end}`);
        await new Promise((resolve) => setTimeout(resolve, options.retryPauseMs ?? 3000));
        queue.unshift({ start, end, depth });
      } else if (allowPartial && depth < 2 && end - start > 7 * 86400) {
        const middle = Math.floor((start + end) / 2);
        queue.unshift({ start, end: middle, depth: depth + 1 }, { start: middle, end, depth: depth + 1 });
      } else if (allowPartial) {
        failedWindows.push({ from: new Date(start * 1000).toISOString().slice(0, 10), to: new Date(end * 1000).toISOString().slice(0, 10), error: String(error.message || "") });
      } else {
        throw error;
      }
      continue;
    }
    succeeded += 1;
    errors.push(...result.errors);
    // What each request returned (counts and the Bridge's own messages, no credentials): the record for when an import comes back short.
    console.log(`SimpleFIN window ${new Date(start * 1000).toISOString().slice(0, 10)}..${new Date(end * 1000).toISOString().slice(0, 10)}: ${result.accounts.length} accounts, ${result.accounts.reduce((sum, account) => sum + (account.transactions || []).length, 0)} transactions${result.errors.length ? `, messages: ${result.errors.map((message) => String(message).slice(0, 160)).join(" | ")}` : ""}`);
    result.accounts.forEach((account) => {
      const existing = accounts.get(String(account.id));
      if (!existing) { accounts.set(String(account.id), { ...account, transactions: [...(account.transactions || [])] }); return; }
      const seen = new Set(existing.transactions.map((transaction) => transaction.id));
      (account.transactions || []).forEach((transaction) => { if (!seen.has(transaction.id)) existing.transactions.push(transaction); });
      existing.balance = account.balance;
      existing["balance-date"] = account["balance-date"];
    });
  }
  if (!succeeded) throw clientError(`SimpleFIN did not answer (${lastFailure?.message || "no reply"}) - its servers may be slow right now. Nothing was imported; try again in a few minutes.`, 502);
  const list = [...accounts.values()];
  const rowsByAccount = list.map((account) => normalizeSimplefinTransactions(account));
  return {
    errors: [...new Set(errors)],
    // Each account also reports how far back the bank actually returned rows, so a history import can say so when a bank holds less than was asked for.
    accounts: list.map((account, index) => {
      const dates = rowsByAccount[index].filter((row) => !row.pending).map((row) => row.date).sort();
      return { ...normalizeSimplefinAccount(account), transactionCount: rowsByAccount[index].length, oldestTransactionDate: dates[0] || "" };
    }),
    transactions: rowsByAccount.flat(),
    failedWindows
  };
}

// ---- SnapTrade ----------------------------------------------------------------------------------------------------

function snaptradeConfig(env) {
  const clientId = String(env.SNAPTRADE_CLIENT_ID || "").trim();
  const consumerKey = String(env.SNAPTRADE_CONSUMER_KEY || "").trim();
  if (!clientId || !consumerKey) return null;
  // A "personal" key identifies ONE SnapTrade user, so it can only ever serve one FamilyLoop owner; commercial keys register a
  // SnapTrade user per FamilyLoop user.
  const mode = String(env.SNAPTRADE_MODE || "personal").toLowerCase() === "commercial" ? "commercial" : "personal";
  return { clientId, consumerKey, mode, personalOwnerEmail: String(env.SNAPTRADE_PERSONAL_OWNER_EMAIL || "").trim().toLowerCase(), basePath: String(env.SNAPTRADE_BASE_URL || "").trim() };
}

function createSnaptradeClient(config) {
  const { Snaptrade, SnaptradeAuth } = require("snaptrade-typescript-sdk");
  const auth = config.mode === "commercial"
    ? SnaptradeAuth.commercialApiKey({ clientId: config.clientId, consumerKey: config.consumerKey })
    : SnaptradeAuth.personalApiKey({ clientId: config.clientId, consumerKey: config.consumerKey });
  return new Snaptrade({ auth, ...(config.basePath ? { basePath: config.basePath } : {}) });
}

// Thin, defensive adapter over the SDK: everything the routes need, normalized, so the rest of the code never touches SDK shapes.
function createSnaptradeAdapter(config, client = createSnaptradeClient(config)) {
  const userArgs = (credentials) => (config.mode === "commercial" ? { userId: credentials.userId, userSecret: credentials.userSecret } : {});
  return {
    async registerUser(userId) {
      if (config.mode !== "commercial") return {};
      const { data } = await client.authentication.registerSnapTradeUser({ userId });
      return { userId: data.userId || userId, userSecret: data.userSecret };
    },
    async portalUrl(credentials, customRedirect) {
      const { data } = await client.authentication.loginSnapTradeUser({ ...userArgs(credentials), connectionType: "read", immediateRedirect: false, ...(customRedirect ? { customRedirect } : {}) });
      const url = typeof data === "string" ? data : data?.redirectURI;
      if (!url) throw clientError("SnapTrade did not return a connection link.", 502);
      return url;
    },
    async listAccounts(credentials) {
      const { data } = await client.accountInformation.listUserAccounts(userArgs(credentials));
      return (Array.isArray(data) ? data : []).map((account) => ({
        remoteId: String(account.id),
        name: String(account.name || account.number || "Brokerage account"),
        orgName: String(account.institution_name || ""),
        currency: String(account.balance?.total?.currency || "USD"),
        balance: numberOrNull(account.balance?.total?.amount),
        balanceDate: ""
      }));
    },
    async positions(credentials, remoteAccountId) {
      const { data } = await client.accountInformation.getAllAccountPositions({ accountId: remoteAccountId, ...userArgs(credentials) });
      return normalizeSnaptradePositions(data?.results || (Array.isArray(data) ? data : []), remoteAccountId);
    },
    async cash(credentials, remoteAccountId) {
      const { data } = await client.accountInformation.getUserAccountBalance({ accountId: remoteAccountId, ...userArgs(credentials) });
      return (Array.isArray(data) ? data : []).reduce((sum, balance) => sum + (numberOrNull(balance.cash) || 0), 0);
    },
    async deleteUser(credentials) {
      if (config.mode !== "commercial" || !credentials.userId) return;
      await client.authentication.deleteSnapTradeUser({ userId: credentials.userId });
    }
  };
}

function normalizeSnaptradePositions(results, remoteAccountId) {
  return results.map((position) => {
    const instrument = position.instrument || position.symbol || {};
    const symbol = String(instrument.symbol?.symbol || instrument.symbol || instrument.raw_symbol || "").trim();
    const units = numberOrNull(position.units);
    if (!symbol || units === null || units === 0) return null;
    return {
      remoteAccountId: String(remoteAccountId),
      symbol,
      name: String(instrument.description || instrument.symbol?.description || symbol),
      units,
      price: numberOrNull(position.price) ?? 0,
      costBasis: numberOrNull(position.cost_basis ?? position.average_purchase_price) ?? 0,
      currency: String(position.currency?.code || position.currency || "USD"),
      holdingType: BROKERAGE_KINDS_AS_FUND.has(String(instrument.kind || "").toLowerCase()) ? "fund" : "stock"
    };
  }).filter(Boolean);
}

// ---- store (memory for tests/demo, Postgres in production) --------------------------------------------------------

// Remote accounts the user has not made a decision about yet: anything without a mapping entry. A deliberate "don't import" is stored
// as a { skipped: true } entry, so only genuinely new accounts show up here.
function findNewAccounts(remoteAccounts, mappings) {
  return (remoteAccounts || []).filter((account) => !Object.prototype.hasOwnProperty.call(mappings || {}, account.remoteId)).map((account) => ({ remoteId: account.remoteId, name: account.name, orgName: account.orgName || "" }));
}

const STAGED_RETENTION_DAYS = 120;
const STAGED_TRANSACTION_LIMIT = 3000;

// A history import asks for everything since a date, but a bank often holds less. For an account whose rows start well after the date asked
// for, the month the rows start in is only partly covered, and importing half a month would leave the ledger wrong in a way that is hard to
// spot - and double up when the person later imports that month from a statement. So rows dated before the first fully covered month are
// left out, and each such account is reported (the months missing, and where the bank's rows really start) so the person can import those
// months from a statement instead. A month counts as covered when the bank's rows start on its first three days or before. An account whose
// rows start within three weeks of the requested date, with only a few rows, or with none at all, is left alone.
const HISTORY_GAP_SLACK_DAYS = 21;
// An account with only a few rows in the whole range (a savings account with the odd interest credit) simply had nothing happen for weeks;
// that is not the bank holding less, so only an account with real activity is reported.
const HISTORY_GAP_MIN_ROWS = 5;

function trimPartialHistory(payload, sinceDate) {
  if (payload?.provider !== "simplefin" || !/^\d{4}-\d{2}-\d{2}$/.test(String(sinceDate || ""))) return { payload, gaps: [], coverage: {} };
  const oldestByAccount = new Map();
  const rowCounts = new Map();
  (payload.transactions || []).filter((transaction) => !transaction.pending).forEach((transaction) => {
    rowCounts.set(transaction.remoteAccountId, (rowCounts.get(transaction.remoteAccountId) || 0) + 1);
    const current = oldestByAccount.get(transaction.remoteAccountId);
    if (!current || transaction.date < current) oldestByAccount.set(transaction.remoteAccountId, transaction.date);
  });
  const since = Date.parse(`${sinceDate}T00:00:00Z`);
  const firstCovered = new Map();
  const gaps = [];
  for (const [remoteId, oldest] of oldestByAccount) {
    if (Date.parse(`${oldest}T00:00:00Z`) - since <= HISTORY_GAP_SLACK_DAYS * 86400000 || (rowCounts.get(remoteId) || 0) < HISTORY_GAP_MIN_ROWS) continue;
    const [year, month, day] = oldest.split("-").map(Number);
    // The month the rows start in counts only if they start in its first days; otherwise the first covered month is the next one.
    const next = day <= 3 ? { year, month } : month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    const boundary = `${next.year}-${String(next.month).padStart(2, "0")}-01`;
    firstCovered.set(remoteId, boundary);
    const lastMissing = next.month === 1 ? `${next.year - 1}-12` : `${next.year}-${String(next.month - 1).padStart(2, "0")}`;
    const account = (payload.accounts || []).find((item) => item.remoteId === remoteId);
    gaps.push({ remoteId, name: account?.name || "Account", fromMonth: sinceDate.slice(0, 7), toMonth: lastMissing, oldestReturned: oldest, skippedRows: 0 });
  }
  // Where each account's bank rows are complete from: the date asked for, or the first fully covered month when the bank returned less.
  const coverage = {};
  (payload.accounts || []).forEach((account) => { coverage[account.remoteId] = { from: firstCovered.get(account.remoteId) || sinceDate }; });
  if (!gaps.length) return { payload, gaps, coverage };
  const transactions = (payload.transactions || []).filter((transaction) => {
    const boundary = firstCovered.get(transaction.remoteAccountId);
    if (!boundary || transaction.date >= boundary) return true;
    gaps.find((gap) => gap.remoteId === transaction.remoteAccountId).skippedRows += 1;
    return false;
  });
  // A gap that only just misses the start (covered from the first month asked for) has nothing to report.
  return { payload: { ...payload, transactions }, gaps: gaps.filter((gap) => gap.toMonth >= gap.fromMonth), coverage };
}

// When the Bridge could not answer for some stretch of a history import even after retrying smaller ranges (failedWindows), the months those
// stretches touch are left out for every account - a month with a hole in the middle is as wrong as a half month - and each mapped account
// gets a gap to report, like the ones trimPartialHistory makes (oldestReturned is empty and reason is "timeout"). coverage moves up to the first
// month after the last failed one so "Synced from" never claims more than was loaded.
function gapsFromFailedWindows(payload, failedWindows, mappings) {
  if (!failedWindows?.length) return { payload, gaps: [], failedThrough: "" };
  const months = new Set();
  failedWindows.forEach((window) => {
    const [fromYear, fromMonth] = window.from.split("-").map(Number);
    const end = new Date(Date.parse(`${window.to}T00:00:00Z`) - 86400000);
    let year = fromYear;
    let month = fromMonth;
    while (year < end.getUTCFullYear() || (year === end.getUTCFullYear() && month <= end.getUTCMonth() + 1)) {
      months.add(`${year}-${String(month).padStart(2, "0")}`);
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
  });
  const sorted = [...months].sort();
  const ranges = [];
  sorted.forEach((month) => {
    const last = ranges[ranges.length - 1];
    const [y, m] = last ? last.to.split("-").map(Number) : [0, 0];
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    if (last && next === month) last.to = month; else ranges.push({ from: month, to: month });
  });
  const transactions = (payload.transactions || []).filter((transaction) => !months.has(String(transaction.date).slice(0, 7)));
  const gaps = [];
  Object.entries(mappings || {}).filter(([, mapping]) => mapping?.accountId).forEach(([remoteId]) => {
    const account = (payload.accounts || []).find((item) => item.remoteId === remoteId);
    ranges.forEach((range) => gaps.push({ remoteId, name: account?.name || "Account", fromMonth: range.from, toMonth: range.to, oldestReturned: "", reason: "timeout", skippedRows: (payload.transactions || []).filter((transaction) => transaction.remoteAccountId === remoteId && String(transaction.date).slice(0, 7) >= range.from && String(transaction.date).slice(0, 7) <= range.to).length }));
  });
  const lastFailed = sorted[sorted.length - 1];
  const [lastYear, lastMonth] = lastFailed.split("-").map(Number);
  const failedThrough = lastMonth === 12 ? `${lastYear + 1}-01-01` : `${lastYear}-${String(lastMonth + 1).padStart(2, "0")}-01`;
  return { payload: { ...payload, transactions }, gaps, failedThrough };
}

// Folds a fresh fetch into what is already staged (not yet applied by any client): SimpleFIN transactions accumulate by id (so nights
// the app was never opened are not lost, even past the Bridge's 60-day request window), and accounts/balances/errors are the latest
// snapshot; a SnapTrade payload is a snapshot of positions, so it simply replaces the old one.
function mergeStagedPayload(staged, payload, nowIso, { sinceDate } = {}) {
  const now = new Date(nowIso);
  let cutoff = new Date(now.getTime() - STAGED_RETENTION_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  // An explicit "import history from <date>" must not have the older part pruned straight back out again.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(sinceDate || "")) && sinceDate < cutoff) cutoff = sinceDate;
  if (payload.provider !== "simplefin") return { merged: { ...payload, stagedAt: nowIso }, newTransactionCount: 0 };
  const byId = new Map();
  (staged?.transactions || []).forEach((transaction) => byId.set(transaction.externalId, transaction));
  let newTransactionCount = 0;
  (payload.transactions || []).forEach((transaction) => {
    if (!byId.has(transaction.externalId)) newTransactionCount += 1;
    byId.set(transaction.externalId, transaction);
  });
  let transactions = [...byId.values()].filter((transaction) => transaction.date >= cutoff);
  if (transactions.length > STAGED_TRANSACTION_LIMIT) transactions = transactions.sort((a, b) => b.date.localeCompare(a.date)).slice(0, STAGED_TRANSACTION_LIMIT);
  return { merged: { provider: "simplefin", accounts: payload.accounts, transactions, errors: payload.errors || [], stagedAt: nowIso }, newTransactionCount };
}

// Every linked-feed row id the household already imported: remembered ids, ledger rows and drafts still waiting.
function knownExternalIds(appState) {
  const ids = new Set(Array.isArray(appState?.linkedImportedIds) ? appState.linkedImportedIds : []);
  (appState?.transactions || []).forEach((transaction) => { if (transaction?.externalId) ids.add(transaction.externalId); });
  (appState?.transactionInboxDrafts || []).forEach((draft) => { if (draft?.externalId) ids.add(draft.externalId); });
  return ids;
}

function createStore({ MEMORY_DB, memoryDb, pool }) {
  if (MEMORY_DB) memoryDb.linkedAccounts ||= [];
  const toRow = (row) => ({
    id: row.id, householdId: row.household_id, provider: row.provider, label: row.label, credentials: row.credentials,
    mappings: row.mappings || {}, newAccounts: row.new_accounts || [], staged: row.staged || {}, stagedAt: row.staged_at || null, lastRun: row.last_run || {}, status: row.status, lastSyncAt: row.last_sync_at || null, lastError: row.last_error || "", createdAt: row.created_at
  });
  return {
    async list(householdId) {
      if (MEMORY_DB) return memoryDb.linkedAccounts.filter((row) => row.household_id === householdId).map(toRow);
      return (await pool.query("SELECT * FROM linked_accounts WHERE household_id = $1 ORDER BY created_at", [householdId])).rows.map(toRow);
    },
    async listAll() {
      if (MEMORY_DB) return memoryDb.linkedAccounts.map(toRow);
      return (await pool.query("SELECT * FROM linked_accounts ORDER BY created_at")).rows.map(toRow);
    },
    async get(householdId, id) {
      if (MEMORY_DB) {
        const row = memoryDb.linkedAccounts.find((item) => item.id === id && item.household_id === householdId);
        return row ? toRow(row) : null;
      }
      const result = await pool.query("SELECT * FROM linked_accounts WHERE id = $1 AND household_id = $2", [id, householdId]);
      return result.rows[0] ? toRow(result.rows[0]) : null;
    },
    async create({ householdId, provider, label, credentials, createdBy }) {
      const id = crypto.randomUUID();
      if (MEMORY_DB) {
        memoryDb.linkedAccounts.push({ id, household_id: householdId, provider, label, credentials, mappings: {}, new_accounts: [], staged: {}, staged_at: null, status: "active", last_sync_at: null, last_error: "", created_by: createdBy, created_at: new Date().toISOString() });
      } else {
        await pool.query("INSERT INTO linked_accounts (id, household_id, provider, label, credentials, created_by) VALUES ($1, $2, $3, $4, $5, $6)", [id, householdId, provider, label, credentials, createdBy]);
      }
      return id;
    },
    async update(householdId, id, patch) {
      const columns = { label: "label", credentials: "credentials", mappings: "mappings", newAccounts: "new_accounts", staged: "staged", stagedAt: "staged_at", lastRun: "last_run", status: "status", lastSyncAt: "last_sync_at", lastError: "last_error" };
      const entries = Object.entries(patch).filter(([key]) => columns[key]);
      if (!entries.length) return;
      if (MEMORY_DB) {
        const row = memoryDb.linkedAccounts.find((item) => item.id === id && item.household_id === householdId);
        if (row) entries.forEach(([key, value]) => { row[columns[key]] = value; });
        return;
      }
      const sets = entries.map(([key], index) => `${columns[key]} = $${index + 3}`).join(", ");
      const values = entries.map(([key, value]) => (key === "mappings" || key === "newAccounts" || key === "staged" || key === "lastRun" ? JSON.stringify(value) : value));
      await pool.query(`UPDATE linked_accounts SET ${sets} WHERE id = $1 AND household_id = $2`, [id, householdId, ...values]);
    },
    async remove(householdId, id) {
      if (MEMORY_DB) { memoryDb.linkedAccounts = memoryDb.linkedAccounts.filter((row) => !(row.id === id && row.household_id === householdId)); return; }
      await pool.query("DELETE FROM linked_accounts WHERE id = $1 AND household_id = $2", [id, householdId]);
    }
  };
}

// ---- routes -------------------------------------------------------------------------------------------------------

function registerLinkedAccountRoutes({ app, requireSession, requireEditAccess, requireJobSecret, notifyHousehold, loadHouseholdState, stateStore = null, suggestBatch = null, MEMORY_DB, memoryDb, pool, env = process.env, snaptradeAdapterFactory = createSnaptradeAdapter, fetchImpl = fetch }) {
  const encryptionKey = String(env.LINK_ENCRYPTION_KEY || "").trim();
  const snaptrade = snaptradeConfig(env);
  const allowInsecureHosts = env.NODE_ENV === "test" && String(env.SIMPLEFIN_ALLOW_TEST_HOSTS || "") === "true";
  const store = createStore({ MEMORY_DB, memoryDb, pool });
  let adapter = null;
  const getAdapter = () => { adapter ||= snaptradeAdapterFactory(snaptrade); return adapter; };

  const requireConfigured = (req, res, next) => (encryptionKey ? next() : res.status(503).json({ error: "Linked accounts are not configured on this server" }));
  const sessionHouseholdId = (req) => req.sessionUser.household_id;
  const publicLink = (link) => ({ id: link.id, provider: link.provider, label: link.label, status: link.status, lastSyncAt: link.lastSyncAt, lastError: link.lastError, lastRun: link.lastRun || {}, mappings: link.mappings, newAccounts: link.newAccounts || [], stagedCount: Array.isArray(link.staged?.transactions) ? link.staged.transactions.length : 0, hasStaged: Boolean(link.stagedAt && Object.keys(link.staged || {}).length) });
  const wrap = (handler) => async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      return next(error);
    }
  };
  const loadLink = async (req, provider) => {
    const link = await store.get(sessionHouseholdId(req), req.params.id);
    if (!link || (provider && link.provider !== provider)) throw clientError("Linked account not found", 404);
    return link;
  };
  const credentialsOf = (link) => decryptJson(encryptionKey, link.credentials);
  const requireSnaptrade = () => { if (!snaptrade) throw clientError("Brokerage linking (SnapTrade) is not configured on this server", 503); };
  // touchLastSync is false when only listing accounts: that call fetches no transactions, so it must not move the point the next real
  // fetch starts from (otherwise the first sync after linking would only look back a few days instead of the default 30).
  const recordOutcome = (req, link, error, remoteAccounts, { touchLastSync = true } = {}) => store.update(sessionHouseholdId(req), link.id, error
    ? { lastError: error.message, ...(error.statusCode === 409 ? { status: "needs_reconnect" } : {}) }
    : { lastError: "", status: "active", ...(touchLastSync ? { lastSyncAt: new Date().toISOString() } : {}), ...(remoteAccounts ? { newAccounts: findNewAccounts(remoteAccounts, link.mappings) } : {}) });

  app.get("/api/linked-accounts", requireSession, wrap(async (req, res) => {
    const links = await store.list(sessionHouseholdId(req));
    res.json({
      configured: Boolean(encryptionKey),
      providers: { simplefin: Boolean(encryptionKey), snaptrade: Boolean(encryptionKey && snaptrade) },
      links: links.map(publicLink)
    });
  }));

  // -- SimpleFIN
  app.post("/api/linked-accounts/simplefin", requireSession, requireEditAccess, requireConfigured, wrap(async (req, res) => {
    const setupToken = String(req.body?.setupToken || "").trim();
    if (!setupToken) throw clientError("Paste the setup token from SimpleFIN Bridge.");
    const accessUrl = await claimSimplefinToken(setupToken, { fetchImpl, allowInsecureHosts });
    const id = await store.create({ householdId: sessionHouseholdId(req), provider: "simplefin", label: String(req.body?.label || "").trim().slice(0, 80) || "SimpleFIN Bridge", credentials: encryptJson(encryptionKey, { accessUrl }), createdBy: req.sessionUser.id });
    const link = await store.get(sessionHouseholdId(req), id);
    res.status(201).json({ link: publicLink(link) });
  }));

  // -- SnapTrade
  app.post("/api/linked-accounts/snaptrade", requireSession, requireEditAccess, requireConfigured, wrap(async (req, res) => {
    requireSnaptrade();
    if (snaptrade.mode === "personal" && (!snaptrade.personalOwnerEmail || snaptrade.personalOwnerEmail !== String(req.sessionUser.email || "").toLowerCase())) {
      throw clientError("This server's SnapTrade key is a personal key that belongs to one person, so only that person can link a brokerage.", 403);
    }
    const credentials = await getAdapter().registerUser(`familyloop-${crypto.randomUUID()}`);
    const id = await store.create({ householdId: sessionHouseholdId(req), provider: "snaptrade", label: String(req.body?.label || "").trim().slice(0, 80) || "Brokerage", credentials: encryptJson(encryptionKey, credentials), createdBy: req.sessionUser.id });
    const link = await store.get(sessionHouseholdId(req), id);
    const portalUrl = await getAdapter().portalUrl(credentials, String(req.body?.redirectUrl || "").trim() || undefined);
    res.status(201).json({ link: publicLink(link), portalUrl });
  }));

  app.post("/api/linked-accounts/:id/portal", requireSession, requireEditAccess, requireConfigured, wrap(async (req, res) => {
    requireSnaptrade();
    const link = await loadLink(req, "snaptrade");
    res.json({ portalUrl: await getAdapter().portalUrl(credentialsOf(link), String(req.body?.redirectUrl || "").trim() || undefined) });
  }));

  // -- shared
  app.get("/api/linked-accounts/:id/remote-accounts", requireSession, requireConfigured, wrap(async (req, res) => {
    const link = await loadLink(req);
    try {
      const credentials = credentialsOf(link);
      const accounts = link.provider === "simplefin"
        ? (await fetchSimplefinAccounts(credentials.accessUrl, { "balances-only": 1 }, { fetchImpl, allowInsecureHosts })).accounts.map(normalizeSimplefinAccount)
        : await getAdapter().listAccounts(credentials);
      await recordOutcome(req, link, null, accounts, { touchLastSync: false });
      res.json({ accounts });
    } catch (error) {
      await recordOutcome(req, link, error);
      throw error;
    }
  }));

  app.put("/api/linked-accounts/:id/mappings", requireSession, requireEditAccess, requireConfigured, wrap(async (req, res) => {
    const link = await loadLink(req);
    const input = req.body?.mappings;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw clientError("mappings must be an object of remote account id to a local choice");
    const mappings = {};
    Object.entries(input).slice(0, 200).forEach(([remoteId, value]) => {
      const accountId = String(value?.accountId || "").slice(0, 120);
      const groupId = String(value?.groupId || "").slice(0, 120);
      const groupName = String(value?.groupName || "").slice(0, 120);
      const debtId = String(value?.debtId || "").slice(0, 120);
      if (accountId || groupId || debtId) mappings[String(remoteId).slice(0, 200)] = { accountId, groupId, groupName, ...(debtId ? { debtId } : {}) };
      else if (value?.skipped === true) mappings[String(remoteId).slice(0, 200)] = { accountId: "", groupId: "", groupName: "", skipped: true };
    });
    // The client sends a decision (a destination or skipped) for every account it was shown, so nothing is "new" until SimpleFIN/SnapTrade
    // reports an account that was not in that list.
    // Changing which accounts are imported restarts the look-back (default 30 days) so a newly chosen account gets its recent history; rows
    // already imported are skipped by id on the client.
    await store.update(sessionHouseholdId(req), link.id, { mappings, newAccounts: [], lastSyncAt: null });
    res.json({ link: publicLink({ ...link, mappings, newAccounts: [] }) });
  }));

  // Fetches fresh data for a link: SimpleFIN since the last successful fetch (minus a few days of overlap) or an explicit date, SnapTrade as a
  // snapshot of positions for the mapped accounts.
  const fetchLinkPayload = async (link, { sinceDate, allowPartial = false } = {}) => {
    const credentials = credentialsOf(link);
    if (link.provider === "simplefin") {
      const nowUnix = Math.floor(Date.now() / 1000);
      const requested = String(sinceDate || "").trim();
      const requestedUnix = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? Math.floor(Date.parse(`${requested}T00:00:00Z`) / 1000) : null;
      const lastUnix = link.lastSyncAt ? Math.floor(new Date(link.lastSyncAt).getTime() / 1000) - SIMPLEFIN_OVERLAP_DAYS * 86400 : null;
      const startUnix = Math.max(requestedUnix ?? lastUnix ?? Math.floor(Date.parse(`${firstOfPreviousMonth()}T00:00:00Z`) / 1000), nowUnix - 365 * 86400);
      const result = await syncSimplefin(credentials.accessUrl, { startUnix, endUnix: nowUnix, allowPartial: Boolean(allowPartial) }, { fetchImpl, allowInsecureHosts });
      // Only accounts sent to a Wealth account import transactions (investment and loan accounts follow their balance only), so only those are staged.
      const wanted = new Set(Object.entries(link.mappings || {}).filter(([, mapping]) => mapping && mapping.accountId).map(([remoteId]) => remoteId));
      return { provider: "simplefin", accounts: result.accounts, transactions: result.transactions.filter((transaction) => wanted.has(transaction.remoteAccountId)), errors: result.errors, failedWindows: result.failedWindows || [] };
    }
    const accounts = await getAdapter().listAccounts(credentials);
    const mapped = accounts.filter((account) => link.mappings[account.remoteId] && !link.mappings[account.remoteId].skipped);
    const positions = [];
    const cash = {};
    for (const account of mapped) {
      positions.push(...await getAdapter().positions(credentials, account.remoteId));
      cash[account.remoteId] = await getAdapter().cash(credentials, account.remoteId);
    }
    return { provider: "snaptrade", accounts, positions, cash, errors: [] };
  };

  // Fetch, fold into whatever is already staged, and remember it before answering - so a response the client never manages to apply is
  // not lost: it stays staged until the client acknowledges (POST /:id/ack) that it has saved the result.
  app.post("/api/linked-accounts/:id/sync", requireSession, requireEditAccess, requireConfigured, wrap(async (req, res) => {
    const link = await loadLink(req);
    try {
      // A first sync reads from the first of last month, and is held to the same whole-months rule as a history import.
      const since = req.body?.sinceDate || (link.provider === "simplefin" && !link.lastSyncAt ? firstOfPreviousMonth() : "");
      const fetched = await fetchLinkPayload(link, { sinceDate: req.body?.sinceDate, allowPartial: Boolean(since) });
      const failed = gapsFromFailedWindows(fetched, fetched.failedWindows, link.mappings);
      const trimmed = trimPartialHistory(failed.payload, since);
      const payload = trimmed.payload;
      const gaps = [...failed.gaps, ...trimmed.gaps];
      const coverage = trimmed.coverage;
      if (failed.failedThrough) Object.values(coverage).forEach((entry) => { if (entry.from < failed.failedThrough) entry.from = failed.failedThrough; });
      const { merged } = mergeStagedPayload(link.staged, payload, new Date().toISOString(), { sinceDate: req.body?.sinceDate });
      await store.update(sessionHouseholdId(req), link.id, { staged: merged, stagedAt: merged.stagedAt });
      await recordOutcome(req, link, null, payload.accounts);
      res.json({ ...merged, ...(gaps.length ? { historyGaps: gaps } : {}), ...(Object.keys(coverage).length ? { coverage } : {}) });
    } catch (error) {
      await recordOutcome(req, link, error);
      throw error;
    }
  }));

  app.post("/api/linked-accounts/:id/ack", requireSession, requireEditAccess, requireConfigured, wrap(async (req, res) => {
    const link = await loadLink(req);
    const through = String(req.body?.stagedAt || "");
    // Only clears what the client actually applied: anything staged after that (a nightly run in between) stays for next time.
    if (through && link.stagedAt && new Date(link.stagedAt).getTime() <= new Date(through).getTime()) {
      await store.update(sessionHouseholdId(req), link.id, { staged: {}, stagedAt: null });
    }
    res.json({ ok: true });
  }));

  // Applies whatever is staged for a household straight to its saved state (new rows into Bank stream, balances to the bank, salary to a
  // paycheck, AI categories, safe rows into the ledger) so nobody has to open the app. The household is read with its version and written
  // back only if nobody saved in between (the AI calls take a while); if someone did, it starts again from their version, reusing the
  // answers it already has. Staged data is cleared only after the save lands, and a household can switch this off (linkedAutoApply: false).
  const autoApplyHousehold = async (householdId) => {
    if (!stateStore) return null;
    const aiCache = new Map();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const links = (await store.list(householdId)).filter((link) => link.status === "active" && link.stagedAt && Object.keys(link.staged || {}).length);
      if (!links.length) return { applied: 0, skipped: "nothing", perLink: {} };
      const loaded = await stateStore.load(householdId);
      if (!loaded) return null;
      if (loaded.state?.linkedAutoApply === false) return { applied: 0, skipped: "off", perLink: {} };
      const working = structuredClone(loaded.state);
      const outcomes = [];
      for (const link of links) {
        try {
          outcomes.push({ link, result: await applyLinkedPayload(working, link, link.staged, { suggest: suggestBatch, aiCache }) });
        } catch (error) {
          outcomes.push({ link, error });
        }
      }
      const applied = outcomes.filter((outcome) => outcome.result);
      for (const outcome of outcomes.filter((item) => item.error)) {
        await store.update(householdId, outcome.link.id, { lastError: `Could not apply new transactions automatically: ${String(outcome.error.message || "").slice(0, 200)}` });
      }
      const perLink = {};
      outcomes.forEach((outcome) => { perLink[outcome.link.id] = outcome.error ? { error: String(outcome.error.message || "").slice(0, 200) } : { imported: outcome.result.imported, added: outcome.result.added, left: outcome.result.left, uncategorized: outcome.result.uncategorized }; });
      if (!applied.length) return { applied: 0, added: 0, left: 0, imported: 0, perLink };
      if (!(await stateStore.saveIfVersion(householdId, working, loaded.version))) continue;
      for (const { link } of applied) {
        const fresh = await store.get(householdId, link.id);
        if (fresh?.stagedAt && link.stagedAt && new Date(fresh.stagedAt).getTime() <= new Date(link.stagedAt).getTime()) await store.update(householdId, link.id, { staged: {}, stagedAt: null });
      }
      const total = applied.reduce((sum, { result }) => ({ applied: sum.applied + 1, imported: sum.imported + result.imported, added: sum.added + result.added, left: sum.left + result.left, uncategorized: sum.uncategorized + result.uncategorized }), { applied: 0, imported: 0, added: 0, left: 0, uncategorized: 0 });
      // Counts only (no names or amounts): the record of what each night did, for when a morning looks wrong.
      console.log(`Overnight linked apply: household ${householdId} ${JSON.stringify({ ...total, reasons: Object.fromEntries(applied.flatMap(({ result }) => Object.entries(result.reasons))), aiNote: applied.map(({ result }) => result.aiNote).filter(Boolean)[0] || "" })}`);
      return { ...total, perLink };
    }
    return { applied: 0, skipped: "conflict", perLink: {} };
  };

  // The catch-up every night: whatever from a linked bank is still waiting in Bank stream gets another chance at the ledger, and bank rows that went
  // in marked "Needs a category" (the AI was busy) are offered to the AI again.
  const fillHousehold = async (householdId) => {
    if (!stateStore) return 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await stateStore.load(householdId);
      if (!loaded || loaded.state?.linkedAutoApply === false) return 0;
      const working = structuredClone(loaded.state);
      const retried = await retryWaitingDrafts(working, { suggest: suggestBatch, createId: uniqueIdFactory() });
      const filled = await fillUncategorizedLedgerRows(working, { suggest: suggestBatch });
      if (!filled && !retried.added) return 0;
      if (await stateStore.saveIfVersion(householdId, working, loaded.version)) {
        console.log(`Overnight catch-up: household ${householdId} ${JSON.stringify({ waitingAdded: retried.added, aiCategorized: filled })}`);
        return filled + retried.added;
      }
    }
    return 0;
  };

  // Nightly job (Cloud Scheduler, shared-secret): fetch every active link and stage the result, then apply it to each household's state
  // (autoApplyHousehold above; a household that turned that off, or an apply that failed, leaves it staged for the app to apply when it is
  // next opened). It tells the household's phones what was added, or that a bank connection needs signing in again.
  if (requireJobSecret) {
    app.post("/api/internal/linked-accounts/sync-all", requireJobSecret, async (req, res, next) => {
      try {
        if (!encryptionKey) return res.json({ skipped: "Linked accounts are not configured" });
        // The retry run (a second schedule a few hours after the main one) only picks up links whose last run did not finish cleanly or is old,
        // so a bank that was down overnight is tried again before the morning rather than waiting a whole day.
        const retry = Boolean(req.body?.retry);
        const freshEnough = (link) => link.lastRun?.ok === true && link.lastRun.at && Date.now() - new Date(link.lastRun.at).getTime() < 8 * 3600 * 1000;
        // A link that has never synced (or whose accounts were just changed) waits for its first sync in the app, where a bank that returns less
        // history than asked for is explained and has to be acknowledged before anything is imported.
        const links = (await store.listAll()).filter((link) => link.status === "active" && Object.keys(link.mappings || {}).length && !(link.provider === "snaptrade" && !snaptrade) && (link.provider !== "simplefin" || link.lastSyncAt) && !(retry && freshEnough(link)));
        const summary = { links: links.length, synced: 0, failed: 0, newTransactions: 0, reconnect: 0 };
        const byHousehold = new Map();
        const runs = new Map();
        for (const link of links) {
          const entry = byHousehold.get(link.householdId) || { newTransactions: 0, reconnect: [], failed: [], links: [] };
          byHousehold.set(link.householdId, entry);
          entry.links.push(link);
          const at = new Date().toISOString();
          try {
            const payload = await fetchLinkPayload(link);
            const { merged, newTransactionCount: stagedNew } = mergeStagedPayload(link.staged, payload, at);
            // Count only rows the household has not already imported (read-only look at its state), so the phone message is not inflated by
            // rows an app already applied and then cleared from staging.
            let newTransactionCount = stagedNew;
            if (loadHouseholdState && stagedNew) {
              const known = knownExternalIds(await loadHouseholdState(link.householdId));
              const previouslyStaged = new Set((link.staged?.transactions || []).map((transaction) => transaction.externalId));
              newTransactionCount = (payload.transactions || []).filter((transaction) => !previouslyStaged.has(transaction.externalId) && !known.has(transaction.externalId)).length;
            }
            runs.set(link.id, { at, ok: true, stage: "fetched", accounts: (payload.accounts || []).length, newRows: newTransactionCount, ...(retry ? { retry: true } : {}) });
            await store.update(link.householdId, link.id, { staged: merged, stagedAt: merged.stagedAt, lastError: "", status: "active", lastSyncAt: at, newAccounts: findNewAccounts(payload.accounts, link.mappings), lastRun: runs.get(link.id) });
            entry.newTransactions += newTransactionCount;
            summary.synced += 1;
            summary.newTransactions += newTransactionCount;
          } catch (error) {
            summary.failed += 1;
            const needsReconnect = error.statusCode === 409;
            const reason = String(error.message || "Sync failed").slice(0, 300);
            runs.set(link.id, { at, ok: false, stage: "fetch", error: reason, ...(needsReconnect ? { reconnect: true } : {}), ...(retry ? { retry: true } : {}) });
            await store.update(link.householdId, link.id, { lastError: reason, lastRun: runs.get(link.id), ...(needsReconnect ? { status: "needs_reconnect" } : {}) });
            if (needsReconnect) { entry.reconnect.push(link.label); summary.reconnect += 1; } else entry.failed.push(`${link.label}: ${reason}`);
          }
        }
        for (const [householdId, entry] of byHousehold) {
          try {
            const outcome = await autoApplyHousehold(householdId);
            if (outcome?.applied) { entry.autoApplied = outcome; summary.autoApplied = (summary.autoApplied || 0) + outcome.added; }
            await fillHousehold(householdId);
            // What each link ended the night with, so the apps can show whether the data really is loaded: applied, waiting for a person, or failed.
            for (const link of entry.links) {
              const run = runs.get(link.id);
              if (!run?.ok) continue;
              const result = outcome?.perLink?.[link.id];
              const finished = result?.error
                ? { ...run, ok: false, stage: "apply", error: `Could not load the new transactions: ${result.error}` }
                : result ? { ...run, stage: "applied", imported: result.imported, added: result.added, left: result.left }
                : outcome?.skipped === "off" ? { ...run, stage: "waiting", reason: "Automatic loading is switched off, so the new transactions wait for you to open the app." }
                : outcome?.skipped === "conflict" ? { ...run, ok: false, stage: "apply", error: "Your household was being edited while it loaded, so loading it was postponed." }
                : outcome ? { ...run, stage: "applied", imported: 0, added: 0, left: 0 } : run;
              runs.set(link.id, finished);
              await store.update(householdId, link.id, { lastRun: finished });
              if (!finished.ok) entry.failed.push(`${link.label}: ${finished.error}`);
            }
          } catch (error) {
            console.warn("Automatic apply of linked transactions failed", error.message);
            for (const link of entry.links) {
              if (runs.get(link.id)?.ok) { const failed = { ...runs.get(link.id), ok: false, stage: "apply", error: `Could not load the new transactions: ${String(error.message || "").slice(0, 200)}` }; runs.set(link.id, failed); await store.update(householdId, link.id, { lastRun: failed }).catch(() => undefined); entry.failed.push(`${link.label}: ${failed.error}`); }
            }
          }
        }
        if (notifyHousehold) {
          for (const [householdId, entry] of byHousehold) {
            try {
              if (entry.autoApplied?.imported > 0) await notifyHousehold(householdId, `${entry.autoApplied.added} new bank transaction${entry.autoApplied.added === 1 ? "" : "s"} added to your ledger${entry.autoApplied.left ? `, ${entry.autoApplied.left} need a look` : ""}`);
              else if (entry.newTransactions > 0) await notifyHousehold(householdId, `${entry.newTransactions} new bank transaction${entry.newTransactions === 1 ? "" : "s"} waiting to review`);
              if (entry.reconnect.length) await notifyHousehold(householdId, `${entry.reconnect.join(", ")} needs signing in again - open Wealth to relink`);
              if (entry.failed.length) await notifyHousehold(householdId, `Overnight bank sync did not finish: ${entry.failed.join("; ").slice(0, 180)}`);
            } catch (error) { console.warn("Linked-account notification failed", error.message); }
          }
        }
        res.json({ ok: true, ...summary });
      } catch (error) {
        next(error);
      }
    });
  }

  app.delete("/api/linked-accounts/:id", requireSession, requireEditAccess, wrap(async (req, res) => {
    const link = await loadLink(req);
    if (link.provider === "snaptrade" && snaptrade && encryptionKey) {
      try { await getAdapter().deleteUser(credentialsOf(link)); } catch (error) { console.warn("Could not delete SnapTrade user", error.message); }
    }
    await store.remove(sessionHouseholdId(req), link.id);
    res.json({ ok: true });
  }));
}

module.exports = {
  registerLinkedAccountRoutes, trimPartialHistory, gapsFromFailedWindows, syncSimplefin, firstOfPreviousMonth, mergeStagedPayload, knownExternalIds, findNewAccounts, encryptJson, decryptJson, claimSimplefinToken, syncSimplefin, normalizeSimplefinAccount,
  normalizeSimplefinTransactions, normalizeSnaptradePositions, snaptradeConfig, assertSimplefinUrl
};
