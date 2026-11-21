const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { accountImportedFrom } = require("../lib/shared-logic");

const account = { id: "acct-1", syncedFrom: "2026-08-01" };
const row = (date, extra = {}) => ({ accountId: "acct-1", date, ...extra });

test("an imported statement that goes back before the bank feed pushes the 'Imported back to' date back", () => {
  const ledger = [row("2026-01-15"), row("2026-02-03"), row("2026-09-02", { externalId: "sf:ACC1:tx1" }), row("2026-08-20")];
  assert.equal(accountImportedFrom(account, ledger, []), "2026-01-15");
});

test("bank-feed rows, other accounts' rows and rows on or after the feed's start do not count", () => {
  assert.equal(accountImportedFrom(account, [row("2026-03-01", { externalId: "sf:ACC1:tx9" })], []), "", "a bank-fed row is not an import");
  assert.equal(accountImportedFrom(account, [{ accountId: "other", date: "2026-01-01" }], []), "", "another account");
  assert.equal(accountImportedFrom(account, [row("2026-08-01"), row("2026-10-10")], []), "", "nothing before the feed starts");
  assert.equal(accountImportedFrom({ id: "acct-1" }, [row("2026-01-01")], []), "", "an account with no bank feed has no tag");
  assert.equal(accountImportedFrom(null, [row("2026-01-01")], []), "");
  assert.equal(accountImportedFrom(account, [row("")], [row("not a date")]), "", "rows without a real date are ignored");
});

test("rows still waiting in Bank stream count too, so the tag moves as soon as the file is imported", () => {
  assert.equal(accountImportedFrom(account, [row("2026-06-15")], [row("2026-01-02")]), "2026-01-02");
  assert.equal(accountImportedFrom(account, [], [row("2026-05-05T10:00:00Z")]), "2026-05-05", "a time part is ignored");
});

test("the Wealth account row shows the tag beside 'Synced from'", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /accountImportedFrom\(account, state\.transactions, state\.transactionInboxDrafts\)/);
  assert.match(app, /Imported back to \$\{escapeHtml\(/);
});
