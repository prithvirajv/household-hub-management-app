const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

test("Bank stream rows are cross-checked and drawn a page at a time, not all at once", () => {
  assert.match(app, /const BANK_STREAM_PAGE_SIZE = 100;/);
  assert.match(app, /const imported = importedBase\.slice\(0, bankStreamRowLimit\)\.map\(enrichBankRow\)/);
  assert.doesNotMatch(app, /const allImported = transactionInboxItems\(\)\s*\.filter\([^)]*\)\s*\.map\(\(transaction\) => \(\{\s*\.\.\.transaction,\s*possibleDuplicate/, "the matchers no longer run for every waiting row");
  assert.match(app, /id="bankStreamShowMore"/);
});

test("the Notes board draws 30 unpinned notes at a time", () => {
  assert.match(app, /const NOTES_PAGE_SIZE = 30;/);
  assert.match(app, /const shownOthers = others\.slice\(0, notesRowLimit\)/);
  assert.match(app, /id="notesShowMore"/);
});

test("a Ledger row's two menus hold only the current choice until they are touched", () => {
  assert.match(app, /data-lazy-options="line"/);
  assert.match(app, /data-lazy-options="account"/);
  assert.match(app, /\["pointerdown", "focusin", "touchstart"\]\.forEach\(\(type\) => view\.addEventListener\(type/);
  assert.match(app, /function fillLazySelect\(select\)[\s\S]{0,600}select\.value = value;/, "the choice survives the fill");
});

test("rows built for a wide screen wrap or squeeze on phones instead of running past the right edge", () => {
  assert.match(css, /\.account-item,\s*\.net-worth-item \{ min-width: 0; grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.budget-vs-actual-row > :first-child \{ grid-column: 1 \/ -1;/);
  assert.match(css, /\.button-row,\s*\.section-head \{ flex-wrap: wrap; \}/);
});

test("Recipes can paste the copied link, which is the iPhone route since it cannot use the Share menu", () => {
  assert.match(app, /id="recipeImportPasteButton"/);
  assert.match(app, /navigator\.clipboard\.readText\(\)/);
});
