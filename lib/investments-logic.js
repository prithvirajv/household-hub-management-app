// Investments page: every stock and fund the household holds (the holding-class net-worth assets, one group per account) read as ONE portfolio:
// total, who holds what, the mix against a target, concentration warnings, tax buckets and the largest positions. Pure functions; the page in
// app.js only renders them. Nothing here changes a holding: the page's own choices (owner and tax bucket per account, a fund type per ticker,
// the target mix) live in state.goals.investmentsView.
//
// Loaded as a classic script beside shared-logic.js and app.js, so every top-level name here starts with `investments` / `INVESTMENT` to stay
// unique in the shared scope.

const investmentsShared = (typeof module !== "undefined" && module.exports)
  ? require("./shared-logic")
  : { isHoldingAssetClass, assetValue, groupStockHoldings, groupGainLoss };

// Fund types, and how much of each counts toward the four mix buckets (a target-date fund is a blend).
const INVESTMENT_CLASSES = {
  "US broad index": { us: 1 },
  "Nasdaq-100": { us: 1 },
  "Momentum": { us: 1 },
  "Sector fund": { us: 1 },
  "Small-cap": { us: 1 },
  "Dividend growth": { us: 1 },
  "Employer stock": { us: 1 },
  "Single stocks": { us: 1 },
  "Other / not sure": { us: 1 },
  "Target date": { us: 0.55, intl: 0.3, bond: 0.15 },
  "International": { intl: 1 },
  "Bonds": { bond: 1 },
  "Cash": { cash: 1 }
};
const INVESTMENT_BUCKETS = [["us", "US stocks"], ["intl", "International"], ["bond", "Bonds"], ["cash", "Cash"]];
const INVESTMENT_TAX_TYPES = ["Pre-tax", "Roth", "HSA", "Taxable"];
// Fund types where one name is not a concentration risk (a broad fund spreads itself), so they never trigger the single-position warning.
const INVESTMENT_DIVERSIFIED = new Set(["US broad index", "Target date", "Bonds", "Cash", "International", "Small-cap", "Dividend growth", "Nasdaq-100", "Momentum", "Other / not sure"]);
const INVESTMENT_SINGLE_LIMIT = 0.1;
const INVESTMENT_SECTOR_LIMIT = 0.08;

// A starting guess for well-known tickers, so a household is not asked to classify fifty funds by hand. Anything else: a name that says target
// date, a money-market-like name, otherwise a 5-letter ticker ending in X is a mutual fund (broad index) and the rest are single stocks.
const INVESTMENT_KNOWN = {
  "US broad index": "VOO VTI SPY IVV ITOT SCHB FXAIX FNILX FZROX VFIAX VTSAX VIIIX SWPPX SWTSX FSKAX VV",
  "Nasdaq-100": "QQQ QQQM ONEQ",
  "Momentum": "SPMO MTUM",
  "Sector fund": "SMH SOXX XLK VGT XLF XLV XLE XLY XLI ARKK DRAM IGV",
  "Small-cap": "VB IJR IWM VSMAX FSSNX SCHA VBR",
  "Dividend growth": "SCHD VIG DGRO VDADX VYM DVY",
  "International": "VXUS VEA VWO IXUS IEFA EFA FZILX VTIAX VTMGX SCHF",
  "Bonds": "BND AGG BNDX SCHZ VBTLX VBMPX FXNAX FBND TLT IEF VGIT",
  "Cash": "SPAXX FDRXX VMFXX SWVXX SGOV BIL"
};
const investmentsKnownClass = (() => {
  const map = new Map();
  Object.entries(INVESTMENT_KNOWN).forEach(([cls, list]) => list.split(" ").forEach((symbol) => map.set(symbol, cls)));
  return map;
})();

// The fund type of one holding: the household's own choice for that ticker, else the starting guess.
function investmentsClassOf(item, overrides) {
  const symbol = String(item.symbol || "").trim().toUpperCase();
  const chosen = overrides && overrides[symbol];
  if (chosen && INVESTMENT_CLASSES[chosen]) return chosen;
  if (item.holdingType === "cash") return "Cash";
  if (symbol && investmentsKnownClass.has(symbol)) return investmentsKnownClass.get(symbol);
  const name = String(item.name || "");
  if (/target[- ]?(date|retirement)|\b20[2-6]0\b.*(fund|trust)|lifepath|freedom/i.test(name)) return "Target date";
  if (/money market|cash reserve/i.test(name)) return "Cash";
  if (/^[A-Z]{5}$/.test(symbol) && symbol.endsWith("X")) return "US broad index";
  // A balance with no ticker (a plain account total, "balance before holdings") cannot be judged: counted as US stocks, never warned about.
  if (!symbol) return "Other / not sure";
  return "Single stocks";
}

// A saved page-settings object, made safe: targets 0-100, owner and tax choice per account, fund type per ticker (only known types).
function investmentsSanitizeMeta(raw) {
  const meta = { targets: { us: 0, intl: 0, bond: 0, cash: 0 }, groups: {}, classes: {} };
  const source = raw && typeof raw === "object" ? raw : {};
  INVESTMENT_BUCKETS.forEach(([key]) => {
    const value = Math.round(Number(source.targets && source.targets[key]));
    meta.targets[key] = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  });
  Object.entries(source.groups && typeof source.groups === "object" ? source.groups : {}).slice(0, 200).forEach(([groupId, value]) => {
    const owner = String((value && value.owner) || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const tax = INVESTMENT_TAX_TYPES.includes(value && value.tax) ? value.tax : "";
    if (groupId && (owner || tax)) meta.groups[String(groupId).slice(0, 120)] = { ...(owner ? { owner } : {}), ...(tax ? { tax } : {}) };
  });
  Object.entries(source.classes && typeof source.classes === "object" ? source.classes : {}).slice(0, 500).forEach(([symbol, cls]) => {
    const key = String(symbol).trim().toUpperCase().slice(0, 20);
    if (key && INVESTMENT_CLASSES[cls]) meta.classes[key] = cls;
  });
  return meta;
}

const investmentsAdd = (map, key, amount) => { map[key] = (map[key] || 0) + amount; };

// The whole portfolio at today's prices. `assets` is state.goals.netWorth.assets (anything not stock/retirement is ignored); `meta` is the
// saved page settings. Returns the total and every cut of it the page shows.
function investmentsSnapshot(assets, meta, defaultOwner = "Household") {
  const settings = investmentsSanitizeMeta(meta);
  const groups = investmentsShared.groupStockHoldings(assets || []).map((group) => {
    const rows = group.items.map((item) => {
      const value = investmentsShared.assetValue(item);
      const cls = investmentsClassOf(item, settings.classes);
      const symbol = String(item.symbol || "").trim().toUpperCase();
      return { id: item.id, symbol, name: item.name || symbol, label: symbol || item.name || "Holding", shares: Number(item.shares || 0), price: Number(item.price || 0), value, cls, hasCostBasis: Number(item.costBasis || 0) > 0, item };
    });
    const saved = settings.groups[group.groupId] || {};
    const retirement = group.items.some((item) => item.assetClass === "retirement");
    const gain = investmentsShared.groupGainLoss(group.items);
    return {
      groupId: group.groupId,
      name: group.groupName || (rows[0] && rows[0].name) || "Account",
      owner: saved.owner || defaultOwner,
      tax: saved.tax || (retirement ? "Pre-tax" : "Taxable"),
      taxChosen: Boolean(saved.tax),
      value: rows.reduce((sum, row) => sum + row.value, 0),
      gain: gain.hasCostBasis ? { amount: gain.amount, percent: gain.percent } : null,
      rows: rows.sort((a, b) => b.value - a.value)
    };
  }).filter((group) => group.rows.length);
  groups.sort((a, b) => b.value - a.value);

  const total = groups.reduce((sum, group) => sum + group.value, 0);
  const byOwner = {};
  const byTax = {};
  const byClass = {};
  const bySymbol = {};
  const symbolClass = {};
  const bucket = { us: 0, intl: 0, bond: 0, cash: 0 };
  groups.forEach((group) => {
    investmentsAdd(byOwner, group.owner, group.value);
    investmentsAdd(byTax, group.tax, group.value);
    group.rows.forEach((row) => {
      investmentsAdd(byClass, row.cls, row.value);
      investmentsAdd(bySymbol, row.label, row.value);
      symbolClass[row.label] = row.cls;
      const weights = INVESTMENT_CLASSES[row.cls] || { us: 1 };
      Object.keys(weights).forEach((key) => { bucket[key] += row.value * weights[key]; });
    });
  });
  const positions = Object.entries(bySymbol).map(([label, value]) => ({ label, value, cls: symbolClass[label], share: total ? value / total : 0 })).sort((a, b) => b.value - a.value);
  return { total, groups, byOwner, byTax, byClass, bySymbol, bucket, positions, symbolClass };
}

// Concentration warnings: one stock or sector fund above 10% of the household (across every account), and sector funds together above 8%.
// Broad funds never count as a concentration. Data only; the page words it.
function investmentsAlerts(snapshot) {
  const alerts = [];
  if (!snapshot.total) return alerts;
  const employer = snapshot.byClass["Employer stock"] || 0;
  if (employer / snapshot.total > INVESTMENT_SINGLE_LIMIT) alerts.push({ kind: "employer", share: employer / snapshot.total, value: employer });
  snapshot.positions.forEach((position) => {
    // A sector fund is covered by the sector warning below, and employer stock by its own, so neither also gets a one-position warning.
    if (position.share > INVESTMENT_SINGLE_LIMIT && !INVESTMENT_DIVERSIFIED.has(position.cls) && position.cls !== "Employer stock" && position.cls !== "Sector fund") alerts.push({ kind: "position", label: position.label, share: position.share, value: position.value });
  });
  const sector = snapshot.byClass["Sector fund"] || 0;
  if (sector / snapshot.total > INVESTMENT_SECTOR_LIMIT) alerts.push({ kind: "sector", share: sector / snapshot.total, value: sector });
  return alerts;
}

// For each bucket: what it is now, the target, and the dollars to add (+) or trim (-) to reach the target at today's total.
// With no target set at all (all zero) there is nothing to compare, so `hasTarget` is false and no gap is given.
function investmentsGaps(snapshot, targets) {
  const settings = investmentsSanitizeMeta({ targets }).targets;
  const targetSum = INVESTMENT_BUCKETS.reduce((sum, [key]) => sum + settings[key], 0);
  return {
    hasTarget: targetSum > 0,
    targetSum,
    buckets: INVESTMENT_BUCKETS.map(([key, label]) => {
      const share = snapshot.total ? snapshot.bucket[key] / snapshot.total : 0;
      const target = settings[key] / 100;
      return { key, label, share, value: snapshot.bucket[key], target: settings[key], gap: targetSum > 0 ? (target - share) * snapshot.total : 0 };
    })
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { INVESTMENT_CLASSES, INVESTMENT_BUCKETS, INVESTMENT_TAX_TYPES, investmentsClassOf, investmentsSanitizeMeta, investmentsSnapshot, investmentsAlerts, investmentsGaps };
}
