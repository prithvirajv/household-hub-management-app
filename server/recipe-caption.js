// Fetches the public page of a social post and returns the caption posted with it (see lib/recipe-caption.js for the reading). Only the sites listed
// in lib/recipe-import.js are ever contacted - the first address and every redirect hop is checked against that list, over https only - and the
// reply is size- and time-bounded. It never throws: when a site hides the caption, the result is empty and the person is asked to paste it.

const { recipeSourceLink } = require("../lib/recipe-import");
const { extractCaption, CAPTION_MAX } = require("../lib/recipe-caption");

const MAX_HOPS = 4;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; FamilyLoopRecipeReader/1.0)";

// Reads at most `limit` bytes of a response body as text.
async function readLimited(response, limit) {
  if (!response.body?.getReader) return (await response.text()).slice(0, limit);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  try { await reader.cancel(); } catch (_error) { /* already closed */ }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

// One GET that follows redirects by hand so each hop can be checked. `rewrite` (tests only) maps an allowed address to the address really fetched.
async function fetchPage(startUrl, { fetchImpl, timeoutMs, rewrite }) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const link = recipeSourceLink(current);
    if (!link) return null; // sent somewhere that is not a supported site
    const response = await fetchImpl(rewrite ? rewrite(link.url) : link.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      try { current = new URL(location, link.url).href; } catch (_error) { return null; }
      continue;
    }
    if (!response.ok) return null;
    if (!/html|xml/i.test(response.headers.get("content-type") || "")) return null;
    return { html: await readLimited(response, MAX_PAGE_BYTES), finalLink: link };
  }
  return null;
}

// TikTok publishes each video's caption through a small public JSON service, which is steadier than reading its page.
async function tiktokOembed(link, { fetchImpl, timeoutMs, rewrite }) {
  const target = `https://www.tiktok.com/oembed?url=${encodeURIComponent(link.url)}`;
  const response = await fetchImpl(rewrite ? rewrite(target) : target, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!response.ok) return "";
  const data = JSON.parse(await readLimited(response, 100 * 1024));
  return String(data?.title || "").trim();
}

// { title, caption } for a recipeSourceLink result; both "" when nothing could be read.
async function fetchRecipeCaption(link, { fetchImpl = fetch, timeoutMs = 8000, rewrite } = {}) {
  const options = { fetchImpl, timeoutMs, rewrite };
  const empty = { title: "", caption: "" };
  if (!link) return empty;
  try {
    if (link.platform === "tiktok") {
      try {
        const caption = await tiktokOembed(link, options);
        if (caption) return { title: "", caption: caption.slice(0, CAPTION_MAX) };
      } catch (_error) { /* fall through to the page */ }
    }
    const page = await fetchPage(link.url, options);
    if (!page) return empty;
    return extractCaption(page.html, page.finalLink.platform);
  } catch (error) {
    console.warn(`Recipe caption read failed for ${link.platform}: ${error?.name || "error"}`);
    return empty;
  }
}

module.exports = { fetchRecipeCaption };
