const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("app.js");
const css = read("styles.css");
const html = read("index.html");

test("Calculators is a page of its own under Personal, with its maths loaded before the page code", () => {
  assert.match(app, /\["calculators", "Calculators", "🧮"\]/);
  assert.match(app, /\["Personal", \["journal", "plan", "goals", "calculators"\]\]/);
  assert.match(app, /calculators: renderCalculators,/);
  assert.match(app, /currentView === "calculators"\s*\? "Calculators"/, "has its own title");
  assert.match(app, /isHomeView \|\| currentView === "calculators"/, "no month picker or CSV button here");
  assert.match(app, /if \(currentView === "calculators"\) return \[\];/, "no household budget tiles here");
  assert.match(app, /bindPricesEvents\(\);\s*bindCalculatorEvents\(\);/);
  assert.ok(html.indexOf("/lib/calculators.js") > html.indexOf("/lib/shared-logic.js") && html.indexOf("/lib/calculators.js") < html.indexOf("/app.js?v="), "after shared-logic, before app.js");
});

test("the calculators' shared names are defined once: CALC_MAX_REACH_AGE lives in lib/calculators.js only", () => {
  assert.equal((app.match(/^const CALC_MAX_REACH_AGE\b/gm) || []).length, 0, "a second top-level const of the same name would break the whole app");
  assert.match(read("lib/calculators.js"), /^const CALC_MAX_REACH_AGE = 80;/m);
});

test("what is typed is saved inside the existing goals object, and the results follow every keystroke", () => {
  assert.match(app, /form\.addEventListener\("input", refresh\);/);
  assert.match(app, /form\.addEventListener\("change", \(\) => calcSave\(tool, calcReadForm\(form\)\)\);/);
  assert.match(app, /state\.goals\.calculators/, "no new top-level state key, so older saved households still load");
  assert.match(app, /data-calc-use/, "one-tap buttons fill a box from the household's own numbers");
});

test("the advanced assumptions stay open until the person closes them: the outside-click closer leaves them alone", () => {
  assert.match(app, /<details id="calcAdvanced" data-keep-open /);
  assert.match(app, /if \(details\.hasAttribute\("data-keep-open"\)\) return;/);
  assert.match(app, /\$\("#calcAdvanced"\)\?\.addEventListener\("toggle", \(event\) => calcSave\("kyn", calcReadForm\(form\), \{ advanced: event\.currentTarget\.open \}\)\);/);
});

test("the page can never be wider than the screen, and stacks to one column on a phone", () => {
  assert.match(css, /\.calcs \{ width: 100%; max-width: 1040px; min-width: 0; margin: 0 auto;/, "explicit width: an auto-margin grid item would size to its widest table");
  assert.match(css, /@media \(max-width: 800px\) \{ \.calc-grid \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width: 560px\) \{ \.calc-two \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test("the page says its results are estimates, not advice, and shows the assumptions behind them", () => {
  assert.ok(app.includes("they are for planning, not financial advice"));
  assert.ok(app.includes("calc-assumptions"));
});
