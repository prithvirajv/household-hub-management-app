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

test("Notes grow their checklist boxes in one batch, and the ledger shows half a page on a phone", () => {
  assert.ok(app.includes("function autoGrowNoteCheckTexts(elements)"));
  assert.ok(app.includes('autoGrowNoteCheckTexts(document.querySelectorAll("[data-note-check-text]"))') || app.includes("autoGrowNoteCheckTexts("), "both lists call the batch version");
  assert.match(app, /const ledgerPageSize = \(\) => \(window\.innerWidth <= 760 \? LEDGER_PAGE_SIZE \/ 2 : LEDGER_PAGE_SIZE\);/);
});

test("the Bank stream spans the full width, and Connected accounts is a live card under the ledger layout", () => {
  assert.match(css, /\.transactions-grid > \.side-stack > #bankStreamCard \{[^}]*grid-column: 1 \/ -1;[^}]*order: -1;/);
  assert.ok(app.includes("function connectedAccountsCardHtml()"));
  assert.ok(app.includes("${connectedAccountsCardHtml()}"), "drawn in the Transactions side-stack");
});

test("Wealth accounts fold into a summary row with an Edit toggle; a new account opens already editing", () => {
  assert.ok(app.includes('class="ghost account-edit-toggle" data-toggle-account-edit="${account.id}"'));
  assert.ok(app.includes("wealthEditingAccounts.has(account.id)") && app.includes("account-edit-panel"));
  assert.ok(app.includes("wealthEditingAccounts.add(newAccountId)"));
  assert.match(css, /\.account-summary-head/);
});

test("Budget owner pills appear only once a line has an owner (or a filter is active)", () => {
  assert.ok(app.includes('budgetMemberFilter !== "all" || state.budget.categories.some((category) => category.lines.some((line) => line.ownerId))'));
});

test("the Calendar add/edit form folds away, and its +Add buttons are exempt from the click-outside close", () => {
  assert.ok(app.includes('<details id="calendarAddPanel" class="calendar-add-panel" data-keep-open'));
  assert.ok(app.includes("function openCalendarForm()") && app.includes("data-calendar-hide-form"));
  assert.match(css, /\.calendar-add-panel > summary \{ display: none; \}/);
});

test("Reports' Sankey has phone rules, and the table-to-stack breakpoint is 1080px", () => {
  assert.ok(css.includes("@media (max-width: 1080px)"));
  assert.ok(!css.includes("@media (max-width: 1000px)"), "the old breakpoint is gone");
  assert.match(css, /sankey/i);
});

test("Transactions side cards: an even grid, housekeeping folded into a full-width bar that remembers it was open, and the learned-rules note is a card", () => {
  assert.ok(app.includes('<details class="card cleanup-card" id="cleanupPanel" data-keep-open ${cleanupPanelOpen ? "open" : ""}>'));
  assert.ok(app.includes('$("#cleanupPanel")?.addEventListener("toggle"'));
  assert.ok(app.includes('<section class="card learned-rules-pointer">'));
  assert.match(css, /\.transactions-grid > \.side-stack \{ align-items: stretch; \}/);
  assert.match(css, /\.transactions-grid > \.side-stack > \.cleanup-card \{ grid-column: 1 \/ -1; order: 99; \}/);
  assert.match(css, /\.transactions-grid > \.side-stack > details\.card \{ align-self: start; \}/);
});

test("the Bank stream no longer carries a second '+ Add transaction' (the ledger's '+ New transaction' is the one place to type one); Re-date is the quieter button", () => {
  assert.ok(!app.includes('<button id="addTransactionButton" type="button">+ Add transaction</button>'));
  assert.ok(app.includes('class="documents-upload-button secondary-upload"'));
  assert.match(css, /\.documents-upload-button\.secondary-upload \{ background: transparent;/);
});
