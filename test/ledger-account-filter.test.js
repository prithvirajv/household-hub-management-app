const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

// The two small helpers are pure apart from the page's own filter variables, so they are run here exactly as written in app.js.
function helpers(filter, allMonths, month) {
  const source = [
    app.slice(app.indexOf("function ledgerAccountFilterMatches"), app.indexOf("function accountOptions")),
  ].join("\n");
  const context = { ledgerAccountFilter: filter, ledgerAllMonths: allMonths, state: { budget: { month } } };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.matches = ledgerAccountFilterMatches; this.monthOk = ledgerMonthMatches;`, context);
  return context;
}

test("with no account chosen every row matches and the month limit applies", () => {
  const { matches, monthOk } = helpers("", false, "2026-11");
  assert.equal(matches({ accountId: "a" }), true);
  assert.equal(matches({}), true);
  assert.equal(monthOk({ date: "2026-11-05" }), true);
  assert.equal(monthOk({ date: "2026-10-05" }), false);
});

test("choosing an account keeps only its rows; 'none' keeps the rows with no account", () => {
  const one = helpers("card-1", false, "2026-11");
  assert.equal(one.matches({ accountId: "card-1" }), true);
  assert.equal(one.matches({ accountId: "card-2" }), false);
  assert.equal(one.matches({}), false);
  const none = helpers("none", false, "2026-11");
  assert.equal(none.matches({}), true);
  assert.equal(none.matches({ accountId: "" }), true);
  assert.equal(none.matches({ accountId: "card-1" }), false);
});

test("'All months' lifts the month limit only while an account is chosen", () => {
  assert.equal(helpers("card-1", true, "2026-11").monthOk({ date: "2026-01-15" }), true);
  assert.equal(helpers("card-1", false, "2026-11").monthOk({ date: "2026-01-15" }), false);
  assert.equal(helpers("", true, "2026-11").monthOk({ date: "2026-01-15" }), false, "a stale tick without an account does nothing");
});

test("Recent transactions and Bank stream both use the filter, and the page has the controls", () => {
  assert.match(app, /allImported\.filter\(\(transaction\) => ledgerMonthMatches\(transaction\) && ledgerAccountFilterMatches\(transaction\)\)/, "Bank stream is filtered");
  assert.match(app, /\.filter\(\(\{ transaction \}\) => ledgerMonthMatches\(transaction\) && ledgerAccountFilterMatches\(transaction\)\)/, "the Ledger is filtered");
  assert.match(app, /id="ledgerAccountFilter"[\s\S]*?All accounts[\s\S]*?accountOptions\(ledgerAccountFilter\)[\s\S]*?Not linked to an account/);
  assert.match(app, /id="ledgerAllMonths"/);
  assert.match(app, /\$\("#ledgerAccountFilter"\)\?\.addEventListener\("change"[\s\S]*?ledgerSelectedIndices\.clear\(\)/, "changing the filter drops the selection");
  assert.match(app, /!state\.accounts\.some\(\(account\) => account\.id === ledgerAccountFilter\)\) \{ ledgerAccountFilter = ""/, "a deleted account clears the filter");
  assert.match(css, /\.ledger-filter-row \{/);
});
