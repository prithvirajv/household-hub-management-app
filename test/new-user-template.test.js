const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer } = require("./helpers");
const { BUILT_IN_RECIPES, sanitizeTemplate, templateFromState, effectiveTemplate, applyTemplate, applyStarterDefaults, describeTemplate } = require("../server/new-user-template");

const emptyState = () => ({ household: { currency: "USD" }, budget: { month: "2026-11", income: 0, categories: [], setupStarted: false }, meals: { recipes: [], plannedWeek: [], savedWeeks: [] } });
const sample = () => ({
  household: { currency: "USD" },
  budget: { month: "2026-11", categories: [{ name: "Housing", color: "#2563eb", lines: [{ id: "rent", name: "Rent", planned: 0, dueDay: 1, assigneeKey: "someone@example.com" }, { id: "util", name: "Utilities", planned: 5 }] }] },
  budgetHistory: [{ month: "2025-01", income: 5000, categories: [{ name: "Housing", lines: [{ id: "rent", planned: 1850 }, { id: "util", planned: 240.5 }, { id: "old-gym", name: "Gym (closed)", planned: 40 }] }, { name: "Fun", color: "#abcdef", lines: [{ id: "games", name: "Games", planned: 25 }] }] }],
  meals: { recipes: [{ name: "My own recipe", ingredients: ["x"] }] }
});

test("a template is the structure with the chosen month's planned amounts: no income, no people, no recipes", () => {
  const { template } = templateFromState(sample(), "2025-01", new Date("2026-11-23T10:00:00Z"));
  assert.equal(template.sourceMonth, "2025-01");
  assert.deepEqual(template.categories, [
    { name: "Housing", color: "#2563eb", lines: [{ id: "rent", name: "Rent", planned: 1850, dueDay: 1 }, { id: "util", name: "Utilities", planned: 240.5 }, { id: "old-gym", name: "Gym (closed)", planned: 40 }] },
    { name: "Fun", color: "#abcdef", lines: [{ id: "games", name: "Games", planned: 25 }] }
  ], "the month as it was (a line since deleted is still there), with names, colours and due days filled in from today's budget where the month did not record them");
  assert.deepEqual(template.recipes, [], "the owner's own recipes are not part of it");
  assert.ok(!JSON.stringify(template).includes("someone@example.com"), "no person-specific field is kept");
  assert.match(templateFromState(sample(), "2024-06").error, /no budget saved for 2024-06/);
  assert.match(templateFromState({ household: {}, budget: { month: "2026-11", categories: [] }, budgetHistory: [] }, "2026-11").error, /no categories/);
});

test("new households always get a budget, recipes, notes, chores and savings goals, with or without a saved template", () => {
  const withBuiltIn = applyTemplate(emptyState(), null, { currency: "USD", now: new Date(2026, 10, 23) });
  assert.ok(withBuiltIn.budget.categories.length >= 5 && withBuiltIn.budget.setupStarted === true);
  assert.ok(withBuiltIn.budget.categories.every((category) => category.lines.every((line) => line.planned === 0)), "the built-in budget leaves amounts to fill in");
  assert.equal(withBuiltIn.meals.recipes.length, BUILT_IN_RECIPES.length);
  assert.ok(withBuiltIn.meals.recipes.every((recipe) => recipe.id && recipe.ingredients.length && recipe.steps.length && recipe.tips.length));
  assert.equal(new Set(withBuiltIn.meals.recipes.map((recipe) => recipe.id)).size, withBuiltIn.meals.recipes.length, "recipe ids are unique");
  assert.equal(withBuiltIn.notes.entries.length, 2);
  assert.ok(withBuiltIn.notes.labels.includes("Groceries"));
  assert.equal(withBuiltIn.calendar.chores.length, 3);
  assert.ok(withBuiltIn.calendar.chores.every((chore) => /^\d{4}-\d{2}-\d{2}$/.test(chore.nextDue) && chore.nextDue >= "2026-11-23"), "chores start on the coming weekday");
  assert.equal(withBuiltIn.goals.sinkingFunds.length, 3);
  assert.deepEqual([withBuiltIn.goals.debts.length, withBuiltIn.goals.netWorth.assets.length, withBuiltIn.calendar.events.length, withBuiltIn.meals.plannedWeek.length], [0, 0, 0, 0], "nothing personal is guessed");

  const { template } = templateFromState(sample(), "2025-01");
  const saved = applyTemplate(emptyState(), template, { currency: "USD" });
  assert.equal(saved.budget.categories[0].lines[0].planned, 1850, "the saved budget's amounts are used");
  assert.equal(saved.meals.recipes.length, BUILT_IN_RECIPES.length, "recipes are the built-in ones whatever is saved");
  const india = applyTemplate(emptyState(), template, { currency: "INR" });
  assert.equal(india.budget.categories[0].lines[0].planned, 0, "amounts in another currency are not carried over");
  assert.equal(india.goals.sinkingFunds[0].target, 80000, "starter savings targets are scaled for the currency");
});

test("a damaged saved template falls back to the built-in budget, and the sanitizer bounds what it keeps", () => {
  const broken = effectiveTemplate({ categories: [{ name: "", lines: [] }, { name: "X", lines: [{ name: "" }] }] });
  assert.ok(broken.categories.length >= 5, "no usable category: the built-in budget is used");
  const clean = sanitizeTemplate({ categories: [{ name: "A", color: "red", lines: [{ name: "Same", planned: "12.345" }, { name: "Same", planned: -4, dueDay: 99 }] }] });
  assert.deepEqual(clean.categories[0].lines.map((line) => [line.id, line.planned, line.dueDay]), [["same", 12.35, undefined], ["same-2", 0, undefined]]);
  assert.equal(clean.categories[0].color, "#64748b", "a bad colour is replaced");
  assert.deepEqual(describeTemplate(null).saved, false);
});

test("applyStarterDefaults can be run on its own and does not touch the budget", () => {
  const state = emptyState();
  state.meals = { recipes: [1], plannedWeek: [{}], savedWeeks: ["x"] };
  applyStarterDefaults(state, { currency: "USD", now: new Date(2026, 10, 23) });
  assert.deepEqual([state.budget.categories.length, state.meals.recipes.length, state.meals.plannedWeek.length], [0, 1, 0]);
});

test("a new account starts with the defaults; an admin can save a month as the template and the next new account gets it", async () => {
  const server = await startTestServer({ ADMIN_EMAIL: "owner@example.com", ADMIN_PASSWORD: "Owner-Password-123!", ADMIN_NAME: "Owner" });
  try {
    const signup = (name) => server.request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: `${name}@example.com`, password: `${name}-Password-123!`, name, householdName: `${name} house`, country: "US" }) });
    const first = await signup("first-user");
    assert.equal(first.status, 201);
    const firstState = (await server.request("/api/state", { headers: { cookie: first.cookie } })).body;
    assert.ok(firstState.budget.categories.length >= 5 && firstState.budget.setupStarted === true, "a budget to start from");
    assert.equal(firstState.meals.recipes.length, BUILT_IN_RECIPES.length);
    assert.equal(firstState.calendar.chores.length, 3);
    assert.equal(firstState.household.members.length, 0, "no demo household members");

    const forbidden = await server.request("/api/admin/new-user-template", { headers: { cookie: first.cookie } });
    assert.equal(forbidden.status, 403, "only the owner can see or change it");
    assert.equal((await server.request("/api/admin/new-user-template", { method: "PUT", headers: { cookie: first.cookie }, body: JSON.stringify({ month: firstState.budget.month }) })).status, 403);

    const admin = await server.request("/api/auth/signin", { method: "POST", body: JSON.stringify({ email: "owner@example.com", password: "Owner-Password-123!" }) });
    assert.equal(admin.status, 200);
    const adminState = (await server.request("/api/state", { headers: { cookie: admin.cookie } })).body;
    adminState.budget.categories = [{ name: "Test category", color: "#123456", lines: [{ id: "test-line", name: "Test line", planned: 321, dueDay: 5 }] }];
    adminState.budget.income = 9999;
    assert.equal((await server.request("/api/state", { method: "PUT", headers: { cookie: admin.cookie }, body: JSON.stringify(adminState) })).status, 200);

    assert.equal((await server.request("/api/admin/new-user-template", { method: "PUT", headers: { cookie: admin.cookie }, body: JSON.stringify({ month: "1999-01" }) })).status, 422, "a month with no budget");
    const saved = await server.request("/api/admin/new-user-template", { method: "PUT", headers: { cookie: admin.cookie }, body: JSON.stringify({ month: adminState.budget.month }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.saved, saved.body.categories, saved.body.lines, saved.body.sourceMonth], [true, 1, 1, adminState.budget.month]);

    const preview = await server.request("/api/admin/new-user-preview?currency=USD", { headers: { cookie: admin.cookie } });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.categories, [{ name: "Test category", color: "#123456", lines: [{ name: "Test line", planned: 321 }] }], "the preview shows the saved budget");
    assert.equal(preview.body.plannedTotal, 321);
    assert.equal(preview.body.recipes.length, BUILT_IN_RECIPES.length);
    assert.deepEqual(preview.body.startsEmpty, { income: true, accounts: true, transactions: true, debts: true });
    assert.equal((await server.request("/api/admin/new-user-preview", { headers: { cookie: first.cookie } })).status, 403, "owner only");

    const second = await signup("second-user");
    const secondState = (await server.request("/api/state", { headers: { cookie: second.cookie } })).body;
    assert.deepEqual(secondState.budget.categories, [{ name: "Test category", color: "#123456", lines: [{ id: "test-line", name: "Test line", planned: 321, dueDay: 5 }] }]);
    assert.equal(secondState.budget.income, 0, "income is never copied");
    assert.equal(secondState.meals.recipes.length, BUILT_IN_RECIPES.length);
    const stillFirst = (await server.request("/api/state", { headers: { cookie: first.cookie } })).body;
    assert.equal(stillFirst.budget.categories.length, firstState.budget.categories.length, "an existing household is not changed");

    const reset = await server.request("/api/admin/new-user-template", { method: "DELETE", headers: { cookie: admin.cookie } });
    assert.equal(reset.body.saved, false);
    const third = await signup("third-user");
    assert.ok((await server.request("/api/state", { headers: { cookie: third.cookie } })).body.budget.categories.length >= 5, "back to the built-in budget");
  } finally { await server.stop(); }
});
