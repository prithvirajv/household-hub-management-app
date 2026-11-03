const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("the new-transaction form is folded away on Transactions and its open state survives a re-render", () => {
  assert.match(app, /<details class="new-transaction" id="newTransactionDetails" \$\{newTransactionOpen \? "open" : ""\}>\s*<summary>\+ New transaction<\/summary>\s*<form id="transactionForm"/);
  assert.match(app, /\$\("#newTransactionDetails"\)\?\.addEventListener\("toggle", \(event\) => \{ newTransactionOpen = event\.currentTarget\.open; \}\)/);
  assert.match(app, /homeAddTransactionButton"\)\?\.addEventListener\("click", \(\) => goToViewAndRun\("transactions", \(\) => \{\s*newTransactionOpen = true;/, "the Home shortcut opens it before focusing the payee");
});

test("an empty month with rows waiting in Bank stream says so instead of reading as nothing synced", () => {
  assert.match(app, /waiting in Bank stream \(\$\{escapeHtml\(why\)\}\)/);
});

test("accounts saved as Other that read like investments are offered one click to Investment", () => {
  assert.match(app, /account\.type === "other" && !account\.closedAt && guessAccountType\(\{ name: account\.name \}\) === "investment"/);
  assert.match(app, /data-retype-investment/);
});

test("removing a deposit that matches no paycheck asks why, and 'my salary' teaches a paycheck", () => {
  assert.match(app, /if \(!plan\) \{\s*await askRemovalReason\(row\);\s*return;\s*\}/);
  assert.match(app, /function depositWorthAsking\(row\)[\s\S]*SALARY_PAYEE_DENYLIST[\s\S]*refundMatch\(row, state\.transactions\)/, "transfers, P2P payments and refunds are not asked about");
  assert.match(app, /depositPayeeKeys: key \? \[key\] : \[\]/, "a new paycheck remembers the payer");
  assert.match(app, /date: nextSalaryPayday\(row\.date, recurrence\)/, "it starts at the next payday, so the removed deposit is not counted twice");
});

test("any removed row asks why, with remembered reasons, and the learned-rules lists live on Profile instead of Transactions", () => {
  assert.match(app, /function askRemovalReason\(row\)/);
  assert.match(app, /REMOVAL_REASONS\.map\(\(reason\) => choice\(`built:\$\{reason\.id\}`, reason\.label\)\)/);
  assert.match(app, /\(state\.removalReasons \|\| \[\]\)\.map\(\(label\) => choice\(`custom:\$\{label\}`, label\)\)/, "reasons typed before are offered again");
  assert.match(app, /removalRule: lookupRemovalRule\(state\.removalRules, transaction\)/, "the Bank stream hold reason shows the rule");
  const profile = app.slice(app.indexOf("function renderProfile()"), app.indexOf("function renderHelp()"));
  assert.ok(profile.includes("learnedRulesCardHtml()"), "Profile shows the learned rules");
  const transactionsPage = app.slice(app.indexOf("function renderTransactions"), app.indexOf("function renderTransactions") + 60000);
  assert.equal(transactionsPage.includes("category-rules-card"), false, "the long category-rules list is gone from Transactions");
  assert.ok(transactionsPage.includes("data-open-learned-rules"), "a pointer to it stays");
});

test("a sync that skips pending rows says which accounts they are on and the newest posted row the bank sent for each", () => {
  assert.match(app, /const pendingDetail = \[\.\.\.feedByAccount\]\.filter\(\(\[, entry\]\) => entry\.pending\)/);
  assert.match(app, /pending skipped until they post\$\{result\.pendingDetail\.length \?/);
  assert.match(app, /newest posted row sent \$\{entry\.newestPosted \? formatShortDate\(entry\.newestPosted\) : "none"\}/);
});
