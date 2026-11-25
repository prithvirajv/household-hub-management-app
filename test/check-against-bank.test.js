const test = require("node:test");
const assert = require("node:assert/strict");
const { checkRowsAgainstRecords, removedRowSignature } = require("../lib/shared-logic");

const A = "acct";
const led = (date, payee, amount, extra = {}) => ({ date, payee, amount, accountId: A, ...extra });
const stmt = (date, payee, amount, extra = {}) => ({ date, payee, amount, ...extra });
const run = (rows, state = {}) => checkRowsAgainstRecords({ rows, accountId: A, transactions: [], drafts: [], removedSignatures: [], transfers: [], importedIds: [], ...state });

test("a statement row is accounted for by a ledger row, a Bank stream row, a removal, a transfer, or it is missing", () => {
  const rows = [
    stmt("2026-10-01", "GROCER 123", 40),
    stmt("2026-10-02", "COFFEE SHOP", 5),
    stmt("2026-10-03", "OLD GYM", 20),
    stmt("2026-10-04", "TRANSFER TO SAVINGS", 300),
    stmt("2026-10-05", "NEVER SEEN", 77)
  ];
  const result = run(rows, {
    transactions: [led("2026-10-01", "Grocer", 40)],
    drafts: [led("2026-10-02", "Coffee Shop", 5)],
    removedSignatures: [removedRowSignature(stmt("2026-10-03", "OLD GYM", 20))],
    transfers: [{ date: "2026-10-04", amount: 300, fromAccountId: A, toAccountId: "sav" }]
  });
  assert.deepEqual(result.items.map((item) => item.status), ["ledger", "stream", "removed", "transfer", "missing"]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.counts, { total: 5, ledger: 1, stream: 1, removed: 1, transfer: 1, pending: 0, missing: 1, extra: 0 });
});

test("when every row is accounted for the check is complete, and one record never accounts for two rows", () => {
  const same = [stmt("2026-10-01", "CAFE", 4), stmt("2026-10-01", "CAFE", 4)];
  const one = run(same, { transactions: [led("2026-10-01", "Cafe", 4)] });
  assert.deepEqual(one.items.map((item) => item.status), ["ledger", "missing"], "two identical purchases, one record: the second is missing");
  const both = run(same, { transactions: [led("2026-10-01", "Cafe", 4), led("2026-10-01", "Cafe", 4)] });
  assert.equal(both.complete, true);
});

test("a post date a few days off still matches when the payee reads alike, but a far date or another amount does not", () => {
  const result = run([stmt("2026-10-05", "AMAZON MKTP US", 25), stmt("2026-10-20", "AMAZON MKTP US", 25), stmt("2026-10-05", "AMAZON MKTP US", 26)], { transactions: [led("2026-10-02", "Amazon.com", 25)] });
  assert.deepEqual(result.items.map((item) => item.status), ["ledger", "missing", "missing"]);
});

test("a bank row is matched by its id first; one imported before that is nowhere now was removed; pending rows are only pending", () => {
  const rows = [
    stmt("2026-10-01", "A", 10, { externalId: "sf:1:a" }),
    stmt("2026-10-02", "B", 11, { externalId: "sf:1:b" }),
    stmt("2026-10-03", "C", 12, { externalId: "sf:1:c" }),
    stmt("2026-10-04", "D", 13, { externalId: "sf:1:d", pending: true }),
    stmt("2026-10-05", "E", 14, { externalId: "sf:1:e" })
  ];
  const result = run(rows, {
    transactions: [led("2026-10-01", "different words", 10, { externalId: "sf:1:a" })],
    drafts: [led("2026-10-02", "different words", 11, { externalId: "sf:1:b" })],
    importedIds: ["sf:1:c"]
  });
  assert.deepEqual(result.items.map((item) => item.status), ["ledger", "stream", "removed", "pending", "missing"]);
});

test("rows FamilyLoop holds inside the source's dates that the source does not list come back as extras; other accounts and dates are ignored", () => {
  const result = run([stmt("2026-10-01", "A", 10), stmt("2026-10-10", "B", 20)], {
    transactions: [led("2026-10-01", "A", 10), led("2026-10-05", "Hand entered", 99), led("2026-09-01", "Before", 5), led("2026-10-05", "Other account", 7, { accountId: "other" })]
  });
  assert.equal(result.counts.extra, 1);
  assert.equal(result.extras[0].row.payee, "Hand entered");
  assert.deepEqual(result.range, { from: "2026-10-01", to: "2026-10-10" });
});

test("an empty source and unreadable rows are handled", () => {
  assert.equal(run([]).counts.total, 0);
  assert.equal(run([{ date: "nope", amount: "x" }]).counts.total, 0);
  assert.equal(run([]).complete, true);
});

const fs = require("node:fs");
const path = require("node:path");

test("the screen offers the check with both sources, the server's check fetch stages nothing, and balance adjustments are kept", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "server", "linked-accounts.js"), "utf8");
  ["${bankCheckCardHtml()}", 'id="bankCheckInput"', 'id="bankCheckAsk"', 'id="bankCheckAdd"', "checkRowsAgainstRecords({ rows: bankCheck.rows", "dryRun: true", "balanceAdjustments"].forEach((piece) => assert.ok(app.includes(piece), piece));
  assert.match(server, /if \(req\.body\?\.dryRun === true\) return res\.json\(\{ dryRun: true,/, "the rows come straight back");
  assert.ok(server.indexOf("dryRun === true") < server.indexOf("mergeStagedPayload(link.staged, payload"), "and the check returns before anything is staged");
  assert.match(server, /if \(!req\.body\?\.dryRun \|\| error\.statusCode === 409\) await recordOutcome/, "a failed check does not mark the link failed");
});
