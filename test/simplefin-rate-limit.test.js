const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { syncSimplefin, mergeStagedPayload } = require("../server/linked-accounts");

const URL_ = "https://u:p@bridge.simplefin.org/simplefin";
const day = 86400;
const start = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
const end = start + 130 * day; // three windows of up to 44 days
const rangeOf = (url) => { const u = new URL(url); return [Number(u.searchParams.get("start-date")), Number(u.searchParams.get("end-date"))]; };
const ok = (accounts) => ({ ok: true, status: 200, json: async () => ({ errors: [], accounts }) });
const accountFor = (from) => ({ id: "A1", name: "Checking", org: { name: "B" }, currency: "USD", balance: "10", "balance-date": from + day, transactions: [{ id: `t-${from}`, posted: from + day, amount: "-1", description: "X" }] });

// The quota runs out on the second request.
const limitedAfterOne = (status = 429, body = {}) => {
  const calls = [];
  const fetchImpl = async (url) => {
    const [from] = rangeOf(url);
    calls.push(from);
    if (calls.length === 1) return ok([accountFor(from)]);
    return { ok: false, status, json: async () => ({}), text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
};

test("when the daily limit runs out part-way, what was fetched is kept and the run says where it got to, with no retries or splitting", async () => {
  const { fetchImpl, calls } = limitedAfterOne(429);
  const result = await syncSimplefin(URL_, { startUnix: start, endUnix: end, allowPartial: false }, { fetchImpl });
  assert.equal(calls.length, 2, "one window fetched, one refused, nothing more asked");
  assert.equal(result.transactions.length, 1, "the first window's rows are kept");
  assert.equal(result.limit.throughUnix, calls[1], "the next run starts at the window that was refused");
});

test("a 403 that talks about a limit is the quota, never 'remove the connection'; a plain 403 still is", async () => {
  const { fetchImpl } = limitedAfterOne(403, { error: "Too many requests today" });
  const result = await syncSimplefin(URL_, { startUnix: start, endUnix: end, allowPartial: false }, { fetchImpl });
  assert.ok(result.limit);
  await assert.rejects(() => syncSimplefin(URL_, { startUnix: start, endUnix: start + 10 * day, allowPartial: false }, { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "Forbidden" }) }), (error) => error.statusCode === 409 && /remove it and link again/.test(error.message));
});

test("an empty answer whose only message is about a limit counts too, and a limit before anything was fetched is one clear error", async () => {
  let n = 0;
  const emptyLimit = async (url) => (++n === 1 ? ok([accountFor(rangeOf(url)[0])]) : { ok: true, status: 200, json: async () => ({ errors: ["Daily request limit exceeded"], accounts: [] }) });
  const result = await syncSimplefin(URL_, { startUnix: start, endUnix: end, allowPartial: false }, { fetchImpl: emptyLimit });
  assert.ok(result.limit && result.transactions.length === 1);
  await assert.rejects(() => syncSimplefin(URL_, { startUnix: start, endUnix: end, allowPartial: false }, { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) }), (error) => error.rateLimited === true && /daily request limit/.test(error.message));
});

test("a history import that hits the limit reports the rest as a gap instead of splitting it into more requests", async () => {
  const { fetchImpl, calls } = limitedAfterOne(429);
  const result = await syncSimplefin(URL_, { startUnix: start, endUnix: end, allowPartial: true }, { fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(result.failedWindows.length, 1);
  assert.match(result.failedWindows[0].error, /daily request limit/);
});

test("the staged data counts as synced only up to where the fetch got, so the next run resumes there", () => {
  const through = "2026-02-14T00:00:00.000Z";
  const { merged } = mergeStagedPayload({}, { provider: "simplefin", accounts: [], transactions: [], limitHit: true, fetchedThrough: through }, "2026-11-25T03:30:00.000Z");
  assert.equal(merged.fullAt, through);
  assert.equal(merged.limitHit, true);
  const full = mergeStagedPayload({}, { provider: "simplefin", accounts: [], transactions: [] }, "2026-11-25T03:30:00.000Z").merged;
  assert.equal(full.fullAt, "2026-11-25T03:30:00.000Z", "a complete fetch is unchanged");
});

test("the nightly job records a limited run, moves lastSyncAt only to where it got, and is retried; Home says so plainly", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server", "linked-accounts.js"), "utf8");
  assert.match(server, /limited: \{ through: payload\.fetchedThrough \}/);
  assert.match(server, /!link\.lastRun\.limited && link\.lastRun\.at/, "the retry job does not treat a limited run as fresh");
  assert.match(server, /finished\.limited \? \(new Date\(finished\.limited\.through\) > new Date\(link\.lastSyncAt \|\| 0\)/);
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.ok(app.includes("else if (run.limited)") && app.includes("payload.limitHit"));
});

test("a refusal is logged with its status and the start of its reply, never a link", async () => {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    await assert.rejects(() => syncSimplefin(URL_, { startUnix: start, endUnix: start + 10 * day, allowPartial: false }, { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "Forbidden. See https://u:secret@bridge.simplefin.org/simplefin for details" }) }), /remove it and link again/);
    await assert.rejects(() => syncSimplefin(URL_, { startUnix: start, endUnix: start + 10 * day, allowPartial: false }, { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "Too many requests" }) }), /daily request limit/);
  } finally { console.warn = original; }
  const refusals = lines.filter((line) => line.startsWith("SimpleFIN refused a request"));
  assert.equal(refusals.length, 2);
  assert.match(refusals[0], /HTTP 403 Forbidden\. See <link> for details/);
  assert.ok(!refusals.join(" ").includes("secret"), "no credentials in the log");
  assert.match(refusals[1], /HTTP 429 Too many requests/);
});
