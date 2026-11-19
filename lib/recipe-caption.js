// Reads the written part of a social post (the caption or description) out of the post's public web page. Pure: it takes the page's HTML and
// returns text, so it can be tested without the network. Sites change their pages and often hide captions from other apps, so every function
// here returns "" rather than throwing when it finds nothing; the recipe import then asks the person to paste the caption instead.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };
const CAPTION_MAX = 6000;

function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === "#") {
      const number = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(number) && number > 0 && number < 0x110000 ? String.fromCodePoint(number) : "";
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, code.toLowerCase()) ? ENTITIES[code.toLowerCase()] : whole;
  });
}

const tidy = (text) => decodeEntities(text).replace(/\r/g, "").replace(/[ \t ]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, CAPTION_MAX);

// The content of the first <meta> tag whose property/name is one of `names` (case-insensitive), tidied.
function metaContent(html, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    const attributes = {};
    tag.replace(/([a-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (_whole, key, double, single) => { attributes[key.toLowerCase()] = double ?? single ?? ""; return ""; });
    const key = String(attributes.property || attributes.name || "").toLowerCase();
    if (wanted.has(key) && attributes.content) {
      const value = tidy(attributes.content);
      if (value) return value;
    }
  }
  return "";
}

// A JSON string literal found in the page after `"key":`, decoded (the page escapes newlines and quotes inside it).
function jsonStringAfter(html, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(String(html || ""));
  if (!match) return "";
  try { return tidy(JSON.parse(match[1])); } catch (_error) { return ""; }
}

// The description of a schema.org VideoObject/Recipe in the page's JSON-LD, when there is one.
function jsonLdDescription(html) {
  for (const block of String(html || "").match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) {
    try {
      const data = JSON.parse(block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, ""));
      const found = (Array.isArray(data) ? data : [data]).find((item) => item && typeof item === "object" && (item.description || item.recipeIngredient));
      if (found?.recipeIngredient) return tidy([found.description, "Ingredients:", ...[].concat(found.recipeIngredient)].filter(Boolean).join("\n"));
      if (found?.description) return tidy(found.description);
    } catch (_error) { /* not JSON: ignore */ }
  }
  return "";
}

// Pages that only say "log in to see this" carry no caption; their text must never reach the recipe reader as if it were one.
const LOGIN_WALL = /^(log in|login|sign up|sign in|create an account|join facebook|see more of|see photos|watch more|facebook helps you|instagram photos and videos|tiktok - make your day|tiktok.? make your day|reddit - the heart|reddit - dive|pinterest$|x\. it'?s what'?s happening|something went wrong|this page isn'?t available)/i;
const looksLikeLoginWall = (text) => !text || LOGIN_WALL.test(text.trim()) || /\b(log in|sign up) (to|for)\b.{0,60}\b(see|view|continue|watch)\b/i.test(text.slice(0, 200));

// Instagram's description reads: `1,234 likes, 56 comments - user on March 3, 2024: "the caption".` - keep only the caption.
function instagramCaption(description) {
  const match = /^[\d.,KMkm]+ likes?,? [\d.,KMkm]+ comments? - [^:]{1,80}? on [^:]{3,40}: ["“]([\s\S]*?)["”]\.?$/.exec(description) || /^[^:]{1,80} on Instagram: ["“]([\s\S]*?)["”]$/.exec(description);
  return match ? tidy(match[1]) : description;
}

// { title, caption } for a page from `platform` (see recipeSourceLink); either may be "". `html` is the page text.
function extractCaption(html, platform) {
  const page = String(html || "");
  const title = metaContent(page, ["og:title", "twitter:title"]);
  let caption = "";
  if (platform === "youtube") {
    caption = jsonStringAfter(page, "shortDescription");
  } else if (platform === "tiktok") {
    caption = jsonStringAfter(page, "desc");
  }
  const meta = metaContent(page, ["og:description", "twitter:description", "description"]);
  if (!caption) caption = platform === "instagram" ? instagramCaption(meta) : meta;
  if (!caption) caption = jsonLdDescription(page);
  if (platform === "instagram" && !caption) caption = instagramCaption(title);
  caption = tidy(caption);
  const cleanTitle = looksLikeLoginWall(title) ? "" : title;
  if (looksLikeLoginWall(caption)) return { title: "", caption: "" };
  // A title that only repeats the start of the caption adds nothing.
  return { title: cleanTitle && !caption.toLowerCase().startsWith(cleanTitle.toLowerCase().slice(0, 40)) ? cleanTitle : "", caption };
}

module.exports = { CAPTION_MAX, decodeEntities, metaContent, extractCaption, looksLikeLoginWall, instagramCaption };
