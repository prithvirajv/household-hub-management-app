const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

test("the Transactions page puts the ledger first: relevant slim figures, subcategories collapsed, one slim header", () => {
  const branch = app.slice(app.indexOf('if (currentView === "transactions") {'), app.indexOf("// The Partners page has its own figures"));
  ["monthRows", '["Spent"', '["Money in"', '["Transactions"', '["Waiting"'].forEach((piece) => assert.ok(branch.includes(piece), piece));
  assert.ok(app.includes('$("#metrics").classList.add("metrics-compact")') && app.includes('metrics.classList.add("metrics-compact")'), "every page gets the slim figures strip");
  assert.ok(app.includes('<details class="card manage-subcategories">') && app.includes('<h3 class="ledger-title">Ledger'));
  assert.ok(!app.includes("Manage subcategories from Transactions</h3>") && !app.includes('<div class="card-label">Recent transactions</div>'), "the extra headings are gone");
  assert.ok(app.includes('data-scroll-to="bankStreamCard"') && app.includes('id="bankStreamCard"'), "waiting Bank stream rows are one tap away");
  assert.match(app, /<section class="work-grid transactions-grid">/);
});

test("the ledger is one full-width table with a Tags column, a sticky header and no second scroll box; narrow screens get a two-line row with a ⋯ toggle", () => {
  assert.match(css, /\.transactions-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/, "the side cards go below, not beside");
  assert.match(css, /\.transactions-grid \.ledger-entry-list \{ max-height: none; overflow: visible; \}/);
  assert.match(css, /\.transactions-grid \.ledger-entry-head \{ position: sticky; top: 0;/);
  assert.match(css, /\.tag-chip-row \{ grid-column: 3; grid-row: 1;/);
  assert.ok(app.includes("<span>Tags</span>"));
  assert.ok(app.includes('data-ledger-row-more="${index}"') && app.includes("ledgerExpandedRows") && app.includes("row-expanded"));
  assert.match(css, /@media \(max-width: 1080px\) \{[^@]*\.ledger-entry-row:not\(\.row-expanded\) > select\[data-ledger-entry-account\]/);
  assert.match(css, /\.ledger-row-more \{ display: none; \}/, "no ⋯ on a wide screen");
});

test("the table's header and rows have the same number of columns, with and without accounts", () => {
  const count = (template) => template.replace(/repeat\((\d+), [^)]*\)/g, (_m, n) => " x".repeat(Number(n))).replace(/minmax\([^)]*\)/g, "x").trim().split(/\s+/).length;
  const grab = (re) => count(css.match(re)[1]);
  const plain = grab(/\.transactions-grid \.ledger-entry-row \{ grid-template-columns: ([^;]+); gap/);
  const withAccount = grab(/\.transactions-grid \.ledger-entry-row\.has-accounts \{ grid-template-columns: ([^;]+); \}/);
  assert.equal(withAccount, plain + 1, "one more column with accounts");
  // header children: checkbox, Payee, Tags, Amount, Date, Subcategory, [Account], five empty spans
  const head = app.slice(app.indexOf('<div class="ledger-entry-head'), app.indexOf('<div class="ledger-entry-list">'));
  assert.equal((head.match(/<span><\/span>/g) || []).length, 5, "five action columns");
  assert.equal(plain, 1 + 1 + 1 + 1 + 1 + 1 + 5, "checkbox, payee, tags, amount, date, subcategory, five actions");
});

test("Add a receipt and + New transaction sit side by side, and the receipts waiting fold into one collapsible line", () => {
  assert.match(css, /\.transactions-grid \.ledger-card \.receipt-inbox-head \{ order: 1; \}/);
  assert.match(css, /\.transactions-grid \.ledger-card > \.new-transaction:not\(\[open\]\) \{ order: 2; \}/);
  assert.match(css, /\.receipt-inbox > \.receipt-mail:not\(\[open\]\) \{ order: 3; \}/, "Get receipts by email is next to them too");
  assert.ok(app.includes('<details class="receipt-waiting" id="receiptWaitingDetails" ${receiptWaitingOpen ? "open" : ""}><summary>Receipts waiting for a transaction'));
  assert.ok(app.includes("ready to attach</b>") && app.includes("let receiptWaitingOpen = false;") && app.includes('$("#receiptWaitingDetails")?.addEventListener("toggle"'));
});

test("the toolbar controls share one height so they sit on one centre line", () => {
  assert.match(css, /#addReceiptButton,\s*\.transactions-grid \.ledger-card > \.new-transaction > summary,\s*\.transactions-grid \.ledger-card #ledgerAccountFilter \{[^}]*height: 36px; min-height: 36px;/);
});

test("every page opens with a slim header and slim figures; on a phone the header is two short rows and the figures a 2 x 2 grid", () => {
  assert.match(css, /#metrics\.metrics-compact \{ margin-bottom: 0\.2rem; \}/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\/\* Row 1: the page title and Sign out\./);
  assert.match(css, /\.topbar-actions \{ display: contents; \}/, "the actions become grid items of the header");
  assert.match(css, /#metrics\.metrics-compact \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /#signOutButton \{ grid-column: 4 \/ 6; grid-row: 1;/, "Sign out stays one tap away, on the title row");
  assert.match(css, /#metrics\.metrics-compact \.metric small \{ max-width: 26ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.ok(app.includes('title="${String(note).replace(/"/g, "&quot;")}"'), "the full note is the tile's tooltip");
});

test("Wealth folds closed accounts away: live accounts stay in their type groups, closed ones go to one collapsed 'Closed accounts' section", () => {
  assert.match(app, /let wealthCollapsedGroups = new Set\(\["closed-accounts"\]\);/, "collapsed to start with");
  assert.ok(app.includes("!isInvestmentAccount(account) && !account.closedAt)).map((group) =>"), "the type groups hold open accounts only");
  assert.ok(app.includes("}).join(\"\") + closedAccountsGroupHtml()"));
  assert.match(app, /function closedAccountsGroupHtml\(\) \{\s*const closed = state\.accounts\.filter\(\(account\) => account\.closedAt && !isInvestmentAccount\(account\)\);\s*if \(!closed\.length\) return "";/);
  assert.ok(app.includes('data-account-group="closed-accounts"'), "its open state is kept like the other groups");
});

test("recipe chips in the meal planner have a readable text colour, and a long list is searchable and scrolls", () => {
  const chip = css.match(/\.meal-picker-chip \{[^}]*\}/)[0];
  assert.match(chip, /background: var\(--panel\);/);
  assert.match(chip, /color: var\(--text\);/, "a button's white text on this light chip made the recipe name invisible");
  assert.ok(app.includes("data-meal-picker-search") && app.includes("meal-picker-chips-many") && app.includes("chip.hidden = !words.every("));
  assert.match(css, /\.meal-picker-chips-many \{ max-height: 14rem; overflow-y: auto;/);
  assert.match(css, /body::before \{ content: ""; position: fixed; top: 0; left: 0; right: 0; height: env\(safe-area-inset-top, 0px\);/, "a solid strip under the phone's status bar");
});

test("Budget rows carry captioned cells and stack on a phone; 'left to budget' is shown once; paycheck chips have a real remove target; Use in Meals waits for a slot", () => {
  ["budget-cell budget-cell-due", "budget-cell budget-cell-planned", "budget-cell budget-cell-spent", "budget-cell budget-cell-remaining", "budget-cell budget-cell-owner", "budget-cell budget-cell-repeats", "budget-cell budget-cell-deposit"].forEach((cls) => assert.ok(app.includes(cls), cls));
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.budget-line-head, \.budget-ledger-head, \.budget-ledger-head\.has-accounts \{ display: none; \}/);
  assert.match(css, /\.budget-line > \.budget-cell-planned \{ grid-column: 1; grid-row: 2; \}/);
  assert.ok(!app.includes('class="net-worth-strip budget-left-strip"'), "the big duplicate 'Left to budget' strip is gone (the Available figure at the top is the one)");
  assert.doesNotMatch(css, /\.budget-ledger-card \{[^}]*max-width/, "the Income card is as wide as the cards around it");
  assert.match(css, /\.mini-tag-remove \{ display: inline-grid; place-items: center; min-width: 24px; min-height: 24px;/);
  assert.match(css, /@media \(pointer: coarse\) \{ \.mini-tag-remove \{ min-width: 32px; min-height: 32px; \} \}/);
  assert.ok(app.includes("let mealsPlacingRecipeId = \"\";") && app.includes("mealsPickerSelectedRecipeId = planned?.recipeId || mealsPlacingRecipeId || \"\";") && app.includes("data-cancel-placing"));
  assert.ok(!app.includes('activeMealSlot = "Monday:Dinner";'), "no hard-coded Monday Dinner");
});
