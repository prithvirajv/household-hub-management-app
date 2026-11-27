const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

test("Home: Quick add is one row of buttons (same ids), and a long Bills & goals list folds after five", () => {
  assert.ok(app.includes('<section class="card quick-add-card">') && app.includes('<div class="quick-add-row">'));
  ["homeAddChoreButton", "homeAddReminderButton", "homeAddBirthdayButton", "homeAddAnniversaryButton", "homeAddTransactionButton", "homeAddIncomeButton"].forEach((id) => assert.ok(app.includes(`id="${id}"`), id));
  assert.ok(!app.includes("Jump straight to adding something"));
  assert.ok(app.includes("billsAndGoals.slice(0, 5).map(row)") && app.includes('<details class="home-more">'));
});

test("padded payees are shown with single spaces in the ledger and Bank stream, and stored values are untouched", () => {
  assert.ok(app.includes('value="${escapeHtml(payeeDisplay(transaction.payee))}"'));
  assert.equal((app.match(/payeeDisplay\(transaction\.payee\)/g) || []).length >= 4, true, "ledger and Bank stream rows");
  const fn = app.slice(app.indexOf("function payeeDisplay(payee) {"), app.indexOf("function lazyLineOptionsHtml"));
  assert.match(fn, /replace\(\/\\s\{2,\}\/g, " "\)\.trim\(\)/);
  const display = new Function(`${fn}; return payeeDisplay;`)();
  assert.equal(display("Zelle payment from      PRIYA SAMPLE"), "Zelle payment from PRIYA SAMPLE");
  assert.equal(display("  A   B "), "A B");
  assert.equal(display(null), "");
});

test("small print has a 12px floor, and the tag chips' remove button keeps a real size", () => {
  const floor = css.slice(css.indexOf("A floor of 12px for text that was"));
  ["#view .card-label", "#view .pill", "#view .pill-button", "#view .budget-cell small", "#view .event", "#metrics .metric span", "#view .plan-timeline-hour"].forEach((sel) => assert.ok(floor.includes(sel), sel));
  assert.match(css, /\.tag-chip-remove \{ min-width: 24px; width: 24px; height: 24px; min-height: 24px; \}/);
  assert.match(css, /\.tag-chip-remove \{ flex: 0 0 auto;/, "the one-line tag cell can no longer squeeze it to 7px");
});

test("the ledger card can never be wider than the screen (a long account name in the filter pushed rows to 1,000px on a phone)", () => {
  assert.match(css, /\.transactions-grid \.ledger-card > \* \{ min-width: 0; max-width: 100%; \}/);
  assert.match(css, /\.transactions-grid \.ledger-card > \.ledger-filter-row \{ flex: 1 1 auto; \}/);
  assert.match(css, /\.transactions-grid \.ledger-entry-scroll, \.transactions-grid \.ledger-entry-list \{ min-width: 0; max-width: 100%; \}/);
});

test("dark mode: green text on green tints uses the lighter green, scoped so buttons keep their white text on the darker green", () => {
  assert.match(css, /html\[data-theme="dark"\] :is\(\.pill, \.pill-button, \.stock-chip, \.event,[^)]*\.stock-market-value, \.gain-loss\) \{ --green: #55d6ab; \}/);
  assert.ok(!/html\[data-theme="dark"\] \{[^}]*--green: #55d6ab/.test(css), "--green itself is not changed for the whole page");
});

test("Budget's 'N unassigned transactions' Assign opens Transactions showing only the rows that need a category, from every month, in the ledger and Bank stream", () => {
  assert.ok(app.includes('data-assign-unassigned type="button" title="Open Transactions showing only these">Assign</button>'));
  assert.ok(!app.includes('<button class="pill-button" data-goto-view="transactions" type="button">Assign</button>'), "it no longer just opens the page");
  assert.match(app, /const ledgerMonthMatches = \(row\) => ledgerNeedsCategoryOnly \|\| /, "every month while the filter is on");
  assert.ok(app.includes("const needsCategory = (row) => !row.lineId && !(row.splits || []).length;"));
  assert.ok(app.includes("(!ledgerNeedsCategoryOnly || needsCategory(transaction))"), "both the ledger and Bank stream are filtered");
  assert.ok(app.includes('id="ledgerNeedsCategoryButton"') && app.includes('id="ledgerNeedsCategoryClear"') && app.includes("Needs a category (${waiting})"));
  assert.match(app, /if \(currentView !== "transactions"\) ledgerNeedsCategoryOnly = false;/, "it lasts only while the person is on Transactions");
  assert.match(css, /\.transactions-grid \.ledger-card > \.ledger-needs-filter \{ flex: 0 0 auto; order: 4; \}/);
});
