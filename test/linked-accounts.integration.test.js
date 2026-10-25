const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const { startTestServer } = require("./helpers");
const { registerLinkedAccountRoutes, mergeStagedPayload, knownExternalIds, findNewAccounts, encryptJson, decryptJson, normalizeSnaptradePositions, normalizeSimplefinTransactions, snaptradeConfig } = require("../server/linked-accounts");

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
    // An account added at the bank later has no entry, so it shows up as new on the next sync.
    await configured.request(`/api/linked-accounts/${id}/mappings`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ mappings: { "ACT-1": { accountId: "local-checking" } } }) });
    await configured.request(`/api/linked-accounts/${id}/sync`, { method: "POST", headers: { cookie }, body: "{}" });
    assert.deepEqual((await configured.request("/api/linked-accounts", { headers: { cookie } })).body.links[0].newAccounts.map((a) => a.remoteId), ["ACT-2"]);

    // The nightly job (shared-secret) stages every active link's data without touching household state.
    assert.equal((await configured.request("/api/internal/linked-accounts/sync-all", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await configured.request("/api/internal/linked-accounts/sync-all", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status, 401);
    await configured.request(`/api/linked-accounts/${id}/ack`, { method: "POST", headers: { cookie }, body: JSON.stringify({ stagedAt: new Date(Date.now() + 3600000).toISOString() }) });
    const nightly = await configured.request("/api/internal/linked-accounts/sync-all", { method: "POST", headers: { authorization: "Bearer job-secret" }, body: "{}" });
    assert.deepEqual([nightly.status, nightly.body.links, nightly.body.synced, nightly.body.failed], [200, 1, 1, 0]);
    assert.equal(nightly.body.newTransactions, 3);
    const afterNightly = (await configured.request("/api/linked-accounts", { headers: { cookie } })).body.links[0];
    assert.deepEqual([afterNightly.hasStaged, afterNightly.stagedCount], [true, 3]);
    const stateAfterNightly = await configured.request("/api/state", { headers: { cookie } });
    assert.deepEqual(stateAfterNightly.body.transactionInboxDrafts || [], [], "the job stages data; it never writes household state");
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

    const first = await job();
    assert.deepEqual([first.body.synced, first.body.newTransactions], [1, 2]);
    assert.deepEqual(messages, [["h1", "2 new bank transactions waiting to review"]]);
    await job();
    assert.equal(messages.length, 1, "a night with nothing new sends nothing");

    mode = "revoked";
    const failing = await job();
    assert.deepEqual([failing.body.failed, failing.body.reconnect], [1, 1]);
    assert.equal(messages[1][1], "Bank one needs signing in again - open Wealth to relink");
    assert.equal((await call("/api/linked-accounts")).body.links[0].status, "needs_reconnect");
    const again = await job();
    assert.equal(again.body.links, 0, "a link that needs reconnecting is not retried (or announced) every night");
    assert.equal(messages.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
