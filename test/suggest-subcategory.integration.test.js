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

test("suggest-subcategory endpoint returns the AI-picked lineId when it's one of the options offered, and requires a session", async () => {
  const stub = await startGeminiStub({ body: { candidates: [{ content: { parts: [{ text: "utilities" }] } }] } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const anonymous = await server.request("/api/transactions/suggest-subcategory", { method: "POST", body: JSON.stringify({ payee: "Sawnee EMC", lines: [{ id: "utilities", label: "Home - Utilities" }] }) });
    assert.equal(anonymous.status, 401);

    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "suggest-owner@example.com", password: "Suggest-Owner-Password-123!", name: "Suggest Owner", householdName: "Suggest Household", country: "US" })
    });
    const cookie = signup.cookie;

    const missingPayee = await server.request("/api/transactions/suggest-subcategory", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "", lines: [{ id: "utilities", label: "Home - Utilities" }] }) });
    assert.equal(missingPayee.status, 400);

    const noLines = await server.request("/api/transactions/suggest-subcategory", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Sawnee EMC", lines: [] }) });
    assert.equal(noLines.status, 400);

    const suggestion = await server.request("/api/transactions/suggest-subcategory", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Sawnee EMC", lines: [{ id: "utilities", label: "Home - Utilities" }, { id: "groceries", label: "Food - Groceries" }] }) });
    assert.equal(suggestion.status, 200);
    assert.equal(suggestion.body.lineId, "utilities");
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("suggest-subcategory endpoint returns null rather than trusting a model reply that isn't one of the exact ids it was offered", async () => {
  const stub = await startGeminiStub({ body: { candidates: [{ content: { parts: [{ text: "some-made-up-id-the-model-hallucinated" }] } }] } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "hallucination-guard@example.com", password: "Hallucination-Guard-Password-123!", name: "Hallucination Guard", householdName: "Hallucination Guard Household", country: "US" })
    });
    const cookie = signup.cookie;

    const suggestion = await server.request("/api/transactions/suggest-subcategory", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Some Unknown Payee", lines: [{ id: "utilities", label: "Home - Utilities" }] }) });
    assert.equal(suggestion.status, 200);
    assert.equal(suggestion.body.lineId, null);
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("suggest-subcategory endpoint returns null (not an error) when the model itself says none", async () => {
  const stub = await startGeminiStub({ body: { candidates: [{ content: { parts: [{ text: "none" }] } }] } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "no-match@example.com", password: "No-Match-Password-123!", name: "No Match", householdName: "No Match Household", country: "US" })
    });
    const cookie = signup.cookie;

    const suggestion = await server.request("/api/transactions/suggest-subcategory", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Some Unknown Payee", lines: [{ id: "utilities", label: "Home - Utilities" }] }) });
    assert.equal(suggestion.status, 200);
    assert.equal(suggestion.body.lineId, null);
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("suggest-subcategory endpoint is disabled when no API key is configured", async () => {
  const server = await startTestServer({ GEMINI_API_KEY: "" });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "no-key-suggest@example.com", password: "No-Key-Suggest-Password-123!", name: "No Key Suggest", householdName: "No Key Suggest Household", country: "US" })
    });
    const cookie = signup.cookie;

    const suggestion = await server.request("/api/transactions/suggest-subcategory", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Sawnee EMC", lines: [{ id: "utilities", label: "Home - Utilities" }] }) });
    assert.equal(suggestion.status, 503);
  } finally {
    await server.stop();
  }
});

test("suggest-subcategory endpoint surfaces an upstream error as a 502", async () => {
  const stub = await startGeminiStub({ status: 500, body: { error: { message: "overloaded" } } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "suggest-upstream-error@example.com", password: "Suggest-Upstream-Error-Password-123!", name: "Suggest Upstream Error", householdName: "Suggest Upstream Error Household", country: "US" })
    });
    const cookie = signup.cookie;

    const suggestion = await server.request("/api/transactions/suggest-subcategory", { method: "POST", headers: { cookie }, body: JSON.stringify({ payee: "Sawnee EMC", lines: [{ id: "utilities", label: "Home - Utilities" }] }) });
    assert.equal(suggestion.status, 502);
  } finally {
    await server.stop();
    await stub.stop();
  }
});
