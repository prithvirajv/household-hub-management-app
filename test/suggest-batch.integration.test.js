const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startTestServer } = require("./helpers");
const { parseBatchSuggestions, autoAcceptDecision } = require("../lib/shared-logic");

async function startGeminiStub(reply) {
  const requests = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push(body);
      res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${stub.address().port}`, requests, stop: () => new Promise((resolve) => stub.close(resolve)) };
}

test("parseBatchSuggestions only trusts ids that were offered, tolerates fences, drops duplicates and downgrades unsupported high confidence", () => {
  const text = "Sure!\n```json\n" + JSON.stringify([
    { id: "r1", lineId: "groceries", accountId: "checking", confidence: "high" },
    { id: "r2", lineId: "made-up", accountId: null, confidence: "high" },
    { id: "r3", lineId: "utilities", accountId: "nope", confidence: "low" },
    { id: "r1", lineId: "utilities", accountId: null, confidence: "high" },
    { id: "unknown-row", lineId: "groceries", accountId: null, confidence: "high" },
    { id: "r4", lineId: null, accountId: null, confidence: "high" }
  ]) + "\n```";
  const results = parseBatchSuggestions(text, ["r1", "r2", "r3", "r4"], ["groceries", "utilities"], ["checking"]);
  assert.deepEqual(results, [
    { id: "r1", lineId: "groceries", accountId: "checking", confidence: "high" },
    { id: "r2", lineId: null, accountId: null, confidence: "low" },
    { id: "r3", lineId: "utilities", accountId: null, confidence: "low" },
    { id: "r4", lineId: null, accountId: null, confidence: "low" }
  ]);
  assert.deepEqual(parseBatchSuggestions("not json", ["r1"], [], []), []);
  assert.deepEqual(parseBatchSuggestions("[{broken", ["r1"], [], []), []);
  assert.deepEqual(parseBatchSuggestions('{"id":"r1"}', ["r1"], [], []), []);
});

test("autoAcceptDecision only lets confident, ordinary rows straight into the ledger", () => {
  const ok = { lineId: "groceries", accountId: "checking", lineSource: "ai-high" };
  const ctx = { accountsExist: true, possibleDuplicate: false, refundMatch: null, transferMatch: null, accountClosedForDate: false };
  assert.equal(autoAcceptDecision(ok, ctx).accept, true);
  assert.equal(autoAcceptDecision({ ...ok, lineSource: "history" }, ctx).accept, true);
  assert.equal(autoAcceptDecision({ ...ok, lineSource: "rule" }, ctx).accept, true);
  assert.equal(autoAcceptDecision({ ...ok, lineSource: "ai-low" }, ctx).reason, "low confidence");
  assert.equal(autoAcceptDecision({ ...ok, lineSource: "" }, ctx).accept, false);
  assert.equal(autoAcceptDecision({ ...ok, lineId: "" }, ctx).reason, "no category");
  assert.equal(autoAcceptDecision({ ...ok, accountId: "" }, ctx).reason, "no account");
  assert.equal(autoAcceptDecision({ ...ok, accountId: "" }, { ...ctx, accountsExist: false }).accept, true);
  assert.equal(autoAcceptDecision(ok, { ...ctx, possibleDuplicate: true }).reason, "possible duplicate");
  assert.equal(autoAcceptDecision(ok, { ...ctx, refundMatch: { lineId: "x" } }).reason, "refund");
  assert.equal(autoAcceptDecision(ok, { ...ctx, transferMatch: { accountId: "y" } }).reason, "possible transfer");
  assert.equal(autoAcceptDecision({ ...ok, isPayment: true }, ctx).accept, false);
  assert.equal(autoAcceptDecision({ ...ok, isDeposit: true }, ctx).accept, false);
  assert.equal(autoAcceptDecision({ ...ok, isPending: true }, ctx).accept, false);
  assert.equal(autoAcceptDecision(ok, { ...ctx, accountClosedForDate: true }).reason, "account closed");
});

test("suggest-batch endpoint validates input, requires a session, and returns only validated picks", async () => {
  const reply = JSON.stringify([{ id: "r1", lineId: "groceries", accountId: "checking", confidence: "high" }, { id: "r2", lineId: "hallucinated", accountId: null, confidence: "high" }]);
  const stub = await startGeminiStub({ body: { candidates: [{ content: { parts: [{ text: reply }] } }] } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const payload = { rows: [{ id: "r1", payee: "Kroger", amount: 54.2, date: "2026-07-01" }, { id: "r2", payee: "Mystery", amount: 9, date: "2026-07-02" }], lines: [{ id: "groceries", label: "Food - Groceries" }], accounts: [{ id: "checking", label: "Checking (checking)" }] };
    const anonymous = await server.request("/api/transactions/suggest-batch", { method: "POST", body: JSON.stringify(payload) });
    assert.equal(anonymous.status, 401);

    const signup = await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "suggest-batch@example.com", password: "Suggest-Batch-Password-123!", name: "Batch", householdName: "Batch Household", country: "US" }) });
    const cookie = signup.cookie;
    const post = (body) => server.request("/api/transactions/suggest-batch", { method: "POST", headers: { cookie }, body: JSON.stringify(body) });

    assert.equal((await post({ ...payload, rows: [] })).status, 400);
    assert.equal((await post({ ...payload, lines: [] })).status, 400);
    assert.equal((await post({ ...payload, rows: Array.from({ length: 61 }, (_, i) => ({ id: `x${i}`, payee: "P", amount: 1, date: "2026-07-01" })) })).status, 400);

    const ok = await post(payload);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.results, [
      { id: "r1", lineId: "groceries", accountId: "checking", confidence: "high" },
      { id: "r2", lineId: null, accountId: null, confidence: "low" }
    ]);
    assert.equal(stub.requests.length, 1, "one model call for the whole batch");
    assert.ok(stub.requests[0].includes("Kroger") && stub.requests[0].includes("Food - Groceries"));
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("suggest-batch endpoint is disabled without an API key and surfaces an upstream failure as 502", async () => {
  const noKey = await startTestServer();
  try {
    const signup = await noKey.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "suggest-batch-nokey@example.com", password: "Suggest-Batch-Password-123!", name: "B", householdName: "B", country: "US" }) });
    const res = await noKey.request("/api/transactions/suggest-batch", { method: "POST", headers: { cookie: signup.cookie }, body: JSON.stringify({ rows: [{ id: "r1", payee: "x", amount: 1, date: "2026-07-01" }], lines: [{ id: "a", label: "A" }] }) });
    assert.equal(res.status, 503);
  } finally { await noKey.stop(); }

  const stub = await startGeminiStub({ status: 500, body: { error: { message: "boom" } } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "suggest-batch-502@example.com", password: "Suggest-Batch-Password-123!", name: "B", householdName: "B", country: "US" }) });
    const res = await server.request("/api/transactions/suggest-batch", { method: "POST", headers: { cookie: signup.cookie }, body: JSON.stringify({ rows: [{ id: "r1", payee: "x", amount: 1, date: "2026-07-01" }], lines: [{ id: "a", label: "A" }] }) });
    assert.equal(res.status, 502);
  } finally { await server.stop(); await stub.stop(); }
});
