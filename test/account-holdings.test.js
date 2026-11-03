const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { accountBalance, accountCashBalance, accountNetWorthValue, accountsWithBalances, computeNetWorthAtDate, holdingsGroupTotal, assetClassLabelForHoldings, holdingChipLabel } = require("../lib/shared-logic");
const { applyLinkedPayload } = require("../lib/linked-apply");

const TODAY = "2026-11-02";
const fund = (id, value, extra = {}) => ({ id, name: id, assetClass: "stock", symbol: "", shares: 1, price: value, costBasis: 0, holdingType: "fund", groupId: "g1", groupName: "College 529", ...extra });
// A checking account that pays into a 529 that holds two funds ($584 in all) and has no cash yet.
const baseState = (overrides = {}) => ({
  household: { name: "H", country: "US", currency: "USD", activity: [] },
  budget: { month: "2026-11", income: 0, categories: [{ name: "Food", color: "", lines: [{ id: "groceries", name: "Groceries", planned: 400 }] }] },
  accounts: [
    { id: "chk", name: "Checking", type: "checking", openingBalance: 1000, netWorthAssetId: "nw-chk", netWorthLiabilityId: "" },
    { id: "inv", name: "College 529", type: "investment", openingBalance: 0, netWorthAssetId: "nw-inv", netWorthLiabilityId: "", holdingsGroupId: "g1" }
  ],
  transactions: [], transactionInboxDrafts: [], transactionInboxDone: [], paychecks: [], paycheckOccurrences: [], transfers: [], ious: [],
  goals: { netWorth: { assets: [{ id: "nw-chk", name: "Checking", value: 1000, assetClass: "cash" }, { id: "nw-inv", name: "College 529", value: 0, assetClass: "cash" }, fund("growth", 420), fund("bond", 164)], liabilities: [] }, debts: [], sinkingFunds: [] },
  ...overrides
});
const ctx = (state) => ({ accounts: state.accounts, transactions: state.transactions, paychecks: state.paychecks, paycheckOccurrences: state.paycheckOccurrences, transfers: state.transfers, ious: state.ious, assets: state.goals.netWorth.assets });
const total = (state) => Math.round(accountBalance("inv", ctx(state), TODAY) * 100) / 100;
const netWorth = (state) => Math.round(computeNetWorthAtDate(state, TODAY) * 100) / 100;

test("an account that holds investments is worth its holdings plus its cash", () => {
  const state = baseState();
  assert.equal(holdingsGroupTotal(state.goals.netWorth.assets, "g1"), 584);
  assert.equal(accountCashBalance("inv", ctx(state), TODAY), 0);
  assert.equal(total(state), 584);
  const listed = accountsWithBalances(state, TODAY).find((account) => account.id === "inv");
  assert.deepEqual([listed.balance, listed.cashBalance], [584, 0]);
  // An account without holdings is unchanged, and a card never takes holdings.
  assert.equal(accountBalance("chk", ctx(state), TODAY), 1000);
  const card = baseState({ accounts: [{ id: "inv", name: "Card", type: "credit_card", openingBalance: 50, holdingsGroupId: "g1" }] });
  assert.equal(accountBalance("inv", ctx(card), TODAY), 50);
});

test("net worth counts the holdings once: the account's own line carries only its cash", () => {
  const state = baseState();
  assert.equal(netWorth(state), 1584, "checking $1,000 plus the 529's $584 of holdings");
  state.transfers = [{ id: "t1", date: "2026-11-01", fromAccountId: "chk", toAccountId: "inv", amount: 300, memo: "" }];
  assert.equal(accountNetWorthValue("inv", ctx(state), TODAY), 300, "the account line is the cash only");
  assert.equal(netWorth(state), 1584, "$300 moved from checking into the 529's cash; nothing is counted twice");
});

test("a contribution lands as cash and raises the balance; recording the purchase and buying shares leaves it unchanged", () => {
  const state = baseState({ transfers: [{ id: "t1", date: "2026-11-01", fromAccountId: "chk", toAccountId: "inv", amount: 300, memo: "" }] });
  assert.equal(total(state), 884, "584 held + 300 cash");
  // The purchase is a ledger row on the account (positive = money out) and the fund grows by the same amount.
  state.transactions.push({ id: "buy", date: "2026-11-02", payee: "YOU BOUGHT CONTRIBUTION", amount: 300, accountId: "inv", lineId: "", tags: [], memo: "" });
  state.goals.netWorth.assets.find((item) => item.id === "growth").price = 720;
  assert.equal(accountCashBalance("inv", ctx(state), TODAY), 0);
  assert.equal(total(state), 884, "cash fell by 300 as the fund rose by 300");
});

const link = { id: "L1", label: "My bank", provider: "simplefin", mappings: { A1: { accountId: "inv" } } };
const sync = (state, bankBalance) => applyLinkedPayload(state, link, { provider: "simplefin", accounts: [{ remoteId: "A1", balance: bankBalance }], transactions: [] }, { suggest: null, todayKey: TODAY });

test("a bank sync keeps holdings plus cash equal to the bank's balance without touching the opening balance", async () => {
  const state = baseState({ transfers: [{ id: "t1", date: "2026-11-01", fromAccountId: "chk", toAccountId: "inv", amount: 300, memo: "" }] });
  await sync(state, 884);
  assert.equal(state.goals.netWorth.assets.some((item) => item.linkedTo), false, "already equal, so no adjustment line");
  await sync(state, 1000);
  assert.equal(total(state), 1000, "the gap of 116 is carried by a balance adjustment inside the holdings");
  assert.equal(state.accounts.find((account) => account.id === "inv").openingBalance, 0, "the opening balance (the cash) is not rewritten");
  assert.equal(accountCashBalance("inv", ctx(state), TODAY), 300);
  assert.equal(netWorth(state), 700 + 1000, "net worth follows: checking 700 (after the 300 transfer) plus the 529 at 1,000");
  await sync(state, 1000);
  assert.equal(state.goals.netWorth.assets.filter((item) => item.linkedTo).length, 1, "a second sync does not stack another adjustment");
});

test("when the holdings and cash already exceed the bank's balance the adjustment is removed rather than made negative", async () => {
  const state = baseState();
  await sync(state, 1000);
  assert.equal(state.goals.netWorth.assets.filter((item) => item.linkedTo).length, 1);
  await sync(state, 500);
  assert.equal(state.goals.netWorth.assets.some((item) => item.linkedTo), false);
  assert.equal(total(state), 584, "the listed holdings stand; they are not cut to fit");
});

test("a cash holding counts toward the account's balance, is labelled Cash, and shows a Cash chip", () => {
  const state = baseState();
  state.goals.netWorth.assets.push({ ...fund("mm", 250), name: "College 529 - Cash", holdingType: "cash" });
  assert.equal(total(state), 584 + 250, "it is part of the holdings total, so the balance includes it once");
  const items = state.goals.netWorth.assets.filter((item) => item.groupId === "g1");
  assert.equal(assetClassLabelForHoldings(items), "Mixed");
  assert.equal(assetClassLabelForHoldings([items.find((item) => item.holdingType === "cash")]), "Cash");
  assert.equal(holdingChipLabel(items.find((item) => item.holdingType === "cash")), "Cash");
  assert.equal(holdingChipLabel({ symbol: "VTI", name: "x" }), "VTI");
});

test("Net worth has one Add menu (bank or card, investment account, property or other asset) instead of separate Add account and Add holding buttons", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const menu = app.match(/<details class="add-menu" id="wealthAddMenu">[\s\S]*?<\/details>/);
  assert.ok(menu, "the Add menu is on the Net worth card");
  for (const id of ["addAccountButton", "addInvestmentAccountButton", "addNetWorthItemButton"]) assert.ok(menu[0].includes(`id="${id}"`), `${id} is inside the menu`);
  assert.equal(app.includes("+ Add account</button>"), false);
  assert.equal(app.includes("+ Add holding</button>"), false);
  assert.match(app, /addInvestmentAccountButton"\)\?\.addEventListener\("click", \(\) => addWealthAccount\("investment"\)\)/, "choosing it makes an Investment account");
});

test("Investment accounts are listed under Investments with the holdings card; their account fields fold under Edit account", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /groupAccountsByType\(state\.accounts\.filter\(\(account\) => !isInvestmentAccount\(account\)\)\)/, "the by-type account list leaves them out");
  assert.match(app, /key: "nw-investments"[^\n]*isInvestmentAccount\(account\)[^\n]*investmentAccountCard/, "the Investments group lists them");
  assert.match(app, /function isInvestmentAccount\(account\) \{\s*return account\.type === "investment" \|\| Boolean\(account\.holdingsGroupId\);/);
  const card = app.slice(app.indexOf("function netWorthStockGroupCard"), app.indexOf("const accountTypeColors"));
  for (const part of ["data-drag-account", "data-delete-account", "data-toggle-account-edit", "accountEditGridHtml", "data-untrack-holdings", "data-track-holdings"]) assert.ok(card.includes(part), `${part} is on the shared card`);
});
