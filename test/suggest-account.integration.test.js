const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startTestServer } = require("./helpers");

async function startGeminiStub(reply) {
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${stub.address().port}`,
    stop: () => new Promise((resolve) => stub.close(resolve))
  };
}

test("suggest-account endpoint returns the AI-picked accountId when it's one of the options offered, and requires a session", async () => {
  const stub = await startGeminiStub({ body: { candidates: [{ content: { parts: [{ text: "checking" }] } }] } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const anonymous = await server.request("/api/transactions/suggest-account", { method: "POST", body: JSON.stringify({ payee: "Sawnee EMC", accounts: [{ id: "checking", label: "Checking (checking)" }] }) });
    assert.equal(anonymous.status, 401);

    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "suggest-account-owner@example.com", password: "Suggest-Account-Owner-Password-123!", name: "Suggest Account Owner", householdName: "Suggest Account Household", country: "US" })
    });
    const cookie = signup.cookie;

    const missingPayee = await server.request("/api/transactions/suggest-account", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "", accounts: [{ id: "checking", label: "Checking (checking)" }] }) });
    assert.equal(missingPayee.status, 400);

    const noAccounts = await server.request("/api/transactions/suggest-account", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Sawnee EMC", accounts: [] }) });
    assert.equal(noAccounts.status, 400);

    const suggestion = await server.request("/api/transactions/suggest-account", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Sawnee EMC", accounts: [{ id: "checking", label: "Checking (checking)" }, { id: "savings", label: "Savings (savings)" }] }) });
    assert.equal(suggestion.status, 200);
    assert.equal(suggestion.body.accountId, "checking");
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("suggest-account endpoint returns null rather than trusting a model reply that isn't one of the exact ids it was offered", async () => {
  const stub = await startGeminiStub({ body: { candidates: [{ content: { parts: [{ text: "some-made-up-id-the-model-hallucinated" }] } }] } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "account-hallucination-guard@example.com", password: "Account-Hallucination-Guard-Password-123!", name: "Account Hallucination Guard", householdName: "Account Hallucination Guard Household", country: "US" })
    });
    const cookie = signup.cookie;

    const suggestion = await server.request("/api/transactions/suggest-account", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Some Unknown Payee", accounts: [{ id: "checking", label: "Checking (checking)" }] }) });
    assert.equal(suggestion.status, 200);
    assert.equal(suggestion.body.accountId, null);
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("suggest-account endpoint returns null (not an error) when the model itself says none", async () => {
  const stub = await startGeminiStub({ body: { candidates: [{ content: { parts: [{ text: "none" }] } }] } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "account-no-match@example.com", password: "Account-No-Match-Password-123!", name: "Account No Match", householdName: "Account No Match Household", country: "US" })
    });
    const cookie = signup.cookie;

    const suggestion = await server.request("/api/transactions/suggest-account", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Some Unknown Payee", accounts: [{ id: "checking", label: "Checking (checking)" }] }) });
    assert.equal(suggestion.status, 200);
    assert.equal(suggestion.body.accountId, null);
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("suggest-account endpoint is disabled when no API key is configured", async () => {
  const server = await startTestServer({ GEMINI_API_KEY: "" });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "no-key-suggest-account@example.com", password: "No-Key-Suggest-Account-Password-123!", name: "No Key Suggest Account", householdName: "No Key Suggest Account Household", country: "US" })
    });
    const cookie = signup.cookie;

    const suggestion = await server.request("/api/transactions/suggest-account", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Sawnee EMC", accounts: [{ id: "checking", label: "Checking (checking)" }] }) });
    assert.equal(suggestion.status, 503);
  } finally {
    await server.stop();
  }
});

test("suggest-account endpoint surfaces an upstream error as a 502", async () => {
  const stub = await startGeminiStub({ status: 500, body: { error: { message: "overloaded" } } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "suggest-account-upstream-error@example.com", password: "Suggest-Account-Upstream-Error-Password-123!", name: "Suggest Account Upstream Error", householdName: "Suggest Account Upstream Error Household", country: "US" })
    });
    const cookie = signup.cookie;

    const suggestion = await server.request("/api/transactions/suggest-account", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Sawnee EMC", accounts: [{ id: "checking", label: "Checking (checking)" }] }) });
    assert.equal(suggestion.status, 502);
  } finally {
    await server.stop();
    await stub.stop();
  }
});
