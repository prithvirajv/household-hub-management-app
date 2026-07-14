const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startTestServer } = require("./helpers");

async function startQuoteStub(pricesBySymbol) {
  const stub = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const symbol = url.searchParams.get("symbol");
    const price = pricesBySymbol[symbol];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ c: price ?? 0, h: 0, l: 0, o: 0, pc: 0, t: 0 }));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${stub.address().port}`,
    stop: () => new Promise((resolve) => stub.close(resolve))
  };
}

test("stock quote endpoint returns a live price for a known symbol and requires a session", async () => {
  const stub = await startQuoteStub({ AAPL: 191.23 });
  const server = await startTestServer({ FINNHUB_API_KEY: "test-key", FINNHUB_QUOTE_URL: stub.url });
  try {
    const anonymous = await server.request("/api/stock-quote?symbol=AAPL");
    assert.equal(anonymous.status, 401);

    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "stock-owner@example.com", password: "Stock-Owner-Password-123!", name: "Stock Owner", householdName: "Stock Household", country: "US" })
    });
    const cookie = signup.cookie;

    const quote = await server.request("/api/stock-quote?symbol=aapl", { headers: { cookie } });
    assert.equal(quote.status, 200);
    assert.equal(quote.body.symbol, "AAPL");
    assert.equal(quote.body.price, 191.23);

    const unknown = await server.request("/api/stock-quote?symbol=NOTREAL", { headers: { cookie } });
    assert.equal(unknown.status, 404);

    const missingSymbol = await server.request("/api/stock-quote", { headers: { cookie } });
    assert.equal(missingSymbol.status, 400);
  } finally {
    await server.stop();
    await stub.stop();
  }
});

test("stock quote endpoint is disabled when no API key is configured", async () => {
  const server = await startTestServer({ FINNHUB_API_KEY: "" });
  try {
    const signup = await server.request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "no-key-owner@example.com", password: "No-Key-Owner-Password-123!", name: "No Key Owner", householdName: "No Key Household", country: "US" })
    });
    const cookie = signup.cookie;

    const quote = await server.request("/api/stock-quote?symbol=AAPL", { headers: { cookie } });
    assert.equal(quote.status, 503);
  } finally {
    await server.stop();
  }
});
