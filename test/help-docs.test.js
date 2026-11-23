const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("app.js");
const guide = read("docs/consumer-guide.md");
const welcome = read("welcome.html");

// Which Help guide explains each page in the sidebar. A page added to the app without a line here (and a guide) fails this test, so the documentation
// cannot silently fall behind the product again.
const HELP_GUIDE_FOR_VIEW = {
  budget: "budget", bills: "bills", transactions: "transactions", paychecks: "paycheck", calendar: "calendar", notes: "notes", journal: "journal",
  plan: "plan", documents: "documents", decisions: "decisions", ious: "shared-expenses", partners: "partners", meals: "meals", recipes: "meals",
  goals: "goals", calculators: "calculators", wealth: "wealth", investments: "investments", prices: "prices", sharing: "sharing", reports: "reports"
};
const NO_GUIDE_NEEDED = new Set(["home", "profile", "help", "admin"]);

test("every page in the sidebar has a Help guide", () => {
  const viewsBlock = app.slice(app.indexOf("const views = ["), app.indexOf("];", app.indexOf("const views = [")));
  const keys = [...viewsBlock.matchAll(/\["([a-z]+)", "/g)].map((match) => match[1]);
  assert.ok(keys.length >= 20, "the list of pages was found");
  const help = app.slice(app.indexOf("function renderHelp()"), app.indexOf("<section class=\"help-layout\">"));
  const guideIds = new Set([...help.matchAll(/title: "[^"]+", id: "([a-z-]+)"/g)].map((match) => match[1]));
  keys.filter((key) => !NO_GUIDE_NEEDED.has(key)).forEach((key) => {
    assert.ok(HELP_GUIDE_FOR_VIEW[key], `the "${key}" page needs an entry in HELP_GUIDE_FOR_VIEW (and a Help guide)`);
    assert.ok(guideIds.has(HELP_GUIDE_FOR_VIEW[key]), `the Help page has no guide "${HELP_GUIDE_FOR_VIEW[key]}" for the "${key}" page`);
  });
  assert.ok(guideIds.has("receipts"), "receipts have their own guide");
});

test("the consumer guide has a section for every page and the main features", () => {
  ["Budget", "Bills", "Transactions", "Paycheck/Income", "Calendar", "Notes", "Journal", "Plan", "Documents", "Decisions", "Shared Expenses", "Meals and Recipes", "Goals", "Partners", "Wealth", "Investments", "Item prices", "Calculators", "Sharing", "Reports and Export"]
    .forEach((heading) => assert.match(guide, new RegExp(`^## ${heading.replace(/[/()]/g, "\\$&")}`, "m"), `a "${heading}" section`));
  ["Receipts by email", "Know your number", "Car affordability", "House affordability", "Wealth multiplier", "Prodigious accumulator", "Re-date rows you imported earlier", "Imported back to", "Look at one account at a time", "Add a video file", "ready-made budget", "Pays back a charge?", "Share a video straight to FamilyLoop"]
    .forEach((phrase) => assert.ok(guide.includes(phrase), `the consumer guide mentions "${phrase}"`));
});

test("the public page and Help describe what a new household starts with, not an empty app", () => {
  assert.doesNotMatch(app, /Start empty and enter only your data/);
  assert.match(app, /Start from the ready-made budget, recipes and chores/);
  ["Bank sync or statement import", "Receipts read item by item", "YouTube, Instagram, Facebook or TikTok", "Shared rental properties with partners"]
    .forEach((phrase) => assert.ok(welcome.includes(phrase), `the public page mentions "${phrase}"`));
});

test("the Help page packs its guides into two columns instead of stretching rows", () => {
  const css = read("styles.css");
  assert.match(css, /\.help-grid \{[^}]*column-count: 2;/);
  assert.match(css, /\.help-topic \{\s*break-inside: avoid;/);
});

test("Help explains repayments of shared charges and sharing a video from the phone", () => {
  assert.match(app, /Others repaid you\?/);
  assert.match(app, /Pays back a charge\?/);
  assert.match(app, /Paid back by others…/);
  assert.match(app, /appears in the <strong>Share<\/strong> menu/);
});
