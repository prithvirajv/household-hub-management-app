const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const { startTestServer } = require("./helpers");
const { registerLinkedAccountRoutes, trimPartialHistory, mergeStagedPayload, knownExternalIds, findNewAccounts, encryptJson, decryptJson, normalizeSnaptradePositions, normalizeSimplefinTransactions, snaptradeConfig } = require("../server/linked-accounts");

const KEY = "test-link-encryption-key-with-entropy";

// A tiny SimpleFIN Bridge double: claim, then GET /simplefin/accounts with basic auth, recording every request.
async function startSimplefinStub() {
  const requests = [];
  const stub = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || "" });
    if (req.method === "POST" && req.url === "/simplefin/claim/GOODTOKEN") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`http://user:s3cret@127.0.0.1:${stub.address().port}/simplefin`);
    }
    if (req.method === "POST") { res.writeHead(403); return res.end(); }
    if (req.url.startsWith("/simplefin/accounts")) {
      if (req.headers.authorization !== `Basic ${Buffer.from("user:s3cret").toString("base64")}`) { res.writeHead(403); return res.end(); }
      const posted = Math.floor(Date.parse("2026-10-02T12:00:00Z") / 1000);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        errors: ["Connection to Sample Bank may need attention"],
        accounts: [
          { org: { name: "Sample Bank" }, id: "ACT-1", name: "Everyday Checking", currency: "USD", balance: "1250.50", "balance-date": posted, transactions: [
            { id: "T1", posted, amount: "-40.25", description: "SAMPLE GROCER" },
            { id: "T2", posted, amount: "2000.00", description: "SAMPLE PAYROLL" },
            { id: "T3", posted: 0, amount: "-9.99", description: "SAMPLE PENDING", pending: true }
          ] },
          { org: { name: "Sample Bank" }, id: "ACT-2", name: "Sample Card", currency: "USD", balance: "-310.00", "balance-date": posted, transactions: [] }
        ]
      }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = stub.address().port;
  return { port, requests, setupToken: Buffer.from(`http://127.0.0.1:${port}/simplefin/claim/GOODTOKEN`).toString("base64"), stop: () => new Promise((resolve) => stub.close(resolve)) };
}

test("credentials are encrypted at rest: round-trip works, tampering and a wrong key do not", () => {
  const payload = encryptJson(KEY, { accessUrl: "https://u:p@bridge.simplefin.org/simplefin" });
  assert.ok(!payload.includes("simplefin"));
  assert.deepEqual(decryptJson(KEY, payload), { accessUrl: "https://u:p@bridge.simplefin.org/simplefin" });
  assert.throws(() => decryptJson("another-key", payload));
  const parts = payload.split(":"); parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptJson(KEY, parts.join(":")));
  assert.throws(() => decryptJson(KEY, "garbage"));
});

test("mergeStagedPayload accumulates SimpleFIN transactions by id across nights, keeps the latest balances, drops stale rows, and replaces SnapTrade snapshots", () => {
  const now = "2026-10-25T05:00:00.000Z";
  const first = mergeStagedPayload({}, { provider: "simplefin", accounts: [{ remoteId: "A", balance: 10 }], transactions: [{ externalId: "sf:A:1", date: "2026-10-24", amount: 5 }, { externalId: "sf:A:old", date: "2025-01-01", amount: 1 }], errors: [] }, now);
  assert.deepEqual([first.newTransactionCount, first.merged.transactions.map((t) => t.externalId)], [2, ["sf:A:1"]], "rows beyond the retention window are dropped");
  const second = mergeStagedPayload(first.merged, { provider: "simplefin", accounts: [{ remoteId: "A", balance: 25 }], transactions: [{ externalId: "sf:A:1", date: "2026-10-24", amount: 5 }, { externalId: "sf:A:2", date: "2026-10-25", amount: 7 }], errors: ["careful"] }, "2026-10-26T05:00:00.000Z");
  assert.equal(second.newTransactionCount, 1, "a row already staged is not counted as new again");
  assert.deepEqual(second.merged.transactions.map((t) => t.externalId), ["sf:A:1", "sf:A:2"]);
  assert.deepEqual([second.merged.accounts[0].balance, second.merged.errors, second.merged.stagedAt], [25, ["careful"], "2026-10-26T05:00:00.000Z"]);
  const brokerage = mergeStagedPayload({ provider: "snaptrade", positions: [{ symbol: "OLD" }] }, { provider: "snaptrade", accounts: [], positions: [{ symbol: "NEW" }], cash: {}, errors: [] }, now);
  assert.deepEqual(brokerage.merged.positions, [{ symbol: "NEW" }]);
});

test("an explicit history import keeps rows older than the normal 120-day staging window", () => {
  const now = "2026-10-25T05:00:00.000Z";
  const payload = { provider: "simplefin", accounts: [], transactions: [{ externalId: "sf:A:jan", date: "2026-01-15", amount: 5 }, { externalId: "sf:A:oct", date: "2026-10-20", amount: 6 }], errors: [] };
  assert.deepEqual(mergeStagedPayload({}, payload, now).merged.transactions.map((t) => t.externalId), ["sf:A:oct"], "the nightly job only keeps the last 120 days");
  assert.deepEqual(mergeStagedPayload({}, payload, now, { sinceDate: "2026-01-01" }).merged.transactions.map((t) => t.externalId), ["sf:A:jan", "sf:A:oct"]);
  assert.deepEqual(mergeStagedPayload({}, payload, now, { sinceDate: "2026-10-01" }).merged.transactions.map((t) => t.externalId), ["sf:A:oct"], "a recent start date never widens the window");
  assert.deepEqual(mergeStagedPayload({}, payload, now, { sinceDate: "garbage" }).merged.transactions.map((t) => t.externalId), ["sf:A:oct"]);
});

test("knownExternalIds gathers remembered ids, ledger rows and waiting drafts, tolerating missing state", () => {
  const ids = knownExternalIds({ linkedImportedIds: ["sf:A:1"], transactions: [{ externalId: "sf:A:2" }, {}], transactionInboxDrafts: [{ externalId: "sf:A:3" }, null] });
  assert.deepEqual([...ids].sort(), ["sf:A:1", "sf:A:2", "sf:A:3"]);
  assert.equal(knownExternalIds(undefined).size, 0);
});

test("findNewAccounts reports only accounts with no decision, and a skipped entry counts as a decision", () => {
  const remote = [{ remoteId: "A", name: "One", orgName: "Bank" }, { remoteId: "B", name: "Two" }, { remoteId: "C", name: "Three" }];
  assert.deepEqual(findNewAccounts(remote, { A: { accountId: "x" }, B: { skipped: true } }), [{ remoteId: "C", name: "Three", orgName: "" }]);
  assert.deepEqual(findNewAccounts(remote, {}).length, 3);
  assert.deepEqual(findNewAccounts([], { A: {} }), []);
});

test("SimpleFIN transactions flip to the app's sign convention and pending rows are marked", () => {
  const posted = Math.floor(Date.parse("2026-10-02T12:00:00Z") / 1000);
  const rows = normalizeSimplefinTransactions({ id: "A", transactions: [{ id: "1", posted, amount: "-40.25", description: " Shop " }, { id: "2", posted, amount: "2000", description: "Pay" }, { id: "3", posted: 0, amount: "-1", description: "Hold", pending: true }, { id: "4", posted, amount: "nope", description: "bad" }] }, { today: new Date("2026-10-03T00:00:00Z") });
  assert.deepEqual(rows.map((r) => [r.externalId, r.date, r.payee, r.amount, r.pending]), [
    ["sf:A:1", "2026-10-02", "Shop", 40.25, false], ["sf:A:2", "2026-10-02", "Pay", -2000, false], ["sf:A:3", "2026-10-03", "Hold", 1, true]
  ]);
});

test("SnapTrade positions normalize across the new and legacy response shapes and drop empty or unnamed ones", () => {
  const positions = normalizeSnaptradePositions([
    { instrument: { kind: "stock", symbol: "AAPL", description: "Apple Inc" }, units: "10.5", price: "190.1", cost_basis: "150", currency: "USD" },
    { instrument: { kind: "mutualfund", symbol: "VTSAX", description: "Total Market" }, units: "3", price: "120", cost_basis: null },
    { symbol: { symbol: { symbol: "MSFT", description: "Microsoft" } }, units: 2, price: 400, average_purchase_price: 300, currency: { code: "USD" } },
    { instrument: { kind: "stock", symbol: "ZERO" }, units: "0", price: "1" },
    { instrument: { kind: "stock" }, units: "5", price: "1" }
  ], "acct-1");
  assert.deepEqual(positions.map((p) => [p.symbol, p.units, p.price, p.costBasis, p.holdingType, p.remoteAccountId]), [
    ["AAPL", 10.5, 190.1, 150, "stock", "acct-1"], ["VTSAX", 3, 120, 0, "fund", "acct-1"], ["MSFT", 2, 400, 300, "stock", "acct-1"]
  ]);
  assert.equal(snaptradeConfig({}), null);
  assert.equal(snaptradeConfig({ SNAPTRADE_CLIENT_ID: "a", SNAPTRADE_CONSUMER_KEY: "b" }).mode, "personal");
  assert.equal(snaptradeConfig({ SNAPTRADE_CLIENT_ID: "a", SNAPTRADE_CONSUMER_KEY: "b", SNAPTRADE_MODE: "Commercial" }).mode, "commercial");
});

test("SimpleFIN link flow end to end: not configured without a key, SSRF-pinned tokens, claim, map, sync, and household isolation", async () => {
  const stub = await startSimplefinStub();
  const unconfigured = await startTestServer();
  const configured = await startTestServer({ LINK_ENCRYPTION_KEY: KEY, SIMPLEFIN_ALLOW_TEST_HOSTS: "true", NOTIFICATION_SECRET: "job-secret" });
  const pinned = await startTestServer({ LINK_ENCRYPTION_KEY: KEY });
  try {
    const signup = async (server, email) => (await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password: "Linked-Accounts-Password-123!", name: "Linker", householdName: `${email} home`, country: "US" }) })).cookie;

    const noKeyCookie = await signup(unconfigured, "links-nokey@example.com");
    const noKeyList = await unconfigured.request("/api/linked-accounts", { headers: { cookie: noKeyCookie } });
    assert.equal(noKeyList.body.configured, false);
    assert.equal((await unconfigured.request("/api/linked-accounts/simplefin", { method: "POST", headers: { cookie: noKeyCookie }, body: JSON.stringify({ setupToken: stub.setupToken }) })).status, 503);

    const pinnedCookie = await signup(pinned, "links-pinned@example.com");
    const metadataToken = Buffer.from("http://169.254.169.254/latest/meta-data/").toString("base64");
    const blocked = await pinned.request("/api/linked-accounts/simplefin", { method: "POST", headers: { cookie: pinnedCookie }, body: JSON.stringify({ setupToken: metadataToken }) });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /SimpleFIN/);
    assert.equal((await pinned.request("/api/linked-accounts/simplefin", { method: "POST", headers: { cookie: pinnedCookie }, body: JSON.stringify({ setupToken: "not base64 url" }) })).status, 400);

    assert.equal((await configured.request("/api/linked-accounts")).status, 401);
    const cookie = await signup(configured, "links-owner@example.com");
    const created = await configured.request("/api/linked-accounts/simplefin", { method: "POST", headers: { cookie }, body: JSON.stringify({ setupToken: stub.setupToken, label: "My bank" }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.link.label, "My bank");
    assert.ok(!JSON.stringify(created.body).includes("s3cret"), "the access URL never goes back to the client");
    const id = created.body.link.id;

    const reused = await configured.request("/api/linked-accounts/simplefin", { method: "POST", headers: { cookie }, body: JSON.stringify({ setupToken: Buffer.from(`http://127.0.0.1:${stub.port}/simplefin/claim/USEDTOKEN`).toString("base64") }) });
    assert.equal(reused.status, 400, "a rejected (already used) token is a clear client error");

    const remote = await configured.request(`/api/linked-accounts/${id}/remote-accounts`, { headers: { cookie } });
    assert.equal(remote.status, 200);
    assert.deepEqual(remote.body.accounts.map((a) => [a.remoteId, a.name, a.orgName, a.balance]), [["ACT-1", "Everyday Checking", "Sample Bank", 1250.5], ["ACT-2", "Sample Card", "Sample Bank", -310]]);
    assert.ok(stub.requests.some((r) => r.url.includes("balances-only=1")), "listing accounts asks for balances only");
    assert.equal((await configured.request("/api/linked-accounts", { headers: { cookie } })).body.links[0].lastSyncAt, null, "only listing accounts must not move the point the first real sync looks back from");

    const mapped = await configured.request(`/api/linked-accounts/${id}/mappings`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ mappings: { "ACT-1": { accountId: "local-checking" }, "ACT-2": {} } }) });
    assert.equal(mapped.status, 200);
    assert.deepEqual(mapped.body.link.mappings, { "ACT-1": { accountId: "local-checking", groupId: "", groupName: "" } });
    assert.ok(stub.requests.length > 0);
    assert.equal((await configured.request(`/api/linked-accounts/${id}/mappings`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ mappings: [] }) })).status, 400);

    const sync = await configured.request(`/api/linked-accounts/${id}/sync`, { method: "POST", headers: { cookie }, body: JSON.stringify({ sinceDate: "2026-09-01" }) });
    assert.equal(sync.status, 200);
    assert.deepEqual(sync.body.errors, ["Connection to Sample Bank may need attention"]);
    assert.deepEqual(sync.body.transactions.map((t) => [t.externalId, t.remoteAccountId, t.date, t.payee, t.amount, t.pending]), [
      ["sf:ACT-1:T1", "ACT-1", "2026-10-02", "SAMPLE GROCER", 40.25, false],
      ["sf:ACT-1:T2", "ACT-1", "2026-10-02", "SAMPLE PAYROLL", -2000, false],
      ["sf:ACT-1:T3", "ACT-1", new Date().toISOString().slice(0, 10), "SAMPLE PENDING", 9.99, true]
    ]);
    const syncCalls = stub.requests.filter((r) => r.url.startsWith("/simplefin/accounts") && !r.url.includes("balances-only"));
    assert.ok(syncCalls.length >= 1 && syncCalls.every((r) => r.url.includes("pending=1") && r.auth.startsWith("Basic ")), "uses basic auth from the access URL and asks for pending rows");

    // The fetched data stays staged on the server until the client acknowledges it has applied it.
    assert.ok(typeof sync.body.stagedAt === "string" && sync.body.provider === "simplefin");
    const staged = await configured.request("/api/linked-accounts", { headers: { cookie } });
    assert.deepEqual([staged.body.links[0].hasStaged, staged.body.links[0].stagedCount], [true, 3]);
    await configured.request(`/api/linked-accounts/${id}/ack`, { method: "POST", headers: { cookie }, body: JSON.stringify({ stagedAt: "2000-01-01T00:00:00.000Z" }) });
    assert.equal((await configured.request("/api/linked-accounts", { headers: { cookie } })).body.links[0].hasStaged, true, "an acknowledgement older than the staged data clears nothing");
    await configured.request(`/api/linked-accounts/${id}/ack`, { method: "POST", headers: { cookie }, body: JSON.stringify({ stagedAt: sync.body.stagedAt }) });
    assert.deepEqual([(await configured.request("/api/linked-accounts", { headers: { cookie } })).body.links[0].hasStaged], [false]);

    const list = await configured.request("/api/linked-accounts", { headers: { cookie } });
    assert.equal(list.body.links.length, 1);
    assert.ok(list.body.links[0].lastSyncAt, "a successful sync is recorded");
    assert.equal(list.body.links[0].lastError, "");
    assert.ok(!JSON.stringify(list.body).includes("s3cret"));

    // ACT-2 was left without a decision, so it is reported as new until the user decides (a deliberate skip is remembered).
    assert.deepEqual(list.body.links[0].newAccounts.map((a) => [a.remoteId, a.name]), [["ACT-2", "Sample Card"]]);
    const decided = await configured.request(`/api/linked-accounts/${id}/mappings`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ mappings: { "ACT-1": { accountId: "local-checking" }, "ACT-2": { skipped: true } } }) });
    assert.deepEqual(decided.body.link.newAccounts, []);
    assert.equal(decided.body.link.mappings["ACT-2"].skipped, true);
    await configured.request(`/api/linked-accounts/${id}/sync`, { method: "POST", headers: { cookie }, body: "{}" });
    assert.deepEqual((await configured.request("/api/linked-accounts", { headers: { cookie } })).body.links[0].newAccounts, [], "a skipped account is not reported as new again");
    assert.deepEqual((await configured.request("/api/linked-accounts", { headers: { cookie } })).body.links[0].lastRun.notices, ["Connection to Sample Bank may need attention"], "a manual sync records the Bridge's messages too");
    // An account added at the bank later has no entry, so it shows up as new on the next sync.
    await configured.request(`/api/linked-accounts/${id}/mappings`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ mappings: { "ACT-1": { accountId: "local-checking" } } }) });
    await configured.request(`/api/linked-accounts/${id}/sync`, { method: "POST", headers: { cookie }, body: "{}" });
    assert.deepEqual((await configured.request("/api/linked-accounts", { headers: { cookie } })).body.links[0].newAccounts.map((a) => a.remoteId), ["ACT-2"]);

    // The nightly job (shared-secret) stages every active link's data and then applies it to the household (see the overnight-apply test).
    assert.equal((await configured.request("/api/internal/linked-accounts/sync-all", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await configured.request("/api/internal/linked-accounts/sync-all", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status, 401);
    await configured.request(`/api/linked-accounts/${id}/ack`, { method: "POST", headers: { cookie }, body: JSON.stringify({ stagedAt: new Date(Date.now() + 3600000).toISOString() }) });
    const nightly = await configured.request("/api/internal/linked-accounts/sync-all", { method: "POST", headers: { authorization: "Bearer job-secret" }, body: "{}" });
    assert.deepEqual([nightly.status, nightly.body.links, nightly.body.synced, nightly.body.failed], [200, 1, 1, 0]);
    assert.equal(nightly.body.newTransactions, 3);
    const afterNightly = (await configured.request("/api/linked-accounts", { headers: { cookie } })).body.links[0];
    assert.deepEqual([afterNightly.hasStaged, afterNightly.stagedCount], [false, 0], "what the job applied is no longer staged");
    assert.deepEqual(afterNightly.lastRun.notices, ["Connection to Sample Bank may need attention"], "what the Bridge said about a bank is kept on the run record so Home can show it");
    const stateAfterNightly = await configured.request("/api/state", { headers: { cookie } });
    assert.deepEqual((stateAfterNightly.body.transactions || []).filter((t) => t.externalId).map((t) => [t.externalId, t.memo]).sort(), [["sf:ACT-1:T1", "Needs a category"], ["sf:ACT-1:T2", "Needs a category"]], "with no AI here, rows nothing in the household can categorize still go into the ledger, marked");
    assert.deepEqual(stateAfterNightly.body.transactionInboxDrafts || [], []);
    await configured.request(`/api/linked-accounts/${id}/ack`, { method: "POST", headers: { cookie }, body: JSON.stringify({ stagedAt: afterNightly.stagedAt || new Date(Date.now() + 60000).toISOString() }) });

    // A loan can be mapped to a debt; the debt id survives alongside account and group mappings.
    const withDebt = await configured.request(`/api/linked-accounts/${id}/mappings`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ mappings: { "ACT-1": { accountId: "local-checking" }, "ACT-2": { debtId: "tesla-loan" } } }) });
    assert.deepEqual(withDebt.body.link.mappings["ACT-2"], { accountId: "", groupId: "", groupName: "", debtId: "tesla-loan" });

    const otherCookie = await signup(configured, "links-other@example.com");
    assert.deepEqual((await configured.request("/api/linked-accounts", { headers: { cookie: otherCookie } })).body.links, []);
    assert.equal((await configured.request(`/api/linked-accounts/${id}/sync`, { method: "POST", headers: { cookie: otherCookie }, body: "{}" })).status, 404);
    assert.equal((await configured.request(`/api/linked-accounts/${id}`, { method: "DELETE", headers: { cookie: otherCookie } })).status, 404);

    assert.equal((await configured.request(`/api/linked-accounts/${id}`, { method: "DELETE", headers: { cookie } })).status, 200);
    assert.deepEqual((await configured.request("/api/linked-accounts", { headers: { cookie } })).body.links, []);
  } finally {
    await Promise.all([unconfigured.stop(), configured.stop(), pinned.stop(), stub.stop()]);
  }
});

test("SnapTrade routes: personal keys are limited to one named owner, syncs return mapped positions and cash, and links are read-only", async () => {
  const calls = [];
  const adapter = {
    async registerUser(userId) { calls.push(["register", userId]); return {}; },
    async portalUrl(credentials, redirect) { calls.push(["portal", redirect]); return "https://app.snaptrade.com/portal?token=abc"; },
    async listAccounts() { return [{ remoteId: "BR-1", name: "Brokerage", orgName: "Sample Broker", currency: "USD", balance: 5000, balanceDate: "" }, { remoteId: "BR-2", name: "Unmapped", orgName: "Sample Broker", currency: "USD", balance: 1, balanceDate: "" }]; },
    async positions(credentials, remoteId) { calls.push(["positions", remoteId]); return [{ remoteAccountId: remoteId, symbol: "AAPL", name: "Apple", units: 2, price: 190, costBasis: 150, currency: "USD", holdingType: "stock" }]; },
    async cash(credentials, remoteId) { calls.push(["cash", remoteId]); return 125.5; },
    async deleteUser() { calls.push(["deleteUser"]); }
  };
  const build = (envExtra, email) => {
    const app = express();
    app.use(express.json());
    const memoryDb = {};
    const requireSession = (req, _res, next) => { req.sessionUser = { id: "u1", email, household_id: "h1", access_level: "edit" }; next(); };
    registerLinkedAccountRoutes({ app, requireSession, requireEditAccess: (_req, _res, next) => next(), MEMORY_DB: true, memoryDb, pool: null, env: { LINK_ENCRYPTION_KEY: KEY, SNAPTRADE_CLIENT_ID: "id", SNAPTRADE_CONSUMER_KEY: "key", ...envExtra }, snaptradeAdapterFactory: () => adapter });
    return new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })); });
  };
  const call = async (base, path, options = {}) => { const res = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json" } }); return { status: res.status, body: await res.json().catch(() => ({})) }; };

  const stranger = await build({ SNAPTRADE_MODE: "personal", SNAPTRADE_PERSONAL_OWNER_EMAIL: "owner@example.com" }, "someone-else@example.com");
  const owner = await build({ SNAPTRADE_MODE: "personal", SNAPTRADE_PERSONAL_OWNER_EMAIL: "owner@example.com" }, "Owner@Example.com");
  const unconfigured = await build({ SNAPTRADE_CLIENT_ID: "", SNAPTRADE_CONSUMER_KEY: "" }, "owner@example.com");
  try {
    assert.equal((await call(stranger.base, "/api/linked-accounts/snaptrade", { method: "POST", body: "{}" })).status, 403);
    assert.equal((await call(unconfigured.base, "/api/linked-accounts/snaptrade", { method: "POST", body: "{}" })).status, 503);
    assert.equal((await call(unconfigured.base, "/api/linked-accounts")).body.providers.snaptrade, false);

    const created = await call(owner.base, "/api/linked-accounts/snaptrade", { method: "POST", body: JSON.stringify({ label: "Broker", redirectUrl: "https://familyloop.net/done" }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.portalUrl, "https://app.snaptrade.com/portal?token=abc");
    assert.deepEqual(calls.find((c) => c[0] === "portal"), ["portal", "https://familyloop.net/done"]);
    const id = created.body.link.id;
    assert.equal((await call(owner.base, "/api/linked-accounts")).body.providers.snaptrade, true);

    const remote = await call(owner.base, `/api/linked-accounts/${id}/remote-accounts`);
    assert.deepEqual(remote.body.accounts.map((a) => a.remoteId), ["BR-1", "BR-2"]);
    await call(owner.base, `/api/linked-accounts/${id}/mappings`, { method: "PUT", body: JSON.stringify({ mappings: { "BR-1": { groupId: "group-1", groupName: "Sample Broker" } } }) });

    const sync = await call(owner.base, `/api/linked-accounts/${id}/sync`, { method: "POST", body: "{}" });
    assert.equal(sync.status, 200);
    assert.deepEqual(sync.body.positions.map((p) => [p.remoteAccountId, p.symbol, p.units]), [["BR-1", "AAPL", 2]]);
    assert.deepEqual(sync.body.cash, { "BR-1": 125.5 });
    assert.deepEqual(calls.filter((c) => c[0] === "positions" || c[0] === "cash").map((c) => c[1]), ["BR-1", "BR-1"], "only mapped accounts are read");

    assert.equal((await call(owner.base, `/api/linked-accounts/${id}`, { method: "DELETE" })).status, 200);
  } finally {
    await Promise.all([stranger, owner, unconfigured].map((entry) => new Promise((resolve) => entry.server.close(resolve))));
  }
});

test("the nightly job notifies the household about new transactions and about a connection that needs signing in again, once, and keeps going past a failing link", async () => {
  const messages = [];
  let mode = "ok";
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") return { ok: true, status: 200, text: async () => "http://u:p@127.0.0.1:9/simplefin" };
    if (mode === "revoked") return { ok: false, status: 403, json: async () => ({}) };
    const posted = Math.floor(Date.parse("2026-10-24T12:00:00Z") / 1000);
    return { ok: true, status: 200, json: async () => ({ errors: [], accounts: [{ org: { name: "B" }, id: "A1", name: "Checking", currency: "USD", balance: "5", "balance-date": posted, transactions: [{ id: "t1", posted, amount: "-1", description: "X" }, { id: "t2", posted, amount: "-2", description: "Y" }] }] }) };
  };
  const app = express();
  app.use(express.json());
  const memoryDb = {};
  const requireSession = (req, _res, next) => { req.sessionUser = { id: "u1", email: "o@example.com", household_id: "h1", access_level: "edit" }; next(); };
  const requireJobSecret = (req, res, next) => (req.headers.authorization === "Bearer s" ? next() : res.status(401).json({ error: "no" }));
  registerLinkedAccountRoutes({ app, requireSession, requireEditAccess: (_q, _r, n) => n(), requireJobSecret, notifyHousehold: async (householdId, message) => { messages.push([householdId, message]); }, MEMORY_DB: true, memoryDb, pool: null, env: { LINK_ENCRYPTION_KEY: KEY, NODE_ENV: "test", SIMPLEFIN_ALLOW_TEST_HOSTS: "true" }, fetchImpl });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, options = {}) => { const res = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } }); return { status: res.status, body: await res.json().catch(() => ({})) }; };
  const job = () => call("/api/internal/linked-accounts/sync-all", { method: "POST", headers: { authorization: "Bearer s" }, body: "{}" });
  try {
    const token = Buffer.from("http://127.0.0.1:9/simplefin/claim/T").toString("base64");
    const created = await call("/api/linked-accounts/simplefin", { method: "POST", body: JSON.stringify({ setupToken: token, label: "Bank one" }) });
    const id = created.body.link.id;
    assert.equal((await job()).body.links, 0, "a link with no accounts chosen yet is not synced");
    await call(`/api/linked-accounts/${id}/mappings`, { method: "PUT", body: JSON.stringify({ mappings: { A1: { accountId: "chk" } } }) });
    assert.equal((await job()).body.links, 0, "a link that has never synced waits for its first sync in the app, where a short history is explained");
    await call(`/api/linked-accounts/${id}/sync`, { method: "POST", body: "{}" });
    await call(`/api/linked-accounts/${id}/ack`, { method: "POST", body: JSON.stringify({ stagedAt: new Date(Date.now() + 3600000).toISOString() }) });

    const retryJob = () => call("/api/internal/linked-accounts/sync-all", { method: "POST", headers: { authorization: "Bearer s" }, body: JSON.stringify({ retry: true }) });
    const first = await job();
    assert.deepEqual([first.body.synced, first.body.newTransactions], [1, 2]);
    const ran = (await call("/api/linked-accounts")).body.links[0].lastRun;
    assert.deepEqual([ran.ok, ran.stage, ran.newRows, typeof ran.at], [true, "fetched", 2, "string"], "each run records what it did for the link");
    assert.equal((await retryJob()).body.links, 0, "the retry run leaves a link whose overnight run finished cleanly alone");
    assert.deepEqual(messages, [["h1", "2 new bank transactions waiting to review"]]);
    await job();
    assert.equal(messages.length, 1, "a night with nothing new sends nothing");

    mode = "revoked";
    const failing = await job();
    assert.deepEqual([failing.body.failed, failing.body.reconnect], [1, 1]);
    const failedRun = (await call("/api/linked-accounts")).body.links[0].lastRun;
    assert.deepEqual([failedRun.ok, failedRun.stage, failedRun.reconnect], [false, "fetch", true], "a run that could not fetch says so");
    assert.equal(messages[1][1], "Bank one needs signing in again - open Wealth to relink");
    assert.equal((await call("/api/linked-accounts")).body.links[0].status, "needs_reconnect");
    const again = await job();
    assert.equal(again.body.links, 0, "a link that needs reconnecting is not retried (or announced) every night");
    assert.equal(messages.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("a night that never ran is made up: the next run starts from the last successful sync, and the catch-up run only touches links whose last clean run is old", async () => {
  const requested = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") return { ok: true, status: 200, text: async () => "http://u:p@127.0.0.1:9/simplefin" };
    requested.push(new URL(url).searchParams.get("start-date"));
    const posted = Math.floor(Date.now() / 1000) - 3600;
    return { ok: true, status: 200, json: async () => ({ errors: [], accounts: [{ org: { name: "B" }, id: "A1", name: "Checking", currency: "USD", balance: "5", "balance-date": posted, transactions: [] }] }) };
  };
  const app = express();
  app.use(express.json());
  const memoryDb = {};
  const requireSession = (req, _res, next) => { req.sessionUser = { id: "u1", email: "o@example.com", household_id: "h1", access_level: "edit" }; next(); };
  const requireJobSecret = (req, res, next) => (req.headers.authorization === "Bearer s" ? next() : res.status(401).json({ error: "no" }));
  registerLinkedAccountRoutes({ app, requireSession, requireEditAccess: (_q, _r, n) => n(), requireJobSecret, notifyHousehold: async () => undefined, MEMORY_DB: true, memoryDb, pool: null, env: { LINK_ENCRYPTION_KEY: KEY, NODE_ENV: "test", SIMPLEFIN_ALLOW_TEST_HOSTS: "true" }, fetchImpl });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, options = {}) => { const res = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } }); return { status: res.status, body: await res.json().catch(() => ({})) }; };
  const run = (body) => call("/api/internal/linked-accounts/sync-all", { method: "POST", headers: { authorization: "Bearer s" }, body: JSON.stringify(body) });
  const day = 86400 * 1000;
  try {
    const token = Buffer.from("http://127.0.0.1:9/simplefin/claim/T").toString("base64");
    const created = await call("/api/linked-accounts/simplefin", { method: "POST", body: JSON.stringify({ setupToken: token, label: "Bank one" }) });
    const id = created.body.link.id;
    await call(`/api/linked-accounts/${id}/mappings`, { method: "PUT", body: JSON.stringify({ mappings: { A1: { accountId: "chk" } } }) });
    const row = memoryDb.linkedAccounts[0];
    // The last successful sync was six days ago and the nights since never ran.
    row.last_sync_at = new Date(Date.now() - 6 * day).toISOString();
    row.last_run = { at: new Date(Date.now() - 6 * day).toISOString(), ok: true, stage: "applied" };
    const dateOf = (offsetDays) => new Date(Date.now() - offsetDays * day).toISOString().slice(0, 10);
    const first = await run({});
    assert.equal(first.body.synced, 1);
    assert.equal(requested[0] && new Date(Number(requested[0]) * 1000).toISOString().slice(0, 10), dateOf(9), "the fetch started three days of overlap before the last successful sync, not just from last night");
    const ran = (await call("/api/linked-accounts")).body.links[0].lastRun;
    assert.equal(ran.sinceDate, dateOf(9), "the run says where it started, so the status line can say what it covered");
    assert.equal(new Date(row.last_sync_at).toISOString().slice(0, 10), dateOf(6), "a fetch alone does not move the link's last-sync date: nothing has been loaded into the household yet");
    // A manual sync stages data but the date only moves when the client has applied it and acknowledges it.
    const manual = await call(`/api/linked-accounts/${id}/sync`, { method: "POST", body: "{}" });
    assert.equal(manual.status, 200);
    assert.equal(new Date(row.last_sync_at).toISOString().slice(0, 10), dateOf(6), "a manual fetch does not move it either");
    const staged = row.staged_at;
    await call(`/api/linked-accounts/${id}/ack`, { method: "POST", body: JSON.stringify({ stagedAt: new Date(Date.now() + 3600000).toISOString() }) });
    assert.equal(new Date(row.last_sync_at).toISOString(), new Date(staged).toISOString(), "acknowledging the applied data moves it to when that data was fetched");

    // A clean run today: neither the retry nor the catch-up touches the link.
    assert.equal((await run({ retry: true })).body.links, 0);
    assert.equal((await run({ retry: true, maxAgeHours: 20 })).body.links, 0);
    // The nightly run never happened for a day and a half: the catch-up picks it up (the plain retry, with its 8-hour rule, would too).
    row.last_run = { ...row.last_run, at: new Date(Date.now() - 36 * 3600 * 1000).toISOString() };
    assert.equal((await run({ retry: true, maxAgeHours: 20 })).body.links, 1);
    row.last_run = { ...row.last_run, at: new Date(Date.now() - 12 * 3600 * 1000).toISOString() };
    assert.equal((await run({ retry: true, maxAgeHours: 20 })).body.links, 0, "twelve hours old is fine for the catch-up");
    assert.equal((await run({ retry: true })).body.links, 1, "but not for the 8-hour retry rule");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("syncing only some accounts asks the bank for just those, leaves the link's last-sync date alone, and adding an account does not reset the others", async () => {
  const urls = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") return { ok: true, status: 200, text: async () => "http://u:p@127.0.0.1:9/simplefin" };
    urls.push(new URL(url));
    const wanted = new URL(url).searchParams.getAll("account");
    const posted = Math.floor(Date.now() / 1000) - 3600;
    const all = [["A1", "t1"], ["A2", "t2"], ["A3", "t3"]].map(([id, tid]) => ({ org: { name: "B" }, id, name: `Account ${id}`, currency: "USD", balance: "5", "balance-date": posted, transactions: [{ id: tid, posted, amount: "-1", description: `Row ${id}` }] }));
    return { ok: true, status: 200, json: async () => ({ errors: [], accounts: wanted.length ? all.filter((account) => wanted.includes(account.id)) : all }) };
  };
  const app = express();
  app.use(express.json());
  const memoryDb = {};
  const requireSession = (req, _res, next) => { req.sessionUser = { id: "u1", email: "o@example.com", household_id: "h1", access_level: "edit" }; next(); };
  registerLinkedAccountRoutes({ app, requireSession, requireEditAccess: (_q, _r, n) => n(), requireJobSecret: (_q, _r, n) => n(), notifyHousehold: async () => undefined, MEMORY_DB: true, memoryDb, pool: null, env: { LINK_ENCRYPTION_KEY: KEY, NODE_ENV: "test", SIMPLEFIN_ALLOW_TEST_HOSTS: "true" }, fetchImpl });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, options = {}) => { const res = await fetch(`${base}${path}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } }); return { status: res.status, body: await res.json().catch(() => ({})) }; };
  const day = 86400 * 1000;
  try {
    const token = Buffer.from("http://127.0.0.1:9/simplefin/claim/T").toString("base64");
    const created = await call("/api/linked-accounts/simplefin", { method: "POST", body: JSON.stringify({ setupToken: token, label: "Bank one" }) });
    const id = created.body.link.id;
    const map = (mappings) => call(`/api/linked-accounts/${id}/mappings`, { method: "PUT", body: JSON.stringify({ mappings }) });
    const first = await map({ A1: { accountId: "a1" }, A2: { accountId: "a2" } });
    assert.deepEqual(first.body.addedRemoteIds, [], "choosing accounts for the first time is not an addition");
    const row = memoryDb.linkedAccounts[0];
    const syncedAt = new Date(Date.now() - 2 * day).toISOString();
    row.last_sync_at = syncedAt;
    // A third account is added to a link that already syncs: the other accounts' sync date is not reset, and the response says what was added.
    const added = await map({ A1: { accountId: "a1" }, A2: { accountId: "a2" }, A3: { accountId: "a3" } });
    assert.deepEqual(added.body.addedRemoteIds, ["A3"]);
    assert.equal(row.last_sync_at, syncedAt);

    // Only A3, from an earlier date: the bank is asked for just that account.
    const subset = await call(`/api/linked-accounts/${id}/sync`, { method: "POST", body: JSON.stringify({ sinceDate: "2026-09-01", accountIds: ["A3", "NOPE"] }) });
    assert.equal(subset.status, 200);
    assert.deepEqual(urls.at(-1).searchParams.getAll("account"), ["A3"], "an id that is not one of the link's accounts is ignored");
    assert.deepEqual(subset.body.accounts.map((a) => a.remoteId), ["A3"]);
    assert.deepEqual(subset.body.transactions.map((t) => t.remoteAccountId), ["A3"]);
    await call(`/api/linked-accounts/${id}/ack`, { method: "POST", body: JSON.stringify({ stagedAt: subset.body.stagedAt }) });
    assert.equal(row.last_sync_at, syncedAt, "a fetch of some accounts does not move the link's last-sync date: the others were not fetched");

    // A full sync, discarded without applying, does not move it either; applied, it does.
    const full = await call(`/api/linked-accounts/${id}/sync`, { method: "POST", body: "{}" });
    assert.equal(urls.at(-1).searchParams.getAll("account").length, 0, "no account filter on a full sync");
    await call(`/api/linked-accounts/${id}/ack`, { method: "POST", body: JSON.stringify({ stagedAt: full.body.stagedAt, discard: true }) });
    assert.equal(row.last_sync_at, syncedAt);
    const again = await call(`/api/linked-accounts/${id}/sync`, { method: "POST", body: "{}" });
    await call(`/api/linked-accounts/${id}/ack`, { method: "POST", body: JSON.stringify({ stagedAt: again.body.stagedAt }) });
    assert.ok(new Date(row.last_sync_at) > new Date(syncedAt), "applied and acknowledged, a full sync moves it");
    // Choosing every account is a full sync, not a subset.
    await call(`/api/linked-accounts/${id}/sync`, { method: "POST", body: JSON.stringify({ accountIds: ["A1", "A2", "A3"] }) });
    assert.equal(urls.at(-1).searchParams.getAll("account").length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the nightly job applies new bank transactions to the household without the app: ledger, balances and versions", async () => {
  const stub = await startSimplefinStub();
  const server = await startTestServer({ LINK_ENCRYPTION_KEY: KEY, SIMPLEFIN_ALLOW_TEST_HOSTS: "true", NOTIFICATION_SECRET: "job-secret" });
  try {
    const signup = await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "overnight@example.com", password: "Linked-Accounts-Password-123!", name: "Night", householdName: "Overnight home", country: "US" }) });
    const cookie = signup.cookie;
    const get = () => server.request("/api/state", { headers: { cookie } });
    const loaded = await get();
    const version = Number(loaded.headers.get("x-state-version"));
    assert.ok(Number.isInteger(version));
    const state = loaded.body;
    state.budget.categories = [{ name: "Food", color: "#2f6f4e", lines: [{ id: "groceries", name: "Groceries", planned: 400 }] }];
    const line = state.budget.categories[0].lines[0];
    state.accounts = [{ id: "local-checking", name: "Checking", type: "checking", openingBalance: 0, netWorthAssetId: "", netWorthLiabilityId: "", createdAt: "2026-01-01" }];
    // History for the grocer, so the household's own habits can categorize it without any AI.
    state.transactions = [{ date: "2026-09-01", payee: "SAMPLE GROCER", amount: 30, lineId: line.id, memo: "", accountId: "local-checking", orderNumber: "", tags: [], categoryName: "x", subcategoryName: line.name }];
    const saved = await server.request("/api/state", { method: "PUT", headers: { cookie, "x-base-version": String(version) }, body: JSON.stringify(state) });
    assert.equal(saved.status, 200);
    assert.equal(Number(saved.headers.get("x-state-version")), version, "an ordinary save does not move the version apps compare - several tabs or devices saving never refuse each other");
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie, "x-base-version": String(version) }, body: JSON.stringify(state) })).status, 200);

    const created = await server.request("/api/linked-accounts/simplefin", { method: "POST", headers: { cookie }, body: JSON.stringify({ setupToken: stub.setupToken, label: "My bank" }) });
    const id = created.body.link.id;
    await server.request(`/api/linked-accounts/${id}/mappings`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ mappings: { "ACT-1": { accountId: "local-checking" }, "ACT-2": { skipped: true } } }) });

    // A link that has never synced waits for its first sync in the app (where a short history is explained); once it has, the job takes over.
    const skipped = await server.request("/api/internal/linked-accounts/sync-all", { method: "POST", headers: { authorization: "Bearer job-secret" }, body: "{}" });
    assert.deepEqual([skipped.body.links, skipped.body.synced], [0, 0]);
    await server.request(`/api/linked-accounts/${id}/sync`, { method: "POST", headers: { cookie }, body: "{}" });
    await server.request(`/api/linked-accounts/${id}/ack`, { method: "POST", headers: { cookie }, body: JSON.stringify({ stagedAt: new Date(Date.now() + 3600000).toISOString() }) });
    const nightly = await server.request("/api/internal/linked-accounts/sync-all", { method: "POST", headers: { authorization: "Bearer job-secret" }, body: "{}" });
    assert.deepEqual([nightly.status, nightly.body.synced, nightly.body.failed, nightly.body.autoApplied], [200, 1, 0, 2]);

    const after = await get();
    assert.equal(Number(after.headers.get("x-state-version")), version + 1, "the server's own write moves the version");
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie, "x-base-version": String(version) }, body: JSON.stringify(state) })).status, 409, "a screen loaded before the overnight apply is refused instead of overwriting it");
    const grocer = after.body.transactions.find((transaction) => transaction.externalId === "sf:ACT-1:T1");
    assert.deepEqual([grocer.payee, grocer.amount, grocer.lineId, grocer.accountId], ["SAMPLE GROCER", 40.25, line.id, "local-checking"], "a row the household's history can categorize went straight into the ledger");
    const payroll = after.body.transactions.find((transaction) => transaction.externalId === "sf:ACT-1:T2");
    assert.deepEqual([payroll.lineId, payroll.memo, after.body.transactionInboxDrafts.length], ["", "Needs a category", 0], "the payroll row has no history and no AI here, so it goes in marked Needs a category");
    assert.ok(after.body.linkedImportedIds.includes("sf:ACT-1:T1") && after.body.linkedImportedIds.includes("sf:ACT-1:T2"));
    const { accountBalance } = require("../lib/shared-logic");
    const balance = accountBalance("local-checking", { accounts: after.body.accounts, transactions: after.body.transactions, paychecks: after.body.paychecks, paycheckOccurrences: after.body.paycheckOccurrences, transfers: after.body.transfers, ious: after.body.ious || [] }, new Date().toISOString().slice(0, 10));
    assert.equal(Math.round(balance * 100) / 100, 1250.5, "the account's balance follows the bank");
    assert.deepEqual([(await server.request("/api/linked-accounts", { headers: { cookie } })).body.links[0].hasStaged], [false], "applied data is no longer staged");
    const nightRun = (await server.request("/api/linked-accounts", { headers: { cookie } })).body.links[0].lastRun;
    assert.deepEqual([nightRun.ok, nightRun.stage, nightRun.imported, nightRun.added], [true, "applied", 2, 2], "the link records that the night's data was loaded, with the counts");
    const checking = after.body.accounts.find((account) => account.id === "local-checking");
    assert.equal(checking.syncedFrom, "2026-10-02", "the account's start tag is its earliest bank row");
    assert.match(checking.syncedThrough, /^\d{4}-\d{2}-\d{2}$/, "and the end tag says how far the bank's data runs");
    assert.ok(checking.lastSyncedAt);
    assert.equal(after.body.household.activity[0].includes("added to the ledger overnight"), true);

    // The household can turn it off: the job then only stages, as before.
    after.body.linkedAutoApply = false;
    await server.request("/api/state", { method: "PUT", headers: { cookie, "x-base-version": after.headers.get("x-state-version") }, body: JSON.stringify(after.body) });
    await server.request(`/api/linked-accounts/${id}/mappings`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ mappings: { "ACT-1": { accountId: "local-checking" } } }) });
    // Changing the accounts restarts the link's first sync, which happens in the app; then the job takes over again.
    await server.request(`/api/linked-accounts/${id}/sync`, { method: "POST", headers: { cookie }, body: "{}" });
    await server.request(`/api/linked-accounts/${id}/ack`, { method: "POST", headers: { cookie }, body: JSON.stringify({ stagedAt: new Date(Date.now() + 3600000).toISOString() }) });
    await server.request("/api/internal/linked-accounts/sync-all", { method: "POST", headers: { authorization: "Bearer job-secret" }, body: "{}" });
    const off = (await server.request("/api/linked-accounts", { headers: { cookie } })).body.links[0];
    assert.deepEqual([off.hasStaged, (await get()).body.transactions.length], [true, after.body.transactions.length], "with auto-apply off the rows stay staged and the state is untouched");

    // A client that did not send a version (an older mobile build) still saves.
    const unversioned = await get();
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(unversioned.body) })).status, 200);
    assert.equal((await server.request("/api/state/version", { headers: { cookie } })).body.version, Number(unversioned.headers.get("x-state-version")));
  } finally {
    await server.stop();
    await stub.stop();
  }
});


test("a history import leaves out the whole months a bank only partly returned and reports them; a quiet account or a bank that starts on time is left alone", () => {
  const row = (remoteAccountId, date, n) => ({ externalId: `sf:${remoteAccountId}:${date}:${n}`, remoteAccountId, date, payee: "P", amount: 5, pending: false });
  const dates = ["2026-03-09", "2026-03-20", "2026-04-02", "2026-05-11", "2026-06-03", "2026-07-07"];
  const payload = {
    provider: "simplefin",
    accounts: [{ remoteId: "A", name: "DCU Prithvi" }, { remoteId: "B", name: "Quiet savings" }, { remoteId: "C", name: "Good bank" }, { remoteId: "D", name: "Starts on the 2nd" }],
    transactions: [
      ...dates.map((date, i) => row("A", date, i)),
      row("B", "2026-08-20", 1), row("B", "2026-09-20", 2),
      ...["2026-01-02", "2026-02-10", "2026-03-10", "2026-04-10", "2026-05-10"].map((date, i) => row("C", date, i)),
      ...["2026-03-02", "2026-03-15", "2026-04-15", "2026-05-15", "2026-06-15"].map((date, i) => row("D", date, i))
    ],
    errors: []
  };
  const { payload: trimmed, gaps } = trimPartialHistory(payload, "2026-01-01");
  assert.deepEqual(gaps, [
    { remoteId: "A", name: "DCU Prithvi", fromMonth: "2026-01", toMonth: "2026-03", oldestReturned: "2026-03-09", skippedRows: 2 },
    { remoteId: "D", name: "Starts on the 2nd", fromMonth: "2026-01", toMonth: "2026-02", oldestReturned: "2026-03-02", skippedRows: 0 }
  ]);
  const kept = (id) => trimmed.transactions.filter((t) => t.remoteAccountId === id).map((t) => t.date);
  assert.deepEqual(kept("A"), ["2026-04-02", "2026-05-11", "2026-06-03", "2026-07-07"], "March, a partly covered month, is left out whole");
  assert.equal(kept("B").length, 2, "an account with only a couple of rows is not flagged");
  assert.equal(kept("C").length, 5, "a bank that starts within three weeks of the date asked for is complete");
  assert.equal(kept("D").length, 5, "rows starting on the 2nd of a month count that month as covered");
  assert.deepEqual(trimPartialHistory(payload, "").gaps, [], "only a history import trims anything");
  assert.equal(trimPartialHistory(payload, "").payload, payload);
  assert.equal(trimPartialHistory({ ...payload, provider: "snaptrade" }, "2026-01-01").gaps.length, 0);
});

test("an out-of-date screen cannot overwrite an imported ledger with an almost empty one; a deliberate Clean up can", async () => {
  const server = await startTestServer();
  try {
    const signup = await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "shrink@example.com", password: "Shrink-Guard-Password-123!", name: "S", householdName: "Shrink home", country: "US" }) });
    const cookie = signup.cookie;
    const loaded = await server.request("/api/state", { headers: { cookie } });
    const state = loaded.body;
    const stale = JSON.parse(JSON.stringify(state));
    state.transactions = Array.from({ length: 60 }, (_, i) => ({ date: "2026-05-01", payee: `P${i}`, amount: 5, lineId: "", memo: "", accountId: "", orderNumber: "", tags: [] }));
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) })).status, 200);

    // A second tab that loaded before the import keeps saving its older, empty-ledger copy: refused, and nothing is lost.
    const refused = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(stale) });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /updated elsewhere/);
    assert.match(refused.body.error, /0 of 60 transactions/);
    assert.equal((await server.request("/api/state", { headers: { cookie } })).body.transactions.length, 60);

    // Ordinary edits - removing a few rows, or all of a small ledger - are not mistaken for it.
    const fewer = { ...state, transactions: state.transactions.slice(0, 40) };
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(fewer) })).status, 200);

    // The Clean up tool says it means it.
    const cleaned = await server.request("/api/state", { method: "PUT", headers: { cookie, "x-allow-shrink": "1" }, body: JSON.stringify(stale) });
    assert.equal(cleaned.status, 200);
    assert.equal((await server.request("/api/state", { headers: { cookie } })).body.transactions.length, 0);
    // A small ledger can be emptied freely.
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify({ ...stale, transactions: [] }) })).status, 200);
  } finally { await server.stop(); }
});


test("trimPartialHistory reports where each account's bank rows are complete from, and a first sync starts on the first of last month", () => {
  const { firstOfPreviousMonth } = require("../server/linked-accounts");
  assert.equal(firstOfPreviousMonth(Date.parse("2026-10-27T12:00:00Z")), "2026-09-01");
  assert.equal(firstOfPreviousMonth(Date.parse("2026-01-05T12:00:00Z")), "2025-12-01");
  const row = (remoteAccountId, date, n) => ({ externalId: `sf:${remoteAccountId}:${date}:${n}`, remoteAccountId, date, payee: "P", amount: 5, pending: false });
  const payload = { provider: "simplefin", accounts: [{ remoteId: "A", name: "Late" }, { remoteId: "B", name: "On time" }, { remoteId: "C", name: "Empty" }], errors: [], transactions: [
    ...["2026-03-09", "2026-03-20", "2026-04-02", "2026-05-11", "2026-06-03"].map((d, i) => row("A", d, i)),
    ...["2026-01-02", "2026-02-10", "2026-03-10", "2026-04-10", "2026-05-10"].map((d, i) => row("B", d, i))
  ] };
  const { coverage } = trimPartialHistory(payload, "2026-01-01");
  assert.deepEqual(coverage, { A: { from: "2026-04-01" }, B: { from: "2026-01-01" }, C: { from: "2026-01-01" } });
  assert.deepEqual(trimPartialHistory(payload, "").coverage, {});
});

test("a slow SimpleFIN range is split and retried instead of losing the import; what still fails becomes whole-month gaps, and a sync that may not be partial fails clearly", async () => {
  const { syncSimplefin, gapsFromFailedWindows } = require("../server/linked-accounts");
  const day = 86400;
  const start = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
  const end = start + 130 * day; // three windows of up to 55 days
  const respond = (accounts) => ({ ok: true, status: 200, json: async () => ({ errors: [], accounts }) });
  const accountFor = (from, to) => ({ id: "A1", name: "Checking", org: { name: "B" }, currency: "USD", balance: "10", "balance-date": to, transactions: [{ id: `t-${from}`, posted: from + day, amount: "-1", description: "X" }] });
  const rangeOf = (url) => { const u = new URL(url); return [Number(u.searchParams.get("start-date")), Number(u.searchParams.get("end-date"))]; };

  // The Bridge times out on any range that includes the second window's start; smaller pieces of it also fail around that point.
  const calls = [];
  const flaky = async (url) => {
    const [from, to] = rangeOf(url);
    calls.push([from, to]);
    if (from <= start + 56 * day && to > start + 56 * day && to - from > 20 * day) return { ok: false, status: 524, json: async () => ({}) };
    return respond([accountFor(from, to)]);
  };
  const recovered = await syncSimplefin("https://u:p@bridge.simplefin.org/simplefin", { startUnix: start, endUnix: end, allowPartial: true }, { fetchImpl: flaky });
  assert.deepEqual(recovered.failedWindows, [], "the failing range was split into smaller ones that answered");
  assert.ok(calls.length > 3, "more requests were made than the three windows");
  assert.equal(recovered.accounts.length, 1);

  // A range that fails at every size is reported, not silently dropped.
  const alwaysDown = async (url) => {
    const [from, to] = rangeOf(url);
    if (from < start + 55 * day) return { ok: false, status: 524, json: async () => ({}) };
    return respond([accountFor(from, to)]);
  };
  const partial = await syncSimplefin("https://u:p@bridge.simplefin.org/simplefin", { startUnix: start, endUnix: end, allowPartial: true }, { fetchImpl: alwaysDown });
  assert.ok(partial.failedWindows.length >= 1 && partial.failedWindows.every((w) => w.from < "2026-02-26"));
  // ...and a sync that may not be partial (the nightly job) fails with the Bridge's reason instead.
  await assert.rejects(() => syncSimplefin("https://u:p@bridge.simplefin.org/simplefin", { startUnix: start, endUnix: end, allowPartial: false }, { fetchImpl: alwaysDown }), /SimpleFIN is unavailable right now \(HTTP 524\)/);
  // Nothing answering at all is one clear error.
  await assert.rejects(() => syncSimplefin("https://u:p@bridge.simplefin.org/simplefin", { startUnix: start, endUnix: end, allowPartial: true }, { fetchImpl: async () => ({ ok: false, status: 524, json: async () => ({}) }) }), /did not answer .* Nothing was imported; try again in a few minutes/);
  // A request that never answers is given up on (the real timeout is a minute; the test stub just throws like an abort).
  await assert.rejects(() => syncSimplefin("https://u:p@bridge.simplefin.org/simplefin", { startUnix: start, endUnix: start + 10 * day, allowPartial: false }, { fetchImpl: async () => { throw new Error("aborted"); } }), /took too long to answer/);
  // A dropped connection (the Bridge resetting it) is a different, honestly named failure, asked again once after a pause before giving up.
  let drops = 0;
  const resets = async () => { drops += 1; const error = new TypeError("fetch failed"); error.cause = { code: "ECONNRESET" }; throw error; };
  await assert.rejects(() => syncSimplefin("https://u:p@bridge.simplefin.org/simplefin", { startUnix: start, endUnix: start + 10 * day, allowPartial: false }, { fetchImpl: resets }), /SimpleFIN dropped the connection \(ECONNRESET\)/);
  assert.equal(drops, 1, "a sync that may not be partial does not retry");
  drops = 0;
  await assert.rejects(() => syncSimplefin("https://u:p@bridge.simplefin.org/simplefin", { startUnix: start, endUnix: start + 10 * day, allowPartial: true }, { fetchImpl: resets, retryPauseMs: 1 }), /did not answer \(SimpleFIN dropped the connection \(ECONNRESET\)/);
  assert.ok(drops >= 2, "a history import asks the same range again after the pause (then smaller pieces) before it reports the failure");

  // Failed stretches become whole-month gaps for every mapped account, and rows in those months are left out.
  const payload = { provider: "simplefin", accounts: [{ remoteId: "A1", name: "Checking" }, { remoteId: "A2", name: "Card" }], errors: [], transactions: [
    { externalId: "sf:A1:1", remoteAccountId: "A1", date: "2026-01-20", amount: 1, pending: false },
    { externalId: "sf:A1:2", remoteAccountId: "A1", date: "2026-02-10", amount: 1, pending: false },
    { externalId: "sf:A1:3", remoteAccountId: "A1", date: "2026-03-10", amount: 1, pending: false },
    { externalId: "sf:A2:1", remoteAccountId: "A2", date: "2026-02-12", amount: 1, pending: false }
  ] };
  const result = gapsFromFailedWindows(payload, [{ from: "2026-01-15", to: "2026-02-20", error: "x" }], { A1: { accountId: "a" }, A2: { accountId: "b" }, A3: { groupId: "g" } });
  assert.deepEqual(result.payload.transactions.map((t) => t.externalId), ["sf:A1:3"], "January and February are left out whole, for every account");
  assert.deepEqual(result.gaps.map((g) => [g.remoteId, g.fromMonth, g.toMonth, g.oldestReturned, g.reason, g.skippedRows]), [["A1", "2026-01", "2026-02", "", "timeout", 2], ["A2", "2026-01", "2026-02", "", "timeout", 1]]);
  assert.equal(result.failedThrough, "2026-03-01");
  assert.deepEqual(gapsFromFailedWindows(payload, [], {}).gaps, []);
});


test("a save can never drop an entry that came from the bank unless the person asked to remove it", async () => {
  const server = await startTestServer();
  try {
    const signup = await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "protect@example.com", password: "Protect-Ledger-Password-123!", name: "P", householdName: "Protect home", country: "US" }) });
    const cookie = signup.cookie;
    const state = (await server.request("/api/state", { headers: { cookie } })).body;
    const row = (n, externalId) => ({ date: "2026-05-01", payee: `P${n}`, amount: 5, lineId: "", memo: "", accountId: "", orderNumber: "", tags: [], ...(externalId ? { externalId } : {}) });
    state.transactions = [row(1, "sf:a:1"), row(2, "sf:a:2"), row(3), row(4, "sf:a:4")];
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(state) })).status, 200);

    // An older copy that does not have two of the bank entries yet (a second tab) is refused, even though only a few rows differ.
    const stale = { ...state, transactions: [row(1, "sf:a:1"), row(3)] };
    const refused = await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(stale) });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /updated elsewhere/);
    assert.match(refused.body.error, /2 bank-imported ledger entries/);
    assert.equal((await server.request("/api/state", { headers: { cookie } })).body.transactions.length, 4, "nothing was lost");

    // Adding entries, editing them, and removing one that was typed by hand are all fine.
    const edited = { ...state, transactions: [{ ...row(1, "sf:a:1"), lineId: "x" }, row(2, "sf:a:2"), row(4, "sf:a:4"), row(5), row(6, "sf:a:6")] };
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(edited) })).status, 200);

    // Deleting a bank entry yourself says so.
    const deleted = { ...edited, transactions: edited.transactions.filter((t) => t.externalId !== "sf:a:2") };
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie }, body: JSON.stringify(deleted) })).status, 409, "without saying so it is refused");
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie, "x-allow-shrink": "1" }, body: JSON.stringify(deleted) })).status, 200);
    assert.deepEqual((await server.request("/api/state", { headers: { cookie } })).body.transactions.map((t) => t.externalId || "hand"), ["sf:a:1", "sf:a:4", "hand", "sf:a:6"]);
  } finally { await server.stop(); }
});
