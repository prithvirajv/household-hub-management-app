const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sharedLinkFromShare } = require("../lib/shared-logic");

const root = path.join(__dirname, "..");

test("the link is found in whichever field the phone puts it, url first", () => {
  assert.equal(sharedLinkFromShare({ url: "https://www.instagram.com/reel/ABC123/?igsh=xyz", text: "ignored" }), "https://www.instagram.com/reel/ABC123/?igsh=xyz");
  assert.equal(sharedLinkFromShare({ text: "Look at this pasta! https://vm.tiktok.com/ZMabc/ so good." }), "https://vm.tiktok.com/ZMabc/");
  assert.equal(sharedLinkFromShare({ title: "(https://youtu.be/dQw4w9WgXcQ)" }), "https://youtu.be/dQw4w9WgXcQ");
  assert.equal(sharedLinkFromShare({ text: "no link here" }), "");
  assert.equal(sharedLinkFromShare(null), "");
});

test("the manifest makes the app installable and receives shared links on the app page", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.share_target.method, "GET");
  assert.equal(manifest.share_target.action, manifest.start_url);
  assert.deepEqual(Object.keys(manifest.share_target.params).sort(), ["text", "title", "url"]);
  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  manifest.icons.forEach((icon) => assert.ok(fs.existsSync(path.join(root, icon.src)), `${icon.src} exists`));
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(fs.readFileSync(path.join(root, "sw.js"), "utf8"), /addEventListener\("fetch"/);
});

test("the service worker caches nothing, so a deploy is never hidden behind a stale copy", () => {
  assert.doesNotMatch(fs.readFileSync(path.join(root, "sw.js"), "utf8").replace(/\/\/.*$/gm, ""), /caches\.|cache\.put|addAll/);
});
