const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("app.js");
const css = read("styles.css");
const html = read("index.html");

test("Prices is a page of its own in the Money menu, with its analysis loaded before the page code", () => {
  assert.match(app, /\["investments", "Investments", "📊"\],\s*\["prices", "Prices", "🏷️"\]/);
  assert.match(app, /"wealth", "investments", "prices", "reports", "partners"\]/);
  assert.match(app, /prices: renderPrices,/);
  assert.match(app, /currentView === "prices"\s*\? "Item prices"/, "has its own title");
  assert.match(app, /currentView === "investments" \|\| currentView === "prices" \|\| isProfileView/, "no month picker or CSV button here");
  assert.match(app, /if \(currentView === "prices"\) return \[\];/, "no household budget tiles here");
  assert.match(app, /bindInvestmentsEvents\(\);\s*bindPricesEvents\(\);/);
  assert.ok(html.indexOf("/lib/price-analysis.js") > html.indexOf("/lib/shared-logic.js") && html.indexOf("/lib/price-analysis.js") < html.indexOf("/app.js?v="), "after shared-logic, before app.js");
});

test("the page reads every receipt's items, reloads them when stale or after a receipt changes, and never loops on a failure", () => {
  assert.match(app, /api\("\/api\/receipts\?items=1"\)\)\.receipts\.filter\(\(receipt\) => \(receipt\.items \|\| \[\]\)\.length\)/);
  assert.match(app, /if \(currentView === "prices" && !priceReceiptsLoading && priceStale\(\)\) void loadPriceReceipts\(\);/);
  assert.match(app, /catch \(_error\) \{ priceReceipts \|\|= \[\]; \}\s*priceReceiptsLoading = false;\s*priceReceiptsLoadedAt = Date\.now\(\);/, "stamped even when the load fails");
  assert.match(app, /priceReceiptsLoadedAt = 0; \/\/ a receipt was read, corrected or removed/, "a changed receipt makes the analysis reload next time");
});

test("the page shows what is dear lately, where shops differ, and each product's last price, average, shops and purchases", () => {
  ["Dearer than usual lately", "Shops differ most on", "Your average", "Spent in total", "By shop", "Purchases", "First time recorded", "About your usual price"].forEach((text) => assert.ok(app.includes(text), `has "${text}"`));
  assert.match(app, /group\.verdict\.kind === "dearer" && recentDays\(group\.last\.date\) <= 45/, "only recent purchases are called out");
  assert.match(app, /group\.cheapestShop && group\.shopGapPercent >= 20/, "a shop gap is only worth saying at 20% or more");
  assert.match(app, /<details class="price-item" data-keep-open data-price-key="\$\{escapeHtml\(group\.key\)\}" \$\{priceOpen\.has\(group\.key\) \? "open" : ""\}>/, "a product keeps its open state");
});

test("search, shop and order redraw only the list, so typing keeps the cursor in the search box", () => {
  assert.match(app, /function refreshPricesList\(\) \{[\s\S]*?list\.innerHTML = pricesListHtml\(priceAnalyze\(priceReceipts\)\);\s*bindPriceDetails\(\);/);
  assert.match(app, /\$\("#pricesSearch"\)\?\.addEventListener\("input", \(event\) => \{ priceSearch = event\.target\.value; refreshPricesList\(\); \}\);/);
  ["recent", "bought", "dearer", "gap", "name"].forEach((order) => assert.ok(app.includes(`["${order}",`) || app.includes(`${order}:`), `can order by ${order}`));
});

test("each item in the receipt pop-up carries a note on how its price compares with the other receipts", () => {
  assert.match(app, /\$\{receiptPriceHintHtml\(item\)\}\$\{item\.discount \?/);
  assert.match(app, /const hint = priceHintFor\(priceReceipts, receiptData\.id, item\);/, "against the OTHER receipts: this receipt's own purchase is excluded");
  assert.match(app, /if \(priceStale\(\)\) void loadPriceReceipts\(\); \/\/ for the price notes under the items/);
  assert.match(css, /\.price-hint\.dearer \{ color: var\(--coral\); \}/);
});

test("the page can never be wider than the screen, and a product folds into one line on a phone", () => {
  assert.match(css, /\.prices \{ width: 100%; max-width: 980px; min-width: 0; margin: 0 auto;/, "explicit width: an auto-margin grid item would size to its widest table");
  assert.match(css, /\.price-scroll \{ overflow-x: auto; \}/);
  assert.match(css, /@media \(max-width: 560px\) \{ \.price-item summary \{ grid-template-columns: minmax\(0, 1fr\) auto; \} \.price-pill \{ grid-column: 1 \/ -1;/);
});
