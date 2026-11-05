const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeSimplefinAccount } = require("../server/linked-accounts");

test("replacement characters a bank sends for a symbol are dropped from account names", () => {
  const account = normalizeSimplefinAccount({ id: "A1", name: "WAY2SAVE\uFFFD\uFFFD SAVINGS ...1234 (1234)", org: { name: "Some\uFFFDBank" } });
  assert.equal(account.name, "WAY2SAVE SAVINGS ...1234 (1234)");
  assert.equal(account.orgName, "SomeBank");
});
