const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReceiptReadParts, validateReceiptReadRequest, cleanReceiptFields, parseReceiptDraft, receiptCheck, RECEIPT_MAX_FILES } = require("../lib/receipt-read");

const JPEG = "/9j/4AAQSkZJRg==";

test("the request to the AI carries each photo or PDF inline, then the instruction", () => {
  const parts = buildReceiptReadParts([{ mimeType: "image/jpeg", imageBase64: JPEG }, { mimeType: "application/pdf", imageBase64: "JVBERi0=" }]);
  assert.deepEqual(parts.slice(0, 2), [{ inlineData: { mimeType: "image/jpeg", data: JPEG } }, { inlineData: { mimeType: "application/pdf", data: "JVBERi0=" } }]);
  assert.ok(parts[2].text);
});

test("validateReceiptReadRequest needs files and rejects other types, empty files, oversized files and too many", () => {
  assert.match(validateReceiptReadRequest({}).error, /at least one/);
  assert.match(validateReceiptReadRequest({ images: [{ mimeType: "text/html", imageBase64: JPEG }] }).error, /Unsupported file type/);
  assert.match(validateReceiptReadRequest({ images: [{ mimeType: "image/png", imageBase64: "" }] }).error, /empty/);
  assert.match(validateReceiptReadRequest({ images: [{ mimeType: "image/png", imageBase64: "A".repeat(6 * 1024 * 1024 + 1) }] }).error, /too large/);
  assert.match(validateReceiptReadRequest({ images: Array.from({ length: RECEIPT_MAX_FILES + 1 }, () => ({ mimeType: "image/png", imageBase64: JPEG })) }).error, /at most/);
  const ok = validateReceiptReadRequest({ images: [{ mimeType: "IMAGE/JPEG", imageBase64: JPEG }, { mimeType: "application/pdf", imageBase64: "JVBERi0=" }] });
  assert.deepEqual(ok.files.map((file) => file.mimeType), ["image/jpeg", "application/pdf"]);
});

test("parseReceiptDraft cleans the model's answer: numbers, units, discounts, unit price worked out when missing", () => {
  const reply = "```json\n" + JSON.stringify({
    merchant: "  Corner   Market ", location: "Springfield", date: "2026-11-12",
    items: [
      { name: " Roma tomatoes ", product: "  Roma   Tomato ", qty: 1.31, unit: "lb", unit_price: 2.59, amount: "3.39", discount: 0 },
      { name: "Eggs 5 dozen", qty: 1, unit: "each", unit_price: 10.39, amount: 10.39 },
      { name: "Chocolates 48 count", qty: 2, unit: "each", amount: 26.98, discount: 9 },
      { name: "Soup", qty: 0, unit: "bag", amount: 9.99 },
      { name: "", amount: 1 },
      { name: "No price" }
    ],
    subtotal: "40.76", tax: 1.2, total: "41.96", savings: null
  }) + "\n```";
  const draft = parseReceiptDraft(reply);
  assert.deepEqual([draft.merchant, draft.location, draft.date, draft.subtotal, draft.tax, draft.total, draft.savings], ["Corner Market", "Springfield", "2026-11-12", 40.76, 1.2, 41.96, null]);
  assert.deepEqual(draft.items.map((item) => item.name), ["Roma tomatoes", "Eggs 5 dozen", "Chocolates 48 count", "Soup"], "unnamed and unpriced lines are dropped");
  assert.deepEqual(draft.items[0], { name: "Roma tomatoes", product: "roma tomato", qty: 1.31, unit: "lb", unitPrice: 2.59, amount: 3.39, discount: 0 }, "the generic product name is tidied and lowercased");
  assert.equal(draft.items[1].product, "", "no product name given: empty, and the analysis falls back to the item name");
  assert.equal(draft.items[2].unitPrice, 17.99, "(26.98 charged + 9 saved) / 2: the price of one before the discount");
  assert.deepEqual([draft.items[3].qty, draft.items[3].unit], [1, "each"], "a zero quantity becomes 1 and an unknown unit becomes each");
});

test("parseReceiptDraft copes with chatter, bad dates and fails clearly when there is nothing", () => {
  assert.equal(parseReceiptDraft('Here you go: {"merchant":"X","date":"11/12/26","items":[{"name":"Milk","amount":2.5}]} thanks').date, "", "only a real YYYY-MM-DD date is kept");
  assert.throws(() => parseReceiptDraft("sorry, no"), /did not return a receipt/);
  assert.throws(() => parseReceiptDraft(JSON.stringify({ merchant: "X", items: [] })), /could not find any items/);
  assert.throws(() => parseReceiptDraft("[1]"), /did not return a receipt/);
  const many = parseReceiptDraft(JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => ({ name: `item ${i}`, amount: 1 })) }));
  assert.equal(many.items.length, 200, "bounded");
  assert.deepEqual(cleanReceiptFields({ items: [] }).items, [], "edits may remove every item");
});

test("receiptCheck says whether the items add up to what the receipt printed", () => {
  const items = [{ amount: 10.39 }, { amount: 11.49 }, { amount: 9.49 }];
  assert.deepEqual(receiptCheck({ items, subtotal: 31.37 }), { itemsTotal: 31.37, printed: 31.37, difference: 0, adds_up: true });
  const off = receiptCheck({ items, subtotal: 27.87 });
  assert.deepEqual([off.difference, off.adds_up], [3.5, false], "a missed discount shows as the items being too high");
  assert.deepEqual(receiptCheck({ items, subtotal: null, total: 32.57, tax: 1.2 }).printed, 31.37, "no subtotal: total less tax");
  assert.deepEqual([receiptCheck({ items }).difference, receiptCheck({ items }).adds_up], [null, null], "nothing printed to compare with");
});
