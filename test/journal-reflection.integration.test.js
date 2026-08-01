const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startTestServer } = require("./helpers");

async function startAnthropicStub(reply) {
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

test("journal reflection endpoint returns a message for a signed-in user and requires a session", async () => {
  const stub = await startAnthropicStub({ body: { content: [{ type: "text", text: "You showed up for your family today - that counts." }] } });
  const server = await startTestServer({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_API_BASE_URL: stub.url });
  try {
    const anonymous = await server.request("/api/journal/reflection", { method: "POST", body: JSON.stringify({ context: "Completed chores today: Dishes." }) });
    assert.equal(anonymous.status, 401);

    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "reflection-owner@example.com", password: "Reflection-Owner-Password-123!", name: "Reflection Owner", householdName: "Reflection Household", country: "US" })
    });
    const cookie = signup.cookie;

    const missingContext = await server.request("/api/journal/reflection", { method: "POST", headers: { cookie }, body: JSON.stringify({ context: "" }) });
    assert.equal(missingContext.status, 400);

    const tooLong = await server.request("/api/journal/reflection", { method: "POST", headers: { cookie }, body: JSON.stringify({ context: "x".repeat(5000) }) });
    assert.equal(tooLong.status, 400);

    const reflection = await server.request("/api/journal/reflection", { method: "POST", headers: { cookie }, body: JSON.stringify({ context: "Completed chores today: Dishes." }) });
    assert.equal(reflection.status, 200);
    assert.equal(reflection.body.message, "You showed up for your family today - that counts.");
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("journal reflection endpoint is disabled when no API key is configured", async () => {
  const server = await startTestServer({ ANTHROPIC_API_KEY: "" });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "no-key-reflection@example.com", password: "No-Key-Reflection-Password-123!", name: "No Key Reflection", householdName: "No Key Reflection Household", country: "US" })
    });
    const cookie = signup.cookie;

    const reflection = await server.request("/api/journal/reflection", { method: "POST", headers: { cookie }, body: JSON.stringify({ context: "Completed chores today: Dishes." }) });
    assert.equal(reflection.status, 503);
  } finally {
    await server.stop();
  }
});

test("journal reflection endpoint surfaces an upstream error as a 502", async () => {
  const stub = await startAnthropicStub({ status: 500, body: { error: { message: "overloaded" } } });
  const server = await startTestServer({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "upstream-error@example.com", password: "Upstream-Error-Password-123!", name: "Upstream Error", householdName: "Upstream Error Household", country: "US" })
    });
    const cookie = signup.cookie;

    const reflection = await server.request("/api/journal/reflection", { method: "POST", headers: { cookie }, body: JSON.stringify({ context: "Completed chores today: Dishes." }) });
    assert.equal(reflection.status, 502);
  } finally {
    await server.stop();
    await stub.stop();
  }
});
