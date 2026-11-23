// The starting point of every NEW household: a budget (categories and subcategories, with planned amounts when the currency matches) and a set of
// recipes, so a new person never lands on an empty app. The budget comes from one month the owner saves as the template on the Admin page (their January
// 2025); until they do, a built-in starter budget is used. The recipes are always the built-in defaults here, never anyone's own. Existing households are never touched: the template is applied only when a household is created.
// Everything here is pure (no database), so it can be tested directly; server/index.js stores and loads the saved template.

const MAX_CATEGORIES = 40;
const MAX_LINES_PER_CATEGORY = 60;
const MAX_RECIPES = 60;

const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const money = (value) => { const number = Math.round(Number(value) * 100) / 100; return Number.isFinite(number) && number > 0 && number < 1e9 ? number : 0; };
const slug = (text) => clean(text, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";

// The recipes a new household starts with when the owner has not saved their own: plain, familiar dishes with ingredients, steps and a tip or two.
const BUILT_IN_RECIPES = [
  { name: "Dal tadka", calories: 320, protein: 16, ingredients: ["1 cup toor dal", "3 cups water", "1/2 tsp turmeric powder", "1 tsp salt", "1 tbsp ghee", "1 tsp cumin seeds", "3 cloves garlic - chopped", "2 dried red chillies", "1 tomato - chopped", "coriander leaves"],
    steps: ["Rinse the dal and pressure cook with water, turmeric and salt until soft.", "Mash lightly and add water if it is too thick.", "Heat ghee, crackle the cumin, then fry the garlic and chillies.", "Add the tomato and cook until soft, then pour the tadka over the dal.", "Simmer for 3 minutes and finish with coriander."],
    tips: ["Soak the dal for 20 minutes to cook it faster.", "Add the tadka last so the aroma stays strong."] },
  { name: "Vegetable fried rice", calories: 420, protein: 11, ingredients: ["2 cups cooked rice - cold", "1 cup mixed vegetables - chopped", "2 eggs", "2 tbsp soy sauce", "1 tbsp oil", "2 spring onions", "1/2 tsp pepper", "2 cloves garlic - chopped"],
    steps: ["Heat the oil on high and fry the garlic for 10 seconds.", "Add the vegetables and stir-fry for 3 minutes.", "Push to one side, scramble the eggs, then mix everything together.", "Add the cold rice, soy sauce and pepper and toss for 3 minutes.", "Top with spring onions."],
    tips: ["Day-old rice fries better than fresh rice.", "Keep the heat high so the rice does not turn mushy."] },
  { name: "Pasta aglio e olio", calories: 480, protein: 13, ingredients: ["200 g spaghetti", "4 cloves garlic - sliced", "4 tbsp olive oil", "1/2 tsp chilli flakes", "parsley - chopped", "salt", "1/2 cup pasta water"],
    steps: ["Boil the spaghetti in well-salted water until just firm and keep a cup of the water.", "Warm the olive oil on low heat and cook the garlic until pale gold.", "Add the chilli flakes, then the pasta and a splash of pasta water.", "Toss until glossy and finish with parsley."],
    tips: ["Do not let the garlic brown or it turns bitter.", "The starchy pasta water is what makes the sauce cling."] },
  { name: "Chicken curry", calories: 520, protein: 38, ingredients: ["500 g chicken pieces", "2 onions - sliced", "2 tomatoes - chopped", "1 tbsp ginger garlic paste", "1 tsp turmeric powder", "2 tsp coriander powder", "1 tsp red chilli powder", "1 tsp garam masala", "3 tbsp oil", "salt", "coriander leaves"],
    steps: ["Fry the onions in oil until golden.", "Add the ginger garlic paste and cook for a minute.", "Add the tomatoes and the spice powders and cook until the oil separates.", "Add the chicken and salt, cover and cook on low for 25 minutes, stirring now and then.", "Finish with garam masala and coriander."],
    tips: ["Brown the onions well; they give the curry its colour and sweetness.", "Add a little hot water only if the masala starts to stick."] },
  { name: "Scrambled eggs on toast", calories: 340, protein: 20, ingredients: ["3 eggs", "2 slices bread", "1 tbsp butter", "2 tbsp milk", "salt", "black pepper"],
    steps: ["Whisk the eggs with milk, salt and pepper.", "Melt the butter on low heat and add the eggs.", "Stir gently until just set and still creamy.", "Serve on toasted bread."],
    tips: ["Take the pan off the heat while the eggs still look slightly wet; they finish cooking on the plate."] },
  { name: "Overnight oats", calories: 360, protein: 14, ingredients: ["1/2 cup rolled oats", "1/2 cup milk", "1/4 cup yogurt", "1 tbsp honey", "1 tbsp chia seeds", "1/2 cup chopped fruit"],
    steps: ["Mix the oats, milk, yogurt, honey and chia in a jar.", "Cover and chill overnight.", "Top with fruit in the morning."],
    tips: ["Keeps for 3 days in the fridge."] }
];

// The budget categories a new household starts with when the owner has not saved their own: names and colours only, amounts left for the person to fill in.
const BUILT_IN_CATEGORIES = [
  { name: "Giving", color: "#d7961f", lines: ["Charity"] },
  { name: "Housing", color: "#2563eb", lines: ["Rent or mortgage", "Utilities", "Internet", "Home maintenance"] },
  { name: "Food", color: "#16a34a", lines: ["Groceries", "Restaurants"] },
  { name: "Transportation", color: "#ef4444", lines: ["Fuel", "Car insurance", "Auto maintenance"] },
  { name: "Health", color: "#0d9488", lines: ["Medical", "Pharmacy"] },
  { name: "Personal", color: "#8b5cf6", lines: ["Clothing", "Subscriptions", "Fun money"] },
  { name: "Savings and debt", color: "#7c8b2e", lines: ["Emergency fund", "Debt payments"] }
];

// What a saved template may contain: names, colours, due days and planned amounts; no ids of people or accounts, no transactions, no income.
function sanitizeTemplate(input) {
  const categories = (Array.isArray(input?.categories) ? input.categories : []).slice(0, MAX_CATEGORIES).map((category) => {
    const used = new Set();
    const lines = (Array.isArray(category?.lines) ? category.lines : []).slice(0, MAX_LINES_PER_CATEGORY).map((line) => {
      const name = clean(line?.name, 80);
      if (!name) return null;
      let id = clean(line?.id, 60) || slug(name);
      while (used.has(id)) id = `${id}-2`;
      used.add(id);
      const dueDay = Math.round(Number(line?.dueDay));
      return { id, name, planned: money(line?.planned), ...(dueDay >= 1 && dueDay <= 31 ? { dueDay } : {}), ...(line?.rolloverEnabled ? { rolloverEnabled: true } : {}) };
    }).filter(Boolean);
    const name = clean(category?.name, 80);
    return name && lines.length ? { name, color: /^#[0-9a-f]{6}$/i.test(String(category?.color || "")) ? category.color : "#64748b", lines } : null;
  }).filter(Boolean);
  const recipes = (Array.isArray(input?.recipes) ? input.recipes : []).slice(0, MAX_RECIPES).map((recipe) => {
    const name = clean(recipe?.name, 120);
    const ingredients = (Array.isArray(recipe?.ingredients) ? recipe.ingredients : []).map((item) => clean(item, 140)).filter(Boolean).slice(0, 80);
    if (!name || !ingredients.length) return null;
    const steps = (Array.isArray(recipe?.steps) ? recipe.steps : []).map((item) => clean(item, 600)).filter(Boolean).slice(0, 60);
    const tips = (Array.isArray(recipe?.tips) ? recipe.tips : []).map((tip) => ({ text: clean(tip?.text ?? tip, 400), important: Boolean(tip?.important ?? true) })).filter((tip) => tip.text).slice(0, 30);
    const sourceUrl = /^https:\/\//i.test(String(recipe?.sourceUrl || "")) ? String(recipe.sourceUrl).slice(0, 500) : "";
    return { name, ingredients, steps, tips, calories: Math.max(0, Math.round(Number(recipe?.calories) || 0)), protein: Math.max(0, Math.round(Number(recipe?.protein) || 0)), ...(sourceUrl ? { sourceUrl } : {}) };
  }).filter(Boolean);
  return {
    version: 1,
    sourceMonth: /^\d{4}-\d{2}$/.test(String(input?.sourceMonth || "")) ? input.sourceMonth : "",
    currency: /^[A-Z]{3}$/.test(String(input?.currency || "")) ? input.currency : "USD",
    savedAt: input?.savedAt || "",
    categories,
    recipes
  };
}

// The budget template built from a household's saved state: its category structure with the planned amounts of `month` (its snapshot in budgetHistory, or
// the live budget when `month` is the month being viewed). Only the budget is saved: no recipes, income or anything personal. Returns { error } when that
// month has no plan.
function templateFromState(state, month, now = new Date()) {
  const snapshot = (state?.budgetHistory || []).find((item) => item.month === month);
  const live = state?.budget?.month === month;
  if (!snapshot && !live) return { error: `There is no budget saved for ${month}. Open that month in Budget once, then try again.` };
  // The budget as that month had it: its own saved categories and lines (or the live budget when it is the month being viewed). Anything a saved month
  // does not record (a colour, a due day, a name) is filled in from the household's current budget by category name or line id.
  const current = state.budget?.categories || [];
  const currentCategory = (name) => current.find((category) => category.name === name);
  const currentLine = (id) => current.flatMap((category) => category.lines || []).find((line) => line.id === id);
  const source = snapshot?.categories?.length ? snapshot.categories : current;
  const categories = source.map((category) => ({
    ...category,
    color: category.color || currentCategory(category.name)?.color,
    lines: (category.lines || []).map((line) => ({ ...currentLine(line.id), ...line }))
  }));
  const template = sanitizeTemplate({ sourceMonth: month, currency: state.household?.currency || "USD", savedAt: now.toISOString(), categories });
  template.recipes = [];
  if (!template.categories.length) return { error: "That month has no categories to save as a template." };
  return { template };
}

// The template new households use: the saved budget (or the built-in starter budget when none is saved) and always the built-in recipes ("always have defaults").
function effectiveTemplate(saved) {
  const base = saved ? sanitizeTemplate(saved) : null;
  const builtInCategories = sanitizeTemplate({ categories: BUILT_IN_CATEGORIES.map((category) => ({ ...category, lines: category.lines.map((name) => ({ name, planned: 0 })) })) }).categories;
  const builtInRecipes = sanitizeTemplate({ recipes: BUILT_IN_RECIPES }).recipes;
  return {
    sourceMonth: base?.sourceMonth || "",
    currency: base?.currency || "USD",
    categories: base?.categories.length ? base.categories : builtInCategories,
    recipes: builtInRecipes,
    saved: Boolean(base && base.categories.length)
  };
}

// Rough size of the starter savings targets in other currencies (the numbers are written for dollars); anything not listed is used as it is.
const CURRENCY_SCALE = { INR: 80, JPY: 150, KRW: 1300, MXN: 18, PHP: 55, THB: 35, ZAR: 18, BRL: 5, SEK: 10, NOK: 10, DKK: 7, CZK: 23, HUF: 350 };

const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
// The next given weekday (0 = Sunday) on or after `from`.
function nextWeekday(from, weekday) {
  const date = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  date.setDate(date.getDate() + ((weekday - date.getDay() + 7) % 7));
  return dateKey(date);
}

// Reasonable starting points for everything that is not the budget or the recipes: note labels and a short getting-started checklist, three weekly
// chores, three savings goals, and the usual meal targets. Nothing personal is guessed: no accounts, debts, income, birthdays, events or planned meals.
function applyStarterDefaults(state, { currency = "USD", now = new Date() } = {}) {
  state.notes = {
    initialized: true,
    activeView: "notes",
    activeLabel: "",
    labels: ["Groceries", "To-do", "Ideas", "Birthday"],
    entries: [
      { id: "getting-started", title: "Getting started", body: "", checklist: [
        { id: "start-1", text: "Enter your income and adjust the budget amounts", done: false },
        { id: "start-2", text: "Add your bank or card accounts in Wealth", done: false },
        { id: "start-3", text: "Invite your household in Sharing", done: false },
        { id: "start-4", text: "Pick a recipe and plan this week's meals", done: false }
      ], labels: ["To-do"], pinned: true, archived: false, trashed: false, color: "#fff7d6", createdAt: now.toISOString() },
      { id: "grocery-list", title: "Grocery list", body: "", checklist: [], labels: ["Groceries"], pinned: false, archived: false, trashed: false, color: "#ffffff", createdAt: now.toISOString() }
    ]
  };
  state.calendar = {
    events: [],
    chores: [
      { title: "Clean kitchen", assignee: "Rotation", cadence: "Weekly", recurrence: "weekly", startDate: nextWeekday(now, 6), nextDue: nextWeekday(now, 6), completedDates: [] },
      { title: "Take out trash", assignee: "Rotation", cadence: "Weekly", recurrence: "weekly", startDate: nextWeekday(now, 4), nextDue: nextWeekday(now, 4), completedDates: [] },
      { title: "Laundry", assignee: "Rotation", cadence: "Weekly", recurrence: "weekly", startDate: nextWeekday(now, 0), nextDue: nextWeekday(now, 0), completedDates: [] }
    ]
  };
  const scale = CURRENCY_SCALE[currency] || 1;
  const yearOut = dateKey(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()));
  state.goals = {
    sinkingFunds: [
      { name: "Emergency fund", target: 1000 * scale, saved: 0, targetDate: yearOut },
      { name: "Vacation fund", target: 1500 * scale, saved: 0, targetDate: yearOut },
      { name: "Car and home repairs", target: 1000 * scale, saved: 0, targetDate: yearOut }
    ],
    debts: [],
    debtNetWorthLinked: true,
    netWorth: { assets: [], liabilities: [] }
  };
  state.meals.nutritionGoals = { calories: 2100, protein: 140 };
  state.meals.plannedWeek = [];
  state.meals.savedWeeks = [];
  return state;
}

// Puts the template into a freshly created household state (mutates it): categories and subcategories for the current month (planned amounts only when the
// household's currency is the template's, since amounts in another currency would mean nothing), the recipes with ids of their own, and the budget marked
// as started so the person sees a working plan instead of an empty page. Income, accounts, transactions and everything personal stay empty.
function applyTemplate(state, saved, { currency = "USD", now = new Date() } = {}) {
  const template = effectiveTemplate(saved);
  const keepAmounts = currency === template.currency;
  state.budget.categories = template.categories.map((category) => ({
    name: category.name,
    color: category.color,
    lines: category.lines.map((line) => ({ ...line, planned: keepAmounts ? line.planned : 0 }))
  }));
  state.budget.setupStarted = true;
  const used = new Set();
  state.meals.recipes = template.recipes.map((recipe) => {
    let id = slug(recipe.name);
    while (used.has(id)) id = `${id}-2`;
    used.add(id);
    return { id, name: recipe.name, ingredients: [...recipe.ingredients], calories: recipe.calories, protein: recipe.protein, steps: [...recipe.steps], tips: recipe.tips.map((tip) => ({ ...tip })), ...(recipe.sourceUrl ? { sourceUrl: recipe.sourceUrl } : {}) };
  });
  applyStarterDefaults(state, { currency, now });
  return state;
}

// A short description for the Admin page.
function describeTemplate(saved) {
  const template = effectiveTemplate(saved);
  return { saved: template.saved, sourceMonth: template.sourceMonth, savedAt: saved?.savedAt || "", currency: template.currency, categories: template.categories.length, lines: template.categories.reduce((sum, category) => sum + category.lines.length, 0), recipes: template.recipes.length };
}

module.exports = { BUILT_IN_RECIPES, BUILT_IN_CATEGORIES, applyStarterDefaults, sanitizeTemplate, templateFromState, effectiveTemplate, applyTemplate, describeTemplate };
