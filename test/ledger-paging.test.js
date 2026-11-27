const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("the ledger draws a page of rows at a time and starts over when the month, account or sort changes", () => {
  assert.match(app, /const LEDGER_PAGE_SIZE = 200;/);
  assert.match(app, /const limitKey = \[state\.budget\.month, ledgerAccountFilter, ledgerAllMonths, ledgerNeedsCategoryOnly, transactionSort\.field, transactionSort\.direction\]/);
  assert.match(app, /const sorted = allSorted\.slice\(0, ledgerRowLimit\)/);
  assert.match(app, /id="ledgerShowMore"/);
  assert.match(app, /id="ledgerShowAll"/);
  assert.match(app, /\$\("#ledgerShowMore"\)\?\.addEventListener\("click", \(\) => \{ ledgerRowLimit \+= LEDGER_PAGE_SIZE; render\(\); \}\)/);
});

test("select-all only ticks the rows that are drawn, so a bulk change never reaches hidden rows", () => {
  assert.match(app, /\$\("#ledgerSelectAllCheckbox"\)\?\.addEventListener\("change"[\s\S]{0,200}querySelectorAll\("\[data-ledger-entry-select\]"\)/);
});
