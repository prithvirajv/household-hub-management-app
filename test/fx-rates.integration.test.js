const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startTestServer } = require("./helpers");

async function startFxStub(rates) {
  let requestCount = 0;
  const stub = http.createServer((req, res) => {
    requestCount += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ base: "USD", date: "2026-08-10", rates }));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${stub.address().port}`,
    get requestCount() { return requestCount; },
    stop: () => new Promise((resolve) => stub.close(resolve))
  };
}

test("fx-rates endpoint requires a session, returns real fetched rates, and caches them across requests", async () => {
  const stub = await startFxStub({ USD: 1, EUR: 0.92, GBP: 0.79 });
  const server = await startTestServer({ FX_RATES_URL: stub.url });
  try {
    const anonymous = await server.request("/api/fx-rates");
    assert.equal(anonymous.status, 401);

    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "fx-owner@example.com", password: "Fx-Owner-Password-123!", name: "Fx Owner", householdName: "Fx Household", country: "US" })
    });
    const cookie = signup.cookie;

    const first = await server.request("/api/fx-rates", { headers: { cookie } });
    assert.equal(first.status, 200);
    assert.equal(first.body.base, "USD");
    assert.equal(first.body.rates.EUR, 0.92);
    assert.equal(first.body.rates.GBP, 0.79);

    const second = await server.request("/api/fx-rates", { headers: { cookie } });
    assert.equal(second.status, 200);
    assert.equal(second.body.rates.EUR, 0.92);
    assert.equal(stub.requestCount, 1, "the second request should be served from the in-memory cache, not a second upstream fetch");
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("fx-rates endpoint surfaces an upstream failure as a 502 instead of fabricating rates", async () => {
  const brokenStub = http.createServer((req, res) => {
    res.writeHead(500);
    res.end("nope");
  });
  await new Promise((resolve) => brokenStub.listen(0, "127.0.0.1", resolve));
  const server = await startTestServer({ FX_RATES_URL: `http://127.0.0.1:${brokenStub.address().port}` });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "fx-broken-owner@example.com", password: "Fx-Broken-Owner-Password-123!", name: "Fx Broken Owner", householdName: "Fx Broken Household", country: "US" })
    });
    const cookie = signup.cookie;

    const response = await server.request("/api/fx-rates", { headers: { cookie } });
    assert.equal(response.status, 502);
  } finally {
    await server.stop();
    await new Promise((resolve) => brokenStub.close(resolve));
  }
});
