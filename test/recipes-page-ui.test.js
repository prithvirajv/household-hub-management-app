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

test("a recipe card shows its Important tips first, folds the rest into Full recipe, and hides calories it does not know", () => {
  assert.match(app, /<ul class="recipe-card-tips">\$\{tips\.filter\(\(tip\) => tip\.important\)/);
  assert.match(app, /<details class="recipe-card-more" data-recipe-details="\$\{escapeHtml\(recipe\.id\)\}" \$\{recipeDetailsOpen\.has\(recipe\.id\) \? "open" : ""\}>/, "the fold-out keeps its open state");
  assert.match(app, /\$\{recipe\.calories \|\| recipe\.protein \? `<small>\$\{recipe\.calories\} cal/);
  assert.match(css, /\.recipe-card-tips \{[^}]*border-left: 3px solid/, "important tips are visibly highlighted");
});
