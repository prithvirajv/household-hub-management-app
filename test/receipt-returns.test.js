const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { receiptReturnTaxRatio, receiptReturnRefunds, receiptReturnItemSets, receiptReturnedTotal } = require("../lib/receipt-returns");
const { cleanReceiptFields } = require("../lib/receipt-read");
const { priceAnalyze, priceHintFor, priceUnitPrice } = require("../lib/price-analysis");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("app.js");
const css = read("styles.css");
const html = read("index.html");

// The user's Amazon order: four items, $77.92 before tax, $83.38 with it.
const items = () => [
  { name: "Stress cube", amount: 16.99 }, { name: "Sketching kit", amount: 25.99 }, { name: "LEGO pickup truck", amount: 14.95 }, { name: "LEGO off-road buggy", amount: 19.99 }
];
const receipt = { merchant: "Amazon", date: "2026-09-24", subtotal: 77.92, total: 83.38 };
const near = (actual, expected, tolerance = 0.01) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test("the tax on a receipt is spread over its items as the total over the subtotal", () => {
  near(receiptReturnTaxRatio(receipt), 83.38 / 77.92, 1e-9);
  assert.equal(receiptReturnTaxRatio({ subtotal: 50, total: 50 }), 1, "no tax");
  assert.equal(receiptReturnTaxRatio({ total: 30 }), 1, "no subtotal printed");
  assert.equal(receiptReturnTaxRatio({ subtotal: 50, total: 40 }), 1, "a total below the subtotal is not tax");
  assert.equal(receiptReturnTaxRatio(null), 1);
});

test("refunds that look related: money in, the same shop, on or after the purchase, within four months, on the same card", () => {
  const purchase = { payee: "AMAZON MKTPL*2B4", amount: 83.38, date: "2026-09-24", accountId: "visa" };
  const rows = [
    purchase,
    { payee: "AMAZON MKTPL*XY1", amount: -16, date: "2026-10-03", accountId: "visa" }, // the refund
    { payee: "AMAZON MKTPL*XY2", amount: -5, date: "2026-09-20", accountId: "visa" }, // before the purchase
    { payee: "AMAZON MKTPL*XY3", amount: -9, date: "2027-03-01", accountId: "visa" }, // too late
    { payee: "AMAZON MKTPL*XY4", amount: -9, date: "2026-10-05", accountId: "checking" }, // another card
    { payee: "TARGET 1147", amount: -9, date: "2026-10-05", accountId: "visa" }, // another shop
    { payee: "AMAZON PRIME", amount: 14.99, date: "2026-10-05", accountId: "visa" } // money out, not a refund
  ];
  const found = receiptReturnRefunds(receipt, rows, purchase);
  assert.deepEqual(found.map((refund) => [refund.index, refund.amount]), [[1, 16]]);
  assert.equal(receiptReturnRefunds(receipt, rows, null).length, 2, "with no purchase yet the card is not known, so the other card's refund counts too");
  assert.deepEqual(receiptReturnRefunds({ merchant: "Amazon" }, rows, null), [], "a receipt with no date has nothing to measure from");
  const later = [{ payee: "AMAZON", amount: -3, date: "2026-12-01" }, { payee: "AMAZON", amount: -4, date: "2026-10-01" }];
  assert.deepEqual(receiptReturnRefunds(receipt, later, null).map((refund) => refund.amount), [4, 3], "nearest first");
});

test("the items a refund adds up to are found, with the tax share, fewest items first", () => {
  // The LEGO truck is $14.95, and with its share of the tax $16.00 came back.
  assert.deepEqual(receiptReturnItemSets(items(), 16, receiptReturnTaxRatio(receipt)), [[2]]);
  assert.deepEqual(receiptReturnItemSets(items(), 14.95, 1), [[2]], "a refund of the price without tax");
  // Two items: the cube and the truck, with tax.
  const both = Math.round((16.99 + 14.95) * (83.38 / 77.92) * 100) / 100;
  assert.deepEqual(receiptReturnItemSets(items(), both, receiptReturnTaxRatio(receipt)), [[0, 2]]);
  assert.deepEqual(receiptReturnItemSets(items(), 0.5, 1), [], "nothing adds up to it");
  assert.deepEqual(receiptReturnItemSets(items(), 0, 1), []);
  assert.deepEqual(receiptReturnItemSets([], 5, 1), []);
  const marked = items(); marked[2].returned = true;
  assert.deepEqual(receiptReturnItemSets(marked, 16, receiptReturnTaxRatio(receipt)), [], "an item already marked returned is not offered again");
  assert.deepEqual(receiptReturnItemSets([{ amount: 10 }, { amount: 20 }, { amount: 30 }, { amount: 99 }], 60, 1), [[0, 1, 2]], "no one or two items make 60; 10 + 20 + 30 does");
});

test("when several groups fit only a few are offered, and a long receipt is not searched for triples", () => {
  const many = Array.from({ length: 12 }, () => ({ amount: 5 }));
  assert.equal(receiptReturnItemSets(many, 5, 1).length, 3, "at most three suggestions");
  const long = Array.from({ length: 60 }, (_v, i) => ({ amount: 1 + i * 0.01 }));
  assert.deepEqual(receiptReturnItemSets(long, 3.06, 1).filter((set) => set.length === 3), [], "triples are only tried on a receipt of 40 items or fewer");
});

test("what was returned adds up, an item's returned mark is kept on save, and a returned item is not a purchase", () => {
  const list = items(); list[0].returned = true; list[2].returned = true;
  near(receiptReturnedTotal(list), 16.99 + 14.95);
  assert.equal(receiptReturnedTotal([]), 0);
  const cleaned = cleanReceiptFields({ merchant: "Amazon", items: [{ name: "Stress cube", qty: 1, amount: 16.99, returned: true }, { name: "Kit", qty: 1, amount: 25.99 }, { name: "Odd", qty: 1, amount: 3, returned: "yes" }] });
  assert.deepEqual(cleaned.items.map((item) => item.returned), [true, undefined, undefined], "only an actual true is kept; the others carry no mark at all");
  assert.equal(priceUnitPrice({ name: "Cube", qty: 1, unit: "each", amount: 16.99 }), 16.99);
  assert.equal(priceUnitPrice({ name: "Cube", qty: 1, unit: "each", amount: 16.99, returned: true }), null);
  const receipts = [
    { id: "a", merchant: "Amazon", date: "2026-09-01", items: [{ name: "Stress cube", product: "stress cube", qty: 1, unit: "each", amount: 10 }] },
    { id: "b", merchant: "Amazon", date: "2026-09-24", items: [{ name: "Stress cube", product: "stress cube", qty: 1, unit: "each", amount: 16.99, returned: true }] }
  ];
  const groups = priceAnalyze(receipts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].purchases.length, 1, "the returned purchase is left out of the price history");
  assert.equal(priceHintFor(receipts, "b", { name: "Stress cube", product: "stress cube", qty: 1, unit: "each", amount: 16.99 }).count, 1);
  const onlyReturned = [{ id: "a", merchant: "Amazon", date: "2026-09-01", items: [{ name: "Stress cube", product: "stress cube", qty: 1, unit: "each", amount: 10, returned: true }] }];
  assert.equal(priceHintFor(onlyReturned, "z", { name: "Stress cube", product: "stress cube", qty: 1, unit: "each", amount: 12 }), null, "returned earlier purchases are not a price to compare with");
});

test("the pop-up lets items be ticked as returned and offers the related refunds, and the page loads the returns helper after the matcher", () => {
  assert.match(app, /data-key="returned" \$\{item\.returned \? "checked" : ""\}/);
  assert.match(app, /if \(key === "returned"\) item\.returned = input\.checked;/);
  assert.match(app, /if \(input\.dataset\.key === "returned"\) render\(\);/, "the suggestions and summary follow the tick");
  assert.match(app, /\$\{receiptReturnsHtml\(\)\}/);
  assert.match(app, /receiptReturnRefunds\(\{ merchant: receiptDraft\.merchant, date: receiptDraft\.date \}, state\.transactions, purchase\)/);
  assert.match(app, /data-receipt-return="\$\{first\.join\(","\)\}">Mark returned/, "one tap ticks the suggested items");
  assert.match(app, /Returned items are left out of your price history\. Save to keep this\./);
  assert.ok(html.indexOf("/lib/receipt-returns.js") > html.indexOf("/lib/receipt-match.js") && html.indexOf("/lib/receipt-returns.js") < html.indexOf("/app.js?v="), "after the matcher it uses, before app.js");
  assert.match(css, /\.receipt-returns \{ border-left: 4px solid var\(--blue\);/);
});
