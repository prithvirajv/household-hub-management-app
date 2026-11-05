// Property partners: several people put money into one checking account that collects the rent and pays the loans, HOA and repairs of shared
// rental properties. This turns that account's ledger into (1) a profit-and-loss per property and (2) a ledger per partner: what each one sent, what
// their share of the result is, and who should send or receive to square up. Pure functions; the Partners page in app.js only renders them.
//
// Amount convention (the whole app): a positive transaction amount is money OUT of the account, a negative one is money IN.
// Loaded as a classic script beside shared-logic.js and app.js, so every top-level name here starts with `partners` / `PARTNER` to stay unique.

const PARTNER_KINDS = [
  { id: "rent", label: "Rent received", direction: "in" },
  { id: "contribution", label: "Partner contribution", direction: "in" },
  { id: "loan", label: "Loan payment", direction: "out" },
  { id: "hoa", label: "HOA / dues", direction: "out" },
  { id: "repair", label: "Repairs and upkeep", direction: "out" },
  { id: "expense", label: "Other property expense", direction: "out" },
  { id: "interest", label: "Interest earned", direction: "in" },
  { id: "personal", label: "Personal (leave out of the books)", direction: "none" }
];

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

// The first rule (in list order, so put specific ones first) that matches the payee decides: { kind, propertyId, partnerId, ruleId } or null.
function classifyPartnerRow(transaction, rules) {
  const rule = (rules || []).find((item) => partnersRuleMatches(item, transaction && transaction.payee));
  return rule ? { kind: rule.kind, propertyId: rule.propertyId || "", partnerId: rule.partnerId || "", ruleId: rule.id } : null;
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
    if (!monthMap.has(month)) monthMap.set(month, { month, income: 0, expenses: 0, net: 0, contributions: 0 });
    return monthMap.get(month);
  };
  const contributed = new Map(partners.map((partner) => [partner.id, 0]));
  let unassignedContributions = 0;
  const unclassified = [];
  const entries = [];
  let personalCount = 0;
  let rowCount = 0;

  (transactions || []).forEach((transaction) => {
    if (accountIds.length && !accountIds.includes(transaction.accountId)) return;
    const month = partnersMonthKey(transaction.date);
    if (!month || (fromMonth && month < fromMonth) || (toMonth && month > toMonth)) return;
    const amount = Number(transaction.amount);
    if (!Number.isFinite(amount) || amount === 0) return;
    rowCount += 1;
    const verdict = classifyPartnerRow(transaction, rules);
    entries.push({ date: transaction.date, payee: transaction.payee, money: -amount, kind: verdict ? verdict.kind : "", propertyId: verdict ? verdict.propertyId : "", partnerId: verdict ? verdict.partnerId : "" });
    if (!verdict) { unclassified.push(transaction); return; }
    if (verdict.kind === "personal") { personalCount += 1; return; }
    const monthly = monthFor(month);
    if (verdict.kind === "contribution") {
      const money = -amount;
      monthly.contributions = partnersCents(monthly.contributions + money);
      if (contributed.has(verdict.partnerId)) contributed.set(verdict.partnerId, partnersCents(contributed.get(verdict.partnerId) + money));
      else unassignedContributions = partnersCents(unassignedContributions + money);
      return;
    }
    const bucket = bucketFor(verdict.propertyId);
    if (verdict.kind === "rent" || verdict.kind === "interest") {
      bucket.income = partnersCents(bucket.income - amount);
      monthly.income = partnersCents(monthly.income - amount);
    } else if (bucket[verdict.kind] !== undefined) {
      bucket[verdict.kind] = partnersCents(bucket[verdict.kind] + amount);
      monthly.expenses = partnersCents(monthly.expenses + amount);
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
    return { id: partner.id, name: partner.name, contributed: sent, share: partnersCents(share), balance: partnersCents(sent + share), effectivePct: effective * 100 };
  });
  // To square up: if the money the partners put in were shared by ownership, who should send more and who should get some back.
  partnerRows.forEach((row) => { row.toSquare = partnersCents((row.effectivePct / 100) * totalContributed - row.contributed); });

  // What each should send next month: their share of the average monthly shortfall over the last three months in which costs were paid (a month
  // that so far has only rent in it is not a full month, and would hide the shortfall).
  const recent = months.filter((row) => row.expenses > 0).slice(-3);
  const averageNet = recent.length ? recent.reduce((sum, row) => sum + row.net, 0) / recent.length : 0;
  const averageShortfall = partnersCents(Math.max(0, -averageNet));
  partnerRows.forEach((row) => { row.suggested = partnersCents((row.effectivePct / 100) * averageShortfall); });

  entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    months, properties: propertyRows, partners: partnerRows, unclassified, entries, personalCount, rowCount, unassignedContributions,
    pool: { income: poolIncome, expenses: poolExpenses, net: poolNet, contributions: totalContributed, cash: partnersCents(totalContributed + poolNet) },
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

// A saved setup comes back from the browser (or a JSON file someone imports) as plain data; this keeps only what the page understands.
function partnersSanitizeConfig(raw) {
  const text = (value, max = 80) => String(value == null ? "" : value).slice(0, max);
  const id = (value, fallback) => text(value || fallback, 60).replace(/[^A-Za-z0-9_-]/g, "") || fallback;
  const data = raw && typeof raw === "object" ? raw : {};
  const properties = (Array.isArray(data.properties) ? data.properties : []).slice(0, PARTNER_MAX_ITEMS).map((item, index) => ({ id: id(item && item.id, `prop${index + 1}`), name: text(item && item.name) || `Property ${index + 1}` }));
  const partners = (Array.isArray(data.partners) ? data.partners : []).slice(0, PARTNER_MAX_ITEMS).map((item, index) => ({ id: id(item && item.id, `partner${index + 1}`), name: text(item && item.name) || `Partner ${index + 1}` }));
  const percent = (value) => Math.min(100, Math.max(0, Number(value) || 0));
  const shares = {};
  properties.forEach((property) => {
    const source = (data.shares && data.shares[property.id]) || {};
    shares[property.id] = Object.fromEntries(partners.map((partner) => [partner.id, percent(source[partner.id])]));
  });
  const defaultShares = Object.fromEntries(partners.map((partner) => [partner.id, percent(data.defaultShares && data.defaultShares[partner.id])]));
  const kinds = new Set(PARTNER_KINDS.map((kind) => kind.id));
  const propertyIds = new Set(properties.map((property) => property.id));
  const partnerIds = new Set(partners.map((partner) => partner.id));
  const rules = (Array.isArray(data.rules) ? data.rules : []).slice(0, PARTNER_MAX_RULES)
    .filter((rule) => rule && kinds.has(rule.kind) && partnersNormalize(rule.match))
    .map((rule, index) => ({
      id: id(rule.id, `rule${index + 1}`), match: text(rule.match, 100), kind: rule.kind,
      propertyId: propertyIds.has(rule.propertyId) ? rule.propertyId : "", partnerId: partnerIds.has(rule.partnerId) ? rule.partnerId : ""
    }));
  const accountIds = (Array.isArray(data.accountIds) ? data.accountIds : []).slice(0, 20).map((value) => text(value, 80)).filter(Boolean);
  return { properties, partners, shares, defaultShares, rules, accountIds };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PARTNERS_POOL_ID, partnersMergeBankRows, partnersMergeCsvRows, partnersParseCsv, PARTNER_KINDS, partnersNormalize, classifyPartnerRow, partnersSharesFor, buildPartnersStatement, partnersSuggestMatch, partnersSanitizeConfig };
}
