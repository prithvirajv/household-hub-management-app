const test = require("node:test");
const assert = require("node:assert/strict");
const { extractCaption, decodeEntities, looksLikeLoginWall, instagramCaption } = require("../lib/recipe-caption");
const { fetchRecipeCaption } = require("../server/recipe-caption");
const { recipeSourceLink } = require("../lib/recipe-import");

test("decodeEntities handles named, decimal and hex entities and leaves unknown ones alone", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry &#39;s &#x2019; &quot;x&quot; &unknownthing;"), "Tom & Jerry 's ’ \"x\" &unknownthing;");
});

test("a YouTube description is read in full from the page data, with its line breaks", () => {
  const html = '<meta property="og:title" content="Sambar | Easy"><script>ytInitialPlayerResponse={"videoDetails":{"shortDescription":"Ingredients:\\n1 cup toor dal\\n2 tomatoes \\u0026 salt\\n\\nSubscribe!"}}</script>';
  const result = extractCaption(html, "youtube");
  assert.equal(result.caption, "Ingredients:\n1 cup toor dal\n2 tomatoes & salt\n\nSubscribe!");
  assert.equal(result.title, "Sambar | Easy");
});

test("an Instagram description loses its likes line and keeps only the caption", () => {
  const description = '1,204 likes, 33 comments - cook on March 3, 2025: "Idli podi\n1 cup urad dal. Roast on low flame."';
  assert.equal(instagramCaption(description), "Idli podi\n1 cup urad dal. Roast on low flame.");
  const html = `<meta property="og:description" content="${description.replace(/"/g, "&quot;")}">`;
  assert.match(extractCaption(html, "instagram").caption, /^Idli podi\n1 cup urad dal/);
  assert.equal(instagramCaption('cook on Instagram: "Quick chutney"'), "Quick chutney");
});

test("a TikTok page's own caption field is preferred, and Facebook uses the standard description", () => {
  assert.equal(extractCaption('<script>{"desc":"Garlic noodles \\n3 cloves garlic #fyp"}</script><meta property="og:description" content="other">', "tiktok").caption, "Garlic noodles\n3 cloves garlic #fyp");
  assert.equal(extractCaption('<meta content="Paneer wrap: 200 g paneer" property="og:description">', "facebook").caption, "Paneer wrap: 200 g paneer", "attribute order does not matter");
});

test("a recipe in JSON-LD is used when the meta tags say nothing", () => {
  const html = '<script type="application/ld+json">{"@type":"VideoObject","description":"Quick dal","recipeIngredient":["1 cup dal","salt"]}</script>';
  assert.equal(extractCaption(html, "pinterest").caption, "Quick dal\nIngredients:\n1 cup dal\nsalt");
});

test("login walls and empty pages give no caption", () => {
  ["Log in to Facebook to see more", "Sign up to see photos and videos from your friends.", "Instagram photos and videos", "Something went wrong", ""].forEach((text) => assert.equal(looksLikeLoginWall(text), true, text));
  assert.equal(looksLikeLoginWall("1 cup rice and 2 cups water"), false);
  assert.deepEqual(extractCaption('<meta property="og:description" content="Log in or sign up to view">', "facebook"), { title: "", caption: "" });
  assert.deepEqual(extractCaption("", "instagram"), { title: "", caption: "" });
  assert.deepEqual(extractCaption("<html>not a post</html>", "tiktok"), { title: "", caption: "" });
});

function response(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => body, body: null, json: async () => JSON.parse(body) };
}

test("fetchRecipeCaption only contacts supported sites at every hop, and never throws", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === "https://fb.watch/a/") return response(302, "", { location: "https://www.facebook.com/reel/1/" });
    if (url === "https://www.facebook.com/reel/1/") return response(200, '<meta property="og:description" content="Wrap: 2 rotis">', { "content-type": "text/html; charset=utf-8" });
    if (url === "https://www.instagram.com/reel/x/") return response(302, "", { location: "http://169.254.169.254/latest/meta-data" });
    if (url === "https://www.instagram.com/reel/loop/") return response(302, "", { location: "https://www.instagram.com/reel/loop/" });
    if (url === "https://www.instagram.com/reel/json/") return response(200, "{}", { "content-type": "application/json" });
    throw new Error("network down");
  };
  assert.equal((await fetchRecipeCaption(recipeSourceLink("https://fb.watch/a/"), { fetchImpl })).caption, "Wrap: 2 rotis");
  assert.deepEqual(await fetchRecipeCaption(recipeSourceLink("https://www.instagram.com/reel/x/"), { fetchImpl }), { title: "", caption: "" });
  assert.ok(!seen.some((url) => url.includes("169.254")), "a redirect to an internal address is never followed");
  assert.deepEqual(await fetchRecipeCaption(recipeSourceLink("https://www.instagram.com/reel/loop/"), { fetchImpl }), { title: "", caption: "" }, "a redirect loop gives up");
  assert.deepEqual(await fetchRecipeCaption(recipeSourceLink("https://www.instagram.com/reel/json/"), { fetchImpl }), { title: "", caption: "" }, "not a web page");
  assert.deepEqual(await fetchRecipeCaption(recipeSourceLink("https://www.reddit.com/r/a/comments/1/"), { fetchImpl }), { title: "", caption: "" }, "a failing network is not an error");
  assert.deepEqual(await fetchRecipeCaption(null, { fetchImpl }), { title: "", caption: "" });
});

test("fetchRecipeCaption asks TikTok's caption service first", async () => {
  const fetchImpl = async (url) => url.startsWith("https://www.tiktok.com/oembed") ? response(200, JSON.stringify({ title: "Garlic noodles 3 cloves garlic" }), { "content-type": "application/json" }) : response(404, "");
  assert.deepEqual(await fetchRecipeCaption(recipeSourceLink("https://www.tiktok.com/@cook/video/1"), { fetchImpl }), { title: "", caption: "Garlic noodles 3 cloves garlic" });
});
