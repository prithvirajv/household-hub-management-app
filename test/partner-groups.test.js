const assert = require("node:assert/strict");
const test = require("node:test");
const { createGroupStore, forwardHouseholdPartnerRows } = require("../server/partner-groups");

const memory = () => createGroupStore({ MEMORY_DB: true, memoryDb: {}, pool: null });
const bankRow = (id, date, amount) => ({ externalId: `sf:P1:${id}`, date, payee: `ROW ${id}`, amount });

test("the overnight forward lands rows in the group only when the household's owner owns that group, and never twice", async () => {
  const store = memory();
  const group = await store.create({ name: "G", ownerUserId: "owner-1", ownerEmail: "o@example.com", setup: {}, rows: [], poolBalance: null });
  const rows = [bankRow("1", "2026-10-01", -500), bankRow("2", "2026-10-02", 2600)];
  assert.equal(await forwardHouseholdPartnerRows(store, { groupId: group.id, householdOwnerId: "someone-else", rows, poolBalance: null }), false, "another person's household cannot write into the group");
  assert.equal((await store.get(group.id)).rows.length, 0);
  assert.equal(await forwardHouseholdPartnerRows(store, { groupId: group.id, householdOwnerId: "owner-1", rows, poolBalance: { amount: 12.5, date: "2026-10-02", name: "Shared" } }), true);
  assert.equal(await forwardHouseholdPartnerRows(store, { groupId: group.id, householdOwnerId: "owner-1", rows, poolBalance: null }), true);
  const saved = await store.get(group.id);
  assert.equal(saved.rows.length, 2, "the same rows forwarded again are not added twice");
  assert.deepEqual(saved.poolBalance, { amount: 12.5, date: "2026-10-02", name: "Shared" }, "a forward with no balance keeps the last one");
  assert.equal(await forwardHouseholdPartnerRows(store, { groupId: "nope", householdOwnerId: "owner-1", rows, poolBalance: null }), false);
  assert.equal(await forwardHouseholdPartnerRows(store, { groupId: "", householdOwnerId: "owner-1", rows, poolBalance: null }), false);
});

test("a bank row forwarded to the group takes the place of the matching CSV row instead of doubling it", async () => {
  const store = memory();
  const group = await store.create({ name: "G", ownerUserId: "owner-1", ownerEmail: "o@example.com", setup: {}, rows: [{ date: "2026-10-01", payee: "FROM CSV", amount: -500, externalId: "", source: "csv" }], poolBalance: null });
  await forwardHouseholdPartnerRows(store, { groupId: group.id, householdOwnerId: "owner-1", rows: [bankRow("1", "2026-10-01", -500)], poolBalance: null });
  const rows = (await store.get(group.id)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].externalId, "sf:P1:1");
});

test("overnight rows no rule matches are sent to the AI once, only confident answers are kept as that row's own choice, and a failure never blocks the rows", async () => {
  const store = memory();
  const setup = { properties: [{ id: "a", name: "Maple" }], partners: [{ id: "p1", name: "Pat" }, { id: "p2", name: "Sam" }], shares: {}, defaultShares: {}, overrides: {},
    rules: [{ id: "r1", match: "zelle tina", kind: "rent", propertyId: "a" }] };
  const group = await store.create({ name: "G", ownerUserId: "owner-1", ownerEmail: "o@example.com", setup, rows: [], poolBalance: null });
  const seen = [];
  const suggest = async ({ rows, examples }) => {
    seen.push({ payees: rows.map((row) => row.payee), exampleCount: examples.length });
    return rows.map((row) => (/SAM/.test(row.payee) ? { id: row.id, kind: "contribution", propertyId: "", partnerId: "p2", confidence: "high" } : { id: row.id, kind: "expense", propertyId: "a", partnerId: "", confidence: "low" }));
  };
  const rows = [bankRow("1", "2026-10-01", -2000), bankRow("2", "2026-10-02", -500), bankRow("3", "2026-10-03", 40)].map((row, index) => ({ ...row, payee: ["ZELLE FROM TINA TENANT", "ZELLE FROM SAM", "MYSTERY SHOP"][index] }));
  assert.equal(await forwardHouseholdPartnerRows(store, { groupId: group.id, householdOwnerId: "owner-1", rows, poolBalance: null, suggest }), true);
  assert.deepEqual(seen[0].payees, ["ZELLE FROM SAM", "MYSTERY SHOP"], "the row a rule already reads is not sent to the AI");
  const saved = await store.get(group.id);
  assert.equal(saved.rows.length, 3);
  const overrides = Object.values(saved.setup.overrides);
  assert.equal(overrides.length, 1, "only the confident answer is kept");
  assert.deepEqual(overrides[0], { kind: "contribution", propertyId: "", partnerId: "p2" });
  assert.equal(saved.version, 2);
  // The same rows forwarded again are not "new": the AI is not asked again.
  await forwardHouseholdPartnerRows(store, { groupId: group.id, householdOwnerId: "owner-1", rows, poolBalance: null, suggest });
  assert.equal(seen.length, 1);
  // A failing AI does not stop rows from landing.
  const failing = await forwardHouseholdPartnerRows(store, { groupId: group.id, householdOwnerId: "owner-1", rows: [{ ...bankRow("9", "2026-10-09", 5), payee: "NEW THING" }], poolBalance: null, suggest: async () => { throw new Error("AI down"); } });
  assert.equal(failing, true);
  assert.equal((await store.get(group.id)).rows.length, 4);
});
