const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

test("Recipes can be added from a video and/or photos: a reviewed draft, never saved by the AI call itself", () => {
  assert.match(app, /id="openRecipeImportButton" type="button">\+ From a video or photos<\/button>/);
  assert.match(app, /api\("\/api\/recipes\/import", \{ method: "POST", body: JSON\.stringify\(\{ videoUrl: url, images: recipeImportImages\.map/, "the link and the photos go to the import route");
  assert.match(app, /Nothing is saved until you do\./, "the draft is reviewed first");
  // Only the review form's submit adds the recipe; the import call just fills the draft.
  const importCall = app.slice(app.indexOf('$("#recipeImportRunButton")?.addEventListener'), app.indexOf('$("#recipeImportForm")?.addEventListener("input"'));
  assert.doesNotMatch(importCall, /state\.meals\.recipes\.push/, "reading the video does not add anything");
  assert.match(app, /\$\("#recipeImportForm"\)\?\.addEventListener\("submit"[\s\S]*?state\.meals\.recipes\.push\(\{[\s\S]*?steps: draft\.steps, tips: draft\.tips/, "saving keeps the steps, tips and source link");
  assert.match(app, /if \(taken\(name\)\) \{ let n = 2;/, "a repeated name gets a number instead of being refused");
});

test("what the person types in the review form survives a re-render, and tips are an Important tick plus text", () => {
  assert.match(app, /\$\("#recipeImportForm"\)\?\.addEventListener\("input", syncRecipeImportDraft\)/);
  assert.match(app, /data-recipe-tip-important \$\{tip\.important \? "checked" : ""\}/);
  assert.match(app, /rows\.insertAdjacentHTML\("beforeend", recipeTipRowHtml\(\{ text: "", important: true \}\)\)/, "a new tip starts Important and is added in place");
  assert.match(app, /\$\{recipeTipsEditorHtml\(editingRecipe\?\.tips \|\| \[\]\)\}/, "the normal recipe form edits tips too");
  assert.match(app, /editingRecipe\.tips = readRecipeTips\(event\.currentTarget\)/);
});

test("a recipe card is compact (name, calories, every ingredient) and opens the full recipe in a pop-up", () => {
  assert.match(app, /<div class="mini-tags">\$\{recipe\.ingredients\.map\(\(ingredient\) => `<span>\$\{escapeHtml\(ingredient\)\}<\/span>`\)\.join\(""\)\}<\/div>/, "all ingredients, none hidden behind a +N");
  assert.doesNotMatch(app, /extraCount/, "no truncated ingredient list");
  assert.doesNotMatch(app, /recipe-card-tips|recipe-card-more|recipeDetailsOpen/, "no tips box or fold-out on the card itself");
  assert.match(app, /<div class="recipe-card-body" data-open-recipe="\$\{escapeHtml\(recipe\.id\)\}" role="button" tabindex="0"/, "the card opens the recipe, by mouse or keyboard");
  assert.match(app, /recipe-meta-pill important">★ \$\{importantCount\} important tip/, "a small pill says there are important tips");
  assert.match(css, /\.recipe-card-v2 \{[^}]*grid-template-rows: auto 1fr auto;/, "spare height goes to the body, not spread between the card's rows");
  assert.match(css, /\.recipe-card-body \{[^}]*align-content: start;/, "the text stays at the top of the card");
  assert.match(app, /\$\{recipeDetailId && recipeById\(recipeDetailId\) \? renderRecipeDetailDialog\(recipeById\(recipeDetailId\)\) : ""\}/, "the pop-up is drawn with the page while a recipe is open");
});

test("the recipe pop-up shows Important tips first, then ingredients (a checklist) beside numbered steps, more tips and the video link", () => {
  const dialog = app.slice(app.indexOf("function renderRecipeDetailDialog("), app.indexOf("function renderRecipes() {"));
  const order = ["recipe-detail-important", "recipe-checklist", "recipe-steps", "recipe-other-tips", "recipe-detail-source", "recipe-detail-actions"].map((marker) => dialog.indexOf(marker));
  assert.ok(order.every((position, index) => position > 0 && (index === 0 || position > order[index - 1])), "sections are in reading order");
  assert.match(dialog, /data-select-recipe="\$\{escapeHtml\(recipe\.id\)\}">Use in Meals<\/button>\s*<button type="button" class="ghost" data-edit-recipe=/, "Use in Meals and Edit are in the pop-up too");
  assert.match(app, /const closeRecipeDetail = \(\) => \{ recipeDetailId = ""; recipeDetailDialog\.close\(\); \};/, "closing forgets the recipe at once, not in the delayed close event");
  assert.match(app, /if \(event\.target\.closest\("\[data-select-recipe\], \[data-edit-recipe\]"\)\) recipeDetailId = "";\s*\}, true\);/, "Use in Meals and Edit do not leave the pop-up to reopen over the next screen");
  assert.match(css, /\.recipe-detail-dialog\[open\] \{ display: grid;/, "only an open dialog is displayed");
  assert.match(css, /@media \(max-width: 640px\) \{ \.recipe-detail-cols \{ grid-template-columns: minmax\(0, 1fr\)/, "one column on a phone");
  assert.match(css, /\.recipe-checklist input:checked \+ span \{ text-decoration: line-through;/, "ticked ingredients are struck through");
});

test("the recipe form gives the wide fields rows of their own, takes ingredients one per line, and still accepts the old comma style", () => {
  assert.match(app, /<label class="recipe-field-wide">Ingredients \(one per line\)<textarea name="ingredients"/, "a roomy box, not a single line");
  assert.match(app, /<label class="recipe-field-wide">Steps \(one per line, optional\)<textarea name="steps"/);
  assert.match(app, /function recipeIngredientList\(text\) \{[\s\S]*?raw\.includes\("\\n"\) \? raw\.split\(\/\\r\?\\n\/\) : raw\.split\(","\)/, "a line each, or commas on a single line");
  assert.equal((app.match(/recipeIngredientList\(data\.ingredients\)/g) || []).length, 2, "adding and editing both use it");
  assert.match(css, /\.recipe-builder \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, "two columns, so calories and protein sit side by side");
  assert.match(css, /\.recipe-builder > \.recipe-field-wide,\s*\.recipe-builder > \.recipe-tips-editor,/, "name, ingredients, steps and tips each take a full row");
  assert.match(css, /\.recipe-form-actions \{[^}]*justify-content: flex-end;/);
});
