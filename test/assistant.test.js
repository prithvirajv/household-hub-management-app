const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startTestServer } = require("./helpers");
const { assistantContext, assistantFacts, monthSpendingSummary, parseAssistantPlan, assistantActionProblem, describeAssistantAction, applyAssistantActions, lookupCategorizationRule } = require("../lib/shared-logic");

const TODAY = "2026-10-29";
const money = (value) => `$${Number(value).toFixed(2)}`;
const household = () => ({
  household: { name: "H", country: "US", currency: "USD", activity: [] },
  budget: { month: "2026-10", income: 0, categories: [{ name: "Food", color: "", lines: [{ id: "groceries", name: "Groceries", planned: 400 }, { id: "dining", name: "Dining", planned: 100 }] }] },
  accounts: [{ id: "chk", name: "Checking", type: "checking", openingBalance: 0 }, { id: "sav", name: "Savings", type: "savings", openingBalance: 0 }],
  transactions: [{ accountId: "sav", date: "2026-10-20", payee: "X", amount: 5 }],
  goals: { netWorth: { assets: [
    { id: "m1-a", name: "VTI", assetClass: "stock", shares: 10, price: 200, groupId: "m1", groupName: "Sample M1" },
    { id: "m1-b", name: "VXUS", assetClass: "stock", shares: 5, price: 60, groupId: "m1", groupName: "Sample M1" },
    { id: "fid-a", name: "FXAIX", assetClass: "stock", shares: 2, price: 100, groupId: "fid", groupName: "Sample Fidelity" },
    { id: "cash-1", name: "Cash", assetClass: "cash", value: 500 }
  ], liabilities: [] }, debts: [], sinkingFunds: [] }
});

test("the AI's plan keeps only whole, known actions whose ids really exist", () => {
  const context = assistantContext(household());
  assert.deepEqual(context.groups.map((g) => [g.groupId, g.holdings]), [["m1", 2], ["fid", 1]]);
  const reply = "```json\n" + JSON.stringify({ say: "M1 moved to Fidelity.", actions: [
    { type: "merge_holdings_group", fromGroupId: "m1", intoGroupId: "fid" },
    { type: "merge_holdings_group", fromGroupId: "m1", intoGroupId: "made-up" },
    { type: "delete_everything" },
    { type: "close_account", accountId: "sav", closedAt: "2026-10-28" },
    { type: "close_account", accountId: "" },
    { type: "set_payee_category", payee: "Sample Store", lineId: "groceries" },
    { type: "set_payee_category", payee: "Sample Store", lineId: "nope" }
  ] }) + "\n```";
  const plan = parseAssistantPlan(reply, context);
  assert.deepEqual(plan.actions.map((a) => a.type), ["merge_holdings_group", "close_account", "set_payee_category"]);
  assert.equal(plan.say, "M1 moved to Fidelity.");
  assert.equal(parseAssistantPlan("not json", context), null);
  assert.deepEqual(parseAssistantPlan(JSON.stringify({ say: "Which one?", clarify: "Two groups match", actions: [] }), context).clarify, "Two groups match");
});

test("the confirmation is written from the household's own data and says what happens", () => {
  const state = household();
  assert.match(describeAssistantAction({ type: "merge_holdings_group", fromGroupId: "m1", intoGroupId: "fid" }, state, money, TODAY), /Move all 2 holdings \(about \$2300\.00\) from "Sample M1" into "Sample Fidelity".*net worth stays the same/);
  assert.match(describeAssistantAction({ type: "close_account", accountId: "sav", closedAt: "2026-10-01" }, state, money, TODAY), /Mark "Savings" closed as of 2026-10-01.*1 existing transaction is dated after it/);
  assert.match(describeAssistantAction({ type: "set_payee_category", payee: "Sample Store", lineId: "groceries" }, state, money, TODAY), /file "Sample Store" under Food - Groceries/);
});

test("actions that cannot run are reported, not applied: same group, closed account, future date, duplicate name, gone ids", () => {
  const state = household();
  assert.equal(assistantActionProblem({ type: "merge_holdings_group", fromGroupId: "m1", intoGroupId: "m1" }, state, TODAY), "Those are the same group.");
  assert.match(assistantActionProblem({ type: "close_account", accountId: "chk", closedAt: "2026-12-01" }, state, TODAY), /future/);
  assert.match(assistantActionProblem({ type: "rename_account", accountId: "chk", name: "savings" }, state, TODAY), /already called/);
  assert.match(assistantActionProblem({ type: "close_account", accountId: "gone" }, state, TODAY), /no longer exists/);
  const closed = { ...state, accounts: state.accounts.map((a) => (a.id === "sav" ? { ...a, closedAt: "2026-10-01" } : a)) };
  assert.match(assistantActionProblem({ type: "close_account", accountId: "sav" }, closed, TODAY), /already closed/);
});

test("confirmed actions change only what they name, never mutate the input, and Undo restores exactly what changed", () => {
  const state = household();
  const before = JSON.stringify(state);
  const result = applyAssistantActions(state, [
    { type: "merge_holdings_group", fromGroupId: "m1", intoGroupId: "fid" },
    { type: "close_account", accountId: "sav" },
    { type: "rename_account", accountId: "chk", name: "Everyday" },
    { type: "set_payee_category", payee: "Sample Store*A1", lineId: "groceries" },
    { type: "close_account", accountId: "gone" }
  ], TODAY);
  assert.equal(JSON.stringify(state), before, "the input is untouched");
  assert.equal(result.applied.length, 4);
  assert.deepEqual(result.skipped.map((s) => s.action.accountId), ["gone"]);
  const next = { ...state, ...result.patch };
  assert.deepEqual(next.goals.netWorth.assets.filter((a) => a.groupId === "fid").map((a) => a.id).sort(), ["fid-a", "m1-a", "m1-b"]);
  assert.equal(next.goals.netWorth.assets.find((a) => a.id === "m1-a").groupName, "Sample Fidelity");
  assert.equal(next.goals.netWorth.assets.find((a) => a.id === "cash-1").groupId, undefined, "assets outside the group are untouched");
  assert.deepEqual([next.accounts.find((a) => a.id === "sav").closedAt, next.accounts.find((a) => a.id === "chk").name], [TODAY, "Everyday"]);
  assert.equal(lookupCategorizationRule(next.transactionCategorizationRules, "Sample Store*Z9"), "groceries");
  assert.deepEqual(Object.keys(result.undo).sort(), Object.keys(result.patch).sort());
  const restored = { ...next, ...result.undo };
  assert.deepEqual(restored.goals, state.goals);
  assert.deepEqual(restored.accounts, state.accounts);
});

async function startGeminiStub(reply) {
  const requests = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { requests.push(body); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(reply)); });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${stub.address().port}`, requests, stop: () => new Promise((resolve) => stub.close(resolve)) };
}

test("the plan endpoint needs a session, a request and a context, sends only the id summary, and returns the validated plan", async () => {
  const context = assistantContext(household());
  const reply = JSON.stringify({ say: "Moving M1 into Fidelity.", actions: [{ type: "merge_holdings_group", fromGroupId: "m1", intoGroupId: "fid" }, { type: "merge_holdings_group", fromGroupId: "m1", intoGroupId: "invented" }] });
  const stub = await startGeminiStub({ candidates: [{ content: { parts: [{ text: reply }] } }] });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    assert.equal((await server.request("/api/assistant/plan", { method: "POST", body: JSON.stringify({ request: "x", context }) })).status, 401);
    const signup = await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "assistant@example.com", password: "Assistant-Password-123!", name: "A", householdName: "A", country: "US" }) });
    const post = (body) => server.request("/api/assistant/plan", { method: "POST", headers: { cookie: signup.cookie }, body: JSON.stringify(body) });
    assert.equal((await post({ request: "", context })).status, 400);
    assert.equal((await post({ request: "x".repeat(501), context })).status, 400);
    assert.equal((await post({ request: "x" })).status, 400);
    const ok = await post({ request: "my M1 account is closed and moved to Fidelity", context });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.actions, [{ type: "merge_holdings_group", fromGroupId: "m1", intoGroupId: "fid" }], "an id the AI invented is dropped");
    assert.ok(stub.requests[0].includes("my M1 account is closed and moved to Fidelity"));
    assert.ok(stub.requests[0].includes("never delete anything"), "the AI is told it cannot delete");
  } finally { await server.stop(); await stub.stop(); }
  const noKey = await startTestServer();
  try {
    const signup = await noKey.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "assistant-nokey@example.com", password: "Assistant-Password-123!", name: "A", householdName: "A", country: "US" }) });
    assert.equal((await noKey.request("/api/assistant/plan", { method: "POST", headers: { cookie: signup.cookie }, body: JSON.stringify({ request: "x", context }) })).status, 503);
  } finally { await noKey.stop(); }
});

test("the facts the assistant answers from are a compact read of the household's own tables: net worth, holdings groups, liabilities, accounts and the budget", () => {
  const state = household();
  state.goals.netWorth.liabilities = [{ id: "loan", name: "Sample Loan", value: 1000 }];
  state.goals.debts = [{ name: "Sample Loan", balance: 1000, rate: 5, minimum: 50 }];
  state.transactions = [{ accountId: "chk", date: "2026-10-05", payee: "X", amount: 40, lineId: "groceries" }, { accountId: "chk", date: "2026-10-06", payee: "Y", amount: 10, lineId: "" }];
  state.transactionInboxDrafts = [{ id: "d" }];
  const text = assistantFacts(state, TODAY, money);
  assert.match(text, /NET WORTH: \$2000\.00 \(assets \$3000\.00 minus liabilities \$1000\.00\)/);
  assert.match(text, /Sample M1: 2 holdings, \$2300\.00/);
  assert.match(text, /Sample Fidelity: 1 holding, \$200\.00/);
  assert.match(text, /Cash \(cash\): \$500\.00/);
  assert.match(text, /Sample Loan: \$1000\.00/);
  assert.match(text, /BUDGET 2026-10: income \$0\.00, planned \$500\.00, SPENT \$50\.00 \(\$40\.00 on budget lines \+ \$10\.00 of expenses with no category yet; \$0\.00 of money-in rows/);
  assert.match(text, /Food: planned \$500\.00, spent \$40\.00/);
  assert.match(text, /WAITING: 1 bank row in Bank stream; 1 ledger transaction without a category\./);
  assert.ok(text.length < 9000);
  assert.equal(assistantFacts({ ...state, goals: undefined, accounts: [] }, TODAY, money).includes("NET WORTH: $0.00"), true, "a household with nothing yet still reads cleanly");
});

test("a question is answered from the facts the client sent, and the answer comes back with no actions", async () => {
  const reply = JSON.stringify({ say: "Here is your wealth.", answer: "- Net worth: $2000.00\n- Investments: $2500.00", actions: [] });
  const stub = await startGeminiStub({ candidates: [{ content: { parts: [{ text: reply }] } }] });
  const server = await startTestServer({ GEMINI_API_KEY: "test-key", GEMINI_API_BASE_URL: stub.url });
  try {
    const signup = await server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "assistant-q@example.com", password: "Assistant-Password-123!", name: "A", householdName: "A", country: "US" }) });
    const post = (body) => server.request("/api/assistant/plan", { method: "POST", headers: { cookie: signup.cookie }, body: JSON.stringify(body) });
    const context = assistantContext(household());
    const facts = assistantFacts(household(), TODAY, money);
    const ok = await post({ request: "summarize my wealth", context, facts });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.answer, "- Net worth: $2000.00\n- Investments: $2500.00");
    assert.deepEqual(ok.body.actions, []);
    assert.ok(stub.requests[0].includes("FACTS") && stub.requests[0].includes("Sample M1: 2 holdings"), "the household's numbers are sent with the question");
    assert.ok(stub.requests[0].includes("Use ONLY the FACTS"), "the AI is told to answer only from them");
    assert.equal((await post({ request: "x", context, facts: "y".repeat(12001) })).status, 400);
  } finally { await server.stop(); await stub.stop(); }
});

test("spent this month counts spending on budget lines plus uncategorized expenses, and money coming in never reduces it", () => {
  const categories = [{ name: "Food", lines: [{ id: "groceries" }, { id: "dining" }] }];
  const rows = [
    { date: "2026-10-03", amount: 130, lineId: "groceries" },
    { date: "2026-10-04", amount: 20, lineId: "dining" },
    { date: "2026-10-05", amount: 15, lineId: "" },
    { date: "2026-10-06", amount: -4000, lineId: "" },
    { date: "2026-10-07", amount: -300, lineId: "" },
    { date: "2026-10-08", amount: -10, lineId: "groceries" },
    { date: "2026-10-09", amount: 100, splits: [{ lineId: "groceries", amount: 60 }, { lineId: "dining", amount: 40 }] },
    { date: "2026-09-30", amount: 999, lineId: "groceries" }
  ];
  const result = monthSpendingSummary(rows, categories, "2026-10");
  assert.deepEqual([result.onLines, result.uncategorizedOut, result.total, result.moneyInNotCounted], [240, 15, 255, 4300], "a refund on a line nets against it; a card payment or deposit with no line is reported but not counted; splits count by line; other months are ignored");
});

test("Budget and Reports use the same spent definition as Home, and the Bank stream icon buttons explain themselves on hover", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "app.js"), "utf8");
  assert.match(source, /function spentTotal\(\) \{\s*return monthSpendingSummary\(state\.transactions, state\.budget\.categories, state\.budget\.month\)\.total;/);
  ["data-accept-import", "data-assign-iou", "data-move-to-transfer", "data-dismiss-import"].forEach((attribute) => {
    const button = source.split("\n").find((line) => line.includes(`${attribute}="\${transaction.id}"`) && line.includes("<button"));
    assert.ok(button && /title="/.test(button), `${attribute} button has a hover title`);
  });
  assert.ok(source.includes('"button[aria-label]:not([title])"'), "labelled buttons without a title get one on hover");
});
