const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyPartnerRow, partnersSharesFor, buildPartnersStatement, partnersSuggestMatch, partnersSanitizeConfig } = require("../lib/partners-logic");

const config = {
  properties: [{ id: "a", name: "Maple" }, { id: "b", name: "Oak" }],
  partners: [{ id: "p1", name: "Pat" }, { id: "p2", name: "Sam" }, { id: "p3", name: "Alex" }],
  shares: { a: { p1: 50, p2: 25, p3: 25 }, b: { p1: 25, p2: 25, p3: 50 } },
  defaultShares: { p1: 34, p2: 33, p3: 33 },
  accountIds: [],
  rules: [
    { id: "r1", match: "zelle from tina tenant", kind: "rent", propertyId: "a" },
    { id: "r2", match: "zelle from omar renter", kind: "rent", propertyId: "b" },
    { id: "r3", match: "loanco 1111", kind: "loan", propertyId: "a" },
    { id: "r4", match: "loanco 2222", kind: "loan", propertyId: "b" },
    { id: "r5", match: "oak hoa", kind: "hoa", propertyId: "b" },
    { id: "r6", match: "zelle from sam", kind: "contribution", partnerId: "p2" },
    { id: "r7", match: "zelle from alex", kind: "contribution", partnerId: "p3" },
    { id: "r8", match: "card payment", kind: "personal" }
  ]
};
const t = (date, payee, amount, extra = {}) => ({ date, payee, amount, accountId: "chk", ...extra });

test("classifyPartnerRow reads the payee text, first matching rule wins, and unknown payees are left alone", () => {
  assert.equal(classifyPartnerRow(t("2026-09-01", "ZELLE FROM TINA TENANT ON 09/01 REF # X1", -2000), config.rules).propertyId, "a");
  assert.equal(classifyPartnerRow(t("2026-09-01", "LOANCO CASH Aug 26 1111-0021 Pat", 2600), config.rules).kind, "loan");
  assert.equal(classifyPartnerRow(t("2026-09-01", "Something new", 5), config.rules), null);
  assert.equal(classifyPartnerRow(t("2026-09-01", "LOANCO 11112", 5), config.rules), null, "a number only matches as a whole word");
});

test("partnersSharesFor normalises percentages and falls back to an equal split", () => {
  const pct = partnersSharesFor(config, "a");
  assert.equal(Math.round(pct.p1 + pct.p2 + pct.p3), 100);
  assert.equal(pct.p1, 50);
  const equal = partnersSharesFor({ partners: config.partners, shares: { a: { p1: 0, p2: 0, p3: 0 } }, defaultShares: {} }, "a");
  assert.ok(Math.abs(equal.p1 - 100 / 3) < 1e-9);
});

test("buildPartnersStatement gives each property its P&L and each partner a share, a balance and what to send", () => {
  const rows = [
    t("2026-08-01", "ZELLE FROM TINA TENANT ON 08/01", -2000),
    t("2026-08-03", "ZELLE FROM OMAR RENTER ON 08/03", -2200),
    t("2026-08-08", "LOANCO CASH Aug 1111-0021", 2600),
    t("2026-08-08", "LOANCO CASH Aug 2222-0009", 2700),
    t("2026-08-09", "OAK HOA L123", 175),
    t("2026-08-31", "ZELLE FROM SAM ON 08/31 REF # Q", -500),
    t("2026-08-31", "ZELLE FROM ALEX ON 08/31 REF # R", -300),
    t("2026-08-15", "CARD PAYMENT TO MY VISA", 1000),
    t("2026-08-20", "MYSTERY CHARGE", 40)
  ];
  const s = buildPartnersStatement(config, rows, {});
  const a = s.properties.find((p) => p.id === "a");
  const b = s.properties.find((p) => p.id === "b");
  assert.deepEqual([a.income, a.loan, a.net], [2000, 2600, -600]);
  assert.deepEqual([b.income, b.loan, b.hoa, b.net], [2200, 2700, 175, -675]);
  assert.equal(s.pool.net, -1275);
  assert.equal(s.pool.contributions, 800);
  assert.equal(s.pool.cash, -475);
  assert.equal(s.personalCount, 1, "personal rows are counted but left out of the books");
  assert.equal(s.unclassified.length, 1);
  const pat = s.partners.find((p) => p.id === "p1");
  assert.equal(pat.share, -(0.5 * 600 + 0.25 * 675), "Pat's share of each property's loss, by that property's percentages");
  const sam = s.partners.find((p) => p.id === "p2");
  assert.equal(sam.contributed, 500);
  assert.equal(sam.balance, 500 + sam.share);
  assert.equal(Math.round(s.partners.reduce((sum, p) => sum + p.toSquare, 0) * 100) / 100, 0, "squaring up moves money between partners, it never creates any");
  assert.equal(s.averageShortfall, 1275);
  assert.equal(Math.round(s.partners.reduce((sum, p) => sum + p.suggested, 0)), 1275);
});

test("the suggested monthly send ignores a month that has rent but no costs yet", () => {
  const rows = [
    t("2026-07-01", "ZELLE FROM TINA TENANT", -2000), t("2026-07-08", "LOANCO CASH 1111", 2600),
    t("2026-08-01", "ZELLE FROM TINA TENANT", -2000), t("2026-08-08", "LOANCO CASH 1111", 2600),
    t("2026-09-01", "ZELLE FROM TINA TENANT", -2000)
  ];
  assert.equal(buildPartnersStatement(config, rows, {}).averageShortfall, 600);
});

test("buildPartnersStatement honours the month range and the pool account list", () => {
  const rows = [
    t("2026-07-01", "ZELLE FROM TINA TENANT", -2000),
    t("2026-08-01", "ZELLE FROM TINA TENANT", -2000),
    t("2026-08-02", "ZELLE FROM TINA TENANT", -2000, { accountId: "other" })
  ];
  assert.equal(buildPartnersStatement(config, rows, { fromMonth: "2026-08", toMonth: "2026-08" }).pool.income, 4000);
  assert.equal(buildPartnersStatement({ ...config, accountIds: ["chk"] }, rows, { fromMonth: "2026-08", toMonth: "2026-08" }).pool.income, 2000);
});

test("partnersSuggestMatch keeps the stable words of a bank payee", () => {
  assert.equal(partnersSuggestMatch("ZELLE FROM JANE Q SAMPLE ON 09/01 REF # ABC123456789"), "zelle from jane q sample");
  assert.equal(partnersSuggestMatch("Maple Court HOA L1234567   260810 O9876543210"), "maple court hoa l1234567");
});

test("partnersSanitizeConfig keeps only what the page understands", () => {
  const clean = partnersSanitizeConfig({
    properties: [{ id: "a b!", name: "Maple" }], partners: [{ id: "p1", name: "Pat" }],
    shares: { "ab": { p1: 250 } }, rules: [{ match: "x", kind: "rent", propertyId: "nope" }, { match: "y", kind: "bogus" }, { match: "", kind: "rent" }]
  });
  assert.equal(clean.properties[0].id, "ab");
  assert.equal(clean.shares.ab.p1, 100);
  assert.equal(clean.rules.length, 1);
  assert.equal(clean.rules[0].propertyId, "");
  assert.deepEqual(partnersSanitizeConfig(null).properties, []);
});

test("partnersParseCsv reads a statement the way a savings or checking account shows it (money in positive), including two-digit years", () => {
  const { partnersParseCsv } = require("../lib/partners-logic");
  const csv = 'DATE,DESCRIPTION,AMOUNT,CHECK #,STATUS,Paid By\n9/1/26,"ZELLE FROM JANE Q SAMPLE, REF 1",2075,,Posted,Rent\n8/10/26,LOANCO CASH 1111,-2663.72,,Posted,EMI\nnot a row,,,,,\n';
  const parsed = partnersParseCsv(csv);
  assert.deepEqual(parsed.rows, [{ date: "2026-09-01", payee: "ZELLE FROM JANE Q SAMPLE, REF 1", amount: -2075 }, { date: "2026-08-10", payee: "LOANCO CASH 1111", amount: 2663.72 }]);
  assert.equal(parsed.skipped, 1);
  assert.equal(partnersParseCsv(csv, { moneyInPositive: false }).rows[0].amount, 2075);
  assert.match(partnersParseCsv("a,b\n1,2").problem, /Date, Description and Amount/);
});

test("rows kept for the Partners page are merged without doubling: CSV over CSV, CSV over the bank, and the bank over a CSV row", () => {
  const { partnersMergeBankRows, partnersMergeCsvRows } = require("../lib/partners-logic");
  const csv = [{ date: "2026-08-01", payee: "A", amount: -100 }, { date: "2026-08-01", payee: "B", amount: -100 }, { date: "2026-08-02", payee: "C", amount: 40 }];
  const first = partnersMergeCsvRows([], csv);
  assert.equal(first.added, 3, "two equal rows on one day are both real");
  assert.equal(partnersMergeCsvRows(first.rows, csv).added, 0, "the same file twice adds nothing");
  const bank = partnersMergeBankRows(first.rows, [{ externalId: "sf:X:1", date: "2026-08-02", payee: "C BANK TEXT", amount: 40 }, { externalId: "sf:X:2", date: "2026-08-05", payee: "D", amount: 9 }]);
  assert.equal(bank.rows.length, 4, "the bank row matching a CSV row takes its place, the new one is added");
  assert.equal(bank.rows.find((r) => r.payee === "C").externalId, "sf:X:1");
  assert.equal(partnersMergeBankRows(bank.rows, [{ externalId: "sf:X:2", date: "2026-08-05", payee: "D", amount: 9 }]).added, 0, "a known id is never added twice");
  assert.equal(partnersMergeCsvRows(bank.rows, csv).added, 0, "a CSV that overlaps the bank's rows adds nothing");
});

test("a choice made for one row overrides the rules, can be reset, and survives an export", () => {
  const { partnersRowId, partnersSanitizeConfig } = require("../lib/partners-logic");
  const odd = t("2026-08-20", "ZELLE FROM TINA TENANT ON 08/20", -300);
  const sameDay = t("2026-08-21", "SOMETHING ELSE", 40);
  const rowId = partnersRowId(odd);
  const withOverride = { ...config, overrides: { [rowId]: { kind: "contribution", propertyId: "", partnerId: "p1" }, [partnersRowId(sameDay)]: { kind: "repair", propertyId: "b", partnerId: "" } } };
  assert.equal(classifyPartnerRow(odd, config.rules).kind, "rent", "the rule alone says rent");
  assert.equal(classifyPartnerRow(odd, config.rules, withOverride.overrides).kind, "contribution", "the row's own choice wins");
  const s = buildPartnersStatement(withOverride, [odd, sameDay], {});
  assert.equal(s.partners.find((p) => p.id === "p1").contributed, 300);
  assert.equal(s.properties.find((p) => p.id === "b").repair, 40);
  assert.equal(s.unclassified.length, 0, "a row that needed a rule is settled by assigning it");
  assert.equal(s.entries.filter((entry) => entry.overridden).length, 2);
  assert.equal(partnersRowId({ externalId: "sf:X:1", date: "x", amount: 1, payee: "p" }), "x:sf:X:1", "a bank row is found by its bank id");
  const clean = partnersSanitizeConfig({ ...withOverride, overrides: { ...withOverride.overrides, junk: { kind: "bogus" } } });
  assert.equal(Object.keys(clean.overrides).length, 2, "an unknown kind is dropped, valid choices stay");
});

test("partnersParseAiSuggestions keeps only offered ids, known kinds, and treats anything but 'high' as unsure", () => {
  const { partnersParseAiSuggestions } = require("../lib/partners-logic");
  const reply = '```json\n[{"id":"0","kind":"contribution","propertyId":null,"partnerId":"p2","confidence":"high"},{"id":"1","kind":"nonsense","confidence":"high"},{"id":"2","kind":"repair","propertyId":"zz","partnerId":"nobody","confidence":"high"},{"id":"9","kind":"rent","confidence":"high"},{"id":"0","kind":"loan","confidence":"high"},{"id":"3","kind":"rent","propertyId":"a","confidence":"maybe"}]\n```';
  const results = partnersParseAiSuggestions(reply, ["0", "1", "2", "3"], ["a", "b"], ["p1", "p2"]);
  assert.deepEqual(results.map((r) => [r.id, r.kind, r.propertyId, r.partnerId, r.confidence]), [
    ["0", "contribution", "", "p2", "high"],
    ["1", "", "", "", "low"],
    ["2", "repair", "", "", "high"],
    ["3", "rent", "a", "", "low"]
  ]);
  assert.deepEqual(partnersParseAiSuggestions("not json", ["0"], [], []), []);
});

test("more categories: property tax and insurance count as costs, other income as income, and a category the group made up works the same way", () => {
  const { partnersKindList, partnersSanitizeConfig } = require("../lib/partners-logic");
  const cfg = partnersSanitizeConfig({
    ...config,
    customKinds: [{ id: "landscaping", label: "Landscaping", group: "cost" }, { id: "late", label: "Late fees", group: "income" }, { id: "rent", label: "dup of a built-in", group: "cost" }, { id: "nolabel", label: "", group: "cost" }],
    rules: [...config.rules, { id: "t", match: "county tax", kind: "tax", propertyId: "a" }, { id: "i", match: "acme insurance", kind: "insurance", propertyId: "a" }, { id: "l", match: "green lawn", kind: "landscaping", propertyId: "a" }, { id: "f", match: "late fee", kind: "late", propertyId: "a" }, { id: "o", match: "deposit kept", kind: "other_income", propertyId: "a" }]
  });
  assert.deepEqual(cfg.customKinds.map((k) => k.id), ["landscaping", "late"], "a duplicate of a built-in and a label-less category are dropped");
  assert.equal(partnersKindList(cfg).filter((k) => k.custom).length, 2);
  assert.equal(cfg.rules.find((r) => r.id === "l").kind, "landscaping", "a rule may use a category the group made up");
  const rows = [t("2026-08-01", "ZELLE FROM TINA TENANT", -2000), t("2026-08-02", "COUNTY TAX BILL", 300), t("2026-08-03", "ACME INSURANCE", 120), t("2026-08-04", "GREEN LAWN CO", 80), t("2026-08-05", "LATE FEE FROM TENANT", -50), t("2026-08-06", "DEPOSIT KEPT", -100)];
  const s = buildPartnersStatement(cfg, rows, {});
  const a = s.properties.find((p) => p.id === "a");
  assert.deepEqual([a.income, a.expense, a.net], [2150, 500, 1650], "tax, insurance and landscaping are other costs; late fees and kept deposits are income");
  assert.deepEqual(s.byKind.map((k) => [k.id, k.total]), [["rent", 2000], ["other_income", 100], ["tax", 300], ["insurance", 120], ["landscaping", 80], ["late", 50]], "a by-category breakdown in category order");
});

test("a withdrawal to a partner lowers that partner's balance and the pool's cash, but is not a property cost", () => {
  const rows = [t("2026-08-01", "ZELLE FROM TINA TENANT", -2000), t("2026-08-02", "LOANCO CASH 1111", 1500), t("2026-08-05", "ZELLE FROM SAM", -600), t("2026-08-20", "ZELLE TO SAM DISTRIBUTION", 200)];
  const withRule = { ...config, rules: [...config.rules, { id: "w", match: "distribution", kind: "withdrawal", partnerId: "p2" }] };
  const s = buildPartnersStatement(withRule, rows, {});
  const sam = s.partners.find((p) => p.id === "p2");
  assert.deepEqual([sam.contributed, sam.withdrawn], [600, 200]);
  assert.equal(s.pool.net, 500, "a withdrawal is not a cost of the properties");
  assert.deepEqual([s.pool.contributions, s.pool.withdrawals, s.pool.cash], [600, 200, 900], "cash = put in - taken out + result");
  assert.equal(sam.balance, Math.round((600 - 200 + sam.share) * 100) / 100);
  assert.equal(Math.round(s.partners.reduce((sum, p) => sum + p.toSquare, 0) * 100) / 100, 0);
  assert.equal(s.months[0].withdrawals, 200);
});

test("a row's amount can be corrected without losing the bank's own figure, and an amount-only change leaves the rules to classify it", () => {
  const { partnersRowId } = require("../lib/partners-logic");
  const rent = t("2026-08-01", "ZELLE FROM TINA TENANT", -2000);
  const edited = { ...config, overrides: { [partnersRowId(rent)]: { amount: 1800 } } };
  const s = buildPartnersStatement(edited, [rent], {});
  assert.equal(s.properties.find((p) => p.id === "a").income, 1800, "the corrected amount is what counts");
  assert.deepEqual([s.entries[0].money, s.entries[0].originalMoney, s.entries[0].edited, s.entries[0].kind], [1800, 2000, true, "rent"], "still classified by the rule, bank figure kept");
  const out = buildPartnersStatement({ ...config, overrides: { [partnersRowId(rent)]: { amount: -50, kind: "loan", propertyId: "b" } } }, [rent], {});
  assert.equal(out.properties.find((p) => p.id === "b").loan, 50, "a corrected amount can also flip a row to money out");
  const { partnersSanitizeConfig } = require("../lib/partners-logic");
  const clean = partnersSanitizeConfig({ ...config, overrides: { a: { amount: "12.345" }, b: { amount: "x" }, c: { kind: "rent", propertyId: "a", amount: 5 } } });
  assert.deepEqual(clean.overrides, { a: { amount: 12.35 }, c: { kind: "rent", propertyId: "a", partnerId: "", amount: 5 } });
});

test("a tenant's deposit is held, not income: received raises it, returned lowers it, and a part kept becomes income with no money moving", () => {
  const { partnersSanitizeConfig } = require("../lib/partners-logic");
  const cfg = partnersSanitizeConfig({
    ...config,
    properties: [{ id: "a", name: "Maple", tenant: "Tina Tenant", leaseEnd: "2026-12-31" }, { id: "b", name: "Oak", leaseEnd: "not a date" }],
    rules: [...config.rules, { id: "d1", match: "deposit from tina", kind: "deposit_in", propertyId: "a" }, { id: "d2", match: "deposit back to tina", kind: "deposit_out", propertyId: "a" }, { id: "d3", match: "damage kept", kind: "deposit_kept", propertyId: "a" }]
  });
  assert.deepEqual([cfg.properties[0].tenant, cfg.properties[0].leaseEnd, cfg.properties[1].leaseEnd], ["Tina Tenant", "2026-12-31", ""], "tenant and lease end are kept, a bad date is dropped");
  const rows = [
    t("2026-01-02", "ZELLE FROM TINA TENANT", -2000),
    t("2026-01-02", "DEPOSIT FROM TINA", -2000),
    t("2026-12-20", "DEPOSIT BACK TO TINA", 1700),
    t("2026-12-20", "DAMAGE KEPT", -300)
  ];
  const s = buildPartnersStatement(cfg, rows, {});
  const a = s.properties.find((p) => p.id === "a");
  assert.deepEqual([a.depositIn, a.depositOut, a.depositKept, a.depositHeld], [2000, 1700, 300, 0], "everything received was returned or kept, nothing is held");
  assert.equal(a.income, 2300, "only the rent and the part kept are income; the deposit itself is not");
  assert.equal(s.pool.depositsHeld, 0);
  assert.deepEqual([a.tenant, a.leaseEnd], ["Tina Tenant", "2026-12-31"]);
  const midLease = buildPartnersStatement(cfg, rows.slice(0, 2), {});
  assert.equal(midLease.pool.depositsHeld, 2000, "while the lease runs the whole deposit is held");
  assert.equal(midLease.pool.income, 2000, "and is not income");
  assert.equal(midLease.pool.cash, 4000, "the account does hold the money: rent plus the deposit");
  assert.deepEqual(s.byKind.filter((k) => k.group === "deposit").map((k) => [k.id, k.total]), [["deposit_in", 2000], ["deposit_out", 1700], ["deposit_kept", 300]]);
  assert.equal(s.pool.cash, 2300 - 0 + 0, "cash = rent in (2000) + deposits received (2000) - returned (1700) = 2300, the kept 300 moved no money");
});
