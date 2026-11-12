const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("Investments is a page of its own in the Money section, loaded after the logic it renders", () => {
  assert.match(app, /\["wealth", "Wealth", "🏦"\],\s*\["investments", "Investments", "📊"\]/, "listed right after Wealth");
  assert.match(app, /"wealth", "investments", "reports", "partners"\]/, "in the Money group of the sidebar");
  assert.match(app, /investments: renderInvestments,/, "registered as a page");
  assert.match(app, /currentView === "investments"\s*\? "Investments"/, "has its own title");
  assert.equal((app.match(/currentView === "partners" \|\| currentView === "investments"/g) || []).length, 2, "no month picker or CSV button on this page");
  assert.match(app, /if \(currentView === "investments"\) return \[\];/, "no household budget tiles on this page");
  assert.match(app, /bindPartnersEvents\(\);\s*bindInvestmentsEvents\(\);/);
  assert.ok(html.indexOf("/lib/investments-logic.js") > html.indexOf("/lib/shared-logic.js") && html.indexOf("/lib/investments-logic.js") < html.indexOf("/app.js?v="), "after shared-logic, before app.js");
});

test("the page shows the big total, owner strip, alerts, target mix, what you own, tax buckets, positions, accounts and fund types", () => {
  ["inv-total", "inv-strip", "inv-owners", "inv-alerts", "Against your target mix", "What you own", "Tax buckets", "Largest positions", "Accounts", "Fund types", "inv-tick"].forEach((marker) => assert.ok(app.includes(marker), `has ${marker}`));
  assert.match(app, /data-inv-target="\$\{bucket\.key\}"/, "targets are editable");
  assert.match(app, /data-inv-owner=[\s\S]*data-inv-tax=/, "each account has an owner and a tax bucket");
  assert.match(app, /data-inv-class="\$\{escapeHtml\(symbol\)\}"/, "each ticker has a fund type");
  assert.ok(app.includes('querySelectorAll("[data-inv-edit]").forEach((button) => button.addEventListener("click", () => openHoldingsModal(button.dataset.invEdit)))'), "Edit holdings reuses the existing dialog");
  assert.match(app, /state\.goals\.investmentsView = investmentsSanitizeMeta\(meta\);\s*autosaveState\(\);/, "choices are cleaned and saved with the household");
});

test("an account's card keeps its open state, and the page can never be wider than the screen", () => {
  assert.match(app, /data-inv-group="\$\{escapeHtml\(group\.groupId\)\}" \$\{investmentsOpen\.has\(group\.groupId\) \? "open" : ""\}/);
  assert.match(css, /\.inv \{ width: 100%; max-width: 980px; min-width: 0; margin: 0 auto;/, "explicit width: an auto-margin grid item would size to its widest table");
  assert.match(css, /\.inv > \*, \.inv-grid2 > \* \{ min-width: 0; \}/);
  assert.match(css, /\.inv-scroll \{ overflow-x: auto; \}/, "wide tables scroll inside their own box");
});

test("refreshing prices asks once per ticker, reports what it could not price, and never blanks a value", () => {
  assert.match(app, /const symbols = \[\.\.\.new Set\(holdings\.map\(\(asset\) => asset\.symbol\.trim\(\)\.toUpperCase\(\)\)\)\];/);
  assert.match(app, /if \(!\(Number\(result\.price\) > 0\)\) throw new Error\("no price"\);/, "a missing quote leaves the old price");
  assert.match(app, /no quote for \$\{missed\.slice\(0, 6\)\.join\(", "\)\}/);
});
