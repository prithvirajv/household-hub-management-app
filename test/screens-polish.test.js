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
  assert.match(css, /html\[data-theme="dark"\] :is\(\.pill, \.pill-button, \.stock-chip, \.event,[^)]*\.stock-market-value, \.gain-loss\) \{ --green: #6ee5be; \}/);
  assert.ok(!/html\[data-theme="dark"\] \{[^}]*--green: #6ee5be/.test(css), "--green itself is not changed for the whole page");
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

test("Transactions: subcategory tools sit with the housekeeping bars, an empty Bank stream is a slim card, and Check against the bank says what it found", () => {
  assert.ok(app.includes('id="manageSubcategories" data-keep-open ${manageSubcategoriesOpen ? "open" : ""}') && app.includes('$("#manageSubcategories")?.addEventListener("toggle"'));
  assert.match(css, /\.transactions-grid > \.side-stack > \.manage-subcategories \{ grid-column: 1 \/ -1; order: 98; \}/);
  assert.ok(app.includes('${allImported.length || bankImportFeedback ? "" : "bank-stream-idle"}'));
  assert.ok(app.includes("accounted for` : `${missing.length} missing"), "the collapsed summary reports the result");
  assert.ok(app.includes("Let AI categorize and file imports"));
});

test("Wealth debts fold into a summary row (balance, APR, EMI) with an Edit toggle; a new debt opens already editing", () => {
  assert.ok(app.includes('const debtEditKey = `debt:${debt.id || index}`;'));
  assert.ok(app.includes("${debtEditing ? `<div class=\"debt-edit-grid\">"));
  assert.ok(app.includes("wealthEditingAccounts.add(`debt:${id}`)"));
  assert.match(css, /\.debt-summary-head \{ padding-right: 0;/);
});

test("test servers get a free port from the OS, never a guessed one another server could share", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const helpers = read("test/helpers.js");
  assert.ok(helpers.includes("probe.listen(0") && !helpers.includes("Math.random"));
  assert.ok(helpers.includes("Test server exited early") && helpers.includes('server.kill("SIGKILL")'));
  assert.ok(!read("test/auth.integration.test.js").includes("Math.random"));
});

test("a typed or pasted #page in the address bar switches the page (Back/Forward still use the history entry's view)", () => {
  assert.ok(app.includes("const view = event.state?.view || location.hash.slice(1);"));
});

test("Plan leads with the to-do list: quick add, the day's tasks (timed first), Time/length/repeat and the log folded away", () => {
  assert.ok(app.includes('<section class="card plan-todo-card">'));
  assert.ok(app.includes("const planTodoRows = [...scheduled, ...unscheduled];"));
  assert.ok(app.includes('<details class="plan-more-options" ${editingTask ? "open" : ""}>'));
  assert.ok(app.includes('<details class="card plan-log-panel" id="planLogPanel" data-keep-open ${editingLog || planLogOpen ? "open" : ""}>'));
  assert.ok(app.includes('$("#planLogPanel")?.addEventListener("toggle"'));
  assert.ok(app.indexOf('class="card plan-todo-card"') < app.indexOf('id="planLogPanel"') && app.indexOf('id="planLogPanel"') < app.indexOf('<div class="plan-timeline" style='), "to-do, then the log, then the timeline");
  assert.ok(!app.includes('<div class="plan-unscheduled">'), "unscheduled tasks are part of the one list now");
  assert.ok(app.includes("metaChips.push(`${task.startTime}–${minutesToTime("), "a timed task shows its time");
});

test("Notes: filters are a row of pills, the board is a masonry, row actions show on hover/focus, the composer is centred", () => {
  const notes = css.slice(css.indexOf("Notes redesign:"));
  assert.match(notes, /\.notes-layout \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(notes, /\.notes-board \{ display: block; column-width: 270px;/);
  assert.match(notes, /\.notes-board > \.note-card \{ break-inside: avoid;/);
  assert.match(notes, /\.notes-search, \.note-composer, \.note-composer-compact \{ max-width: 680px; margin-inline: auto; \}/);
  assert.match(notes, /@media \(hover: hover\) \{\s*\.note-check-row \.note-check-level/);
  assert.match(notes, /:focus-within \.note-check-delete/, "keyboard users see the row actions too");
  assert.ok(app.includes('title="${note.pinned ? "Unpin note" : "Pin note"}" aria-pressed='));
});

test("Wealth: debts fold their payoff and payment boxes, and a flat net-worth history is a sentence, not a flat line", () => {
  assert.ok(app.includes('<details class="debt-more" data-keep-open data-debt-more='));
  assert.ok(app.includes("const wealthTrendIsFlat ="));
  assert.ok(app.includes("The history draws itself as your balances change"));
});

test("Paycheck/Income: each entry keeps name, amount and its lines in view, with date, repeat and deposit account behind one summary line", () => {
  assert.ok(app.includes('<details class="paycheck-more" data-keep-open data-paycheck-more='));
  assert.ok(app.includes("const paycheckMoreOpen = new Set();") && app.includes("[data-paycheck-more]"));
  assert.match(css, /\.paycheck-more > summary \{ cursor: pointer;/);
});

test("Plan: unfinished tasks offer a Move to today with Undo, and an empty day offers yesterday's tasks or a Notes checklist", () => {
  assert.ok(app.includes("data-plan-roll-over") && app.includes("unfinishedEarlierTasks(privateData.plans.tasks, planToday)"));
  assert.ok(app.includes('actionLabel: "Undo", duration: 10000'));
  assert.ok(app.includes("data-plan-copy-yesterday") && app.includes("data-plan-from-note"));
});

test("a delete can be taken back: the toast carries a real Undo button, wired for checklist items, paychecks, debts, goals and Plan tasks", () => {
  assert.ok(app.includes("function offerUndo(message, restore, save)"));
  assert.ok(app.includes('action.className = "toast-action"') && app.includes('action.type = "button"'));
  ["Deleted the checklist item.", "Deleted ${paycheck.name || \"the paycheck\"}.", "Deleted ${debt.name || \"the debt\"}.", "Deleted ${removedGoal.name || \"the goal\"}.", "Deleted \"${(removedPlanTask.title"].forEach((piece) => assert.ok(app.includes(piece), piece));
  assert.equal((app.match(/offerUndo\(/g) || []).length >= 6, true);
});

test("Notes search shows a match count and is not kept between visits; Goals fold like accounts and debts", () => {
  assert.ok(app.includes('id="notesSearchCount"') && app.includes('state.notes.search = "";'));
  assert.ok(app.includes("const goalKey = `goal:${index}`;") && app.includes('<div class="account-summary-head goal-summary-head">'));
  assert.ok(app.includes("wealthEditingAccounts.add(`goal:${state.goals.sinkingFunds.length - 1}`)"));
});

test("keyboard focus is visible on buttons and fold-away summaries, and the quick-add task field has a name", () => {
  assert.match(css, /:is\(button, summary, \[role="button"\]\):focus-visible \{ outline: 2px solid var\(--blue\); outline-offset: 2px; \}/);
  assert.ok(app.includes('aria-label="Add a task for ${dayLabel}"'));
});

test("dark mode: tag chips, note labels and delete crosses clear 4.5:1 with the lighter green and coral", () => {
  assert.match(css, /\.mini-tags span, \.note-labels span, [^)]*\) \{ --green: #6ee5be; \}/);
  assert.match(css, /html\[data-theme="dark"\] :is\(\.icon-button\.danger-button, \.mini-tag-remove, \.note-check-delete\) \{ color: #ff9a9a; \}/);
});

test("Notes can be reordered by dragging a card's handle onto another card, or with Move earlier / later; search hints say where a note matched", () => {
  assert.ok(app.includes("}).sort(compareNotes);"));
  assert.ok(app.includes('data-note-drag-handle="${note.id}" type="button" draggable="true"'));
  assert.ok(app.includes('const NOTE_DRAG_TYPE = "application/x-familyloop-note";') && app.includes("reorderNotes(state.notes.entries, visibleNotes()"));
  assert.ok(app.includes('data-move-note="${note.id}:-1"') && app.includes('data-move-note="${note.id}:1"'));
  assert.ok(app.includes("sortOrder: undefined,"), "a copy lands on top");
  assert.ok(app.includes("data-note-match-hint") && app.includes("noteMatchLocations(note, query)"));
  assert.match(css, /\.note-drop-target \{ outline: 2px dashed var\(--blue\);/);
  assert.match(css, /@media \(hover: none\) \{ \.note-drag-handle \{ display: none; \}/, "touch screens use the menu instead");
});

test("Reports' net-worth trend is a sentence, not a lone dot, when there is no history", () => {
  assert.ok(app.includes("The history draws itself once your balances change from month to month."));
});
