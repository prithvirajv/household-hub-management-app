const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("every form with a password field is a POST form, so a plain browser submit can never put a password in the address bar", () => {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map((match) => match[0]).filter((markup) => /type="password"/.test(markup));
  assert.ok(forms.length >= 4, "the sign-in, sign-up, reset and invitation forms are all found");
  forms.forEach((markup) => assert.match(markup.match(/<form\b[^>]*>/)[0], /method="post"/, `${markup.match(/id="([^"]+)"/)[1]} must be method=post`));
});

test("the page holds auth forms until the app is ready and scrubs credentials already in the address bar", () => {
  assert.match(html, /form\.auth-form/);
  assert.match(html, /window\.__authReady/);
  assert.match(html, /history\.replaceState/);
  assert.match(app, /window\.__authReady = true;/);
  assert.ok(html.indexOf("window.__authReady") < html.indexOf('src="/app.js'), "the guard is in place before app.js loads");
});
