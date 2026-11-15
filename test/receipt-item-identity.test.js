const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanReceiptFields } = require("../lib/receipt-read");
const { priceKey, priceHintFor } = require("../lib/price-analysis");

const banana = (extra = {}) => ({ name: "Bananas", qty: 2, unit: "lb", unitPrice: 0.5, amount: 1, discount: 0, ...extra });

test("a corrected saving and a corrected product are kept when the receipt is saved", () => {
  const cleaned = cleanReceiptFields({ merchant: "Costco", date: "2026-11-12", total: 14.99, items: [{ name: "Kirkland parchment paper", product: "Parchment Paper ", qty: 1, unit: "each", unitPrice: 14.99, amount: 11.49, discount: 3.5 }] });
  assert.deepEqual([cleaned.items[0].discount, cleaned.items[0].product, cleaned.items[0].amount], [3.5, "parchment paper", 11.49]);
  const changed = cleanReceiptFields({ items: [{ name: "Kirkland parchment paper", product: "parchment paper", qty: 1, unit: "each", unitPrice: 14.99, amount: 11.49, discount: 5 }] });
  assert.equal(changed.items[0].discount, 5, "a different saving replaces the old one");
  assert.equal(cleanReceiptFields({ items: [{ name: "Milk", qty: 1, amount: 2.94, discount: -4 }] }).items[0].discount, 0, "a saving is never negative");
});

test("naming a product makes two lines the same product, or keeps a variety apart", () => {
  // Without a product the name decides: "Bananas" and "Organic bananas" are different products.
  assert.notEqual(priceKey(banana()), priceKey(banana({ name: "Organic bananas" })));
  // Saying "banana" for both makes them one product (the plural and word order do not matter).
  assert.equal(priceKey(banana({ product: "banana" })), priceKey(banana({ name: "Organic bananas", product: "Bananas" })));
  // Saying a different product for one keeps it apart even though the names are the same.
  assert.notEqual(priceKey(banana({ product: "banana" })), priceKey(banana({ product: "plantain" })));
  assert.notEqual(priceKey(banana({ product: "banana" })), priceKey(banana({ product: "organic banana" })));
});

test("the price note on a receipt follows the product it counts as", () => {
  const earlier = { id: "r1", items: [banana({ amount: 1, product: "banana" })] };
  const now = banana({ name: "Organic bananas", amount: 1.8 });
  assert.equal(priceHintFor([earlier], "r2", now), null, "a different name is a different product: nothing to compare with");
  const hint = priceHintFor([earlier], "r2", { ...now, product: "banana" });
  assert.ok(hint && hint.kind === "dearer", "said to be the same banana, it is compared, and it is dearer");
});
