const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startTestServer } = require("./helpers");
const { parseBatchSuggestions, autoAcceptDecision, matchesRecordedPaycheck, openingShiftForPostedRow, cleanSuggestedTags, refundMatch, adoptRefundMatch, refundMemo } = require("../lib/shared-logic");

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
    { id: "r1", lineId: "groceries", accountId: "checking", confidence: "high", tags: [] },
    { id: "r2", lineId: null, accountId: null, confidence: "low", tags: [] },
    { id: "r3", lineId: "utilities", accountId: null, confidence: "low", tags: [] },
    { id: "r4", lineId: null, accountId: null, confidence: "low", tags: [] }
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
      { id: "r1", lineId: "groceries", accountId: "checking", confidence: "high", tags: [] },
      { id: "r2", lineId: null, accountId: null, confidence: "low", tags: [] }
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

test("suggested tags are kept short, plain, deduplicated and limited to two", () => {
  assert.deepEqual(cleanSuggestedTags(["Subscription", "subscription", "<b>Florida trip</b>", "third"]), ["Subscription", "bFlorida tripb"]);
  assert.deepEqual(cleanSuggestedTags(["  a very long tag that goes on and on and on  "]), ["a very long tag that goe"]);
  assert.deepEqual(cleanSuggestedTags("nope"), []);
  const results = parseBatchSuggestions(JSON.stringify([{ id: "r1", lineId: "groceries", accountId: null, confidence: "high", tags: ["weekly", "costco", "extra"] }]), ["r1"], ["groceries"], []);
  assert.deepEqual(results[0].tags, ["weekly", "costco"]);
});

test("a linked bank feed also posts deposits and payments, but still holds back duplicates of a recorded paycheck", () => {
  const draft = { lineId: "salary", accountId: "checking", lineSource: "ai-high", isDeposit: true, amount: -2500, date: "2026-03-13" };
  const ctx = { accountsExist: true, possibleDuplicate: false, refundMatch: null, transferMatch: null, accountClosedForDate: false };
  assert.equal(autoAcceptDecision(draft, ctx).reason, "payment or deposit");
  assert.equal(autoAcceptDecision(draft, { ...ctx, bankFeed: true }).accept, true);
  assert.equal(autoAcceptDecision({ ...draft, isDeposit: false, isPayment: true }, { ...ctx, bankFeed: true }).accept, true);
  assert.equal(autoAcceptDecision(draft, { ...ctx, bankFeed: true, paycheckMatch: true }).reason, "matches a recorded paycheck");
  assert.equal(autoAcceptDecision({ ...draft, lineSource: "ai-low" }, { ...ctx, bankFeed: true }).uncategorized, true, "an unsure AI guess goes in without its category");
});

test("matchesRecordedPaycheck needs the same account, about the same amount and a nearby payday", () => {
  const occurrences = [{ depositAccountId: "checking", amount: 2500, date: "2026-03-13" }];
  const deposit = { accountId: "checking", amount: -2500, date: "2026-03-14" };
  assert.equal(matchesRecordedPaycheck(deposit, occurrences), true);
  assert.equal(matchesRecordedPaycheck({ ...deposit, amount: -2530 }, occurrences), true);
  assert.equal(matchesRecordedPaycheck({ ...deposit, amount: -2700 }, occurrences), false);
  assert.equal(matchesRecordedPaycheck({ ...deposit, date: "2026-03-25" }, occurrences), false);
  assert.equal(matchesRecordedPaycheck({ ...deposit, accountId: "savings" }, occurrences), false);
  assert.equal(matchesRecordedPaycheck({ ...deposit, amount: 2500 }, occurrences), false);
});

test("posting a linked row hands its amount back through the opening balance so the synced balance holds", () => {
  const checking = { id: "checking", type: "checking", openingBalance: 100 };
  const card = { id: "card", type: "credit_card", openingBalance: 100 };
  // Money out of checking lowers its balance, so the opening balance rises by the same amount; a card purchase raises what is owed.
  assert.equal(openingShiftForPostedRow(checking, { amount: 40 }), 40);
  assert.equal(openingShiftForPostedRow(checking, { amount: -2500 }), -2500);
  assert.equal(openingShiftForPostedRow(card, { amount: 40 }), -40);
});

test("a card return nets against its purchase: same account, same category, posted straight to the ledger", () => {
  const purchase = { id: "t1", payee: "Target", amount: 12, date: "2026-07-01", accountId: "card", lineId: "household" };
  const credit = { payee: "TARGET 1147", amount: -12, date: "2026-07-09", accountId: "card", lineId: "", lineSource: "" };
  const match = refundMatch(credit, [purchase]);
  assert.equal(match, purchase);
  assert.equal(adoptRefundMatch(credit, match), true);
  assert.equal(credit.lineId, "household");
  assert.equal(credit.lineSource, "refund");
  const ctx = { accountsExist: true, possibleDuplicate: false, refundMatch: match, refundMatchPosted: true, transferMatch: null, accountClosedForDate: false, bankFeed: true };
  assert.equal(autoAcceptDecision(credit, ctx).accept, true);
  assert.match(refundMemo(match), /12\.00 purchase on 2026-07-01/);
  // Held for review when the purchase is not in the ledger yet, on another account, filed elsewhere, or from a plain file import.
  assert.equal(autoAcceptDecision(credit, { ...ctx, refundMatchPosted: false }).reason, "refund");
  assert.equal(autoAcceptDecision(credit, { ...ctx, refundMatch: { ...purchase, lineId: "dining" } }).reason, "refund");
  assert.equal(autoAcceptDecision({ ...credit, accountId: "checking" }, ctx).reason, "refund");
  assert.equal(autoAcceptDecision(credit, { ...ctx, bankFeed: false }).reason, "refund");
});

test("a fuzzy refund match never pairs a credit with a purchase on a different account", () => {
  const purchase = { payee: "Target", amount: 12, date: "2026-07-01", accountId: "checking" };
  assert.equal(refundMatch({ payee: "Target", amount: -12, date: "2026-07-09", accountId: "card" }, [purchase]), null);
  assert.equal(refundMatch({ payee: "Target", amount: -12, date: "2026-07-09", accountId: "checking" }, [purchase]), purchase);
  assert.equal(refundMatch({ payee: "Target", amount: -12, date: "2026-07-09" }, [purchase]), purchase, "an unknown account still matches");
});

test("from a bank feed a row with no category (or an unsure AI guess) still goes in, uncategorized; every other hold still applies", () => {
  const ctx = { accountsExist: true, possibleDuplicate: false, refundMatch: null, transferMatch: null, accountClosedForDate: false, bankFeed: true };
  const row = { lineId: "", accountId: "checking", lineSource: "" };
  assert.deepEqual(autoAcceptDecision(row, ctx), { accept: true, reason: "", uncategorized: true });
  assert.deepEqual(autoAcceptDecision({ ...row, lineId: "dining", lineSource: "ai-low" }, ctx), { accept: true, reason: "", uncategorized: true });
  assert.deepEqual(autoAcceptDecision({ ...row, lineId: "dining", lineSource: "ai-high" }, ctx), { accept: true, reason: "" });
  assert.deepEqual(autoAcceptDecision({ ...row, lineId: "dining", lineSource: "" }, ctx), { accept: true, reason: "" });
  assert.equal(autoAcceptDecision({ ...row, accountId: "" }, ctx).reason, "no account");
  assert.equal(autoAcceptDecision(row, { ...ctx, possibleDuplicate: true }).reason, "possible duplicate");
  assert.equal(autoAcceptDecision(row, { ...ctx, transferMatch: {} }).reason, "possible transfer");
  assert.equal(autoAcceptDecision({ ...row, isPending: true }, ctx).reason, "still pending");
  // Without the bank-feed flag the old conservative rules hold.
  assert.equal(autoAcceptDecision(row, { ...ctx, bankFeed: false }).reason, "no category");
  assert.equal(autoAcceptDecision({ ...row, lineId: "dining", lineSource: "ai-low" }, { ...ctx, bankFeed: false }).reason, "low confidence");
});

test("rows with different bank transaction ids are never duplicates of each other; the same id always is; a hand-entered row still can be", () => {
  const { isDuplicateTransaction } = require("../lib/shared-logic");
  const yesterday = { externalId: "sf:a:1", amount: 10, date: "2026-07-09" };
  assert.equal(isDuplicateTransaction({ externalId: "sf:a:2", amount: 10, date: "2026-07-10" }, [yesterday]), false, "two real $10 purchases");
  assert.equal(isDuplicateTransaction({ externalId: "sf:a:1", amount: 10, date: "2026-07-12" }, [yesterday]), true, "same bank id");
  assert.equal(isDuplicateTransaction({ externalId: "sf:a:2", amount: 10, date: "2026-07-10" }, [{ amount: 10, date: "2026-07-10" }]), true, "a hand-entered row with the same amount and date");
});

test("parseHomeBriefing keeps a plain, size-limited summary and rejects anything unusable", () => {
  const { parseHomeBriefing } = require("../lib/shared-logic");
  const reply = "```json\n" + JSON.stringify({ headline: "A <b>busy</b> Tuesday", points: ["One", " ", "Two", "Three", "Four", "Five"], tip: "Pay the electric bill." }) + "\n```";
  assert.deepEqual(parseHomeBriefing(reply), { headline: "A busy Tuesday", points: ["One", "Two", "Three", "Four"], tip: "Pay the electric bill." });
  assert.equal(parseHomeBriefing("not json"), null);
  assert.equal(parseHomeBriefing("[1,2]"), null);
  assert.equal(parseHomeBriefing(JSON.stringify({ headline: "", points: [], tip: "x" })), null);
});

test("home briefing endpoint needs a session and a context, forwards the facts, and returns the cleaned summary", async () => {
  const reply = JSON.stringify({ headline: "You have spent $120.00 of $400.00.", points: ["Groceries is the biggest category."], tip: "Review the 3 waiting rows." });
  const stub = await startGeminiStub({ body: { candidates: [{ content: { parts: [{ text: reply }] } }] } });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    assert.equal((await server.request("/api/home/briefing", { method: "POST", body: JSON.stringify({ context: "x" }) })).status, 401);
    const signup = await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "briefing@example.com", password: "Briefing-Password-123!", name: "B", householdName: "B", country: "US" }) });
    const post = (body) => server.request("/api/home/briefing", { method: "POST", headers: { cookie: signup.cookie }, body: JSON.stringify(body) });
    assert.equal((await post({ context: "" })).status, 400);
    assert.equal((await post({ context: "x".repeat(6001) })).status, 400);
    const ok = await post({ context: "Today is Tuesday.\nBudget: $120.00 spent of $400.00 planned." });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.briefing.headline, "You have spent $120.00 of $400.00.");
    assert.deepEqual(ok.body.briefing.points, ["Groceries is the biggest category."]);
    assert.ok(stub.requests[0].includes("$120.00 spent of $400.00 planned"));
  } finally { await server.stop(); await stub.stop(); }
  const noKey = await startTestServer();
  try {
    const signup = await noKey.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "briefing-nokey@example.com", password: "Briefing-Password-123!", name: "B", householdName: "B", country: "US" }) });
    assert.equal((await noKey.request("/api/home/briefing", { method: "POST", headers: { cookie: signup.cookie }, body: JSON.stringify({ context: "x" }) })).status, 503);
  } finally { await noKey.stop(); }
});
