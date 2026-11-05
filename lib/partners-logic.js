// Property partners: several people put money into one checking account that collects the rent and pays the loans, HOA and repairs of shared
// rental properties. This turns that account's ledger into (1) a profit-and-loss per property and (2) a ledger per partner: what each one sent, what
// their share of the result is, and who should send or receive to square up. Pure functions; the Partners page in app.js only renders them.
//
// Amount convention (the whole app): a positive transaction amount is money OUT of the account, a negative one is money IN.
// Loaded as a classic script beside shared-logic.js and app.js, so every top-level name here starts with `partners` / `PARTNER` to stay unique.

const PARTNER_KINDS = [
  { id: "rent", label: "Rent received", direction: "in", group: "income" },
  { id: "other_income", label: "Other income (late fees, deposits kept...)", direction: "in", group: "income" },
  { id: "interest", label: "Interest earned", direction: "in", group: "income" },
  { id: "loan", label: "Loan payment", direction: "out", group: "cost" },
  { id: "hoa", label: "HOA / dues", direction: "out", group: "cost" },
  { id: "repair", label: "Repairs and upkeep", direction: "out", group: "cost" },
  { id: "tax", label: "Property tax", direction: "out", group: "cost" },
  { id: "insurance", label: "Insurance", direction: "out", group: "cost" },
  { id: "utilities", label: "Utilities", direction: "out", group: "cost" },
  { id: "management", label: "Management / agent fees", direction: "out", group: "cost" },
  { id: "expense", label: "Other property expense", direction: "out", group: "cost" },
  { id: "contribution", label: "Partner contribution", direction: "in", group: "partner" },
  { id: "withdrawal", label: "Withdrawal to a partner", direction: "out", group: "partner" },
  { id: "personal", label: "Personal (leave out of the books)", direction: "none", group: "leave" }
];

// The built-in kinds plus any the group added itself (setup.customKinds: [{ id, label, group: "income" | "cost" }]).
function partnersKindList(config) {
  const custom = ((config && config.customKinds) || []).map((kind) => ({ id: kind.id, label: kind.label, direction: kind.group === "income" ? "in" : "out", group: kind.group === "income" ? "income" : "cost", custom: true }));
  return [...PARTNER_KINDS, ...custom];
}

const PARTNER_MAX_ITEMS = 60;
const PARTNER_MAX_RULES = 400;

function partnersCents(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

// Lowercase words only, so "ZELLE FROM Jane Q Sample ON 09/01 REF # X" and "jane q sample" compare, and "1234567890-0021" contains "1234567890".
function partnersNormalize(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// A rule matches when EVERY word of its text appears as a whole word in the payee (any order), so "loanco 1234567890" finds
// "LOANCO CASH Aug 26 1234567890-0021 Name" and a number never matches inside a longer one.
function partnersRuleMatches(rule, payee) {
  const needle = partnersNormalize(rule && rule.match);
  if (!needle) return false;
  const words = new Set(partnersNormalize(payee).split(" "));
  return needle.split(" ").every((word) => words.has(word));
}

// A stable id for one row, so a choice made for just that row (an override) finds it again: the bank's transaction id when there is one, otherwise
// the date, amount and the start of the payee.
function partnersRowId(transaction) {
  if (transaction && transaction.externalId) return `x:${transaction.externalId}`;
  return `d:${transaction && transaction.date}|${partnersCents(transaction && transaction.amount).toFixed(2)}|${partnersNormalize(transaction && transaction.payee).slice(0, 60)}`;
}

// What a row is counted as: a choice made for that one row wins; otherwise the first rule (in list order, so put specific ones first) that matches
// the payee decides. Returns { kind, propertyId, partnerId, ruleId, overridden } or null.
function classifyPartnerRow(transaction, rules, overrides) {
  const own = overrides && overrides[partnersRowId(transaction)];
  if (own && own.kind) return { kind: own.kind, propertyId: own.propertyId || "", partnerId: own.partnerId || "", ruleId: "", overridden: true };
  const rule = (rules || []).find((item) => partnersRuleMatches(item, transaction && transaction.payee));
  return rule ? { kind: rule.kind, propertyId: rule.propertyId || "", partnerId: rule.partnerId || "", ruleId: rule.id, overridden: false } : null;
}

// Percentages for one property, normalised to add up to 100 (an empty or all-zero set means an equal split). partners = [{id}].
function partnersSharesFor(config, propertyId) {
  const partners = (config && config.partners) || [];
  if (!partners.length) return {};
  const source = (propertyId && config.shares && config.shares[propertyId]) || (config.defaultShares) || {};
  const raw = partners.map((partner) => Math.max(0, Number(source[partner.id]) || 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  const result = {};
  partners.forEach((partner, index) => { result[partner.id] = sum > 0 ? (raw[index] / sum) * 100 : 100 / partners.length; });
  return result;
}

function partnersMonthKey(dateKey) {
  return String(dateKey || "").slice(0, 7);
}

// config: { properties: [{id,name}], partners: [{id,name}], shares: {propertyId: {partnerId: pct}}, defaultShares: {partnerId: pct}, rules: [...], accountIds: [] }
// range: { fromMonth, toMonth } (inclusive "YYYY-MM"; either may be empty for open-ended)
function buildPartnersStatement(config, transactions, range = {}) {
  const properties = (config && config.properties) || [];
  const partners = (config && config.partners) || [];
  const accountIds = (config && config.accountIds) || [];
  const rules = (config && config.rules) || [];
  const overrides = (config && config.overrides) || {};
  const kinds = partnersKindList(config);
  const kindOf = (id) => kinds.find((kind) => kind.id === id);
  const fromMonth = range.fromMonth || "";
  const toMonth = range.toMonth || "";

  const propertyBuckets = new Map();
  const bucketFor = (propertyId) => {
    const key = propertyId && properties.some((property) => property.id === propertyId) ? propertyId : "";
    if (!propertyBuckets.has(key)) {
      const property = properties.find((item) => item.id === key);
      propertyBuckets.set(key, { id: key, name: property ? property.name : "Shared / not assigned to a property", income: 0, loan: 0, hoa: 0, repair: 0, expense: 0 });
    }
    return propertyBuckets.get(key);
  };
  properties.forEach((property) => bucketFor(property.id));

  const monthMap = new Map();
  const monthFor = (month) => {
    if (!monthMap.has(month)) monthMap.set(month, { month, income: 0, expenses: 0, net: 0, contributions: 0, withdrawals: 0 });
    return monthMap.get(month);
  };
  const contributed = new Map(partners.map((partner) => [partner.id, 0]));
  const withdrawn = new Map(partners.map((partner) => [partner.id, 0]));
  const byKind = new Map();
  const addKind = (id, value) => byKind.set(id, partnersCents((byKind.get(id) || 0) + value));
  let unassignedContributions = 0;
  let unassignedWithdrawals = 0;
  const unclassified = [];
  const entries = [];
  let personalCount = 0;
  let rowCount = 0;

  (transactions || []).forEach((transaction) => {
    if (accountIds.length && !accountIds.includes(transaction.accountId)) return;
    const month = partnersMonthKey(transaction.date);
    if (!month || (fromMonth && month < fromMonth) || (toMonth && month > toMonth)) return;
    const rowId = partnersRowId(transaction);
    const own = overrides[rowId];
    // A row's amount can be corrected on the page (own.amount is money IN: positive in, negative out); the bank's own figure stays on record.
    const edited = Boolean(own) && own.amount !== undefined && own.amount !== null && Number.isFinite(Number(own.amount));
    const amount = edited ? -Number(own.amount) : Number(transaction.amount);
    if (!Number.isFinite(amount) || amount === 0) return;
    rowCount += 1;
    const verdict = classifyPartnerRow(transaction, rules, overrides);
    entries.push({
      rowId, date: transaction.date, payee: transaction.payee, money: -amount, originalMoney: -Number(transaction.amount), edited, manual: transaction.source === "manual", rowRef: transaction.id || "",
      kind: verdict ? verdict.kind : "", propertyId: verdict ? verdict.propertyId : "", partnerId: verdict ? verdict.partnerId : "", overridden: Boolean(verdict && verdict.overridden)
    });
    if (!verdict) { unclassified.push(transaction); return; }
    const kind = kindOf(verdict.kind);
    if (!kind) { unclassified.push(transaction); return; }
    if (kind.group === "leave") { personalCount += 1; return; }
    const monthly = monthFor(month);
    if (kind.id === "contribution") {
      const money = -amount;
      monthly.contributions = partnersCents(monthly.contributions + money);
      addKind(kind.id, money);
      if (contributed.has(verdict.partnerId)) contributed.set(verdict.partnerId, partnersCents(contributed.get(verdict.partnerId) + money));
      else unassignedContributions = partnersCents(unassignedContributions + money);
      return;
    }
    if (kind.id === "withdrawal") {
      monthly.withdrawals = partnersCents(monthly.withdrawals + amount);
      addKind(kind.id, amount);
      if (withdrawn.has(verdict.partnerId)) withdrawn.set(verdict.partnerId, partnersCents(withdrawn.get(verdict.partnerId) + amount));
      else unassignedWithdrawals = partnersCents(unassignedWithdrawals + amount);
      return;
    }
    const bucket = bucketFor(verdict.propertyId);
    if (kind.group === "income") {
      bucket.income = partnersCents(bucket.income - amount);
      monthly.income = partnersCents(monthly.income - amount);
      addKind(kind.id, -amount);
    } else {
      // Loans, HOA and repairs have their own columns; every other cost (tax, insurance, a category the group made up...) is in "other".
      const column = ["loan", "hoa", "repair"].includes(kind.id) ? kind.id : "expense";
      bucket[column] = partnersCents(bucket[column] + amount);
      monthly.expenses = partnersCents(monthly.expenses + amount);
      addKind(kind.id, amount);
    }
  });

  const propertyRows = [...propertyBuckets.values()]
    .filter((bucket) => bucket.id || bucket.income || bucket.loan || bucket.hoa || bucket.repair || bucket.expense)
    .map((bucket) => {
      const expenses = partnersCents(bucket.loan + bucket.hoa + bucket.repair + bucket.expense);
      return { ...bucket, expenses, net: partnersCents(bucket.income - expenses) };
    });
  const months = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)).map((row) => ({ ...row, net: partnersCents(row.income - row.expenses) }));

  const poolIncome = partnersCents(propertyRows.reduce((sum, row) => sum + row.income, 0));
  const poolExpenses = partnersCents(propertyRows.reduce((sum, row) => sum + row.expenses, 0));
  const poolNet = partnersCents(poolIncome - poolExpenses);
  const totalContributed = partnersCents([...contributed.values()].reduce((a, b) => a + b, 0) + unassignedContributions);
  const totalWithdrawn = partnersCents([...withdrawn.values()].reduce((a, b) => a + b, 0) + unassignedWithdrawals);
  const netIn = partnersCents(totalContributed - totalWithdrawn);

  // Each partner's share of each property's result, and their overall percentage (properties weighted by what they cost to run, so a
  // partner who owns more of the expensive property carries more of the pool).
  const weightTotal = propertyRows.reduce((sum, row) => sum + row.expenses, 0);
  const partnerRows = partners.map((partner) => {
    let share = 0;
    let effective = 0;
    propertyRows.forEach((row) => {
      const pct = (partnersSharesFor(config, row.id)[partner.id] || 0) / 100;
      share += pct * row.net;
      effective += pct * (weightTotal > 0 ? row.expenses / weightTotal : 1 / propertyRows.length);
    });
    if (!propertyRows.length) effective = 1 / partners.length;
    const sent = contributed.get(partner.id) || 0;
    const taken = withdrawn.get(partner.id) || 0;
    // A partner's balance is what they put in, less what they took out, plus their share of the result.
    return { id: partner.id, name: partner.name, contributed: sent, withdrawn: taken, share: partnersCents(share), balance: partnersCents(sent - taken + share), effectivePct: effective * 100 };
  });
  // To square up: if the money the partners put in (less what they took out) were shared by ownership, who should send more and who should get some back.
  partnerRows.forEach((row) => { row.toSquare = partnersCents((row.effectivePct / 100) * netIn - (row.contributed - row.withdrawn)); });

  // What each should send next month: their share of the average monthly shortfall over the last three months in which costs were paid (a month
  // that so far has only rent in it is not a full month, and would hide the shortfall).
  const recent = months.filter((row) => row.expenses > 0).slice(-3);
  const averageNet = recent.length ? recent.reduce((sum, row) => sum + row.net, 0) / recent.length : 0;
  const averageShortfall = partnersCents(Math.max(0, -averageNet));
  partnerRows.forEach((row) => { row.suggested = partnersCents((row.effectivePct / 100) * averageShortfall); });

  entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const kindTotals = kinds.filter((kind) => byKind.has(kind.id)).map((kind) => ({ id: kind.id, label: kind.label, group: kind.group, total: byKind.get(kind.id) }));
  return {
    months, properties: propertyRows, partners: partnerRows, unclassified, entries, personalCount, rowCount, unassignedContributions, unassignedWithdrawals, byKind: kindTotals,
    pool: { income: poolIncome, expenses: poolExpenses, net: poolNet, contributions: totalContributed, withdrawals: totalWithdrawn, cash: partnersCents(netIn + poolNet) },
    averageShortfall
  };
}

// ---- Rows that live only on the Partners page ----
// A bank account mapped to "Partners page (not in Wealth)" gets this pseudo account id in the link's mappings. Its rows never enter the ledger,
// Bank stream, budget or net worth; they are kept in state.partnerTransactions as { date, payee, amount, externalId?, source? } (app sign convention:
// money out is positive) and read only by the Partners page.
const PARTNERS_POOL_ID = "partners-pool";

const partnersShared = typeof require !== "undefined" ? require("./shared-logic") : null;
const partnersCsvParse = (text) => (typeof parseDelimitedText === "function" ? parseDelimitedText(text) : partnersShared.parseDelimitedText(text));
// M/D/YY, M/D/YYYY and YYYY-MM-DD (banks write two-digit years); anything else, or a day that does not exist, is "".
function partnersCsvDate(value) {
  const text = String(value || "").trim();
  let year; let month; let day;
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (match) { month = Number(match[1]); day = Number(match[2]); year = Number(match[3]); if (year < 100) year += 2000; }
  else if ((match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text))) { year = Number(match[1]); month = Number(match[2]); day = Number(match[3]); }
  else return "";
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function partnersRowKey(row) {
  return `${row.date}|${partnersCents(row.amount).toFixed(2)}`;
}

// Rows arriving from the bank link. A row whose id is already here is skipped. A bank row with the same date and amount as an earlier row that
// came from a CSV (and has not been matched to a bank row yet) is that same transaction: the CSV row takes the bank's id instead of a copy being added.
function partnersMergeBankRows(existing, incoming) {
  const rows = (existing || []).map((row) => ({ ...row }));
  const known = new Set(rows.map((row) => row.externalId).filter(Boolean));
  let added = 0;
  (incoming || []).forEach((row) => {
    if (row.externalId && known.has(row.externalId)) return;
    const twin = rows.find((item) => item.source === "csv" && !item.externalId && partnersRowKey(item) === partnersRowKey(row));
    if (twin) { twin.externalId = row.externalId; known.add(row.externalId); return; }
    rows.push({ date: row.date, payee: String(row.payee || "").slice(0, 200), amount: Number(row.amount), externalId: row.externalId || "", source: "bank" });
    if (row.externalId) known.add(row.externalId);
    added += 1;
  });
  return { rows, added };
}

// Rows from a CSV (older history). Per date and amount, only as many rows are added as the file has more than are already here, so importing the
// same statement twice, or one that overlaps what the bank link already brought, adds nothing twice.
function partnersMergeCsvRows(existing, incoming) {
  const rows = (existing || []).map((row) => ({ ...row }));
  const have = new Map();
  rows.forEach((row) => have.set(partnersRowKey(row), (have.get(partnersRowKey(row)) || 0) + 1));
  const incomingCount = new Map();
  let added = 0;
  (incoming || []).forEach((row) => {
    const key = partnersRowKey(row);
    const seen = (incomingCount.get(key) || 0) + 1;
    incomingCount.set(key, seen);
    if (seen <= (have.get(key) || 0)) return;
    rows.push({ date: row.date, payee: String(row.payee || "").slice(0, 200), amount: Number(row.amount), externalId: "", source: "csv" });
    added += 1;
  });
  return { rows, added, skipped: (incoming || []).length - added };
}

// A bank statement CSV with Date, Description and Amount columns (other columns are ignored). Amounts are read the way a checking or savings
// statement shows them: money IN is positive; set moneyInPositive false for a file that shows money out as positive. Returns app-sign rows.
function partnersParseCsv(text, { moneyInPositive = true } = {}) {
  const table = partnersCsvParse(String(text || "")).filter((row) => row.some((cell) => String(cell || "").trim() !== ""));
  const names = (row) => row.map((cell) => String(cell || "").trim().toLowerCase());
  const headerIndex = table.findIndex((row) => {
    const cells = names(row);
    return cells.includes("date") && cells.some((cell) => ["description", "payee", "memo", "details", "name"].includes(cell)) && cells.includes("amount");
  });
  if (headerIndex === -1) return { rows: [], skipped: table.length, problem: "No Date, Description and Amount columns were found." };
  const header = names(table[headerIndex]);
  const dateAt = header.indexOf("date");
  const payeeAt = header.findIndex((cell) => ["description", "payee", "memo", "details", "name"].includes(cell));
  const amountAt = header.indexOf("amount");
  const rows = [];
  let skipped = 0;
  table.slice(headerIndex + 1).forEach((row) => {
    const date = partnersCsvDate(row[dateAt]);
    const amount = Number(String(row[amountAt] || "").replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
    if (!date || !Number.isFinite(amount) || amount === 0) { skipped += 1; return; }
    rows.push({ date, payee: String(row[payeeAt] || "").trim().slice(0, 200), amount: moneyInPositive ? -amount : amount });
  });
  return { rows, skipped, problem: "" };
}

// The "Make rule" helper: the part of a payee worth matching on. Long bank strings carry changing reference numbers and dates, so this keeps the
// first few words that are not noise ("ZELLE FROM JANE Q SAMPLE ON 09/01 REF # ABC123" -> "zelle from jane q sample").
function partnersSuggestMatch(payee) {
  const words = partnersNormalize(payee).split(" ").filter(Boolean);
  const out = [];
  for (const word of words) {
    if (out.length && (word === "on" || word === "ref" || /^\d/.test(word) && word.length >= 5 && !/[a-z]/.test(word))) break;
    out.push(word);
    if (out.length >= 5) break;
  }
  return out.join(" ");
}

// The AI's answer for the Partners page: a JSON array of { id, kind, propertyId, partnerId, confidence }. Only ids this request offered are kept; a kind
// the page does not know, or a property or partner that was not offered, is dropped; anything but a clearly stated "high" is treated as unsure.
function partnersParseAiSuggestions(text, rowIds, propertyIds, partnerIds, kindIds) {
  const raw = String(text || "");
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_error) { return []; }
  if (!Array.isArray(parsed)) return [];
  const rows = new Set(rowIds);
  const properties = new Set(propertyIds);
  const partners = new Set(partnerIds);
  const kinds = new Set(kindIds || PARTNER_KINDS.map((kind) => kind.id));
  const seen = new Set();
  const results = [];
  parsed.forEach((item) => {
    const id = String(item && item.id != null ? item.id : "");
    if (!rows.has(id) || seen.has(id)) return;
    seen.add(id);
    const kind = kinds.has(item && item.kind) ? item.kind : "";
    results.push({
      id, kind,
      propertyId: properties.has(String(item && item.propertyId)) ? String(item.propertyId) : "",
      partnerId: partners.has(String(item && item.partnerId)) ? String(item.partnerId) : "",
      confidence: kind && item.confidence === "high" ? "high" : "low"
    });
  });
  return results;
}

// A saved setup comes back from the browser (or a JSON file someone imports) as plain data; this keeps only what the page understands.
function partnersSanitizeConfig(raw) {
  const text = (value, max = 80) => String(value == null ? "" : value).slice(0, max);
  const id = (value, fallback) => text(value || fallback, 60).replace(/[^A-Za-z0-9_-]/g, "") || fallback;
  const data = raw && typeof raw === "object" ? raw : {};
  const properties = (Array.isArray(data.properties) ? data.properties : []).slice(0, PARTNER_MAX_ITEMS).map((item, index) => ({ id: id(item && item.id, `prop${index + 1}`), name: text(item && item.name) || `Property ${index + 1}` }));
  const emailOf = (value) => { const email = text(value, 200).trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ""; };
  const partners = (Array.isArray(data.partners) ? data.partners : []).slice(0, PARTNER_MAX_ITEMS).map((item, index) => ({ id: id(item && item.id, `partner${index + 1}`), name: text(item && item.name) || `Partner ${index + 1}`, email: emailOf(item && item.email) }));
  const percent = (value) => Math.min(100, Math.max(0, Number(value) || 0));
  const shares = {};
  properties.forEach((property) => {
    const source = (data.shares && data.shares[property.id]) || {};
    shares[property.id] = Object.fromEntries(partners.map((partner) => [partner.id, percent(source[partner.id])]));
  });
  const defaultShares = Object.fromEntries(partners.map((partner) => [partner.id, percent(data.defaultShares && data.defaultShares[partner.id])]));
  const customKinds = [];
  (Array.isArray(data.customKinds) ? data.customKinds : []).slice(0, 30).forEach((item, index) => {
    const label = text(item && item.label, 40).trim();
    const kindId = id(item && item.id, `c-${index + 1}`);
    if (!label || customKinds.some((kind) => kind.id === kindId) || PARTNER_KINDS.some((kind) => kind.id === kindId)) return;
    customKinds.push({ id: kindId, label, group: item && item.group === "income" ? "income" : "cost" });
  });
  const kinds = new Set([...PARTNER_KINDS.map((kind) => kind.id), ...customKinds.map((kind) => kind.id)]);
  const propertyIds = new Set(properties.map((property) => property.id));
  const partnerIds = new Set(partners.map((partner) => partner.id));
  const rules = (Array.isArray(data.rules) ? data.rules : []).slice(0, PARTNER_MAX_RULES)
    .filter((rule) => rule && kinds.has(rule.kind) && partnersNormalize(rule.match))
    .map((rule, index) => ({
      id: id(rule.id, `rule${index + 1}`), match: text(rule.match, 100), kind: rule.kind,
      propertyId: propertyIds.has(rule.propertyId) ? rule.propertyId : "", partnerId: partnerIds.has(rule.partnerId) ? rule.partnerId : ""
    }));
  const overrides = {};
  Object.entries(data.overrides && typeof data.overrides === "object" ? data.overrides : {}).slice(0, 3000).forEach(([rowId, value]) => {
    if (!value) return;
    const hasKind = kinds.has(value.kind);
    const hasAmount = value.amount !== undefined && value.amount !== null && value.amount !== "" && Number.isFinite(Number(value.amount)) && Math.abs(Number(value.amount)) < 1e9;
    if (!hasKind && !hasAmount) return;
    overrides[text(rowId, 200)] = {
      ...(hasKind ? { kind: value.kind, propertyId: propertyIds.has(value.propertyId) ? value.propertyId : "", partnerId: partnerIds.has(value.partnerId) ? value.partnerId : "" } : {}),
      ...(hasAmount ? { amount: Math.round(Number(value.amount) * 100) / 100 } : {})
    };
  });
  const accountIds = (Array.isArray(data.accountIds) ? data.accountIds : []).slice(0, 20).map((value) => text(value, 80)).filter(Boolean);
  return { properties, partners, shares, defaultShares, rules, overrides, customKinds, accountIds };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { partnersKindList, PARTNERS_POOL_ID, partnersParseAiSuggestions, partnersRowId, partnersMergeBankRows, partnersMergeCsvRows, partnersParseCsv, PARTNER_KINDS, partnersNormalize, classifyPartnerRow, partnersSharesFor, buildPartnersStatement, partnersSuggestMatch, partnersSanitizeConfig };
}
