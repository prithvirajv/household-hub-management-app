const test = require("node:test");
const assert = require("node:assert/strict");
const { youtubeVideoId, canonicalYoutubeUrl, buildRecipeImportParts, validateRecipeImportRequest, parseRecipeDraft, createImportLimiter, RECIPE_MAX_IMAGES } = require("../lib/recipe-import");

const ID = "abcdefghijk";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("youtubeVideoId accepts the public link shapes and nothing else", () => {
  assert.equal(youtubeVideoId(`https://youtu.be/${ID}?si=tracking-text`), ID, "a share link with its tracking parameter");
  assert.equal(youtubeVideoId(`https://www.youtube.com/watch?v=${ID}&t=30s`), ID);
  assert.equal(youtubeVideoId(`https://m.youtube.com/watch?v=${ID}`), ID);
  assert.equal(youtubeVideoId(`youtube.com/shorts/${ID}`), ID, "no scheme is fine");
  assert.equal(youtubeVideoId(`https://www.youtube.com/embed/${ID}`), ID);
  assert.equal(youtubeVideoId(`https://www.youtube.com/live/${ID}?feature=share`), ID);
  ["", "not a link", "https://example.com/watch?v=" + ID, `https://youtube.com.evil.example/watch?v=${ID}`, `https://evil.example/https://youtu.be/${ID}`,
    "https://www.youtube.com/watch?v=short", "https://www.youtube.com/watch", "https://www.youtube.com/playlist?list=PL123", `https://youtu.be/${ID}extra`, "x".repeat(400)]
    .forEach((input) => assert.equal(youtubeVideoId(input), "", `rejects: ${input.slice(0, 50)}`));
  assert.equal(canonicalYoutubeUrl(ID), `https://www.youtube.com/watch?v=${ID}`);
});

test("the request to the AI carries only the canonical video link, the photos and the instruction", () => {
  const parts = buildRecipeImportParts({ videoId: ID, images: [{ mimeType: "image/png", imageBase64: PNG }] });
  assert.deepEqual(parts.slice(0, 2), [{ fileData: { fileUri: `https://www.youtube.com/watch?v=${ID}` } }, { inlineData: { mimeType: "image/png", data: PNG } }]);
  assert.equal(parts.length, 3);
  assert.ok(parts[2].text);
  assert.equal(buildRecipeImportParts({ images: [{ mimeType: "image/png", imageBase64: PNG }] }).some((part) => part.fileData), false, "photos alone send no video");
});

test("validateRecipeImportRequest needs a source and rejects bad links, types and sizes", () => {
  assert.match(validateRecipeImportRequest({}).error, /Paste a YouTube link/);
  assert.match(validateRecipeImportRequest({ videoUrl: "https://example.com/x" }).error, /YouTube link/);
  assert.match(validateRecipeImportRequest({ images: [{ mimeType: "application/pdf", imageBase64: PNG }] }).error, /Unsupported image type/);
  assert.match(validateRecipeImportRequest({ images: [{ mimeType: "image/png", imageBase64: "" }] }).error, /empty/);
  assert.match(validateRecipeImportRequest({ images: [{ mimeType: "image/png", imageBase64: "A".repeat(5 * 1024 * 1024 + 1) }] }).error, /too large/);
  assert.match(validateRecipeImportRequest({ images: Array.from({ length: RECIPE_MAX_IMAGES + 1 }, () => ({ mimeType: "image/png", imageBase64: PNG })) }).error, /at most/);
  assert.deepEqual(validateRecipeImportRequest({ videoUrl: `https://youtu.be/${ID}?si=x` }), { videoId: ID, images: [] });
  const both = validateRecipeImportRequest({ videoUrl: `https://youtu.be/${ID}`, images: [{ mimeType: "IMAGE/JPEG", imageBase64: PNG }] });
  assert.deepEqual([both.videoId, both.images[0].mimeType], [ID, "image/jpeg"]);
});

test("parseRecipeDraft cleans the model's answer into a draft with every tip important to start with", () => {
  const reply = "```json\n" + JSON.stringify({
    name: "  Idli   Podi ",
    ingredients: ["1 cup urad dal, roasted", "1 cup urad dal, roasted", "", "  1/2 cup chana dal  ", 7],
    steps: ["Roast the dals on low flame.", "Grind with salt."],
    tips: ["Roast on a low flame only.", "Store in a dry jar for a month.", "roast on a low flame only."],
    calories: "45.4", protein: -3
  }) + "\n```";
  const draft = parseRecipeDraft(reply);
  assert.equal(draft.name, "Idli Podi");
  assert.deepEqual(draft.ingredients, ["1 cup urad dal - roasted", "1/2 cup chana dal", "7"], "no commas inside an ingredient, repeats and blanks dropped");
  assert.deepEqual(draft.tips, [{ text: "Roast on a low flame only.", important: true }, { text: "Store in a dry jar for a month.", important: true }], "repeats ignoring case dropped");
  assert.deepEqual([draft.calories, draft.protein], [45, 0], "numbers rounded, nonsense becomes 0");
  assert.deepEqual(draft.steps.length, 2);
});

test("parseRecipeDraft bounds the lists, copes with chatter around the JSON, and fails clearly when there is no recipe", () => {
  const many = parseRecipeDraft(JSON.stringify({ ingredients: Array.from({ length: 100 }, (_, i) => `item ${i}`), steps: Array.from({ length: 80 }, (_, i) => `step ${i}`), tips: Array.from({ length: 50 }, (_, i) => `tip ${i}`) }));
  assert.deepEqual([many.ingredients.length, many.steps.length, many.tips.length], [60, 40, 20]);
  assert.equal(parseRecipeDraft('Sure! Here it is: {"name":"Chutney","ingredients":["coconut"]} hope that helps').name, "Chutney");
  assert.throws(() => parseRecipeDraft("I cannot help with that"), /did not return a recipe/);
  assert.throws(() => parseRecipeDraft(JSON.stringify({ name: "Nothing", ingredients: [], steps: [] })), /could not find a recipe/);
  assert.throws(() => parseRecipeDraft(""), /did not return a recipe/);
  assert.throws(() => parseRecipeDraft("[1,2,3]"), /did not return a recipe/);
});

test("the import limiter lets each person start a few reads an hour, separately, and forgets old ones", () => {
  const limiter = createImportLimiter({ max: 2, windowMs: 1000 });
  assert.deepEqual([limiter.take("a", 0), limiter.take("a", 10), limiter.take("a", 20)], [true, true, false]);
  assert.equal(limiter.take("b", 30), true, "another person has their own allowance");
  assert.equal(limiter.take("a", 1005), true, "the first one has aged out of the window");
  assert.equal(limiter.take("a", 1015), true);
  assert.equal(limiter.take("a", 1016), false);
});
