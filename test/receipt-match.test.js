const test = require("node:test");
const assert = require("node:assert/strict");
const { receiptMatchTokens, receiptMatchSimilar, receiptMatchDays, receiptMatchCandidates, receiptMatchPlan, receiptMatchPending } = require("../lib/receipt-match");

const tx = (payee, amount, date, extra = {}) => ({ payee, amount, date, ...extra });

test("shop names are compared by their distinctive words, so a receipt's name and a bank's payee line up", () => {
  assert.deepEqual(receiptMatchTokens("HOME-MART #4185"), ["home", "mart"]);
  assert.deepEqual(receiptMatchTokens("Corner Market Inc."), ["corner"], "digits, punctuation and filler words are dropped");
  assert.equal(receiptMatchSimilar("Homemart Supercenter", "HOME-MART #4185"), true, "home-mart and homemart are the same letters");
  assert.equal(receiptMatchSimilar("Big Box Wholesale", "BIGBOX WHSE #1175"), true, "a shared distinctive word, filler words ignored");
  assert.equal(receiptMatchSimilar("Maria's Greengrocer", "MARIAS GREENGROCER GA"), true, "apostrophes and trailing state codes do not matter");
  assert.equal(receiptMatchSimilar("Riverside International Market", "RIVERSIDE INTL MKT"), true);
  assert.equal(receiptMatchSimilar("Corner Market", "Harbor Pharmacy"), false);
  assert.equal(receiptMatchSimilar("", "Harbor Pharmacy"), false, "an unreadable shop name matches nothing");
  assert.equal(receiptMatchSimilar("Corner Market", ""), false);
});

test("receiptMatchDays counts whole days between two dates and is null when one is missing", () => {
  assert.equal(receiptMatchDays("2026-11-12", "2026-11-14"), 2);
  assert.equal(receiptMatchDays("2026-11-14", "2026-11-12"), 2, "either order");
  assert.equal(receiptMatchDays("2026-12-30", "2027-01-02"), 3, "across a year end");
  assert.equal(receiptMatchDays("", "2026-11-12"), null);
  assert.equal(receiptMatchDays("2026-11-12", undefined), null);
});

test("a candidate needs the same total to the cent on a money-out row with no receipt, within four days", () => {
  const receipt = { id: "r1", merchant: "Corner Market", date: "2026-11-12", total: 27.52 };
  const rows = [
    tx("CORNER MKT #12", 27.52, "2026-11-13"),                       // 0: yes
    tx("CORNER MKT #12", 27.53, "2026-11-13"),                       // 1: a cent off is still the same charge
    tx("CORNER MKT #12", 27.6, "2026-11-13"),                        // 2: eight cents off: no
    tx("CORNER MKT #12", -27.52, "2026-11-13"),                      // 3: money in (a refund): no
    tx("CORNER MKT #12", 27.52, "2026-11-20"),                       // 4: eight days later: no
    tx("CORNER MKT #12", 27.52, "2026-11-12", { receiptIds: ["x"] }),  // 5: already has a receipt: no
    tx("HARBOR PHARMACY", 27.52, "2026-11-12")                       // 6: same total, other shop: a candidate, but not a name match
  ];
  const found = receiptMatchCandidates(receipt, rows);
  assert.deepEqual(found.map((c) => c.index), [0, 1, 6], "name matches first, then the rest");
  assert.deepEqual(found.map((c) => c.merchantMatch), [true, true, false]);
  assert.deepEqual(receiptMatchCandidates({ ...receipt, total: null }, rows), [], "a receipt with no readable total matches nothing");
  assert.deepEqual(receiptMatchCandidates({ ...receipt, total: 0 }, rows), []);
});

test("a link is certain only with one candidate, a matching name, within 3 days and no rival receipt; otherwise it is a suggestion", () => {
  const receipt = { id: "r1", merchant: "Corner Market", date: "2026-11-12", total: 27.52 };
  // Certain: exactly one candidate, the name matches, two days.
  assert.deepEqual(receiptMatchPlan([receipt], [tx("CORNER MKT #12", 27.52, "2026-11-14"), tx("Other", 5, "2026-11-12")]).certain, [{ receiptId: "r1", index: 0 }]);
  // Four days is within the window but not certain: it is offered.
  const late = receiptMatchPlan([receipt], [tx("CORNER MKT #12", 27.52, "2026-11-16")]);
  assert.deepEqual([late.certain.length, late.suggestions.r1.map((c) => c.index)], [0, [0]]);
  // The right amount at another shop is only a suggestion.
  const other = receiptMatchPlan([receipt], [tx("HARBOR PHARMACY", 27.52, "2026-11-12")]);
  assert.deepEqual([other.certain.length, other.suggestions.r1.length], [0, 1]);
  // Two rows both fit: never guess between them.
  const twin = receiptMatchPlan([receipt], [tx("CORNER MKT #12", 27.52, "2026-11-12"), tx("CORNER MKT #12", 27.52, "2026-11-13")]);
  assert.deepEqual([twin.certain.length, twin.suggestions.r1.map((c) => c.index)], [0, [0, 1]], "both offered, nearest date first");
  // No receipt date: it can be suggested but never linked on its own.
  const undated = receiptMatchPlan([{ ...receipt, date: "" }], [tx("CORNER MKT #12", 27.52, "2026-11-12")]);
  assert.deepEqual([undated.certain.length, undated.suggestions.r1.length], [0, 1]);
  // Nothing fits: nothing is said.
  assert.deepEqual(receiptMatchPlan([receipt], [tx("CORNER MKT #12", 9.99, "2026-11-12")]), { certain: [], suggestions: {} });
});

test("two waiting receipts that want the same row are only suggestions, and two receipts with their own rows are each linked", () => {
  const a = { id: "a", merchant: "Corner Market", date: "2026-11-12", total: 10 };
  const b = { id: "b", merchant: "Corner Market", date: "2026-11-12", total: 10 };
  const shared = receiptMatchPlan([a, b], [tx("CORNER MKT #12", 10, "2026-11-12")]);
  assert.deepEqual([shared.certain.length, Object.keys(shared.suggestions).sort()], [0, ["a", "b"]], "neither is linked, both are offered the row");
  const own = receiptMatchPlan([a, { ...b, total: 20 }], [tx("CORNER MKT #12", 10, "2026-11-12"), tx("CORNER MKT #12", 20, "2026-11-12")]);
  assert.deepEqual(own.certain, [{ receiptId: "a", index: 0 }, { receiptId: "b", index: 1 }]);
});

test("a charge still pending at the bank is noticed (information only) when the total, date and shop name all fit", () => {
  const receipt = { id: "r1", merchant: "Corner Market", date: "2026-11-12", total: 27.52 };
  const accounts = [{ name: "Everyday card", pendingRows: [{ id: "p", date: "2026-11-12", payee: "CORNER MKT #12", amount: 27.52 }] }, { name: "Savings" }];
  assert.deepEqual(receiptMatchPending(receipt, accounts), { accountName: "Everyday card", payee: "CORNER MKT #12" });
  assert.equal(receiptMatchPending(receipt, [{ name: "Card", pendingRows: [{ date: "2026-11-12", payee: "HARBOR PHARMACY", amount: 27.52 }] }]), null, "another shop");
  assert.equal(receiptMatchPending(receipt, [{ name: "Card", pendingRows: [{ date: "2026-11-12", payee: "CORNER MKT", amount: 30 }] }]), null, "another amount");
  assert.equal(receiptMatchPending({ ...receipt, total: null }, accounts), null);
  assert.equal(receiptMatchPending(receipt, undefined), null);
});

test("a match the person undid is still suggested but never linked again by itself", () => {
  const receipt = { id: "r1", merchant: "Corner Market", date: "2026-11-12", total: 27.52 };
  const undone = tx("CORNER MKT #12", 27.52, "2026-11-13", { receiptsDeclined: ["r1"] });
  const plan = receiptMatchPlan([receipt], [undone]);
  assert.deepEqual([plan.certain.length, plan.suggestions.r1.map((c) => c.index)], [0, [0]], "offered, not linked");
  const other = receiptMatchPlan([{ ...receipt, id: "r2" }], [undone]);
  assert.deepEqual(other.certain, [{ receiptId: "r2", index: 0 }], "the decline is only about that receipt");
});
