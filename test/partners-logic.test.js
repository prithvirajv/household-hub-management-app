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
