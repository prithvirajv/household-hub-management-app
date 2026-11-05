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

  return {
    months, properties: propertyRows, partners: partnerRows, unclassified, personalCount, rowCount, unassignedContributions,
    pool: { income: poolIncome, expenses: poolExpenses, net: poolNet, contributions: totalContributed, cash: partnersCents(totalContributed + poolNet) },
    averageShortfall
  };
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
  module.exports = { PARTNER_KINDS, partnersNormalize, classifyPartnerRow, partnersSharesFor, buildPartnersStatement, partnersSuggestMatch, partnersSanitizeConfig };
}
