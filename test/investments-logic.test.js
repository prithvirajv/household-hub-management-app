const test = require("node:test");
const assert = require("node:assert/strict");
const { investmentsClassOf, investmentsSanitizeMeta, investmentsSnapshot, investmentsAlerts, investmentsGaps } = require("../lib/investments-logic");

// Made-up holdings: two retirement accounts and a brokerage, in two groups plus a loose legacy holding.
const asset = (id, groupId, groupName, symbol, shares, price, extra = {}) => ({ id, groupId, groupName, name: symbol, symbol, shares, price, costBasis: 0, value: 0, assetClass: "stock", holdingType: "fund", ...extra });
const ASSETS = [
  asset("a1", "g401", "Work 401(k)", "VOO", 100, 500, { assetClass: "retirement" }),
  asset("a2", "g401", "Work 401(k)", "SMH", 20, 400, { assetClass: "retirement", costBasis: 300 }),
  asset("a3", "groth", "Roth IRA", "VXUS", 100, 70, { assetClass: "retirement" }),
  asset("a4", "groth", "Roth IRA", "ACME", 10, 100, { assetClass: "retirement" }),
  asset("a5", "gbrok", "Brokerage", "ACME", 30, 100),
  asset("a6", "gbrok", "Brokerage", "BND", 50, 80),
  { id: "cash1", assetClass: "cash", name: "Savings", value: 9999 },
  { id: "prop1", assetClass: "property", name: "House", value: 500000 }
];

test("a fund type is guessed for well-known tickers and names, and the household's own choice wins", () => {
  assert.equal(investmentsClassOf({ symbol: "voo" }), "US broad index");
  assert.equal(investmentsClassOf({ symbol: "QQQM" }), "Nasdaq-100");
  assert.equal(investmentsClassOf({ symbol: "VXUS" }), "International");
  assert.equal(investmentsClassOf({ symbol: "BND" }), "Bonds");
  assert.equal(investmentsClassOf({ symbol: "ZZZZ", holdingType: "cash" }), "Cash");
  assert.equal(investmentsClassOf({ symbol: "XYZFX", name: "Some Index Fund" }), "US broad index", "an unknown 5-letter ticker ending in X is a mutual fund");
  assert.equal(investmentsClassOf({ symbol: "", name: "Target Retirement 2050 Trust" }), "Target date");
  assert.equal(investmentsClassOf({ symbol: "ACME", name: "Acme Corp" }), "Single stocks");
  assert.equal(investmentsClassOf({ symbol: "", name: "Work 401(k)" }), "Other / not sure", "a balance with no ticker is not judged as one stock");
  assert.equal(investmentsClassOf({ symbol: "ACME" }, { ACME: "Employer stock" }), "Employer stock", "the household's choice wins");
  assert.equal(investmentsClassOf({ symbol: "ACME" }, { ACME: "Made up type" }), "Single stocks", "an unknown type is ignored");
});

test("the snapshot counts only stocks and funds, grouped per account, with one total and every cut of it", () => {
  const meta = { groups: { g401: { owner: "Sam", tax: "Pre-tax" }, groth: { owner: "Alex", tax: "Roth" } }, classes: { ACME: "Employer stock" } };
  const snap = investmentsSnapshot(ASSETS, meta);
  // 100*500 + 20*400 = 58000; 100*70 + 10*100 = 8000; 30*100 + 50*80 = 7000
  assert.equal(snap.total, 73000, "cash and property assets are not part of the portfolio");
  assert.deepEqual(snap.groups.map((g) => [g.name, g.value]), [["Work 401(k)", 58000], ["Roth IRA", 8000], ["Brokerage", 7000]], "largest account first");
  assert.deepEqual(snap.byOwner, { Sam: 58000, Alex: 8000, Household: 7000 }, "an account with no owner chosen falls under the default");
  assert.deepEqual(snap.byTax, { "Pre-tax": 58000, Roth: 8000, Taxable: 7000 });
  assert.equal(snap.bySymbol.ACME, 4000, "the same ticker held in two accounts is one position");
  assert.equal(snap.byClass["Employer stock"], 4000);
  assert.equal(snap.byClass["Sector fund"], 8000);
  assert.deepEqual(snap.positions.slice(0, 2).map((p) => p.label), ["VOO", "SMH"]);
  assert.equal(snap.groups[0].gain.amount, 2000, "gain comes from the holdings that have a cost basis (SMH: 20 x (400-300))");
  assert.equal(snap.groups[1].gain, null, "no cost basis anywhere: no gain figure");
  const defaults = investmentsSnapshot(ASSETS, null);
  assert.deepEqual(defaults.groups.map((g) => g.tax), ["Pre-tax", "Pre-tax", "Taxable"], "retirement accounts default to Pre-tax, the rest to Taxable");
  assert.equal(investmentsSnapshot([], null).total, 0);
});

test("the mix buckets add up to the total, with a target-date fund split across them", () => {
  const snap = investmentsSnapshot([...ASSETS, asset("t1", "gtd", "Kid account", "TGT", 10, 100, { name: "Target Retirement 2060 Fund" })], null);
  const sum = Object.values(snap.bucket).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - snap.total) < 1e-6, "nothing is lost or counted twice");
  assert.equal(snap.bucket.intl, 100 * 70 + 1000 * 0.3, "VXUS plus 30% of the target-date fund");
  assert.equal(snap.bucket.bond, 50 * 80 + 1000 * 0.15);
});

test("alerts flag one position or sector over the limits, never a broad fund", () => {
  const meta = { classes: { ACME: "Employer stock" } };
  const snap = investmentsSnapshot(ASSETS, meta);
  const kinds = investmentsAlerts(snap).map((a) => a.kind);
  assert.deepEqual(kinds, ["sector"], "SMH is 11% (sector over 8%); the employer stock is only about 5% and VOO is broad");
  const heavy = investmentsSnapshot([asset("x1", "g", "Acct", "ACME", 100, 100), asset("x2", "g", "Acct", "VOO", 10, 100)], { classes: { ACME: "Employer stock" } });
  assert.equal(investmentsAlerts(heavy)[0].kind, "employer");
  const single = investmentsSnapshot([asset("y1", "g", "Acct", "ACME", 100, 100), asset("y2", "g", "Acct", "VOO", 10, 100)], null);
  assert.deepEqual(investmentsAlerts(single).map((a) => [a.kind, a.label]), [["position", "ACME"]]);
  assert.deepEqual(investmentsAlerts(investmentsSnapshot([], null)), []);
});

test("gaps show what to add or trim to reach the target, and nothing when no target is set", () => {
  const snap = investmentsSnapshot([asset("g1", "g", "Acct", "VOO", 100, 100), asset("g2", "g", "Acct", "BND", 100, 100)], null);
  const none = investmentsGaps(snap, { us: 0, intl: 0, bond: 0, cash: 0 });
  assert.equal(none.hasTarget, false);
  assert.ok(none.buckets.every((bucket) => bucket.gap === 0));
  const gaps = investmentsGaps(snap, { us: 60, intl: 20, bond: 20, cash: 0 });
  const by = Object.fromEntries(gaps.buckets.map((b) => [b.key, Math.round(b.gap)]));
  assert.deepEqual(by, { us: 2000, intl: 4000, bond: -6000, cash: 0 }, "$20,000 total: 60% US = 12,000 vs 10,000 now; bonds trimmed from 10,000 to 4,000");
  assert.equal(gaps.targetSum, 100);
});

test("saved page settings are made safe", () => {
  const meta = investmentsSanitizeMeta({
    targets: { us: "85", intl: 150, bond: -5, cash: "x" },
    groups: { g1: { owner: "  Sam   Lee ", tax: "Roth" }, g2: { owner: "", tax: "Weird" }, g3: { tax: "HSA" } },
    classes: { acme: "Employer stock", zzz: "Nonsense" }
  });
  assert.deepEqual(meta.targets, { us: 85, intl: 100, bond: 0, cash: 0 });
  assert.deepEqual(meta.groups, { g1: { owner: "Sam Lee", tax: "Roth" }, g3: { tax: "HSA" } });
  assert.deepEqual(meta.classes, { ACME: "Employer stock" });
  assert.deepEqual(investmentsSanitizeMeta("junk"), { targets: { us: 0, intl: 0, bond: 0, cash: 0 }, groups: {}, classes: {} });
});
