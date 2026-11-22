const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const context = {};
vm.createContext(context);
vm.runInContext(`${app.slice(app.indexOf("function recipeIngredientShortName"), app.indexOf("function renderRecipeCard"))}
this.short = recipeIngredientShortName; this.summary = recipeCardIngredients;`, context);

test("an ingredient line is cut down to the ingredient: no quantity, unit, preparation or note", () => {
  const cases = {
    "1 tbsp ginger garlic paste (for gravy base)": "ginger garlic paste",
    "1 cup urad dal - roasted": "urad dal",
    "0.25 tsp turmeric powder (for marination)": "turmeric powder",
    "500 g onion - medium size": "onion",
    "1 whole chicken breast": "chicken breast",
    "2 glasses (500g) basmati rice": "basmati rice",
    "1/2 kg tomato": "tomato",
    "2-3 green chillies - chopped": "green chillies",
    "100ml buffalo milk": "buffalo milk",
    "1 inch cinnamon stick (for masala)": "cinnamon stick",
    "4 cloves (for masala)": "cloves",
    "2 cloves garlic": "garlic",
    "3 stems curry leaves": "curry leaves",
    "1 pinch asafoetida (hing)": "asafoetida",
    "salt to taste": "salt to taste",
    "curry leaves": "curry leaves"
  };
  Object.entries(cases).forEach(([line, name]) => assert.equal(context.short(line), name, line));
});

test("the card shows the first eight distinct names and says how many more there are", () => {
  const many = Array.from({ length: 30 }, (_, i) => `${i + 1} tsp spice number ${i}`);
  const result = context.summary(many);
  assert.equal(result.shown.length, 8);
  assert.equal(result.more, 22);
  assert.equal(result.total, 30);
  const repeated = context.summary(["1 tsp salt (for gravy)", "2 tsp salt (for rice)", "1 cup rice"]);
  assert.deepEqual([[...repeated.shown], repeated.more, repeated.total], [["salt", "rice"], 0, 3], "a repeated ingredient is listed once");
  const none = context.summary([]);
  assert.deepEqual([none.shown.length, none.more, none.total], [0, 0, 0]);
});
