const assert = require("node:assert/strict");
const test = require("node:test");
const { startTestServer } = require("./helpers");

let server;
let strict;
test.before(async () => {
  server = await startTestServer({ PARTNER_GROUPS_ALLOW_UNVERIFIED_EMAIL: "true" });
  strict = await startTestServer();
});
test.after(async () => { await server.stop(); await strict.stop(); });

async function signUp(srv, email, name = "Test Person") {
  const signup = await srv.request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "Partner-Group-Password-123!", name, householdName: `${name} Home`, country: "US" })
  });
  assert.equal(signup.status, 201);
  return signup.cookie;
}
const call = (srv, cookie, path, method = "GET", body) => srv.request(path, { method, headers: { cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });

const setup = { properties: [{ id: "a", name: "Maple" }], partners: [{ id: "p1", name: "Pat", email: "pat@example.com" }, { id: "p2", name: "Sam" }], shares: {}, defaultShares: {}, rules: [{ id: "r1", match: "zelle tina", kind: "rent", propertyId: "a" }] };

test("a group needs a session, and its owner can create it, read it and change it", async () => {
  assert.equal((await server.request("/api/partner-groups")).status, 401);
  const owner = await signUp(server, "pg-owner@example.com", "Owner");
  const created = await call(server, owner, "/api/partner-groups", "POST", { name: "Rentals", setup, rows: [{ date: "2026-08-01", payee: "ZELLE FROM TINA TENANT", amount: -2000, source: "csv" }], poolBalance: { amount: 100.5, date: "2026-08-02", name: "Shared" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, "owner");
  assert.equal(created.body.setup.partners[0].email, "pat@example.com");
  assert.equal(created.body.rows.length, 1);
  assert.deepEqual(created.body.poolBalance, { amount: 100.5, date: "2026-08-02", name: "Shared" });
  const list = await call(server, owner, "/api/partner-groups");
  assert.deepEqual(list.body.groups.map((g) => [g.name, g.role]), [["Rentals", "owner"]]);
  const saved = await call(server, owner, `/api/partner-groups/${created.body.id}/setup`, "PUT", { setup: { ...setup, properties: [{ id: "a", name: "Maple House" }] }, version: created.body.version });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.version, created.body.version + 1);
  const stale = await call(server, owner, `/api/partner-groups/${created.body.id}/setup`, "PUT", { setup, version: created.body.version });
  assert.equal(stale.status, 409, "a change based on an old version is refused so two partners never overwrite each other");
  assert.equal((await call(server, owner, `/api/partner-groups/${created.body.id}`)).body.setup.properties[0].name, "Maple House");
});

test("members are added by e-mail with a role: edit can change the setup and import rows, view can only look, nobody else sees the group", async () => {
  const owner = await signUp(server, "pg-owner2@example.com", "Owner Two");
  const group = (await call(server, owner, "/api/partner-groups", "POST", { name: "Pair", setup })).body;
  const added = await call(server, owner, `/api/partner-groups/${group.id}/members`, "POST", { email: "Editor@Example.com", role: "edit" });
  assert.equal(added.status, 201);
  assert.equal(added.body.member.email, "editor@example.com");
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/members`, "POST", { email: "viewer@example.com", role: "view" })).status, 201);
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/members`, "POST", { email: "bad", role: "edit" })).status, 400);
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/members`, "POST", { email: "x@example.com", role: "owner" })).status, 400);

  const editor = await signUp(server, "editor@example.com", "Editor");
  const viewer = await signUp(server, "viewer@example.com", "Viewer");
  const stranger = await signUp(server, "stranger@example.com", "Stranger");

  assert.deepEqual((await call(server, editor, "/api/partner-groups")).body.groups.map((g) => g.role), ["edit"]);
  assert.deepEqual((await call(server, viewer, "/api/partner-groups")).body.groups.map((g) => g.role), ["view"]);
  assert.equal((await call(server, stranger, "/api/partner-groups")).body.groups.length, 0);
  assert.equal((await call(server, stranger, `/api/partner-groups/${group.id}`)).status, 404, "a stranger cannot even tell the group exists");

  const editSave = await call(server, editor, `/api/partner-groups/${group.id}/setup`, "PUT", { setup: { ...setup, rules: [] } });
  assert.equal(editSave.status, 200);
  assert.equal((await call(server, viewer, `/api/partner-groups/${group.id}/setup`, "PUT", { setup })).status, 403, "view-only cannot change the setup");
  assert.equal((await call(server, viewer, `/api/partner-groups/${group.id}`)).body.setup.rules.length, 0, "but sees the editor's change");

  const rows = [{ date: "2026-08-01", payee: "ZELLE FROM TINA TENANT", amount: -2000 }, { date: "2026-08-02", payee: "LOANCO CASH", amount: 2600 }];
  const first = await call(server, editor, `/api/partner-groups/${group.id}/rows`, "POST", { rows, mode: "csv" });
  assert.deepEqual([first.body.added, first.body.total], [2, 2]);
  const again = await call(server, editor, `/api/partner-groups/${group.id}/rows`, "POST", { rows, mode: "csv" });
  assert.deepEqual([again.body.added, again.body.total], [0, 2], "the same file twice adds nothing");
  assert.equal((await call(server, viewer, `/api/partner-groups/${group.id}/rows`, "POST", { rows, mode: "csv" })).status, 403);
  assert.equal((await call(server, editor, `/api/partner-groups/${group.id}/rows`, "DELETE")).status, 403, "only the owner clears rows");
  assert.equal((await call(server, editor, `/api/partner-groups/${group.id}/members`, "POST", { email: "z@example.com", role: "edit" })).status, 403, "only the owner decides who has access");
  assert.equal((await call(server, editor, `/api/partner-groups/${group.id}`, "DELETE")).status, 403);

  const members = (await call(server, owner, `/api/partner-groups/${group.id}`)).body.members;
  assert.deepEqual(members.map((m) => [m.email, m.role]), [["pg-owner2@example.com", "owner"], ["editor@example.com", "edit"], ["viewer@example.com", "view"]]);
  const viewerMember = members.find((m) => m.email === "viewer@example.com");
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/members/${viewerMember.id}`, "PATCH", { role: "edit" })).status, 200);
  assert.equal((await call(server, viewer, `/api/partner-groups/${group.id}/setup`, "PUT", { setup })).status, 200, "a promoted member can edit");
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/rows`, "DELETE")).status, 200);

  // A member can leave, the owner cannot be removed, and a removed person loses access at once.
  const editorMember = members.find((m) => m.email === "editor@example.com");
  assert.equal((await call(server, editor, `/api/partner-groups/${group.id}/members/${viewerMember.id}`, "DELETE")).status, 403, "a member cannot remove someone else");
  assert.equal((await call(server, editor, `/api/partner-groups/${group.id}/members/${editorMember.id}`, "DELETE")).status, 200, "but can leave");
  assert.equal((await call(server, editor, `/api/partner-groups/${group.id}`)).status, 404);
  const ownerMember = members.find((m) => m.role === "owner");
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/members/${ownerMember.id}`, "DELETE")).status, 400);
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/members/${viewerMember.id}`, "DELETE")).status, 200);
  assert.equal((await call(server, viewer, `/api/partner-groups/${group.id}`)).status, 404);
});

test("an invite only works for an e-mail address the person has verified", async () => {
  const owner = await signUp(strict, "pg-owner3@example.com", "Owner Three");
  const group = (await call(strict, owner, "/api/partner-groups", "POST", { name: "Strict", setup })).body;
  await call(strict, owner, `/api/partner-groups/${group.id}/members`, "POST", { email: "unverified@example.com", role: "edit" });
  const person = await signUp(strict, "unverified@example.com", "Unverified");
  const list = await call(strict, person, "/api/partner-groups");
  assert.equal(list.body.groups.length, 0, "an address nobody has proved is theirs gets no access");
  assert.equal(list.body.waitingForVerification.length, 1, "but they are told a group is waiting once they verify");
  assert.equal((await call(strict, person, `/api/partner-groups/${group.id}`)).status, 404);
});

test("rows typed in by hand can be added and deleted by editors, and nothing else can be deleted that way", async () => {
  const owner = await signUp(server, "pg-owner4@example.com", "Owner Four");
  const group = (await call(server, owner, "/api/partner-groups", "POST", { name: "Manual", setup, rows: [{ date: "2026-08-01", payee: "FROM BANK", amount: -100, source: "csv" }] })).body;
  await call(server, owner, `/api/partner-groups/${group.id}/members`, "POST", { email: "pg-view4@example.com", role: "view" });
  const viewer = await signUp(server, "pg-view4@example.com", "Viewer Four");
  assert.equal((await call(server, viewer, `/api/partner-groups/${group.id}/rows/manual`, "POST", { rows: [{ date: "2026-08-05", payee: "CASH", amount: 20 }] })).status, 403);
  const added = await call(server, owner, `/api/partner-groups/${group.id}/rows/manual`, "POST", { rows: [{ date: "2026-08-05", payee: "Cash to Sam", amount: 200 }, { date: "bad", payee: "x", amount: 1 }] });
  assert.equal(added.status, 201);
  assert.equal(added.body.added, 1, "a row without a real date is dropped");
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/rows/manual`, "POST", { rows: [{ date: "2026-08-05", payee: "", amount: 0 }] })).status, 400);
  const rows = (await call(server, owner, `/api/partner-groups/${group.id}`)).body.rows;
  const manual = rows.find((row) => row.source === "manual");
  assert.ok(manual.id.startsWith("m-"));
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/rows/${rows.find((row) => row.source === "csv").id || "none"}`, "DELETE")).status, 400, "a bank or CSV row cannot be deleted one by one");
  assert.equal((await call(server, viewer, `/api/partner-groups/${group.id}/rows/${manual.id}`, "DELETE")).status, 403);
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/rows/${manual.id}`, "DELETE")).status, 200);
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}`)).body.rows.length, 1);
});

test("the owner can share a read-only report by link: no login, no e-mail addresses, transactions only if chosen, gone once revoked", async () => {
  const owner = await signUp(server, "pg-owner5@example.com", "Owner Five");
  const reportSetup = { properties: [{ id: "a", name: "Maple House" }], partners: [{ id: "p1", name: "Pat", email: "pat-secret@example.com" }, { id: "p2", name: "Sam" }], shares: {}, defaultShares: {}, overrides: {},
    rules: [{ id: "r1", match: "zelle tina", kind: "rent", propertyId: "a" }, { id: "r2", match: "loanco", kind: "loan", propertyId: "a" }, { id: "r3", match: "zelle sam", kind: "contribution", partnerId: "p2" }] };
  const rows = [{ date: "2026-08-01", payee: "ZELLE FROM TINA TENANT", amount: -2000 }, { date: "2026-08-08", payee: "LOANCO CASH 1111", amount: 2600 }, { date: "2026-08-31", payee: "ZELLE FROM SAM", amount: -500 }];
  const group = (await call(server, owner, "/api/partner-groups", "POST", { name: "Report <Group>", setup: reportSetup, rows, poolBalance: { amount: 1234.5, date: "2026-09-01", name: "Shared" } })).body;
  await call(server, owner, `/api/partner-groups/${group.id}/members`, "POST", { email: "pg-view5@example.com", role: "edit" });
  const editor = await signUp(server, "pg-view5@example.com", "Editor Five");
  assert.equal((await call(server, editor, `/api/partner-groups/${group.id}/share`, "POST", {})).status, 403, "only the owner shares a report");
  assert.deepEqual((await call(server, owner, `/api/partner-groups/${group.id}/share`)).body, { shared: false });

  const made = await call(server, owner, `/api/partner-groups/${group.id}/share`, "POST", { showTransactions: false });
  assert.equal(made.status, 201);
  const path = `/partners/share/${made.body.token}`;
  const page = await server.request(path);
  assert.equal(page.status, 200);
  assert.match(page.body, /<meta name="robots" content="noindex, nofollow">/);
  assert.ok(page.body.includes("Report &lt;Group&gt;"), "the group name is escaped");
  assert.ok(page.body.includes("$2,000.00") && page.body.includes("$2,600.00"), "the figures are there");
  assert.ok(page.body.includes("Maple House") && page.body.includes("Sam"));
  assert.equal(page.body.includes("pat-secret@example.com"), false, "no e-mail address is ever shown");
  assert.equal(page.body.includes("ZELLE FROM TINA"), false, "the transaction list is left out unless the owner chose it");
  assert.ok(page.body.includes("$1,234.50"), "the bank balance is shown");

  const withRows = await call(server, owner, `/api/partner-groups/${group.id}/share`, "POST", { showTransactions: true });
  assert.equal(withRows.body.token, made.body.token, "changing the option keeps the same link");
  const full = await server.request(path);
  assert.ok(full.body.includes("ZELLE FROM TINA TENANT") && full.body.includes("Rent received"));
  assert.ok((await server.request(`${path}?period=month`)).body.includes("This month"));

  assert.equal((await server.request("/partners/share/not-a-real-token-at-all-0000")).status, 404);
  assert.equal((await server.request("/partners/share/x")).status, 404);
  assert.equal((await call(server, editor, `/api/partner-groups/${group.id}/share`, "DELETE")).status, 403);
  assert.equal((await call(server, owner, `/api/partner-groups/${group.id}/share`, "DELETE")).status, 200);
  assert.equal((await server.request(path)).status, 404, "a revoked link stops working at once");
  const again = await call(server, owner, `/api/partner-groups/${group.id}/share`, "POST", {});
  assert.notEqual(again.body.token, made.body.token, "a new link is a new token");
});
