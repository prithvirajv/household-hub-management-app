const test = require("node:test");
const assert = require("node:assert/strict");
const { priceSingular, priceSizes, priceKey, priceUnitPrice, priceShopKey, priceVerdict, priceAnalyze, priceHintFor } = require("../lib/price-analysis");

const item = (name, qty, unit, amount, extra = {}) => ({ name, product: "", qty, unit, unitPrice: qty ? amount / qty : amount, amount, discount: 0, ...extra });
const receipt = (id, merchant, date, items) => ({ id, merchant, date, items });

test("names are reduced to what the thing is: singular, no brand or filler, sorted, with the package size kept for packaged items only", () => {
  assert.deepEqual(["bananas", "tomatoes", "berries", "glass", "hummus", "bus"].map(priceSingular), ["banana", "tomato", "berry", "glass", "hummus", "bus"]);
  assert.deepEqual(priceSizes("Eggs 5 dozen"), ["5dozen"]);
  assert.deepEqual(priceSizes("Chocolates 48 count"), ["48ct"]);
  assert.deepEqual(priceSizes("Frozen coconut 1.2KG 12 oz"), ["1.2kg", "12oz"]);
  assert.equal(priceKey(item("Roma tomatoes", 1.31, "lb", 3.39)), priceKey(item("Tomato Roma", 2, "lb", 5)), "word order and plurals do not matter");
  assert.equal(priceKey(item("Kirkland whole milk", 1, "each", 2.94)), priceKey(item("Whole milk", 1, "each", 3.1)), "a brand does not split a product");
  assert.notEqual(priceKey(item("Eggs 5 dozen", 1, "each", 10.39)), priceKey(item("Eggs 1 dozen", 1, "each", 3.49)), "pack sizes are different products");
  assert.equal(priceKey(item("Carrot 1lb bag", 0.34, "lb", 0.34)), priceKey(item("Carrot", 2, "lb", 2)), "a weighed item ignores its package");
  assert.notEqual(priceKey(item("Banana", 1.5, "lb", 1)), priceKey(item("Bananas", 1, "each", 1.49)), "per lb and each are never compared");
  assert.equal(priceKey(item("Kirkland unsalted quarters", 1, "each", 8.99, { product: "Butter" })), priceKey(item("Salted butter", 1, "each", 4, { product: "butter" })), "the generic product name wins over the item name");
});

test("the price is what was paid per base unit: after the discount, converted to lb, gal, each or dozen", () => {
  assert.equal(priceUnitPrice(item("Tomatoes", 2, "lb", 5)), 2.5);
  assert.equal(priceUnitPrice(item("Cheese", 8, "oz", 4)), 8, "8 oz for $4 is $8 a lb");
  assert.ok(Math.abs(priceUnitPrice(item("Rice", 2, "kg", 6)) - 6 / 4.40924) < 1e-9, "kg to lb");
  assert.ok(Math.abs(priceUnitPrice(item("Milk", 2, "l", 5)) - 5 / 0.528344) < 1e-9, "litres to gallons");
  assert.equal(priceUnitPrice(item("Paper", 1, "each", 11.49, { discount: 3.5 })), 11.49, "the amount is already after the discount");
  assert.equal(priceUnitPrice(item("Eggs", 2, "pack", 6)), 3);
  assert.equal(priceUnitPrice(item("Free sample", 1, "each", 0)), null, "nothing paid is not a price");
  assert.equal(priceUnitPrice(item("Odd", 0, "each", 3)), null);
});

test("shop names are compared by their distinctive words", () => {
  assert.equal(priceShopKey("Riverside International Market"), priceShopKey("riverside intl market"));
  assert.notEqual(priceShopKey("Corner Market"), priceShopKey("Harbor Pharmacy"));
  assert.equal(priceShopKey(""), "unknown");
});

test("dear, cheap or usual is against the earlier purchases only, by 10% and at least 5 cents", () => {
  assert.deepEqual(priceVerdict(3, []), { kind: "first", percent: 0, average: null });
  assert.deepEqual(priceVerdict(11, [10, 10]), { kind: "dearer", percent: 10, average: 10 });
  assert.equal(priceVerdict(9, [10, 10]).kind, "cheaper");
  assert.equal(priceVerdict(10.9, [10, 10]).kind, "usual", "9% is within the usual range");
  assert.equal(priceVerdict(0.5, [0.45]).kind, "usual", "11% but only 5 cents: not worth saying... (exactly at the limit counts as not dear)");
  assert.equal(priceVerdict(0.52, [0.4]).kind, "dearer", "30% and 12 cents");
  assert.equal(priceVerdict(0.43, [0.4]).kind, "usual", "7% and 3 cents");
});

test("every product is analysed across receipts: average, range, latest, verdict, per-shop prices and the gap between shops", () => {
  const receipts = [
    receipt("a", "Corner Market", "2026-10-01", [item("Roma tomatoes", 2, "lb", 5, { product: "roma tomato" }), item("Milk", 1, "each", 3, { product: "milk" })]),
    receipt("b", "Harbor Pharmacy", "2026-10-10", [item("Tomato Roma", 1, "lb", 1.5, { product: "roma tomato" })]),
    receipt("c", "Corner Market", "2026-11-01", [item("Roma tomatoes", 1, "lb", 3.3, { product: "roma tomato" }), item("Milk", 1, "each", 3, { product: "milk" })])
  ];
  const result = priceAnalyze(receipts);
  const tomato = result.find((group) => group.key.startsWith("roma tomato"));
  assert.deepEqual([tomato.label, tomato.unitLabel, tomato.count], ["Roma tomato", "per lb", 3]);
  assert.deepEqual([tomato.min, tomato.max, tomato.average, tomato.last.price], [1.5, 3.3, 2.43, 3.3], "(2.50 + 1.50 + 3.30) / 3");
  assert.deepEqual([tomato.verdict.kind, tomato.verdict.percent, tomato.verdict.average], ["dearer", 65, 2], "3.30 against the earlier 2.50 and 1.50");
  assert.deepEqual(tomato.byShop.map((shop) => [shop.shopName, shop.count, shop.average]), [["Harbor Pharmacy", 1, 1.5], ["Corner Market", 2, 2.9]], "cheapest shop first");
  assert.deepEqual([tomato.cheapestShop.shopName, tomato.dearestShop.shopName, tomato.shopGapPercent], ["Harbor Pharmacy", "Corner Market", 93]);
  const milk = result.find((group) => group.label === "Milk");
  const packs = priceAnalyze([receipt("p", "Corner Market", "2026-11-01", [item("Eggs 5 dozen", 1, "each", 10.39, { product: "eggs" }), item("Eggs 1 dozen", 1, "each", 3.49, { product: "eggs" })])]);
  assert.deepEqual(packs.map((group) => group.label).sort(), ["Eggs (1 dozen)", "Eggs (5 dozen)"], "two pack sizes are two rows, each saying which");
  assert.deepEqual([milk.verdict.kind, milk.cheapestShop, milk.shopGapPercent], ["usual", null, 0], "one shop: no comparison between shops");
  assert.deepEqual(tomato.purchases.map((purchase) => purchase.date), ["2026-10-01", "2026-10-10", "2026-11-01"], "oldest first");
});

test("a receipt without a date is placed by when it was added, an item that is only bought once is the first of its kind, and bad lines are ignored", () => {
  const result = priceAnalyze([
    { id: "x", merchant: "Corner Market", date: "", createdAt: "2026-11-05T10:00:00Z", items: [item("Honey", 1, "each", 14.79), item("Broken", 0, "each", 3), item("Free", 1, "each", 0)] },
    receipt("y", "Corner Market", "2026-10-01", [item("Honey", 1, "each", 12)])
  ]);
  assert.equal(result.length, 1, "lines with no usable price are left out");
  assert.deepEqual(result[0].purchases.map((purchase) => purchase.date), ["2026-10-01", "2026-11-05"]);
  assert.equal(result[0].verdict.kind, "dearer", "14.79 against 12.00, the later date being the added one");
  assert.deepEqual(priceAnalyze([receipt("z", "Corner Market", "2026-11-01", [item("Salt", 1, "each", 1)])])[0].verdict.kind, "first");
  assert.deepEqual(priceAnalyze([]), []);
  assert.deepEqual(priceAnalyze(undefined), []);
});

test("the hint for one item compares it with the same product on OTHER receipts only", () => {
  const receipts = [
    receipt("a", "Corner Market", "2026-10-01", [item("Roma tomatoes", 1, "lb", 2, { product: "roma tomato" })]),
    receipt("b", "Harbor Pharmacy", "2026-10-10", [item("Tomato Roma", 1, "lb", 3, { product: "roma tomato" })])
  ];
  const current = item("Roma tomatoes", 1, "lb", 3.5, { product: "roma tomato" });
  assert.deepEqual(priceHintFor(receipts, "c", current), { kind: "dearer", percent: 40, average: 2.5, count: 2, unitLabel: "per lb", price: 3.5 });
  assert.equal(priceHintFor(receipts, "a", item("Roma tomatoes", 1, "lb", 2, { product: "roma tomato" })).count, 1, "this receipt's own purchase is not compared with itself");
  assert.equal(priceHintFor(receipts, "c", item("Soap", 1, "each", 2)), null, "nothing to compare with");
  assert.equal(priceHintFor(receipts, "c", item("Roma tomatoes", 1, "each", 3.5, { product: "roma tomato" })), null, "a different unit family is never compared");
  assert.equal(priceHintFor(receipts, "c", item("Free", 1, "each", 0)), null);
});
